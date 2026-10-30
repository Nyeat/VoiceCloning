import fs from 'fs';
import crypto from 'crypto';
import { Router } from 'express';
import { inferenceServer } from '../services/inferenceServer.js';
import { activityState } from '../services/activityState.js';
import {
  synthesizeLongText,
  synthesizeLongTextStreaming,
  regenerateLongTextChunk,
  restoreLongTextChunkVersion,
  deleteLongTextChunk,
  insertLongTextChunk,
  hydrateLongTextSession,
  persistLongTextSession,
  cancelSession,
  requestSessionCancellation,
  applyFullInferenceQualityPreset,
  fullInferenceQualityOptions,
  analyzeAudioQuality,
  estimateReferenceCharsPerSec,
  buildAttemptVariants,
  scoreAudioCandidate,
  hasActiveInferenceSession,
  concatWavs,
  padWavBoundaries,
  applyWavOutputGain,
} from '../services/longTextInference.js';
import { inferenceState } from '../services/inferenceState.js';
import { sseManager } from '../services/sseManager.js';
import { resolveRefAudioParams } from '../services/refAudioCache.js';
import { prepareTextForFullSynthesis } from '../services/textPronunciation.js';
import { scanOovWords } from '../services/oovScan.js';
import { applyEmphasisAndSpelling } from '../services/emphasisAndSpelling.js';
import { expandSsml, splitOnBreaks, partitionBreaks } from '../services/ssml.js';
import {
  COMMA_PAUSE_SECONDS,
  TRANSCRIPTION_VERIFY_ENABLED,
  LIVE_TRANSCRIPTION_VERIFY_ENABLED,
  SPEAKER_VERIFY_ENABLED,
} from '../config.js';
import {
  applySynthesisAliases,
  syncHotDictionaryOverrides,
  loadRuntimePronunciationEntries,
  collectArpabetWords,
} from '../services/runtimePronunciationDictionary.js';
import { transcriptionVerifier } from '../services/transcriptionVerifier.js';
import { speakerSimilarity } from '../services/speakerSimilarity.js';
import { SynthesisQueueError, synthesisScheduler } from '../services/synthesisScheduler.js';
import {
  ensureRequestVoiceModel,
  modelResidencyKey,
  readVoiceModelSnapshot,
  voiceModelKey,
} from '../services/requestVoiceModel.js';
import { coordinatorState } from '../services/coordinatorState.js';

const router = Router();
export function synthesisBusy() {
  // `inferenceState` is progress/history and can remain waiting/generating after a
  // browser disconnect or old process error. Ownership comes only from a live Fast
  // request, regeneration lock, or an active long-text session.
  return synthesisScheduler.getStats().active > 0
    || hasActiveInferenceSession();
}

// Identifies the reply a live clip belongs to, so barge-in can drop that reply's
// queued clips. Sent as a header rather than in the body: the body is forwarded
// verbatim to the GPT-SoVITS Python API, which must not see unknown fields.
export function replyCancelKey(req) {
  return String(req.get('X-VCS-Reply-Token') || '').trim();
}

async function acquireSynthesisLease(req, res) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  let lease = null;
  req.once('aborted', abort);
  try {
    if (coordinatorState.snapshot().draining) {
      throw new SynthesisQueueError(503, 'This GPU is changing voice models. Please retry shortly.', 'MODEL_REASSIGNING');
    }
    lease = await synthesisScheduler.acquire({
      modelKey: voiceModelKey(req.body),
      signal: controller.signal,
      priority: Number.parseInt(req.get('X-VCS-Capacity-Retry') || '0', 10) > 0,
      cancelKey: replyCancelKey(req),
      allowQueue: req.get('X-VCS-Coordinator-Direct') !== '1',
    });
    req.off('aborted', abort);
    res.set('X-Synthesis-Queue-Wait-Ms', String(lease.queueWaitMs));
    await ensureRequestVoiceModel(req.body);
    const residencyKey = modelResidencyKey(req.body);
    if (residencyKey) {
      coordinatorState.assign({
        modelKey: residencyKey,
        voiceProfileId: readVoiceModelSnapshot(req.body).voiceProfileId,
      });
    }
    return lease;
  } catch (error) {
    req.off('aborted', abort);
    lease?.release();
    throw error;
  }
}

function sendSynthesisError(res, error) {
  if (error instanceof SynthesisQueueError) {
    if ([429, 503].includes(error.statusCode)) res.set('Retry-After', '2');
    return res.status(error.statusCode).json({
      error: error.message,
      code: error.code,
      queue: synthesisScheduler.getStats(),
    });
  }
  return res.status(500).json({ error: error.message });
}

async function acquireSessionLease(req, res, sessionId) {
  const session = await hydrateLongTextSession(sessionId);
  req.body = {
    ...(req.body || {}),
    ...(session.params?.voice_model ? { voice_model: session.params.voice_model } : {}),
  };
  const lease = await acquireSynthesisLease(req, res);
  return { lease, session };
}

// Pronunciation-dictionary words for the chunker, so a medical dictionary term is
// kept away from the risky chunk-final position. Never blocks synthesis: with no
// dictionary (or an S3 fault) chunking simply proceeds without the rule.
async function chunkingDictionaryWords() {
  try {
    const entries = await loadRuntimePronunciationEntries();
    return entries.flatMap((entry) => {
      const aliasWords = String(entry.synthesisAlias || '').match(/[A-Za-z']+/gu) || [];
      return [entry.word, aliasWords.at(-1)].filter(Boolean);
    });
  } catch {
    return [];
  }
}

// Shared route order: SSML first, then admin aliases, then capital/emphasis
// classification. Alias replacement therefore wins; when no alias is present, an
// admin ARPAbet word stays intact so GPT-SoVITS can match its hot-dictionary key.
export async function prepareTextBeforeNormalization(text, {
  loadEntries = loadRuntimePronunciationEntries,
} = {}) {
  const entries = await loadEntries();
  const protectedWords = collectArpabetWords(entries);
  const expandedText = expandSsml(text, { protectedWords });
  const dictionaryText = applySynthesisAliases(expandedText, entries);
  return applyEmphasisAndSpelling(dictionaryText, { protectedWords });
}

// Per-chunk acceptance check for the chunked full-quality path. A take is accepted
// only when ASR confirms it spoke all the words (no skipped/clipped words) AND it
// still sounds like the reference voice. Live Full fails closed if either configured
// verifier disappears; Live Fast retains its established best-effort behavior.
export function verificationOptions(params = {}, {
  finalWordTailCheck = false,
  phonemeVerification = finalWordTailCheck,
} = {}) {
  const useAsr = TRANSCRIPTION_VERIFY_ENABLED;
  const refAudioPath = params.ref_audio_path || '';
  const useSpeaker = SPEAKER_VERIFY_ENABLED && Boolean(refAudioPath);
  if (!useAsr && !useSpeaker) return {};

  return {
    verifyChunk: async (audioBuffer, expectedText) => {
      // Admin pronunciation-dictionary words are rare medical terms Whisper often
      // mis-transcribes; pass them so Full can verify an anchored timed token occupied
      // the expected slot instead of demanding Whisper's exact spelling.
      let dictionaryEntries = [];
      if (useAsr) {
        try {
          const entries = await loadRuntimePronunciationEntries();
          dictionaryEntries = entries.filter((entry) => entry?.word);
        } catch { /* no dictionary → strict spelling check, as before */ }
      }
      const [asr, speaker] = await Promise.all([
        useAsr ? transcriptionVerifier.verifyChunk(audioBuffer, expectedText, {
          dictionaryWords: dictionaryEntries.map((entry) => entry.word),
          dictionaryEntries,
          finalWordTailCheck,
          phonemeVerification,
        }) : null,
        useSpeaker ? speakerSimilarity.scoreChunk(refAudioPath, audioBuffer) : null,
      ]);
      // Fail closed for Full only when its completeness checker disappears. Speaker
      // similarity is a ranking/identity signal, not evidence that words were skipped:
      // if that sidecar is down, keep ASR validation and rank without similarity.
      const asrUnavailable = useAsr && finalWordTailCheck && !asr;
      const speakerUnavailable = useSpeaker && finalWordTailCheck && !speaker;
      if (asrUnavailable) {
        return {
          ok: false,
          coverage: 0,
          missingWords: [],
          extraWords: [],
          suspectWords: [],
          skippedWords: [],
          words: [],
          transcript: '',
          similarity: speaker?.similarity,
          similarityOk: speaker ? speaker.ok : null,
          verificationUnavailable: asrUnavailable,
          speakerVerificationUnavailable: speakerUnavailable,
        };
      }
      if (!asr && !speaker) return null;
      return {
        ok: (asr ? asr.ok : true) && (speaker ? speaker.ok : true),
        coverage: asr?.coverage ?? 1,
        missingWords: asr?.missingWords ?? [],
        extraWords: asr?.extraWords ?? [],
        duplicatedWords: asr?.duplicatedWords ?? [],
        suspectWords: asr?.suspectWords ?? [],
        skippedWords: asr?.skippedWords ?? [],
        words: asr?.words ?? [],
        transcript: asr?.transcript,
        phonemeAssessments: asr?.phonemeAssessments ?? [],
        similarity: speaker?.similarity,
        similarityOk: speaker ? speaker.ok : null,
        speakerVerificationUnavailable: speakerUnavailable,
      };
    },
  };
}

function readInferenceParams(body) {
  const {
    text,
    text_lang = 'en',
    ref_audio_path,
    prompt_text = '',
    prompt_lang = 'en',
    aux_ref_audio_paths = [],
    top_k = 5,
    top_p = 0.85,
    temperature = 0.7,
    repetition_penalty = 1.35,
    speed_factor = 1.0,
    seed = -1,
  } = body;

  return {
    text,
    text_lang,
    ref_audio_path,
    prompt_text,
    prompt_lang,
    aux_ref_audio_paths,
    top_k,
    top_p,
    temperature,
    repetition_penalty,
    speed_factor,
    seed,
  };
}

function readFullChunkingOptions(body = {}) {
  const maxChunkWords = Number(body.max_chunk_words);
  const maxSentencesPerChunk = Number(body.max_sentences_per_chunk);
  const outputGainDb = Number(body.output_gain_db);
  return {
    ...(Number.isInteger(maxChunkWords) && maxChunkWords >= 10 && maxChunkWords <= 100 ? { maxChunkWords } : {}),
    ...(Number.isInteger(maxSentencesPerChunk) && maxSentencesPerChunk >= 1 && maxSentencesPerChunk <= 5
      ? { maxSentencesPerChunk }
      : {}),
    ...(Number.isFinite(outputGainDb) && outputGainDb >= -6 && outputGainDb <= 6
      ? { outputGainDb }
      : {}),
  };
}

// Live Fast retries each chunk up to this many times (total takes = value + 1).
// Current policy is two normal takes, plus at most two emergency reseeds only when
// every retained take is catastrophic (silence, babble, or severe clipping): four
// total in that exceptional path. Live Fast never splits a chunk below itself — it
// re-seeds the WHOLE chunk, then keeps the best take.
const LIVE_FAST_RETRY_COUNT = 1;

// Synthesize ONE Live Fast chunk with the same anti-skip logic Live Full uses per
// chunk (re-seed retries + ASR/quality verification + best-effort fallback), but
// WITHOUT sentence-splitting. Each take keeps the caller's Live Fast synth params
// (cut0, sampling, fragment_interval); only the seed varies between takes. Accepts the
// first take that passes quality analysis AND word-coverage verification; if none pass
// within the retry budget, ships the highest-scoring take (most complete / least
// clipped) so a stubborn chunk still speaks every word rather than failing the reply.
async function synthesizeLiveFastChunk(baseParams, {
  synthesize,
  verifyChunk = null,
  retryCount = LIVE_FAST_RETRY_COUNT,
} = {}) {
  const chunkText = String(baseParams.text || '').trim();
  const maxRetries = Math.max(0, Number.isFinite(retryCount) ? retryCount : LIVE_FAST_RETRY_COUNT);
  let lastError = null;
  let best = null;

  // A babble / drone ("aaaaa"), silent, or clipped take is a CATASTROPHIC degeneration of
  // the AR decoder, not a mere dropped word — and a fresh seed reliably escapes it. Shipping
  // one as best-effort is far worse than a little extra latency, so when every take so far is
  // catastrophic we spend extra reseeds beyond the normal budget (capped). This never touches
  // the good-take path (a clean take early-returns) and changes nothing about how the model
  // speaks — it only keeps re-rolling audio that is already unusable.
  const isCatastrophic = (analysis) => {
    const m = analysis?.metrics || {};
    return !analysis?.ok && (
      (m.loopScore ?? 0) > 0.5
      || (m.rms ?? 1) < 0.003
      || (m.zeroishRatio ?? 0) > 0.995
      || (m.clippedRatio ?? 0) > 0.2
    );
  };
  const MAX_BABBLE_ESCAPE_RESEEDS = 2;
  let babbleEscapesLeft = MAX_BABBLE_ESCAPE_RESEEDS;

  // takeIndex increases on every take (including babble-escape reseeds) so each take gets
  // a genuinely different seed from buildAttemptVariants; `attempt` only tracks the budget.
  let takeIndex = -1;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    takeIndex += 1;
    const params = buildAttemptVariants({ ...baseParams, text: `${chunkText} ` }, takeIndex);
    try {
      const audioBuffer = await synthesize(params);

      // If the buffer can't be analyzed (e.g. an unexpected/edge format), don't reject
      // on that basis — treat quality as "no opinion" and let verification decide.
      let analysis;
      try {
        analysis = analyzeAudioQuality(audioBuffer, chunkText, {
          charsPerSec: estimateReferenceCharsPerSec(baseParams.ref_audio_path, baseParams.prompt_text),
        });
      } catch {
        // Can't analyze this buffer — treat it as acceptable (not silent) so scoring is
        // driven by word-coverage verification rather than a false "silent audio" penalty.
        analysis = {
          ok: true,
          durationSec: 0,
          reason: null,
          metrics: { rms: 0.02, absPeak: 0.02, zeroishRatio: 0, clippedRatio: 0, longestQuietSec: 0, loopScore: 0 },
        };
      }

      // Only spend ASR on takes whose audio already looks usable.
      let verification = null;
      if (verifyChunk && analysis.ok) {
        verification = await verifyChunk(audioBuffer, chunkText);
      }

      const score = scoreAudioCandidate(analysis, verification);
      if (!best || score > best.score) best = { audioBuffer, score, catastrophic: isCatastrophic(analysis) };

      if (!analysis.ok) throw new Error(analysis.reason || 'Audio failed quality analysis');
      if (verification && !verification.ok) {
        throw new Error(`Take rejected — covered ${((verification.coverage ?? 0) * 100).toFixed(0)}% of the text`);
      }
      return audioBuffer;
    } catch (err) {
      lastError = err;
    }

    // Out of normal budget but every take we kept is babble/silent — buy extra reseeds
    // rather than ship a drone. Only the best (highest-scoring) take being catastrophic
    // triggers this, so a single stray babble among usable takes does not extend the loop.
    if (attempt === maxRetries && best?.catastrophic && babbleEscapesLeft > 0) {
      babbleEscapesLeft -= 1;
      attempt -= 1; // grant one more iteration (takeIndex still advances → fresh seed)
    }
  }

  // Best-effort fallback: never fail a Live Fast reply on a stubborn chunk — ship the
  // most complete / least-clipped take we saw.
  if (best) {
    console.warn(`[live-fast] kept best-effort take after ${maxRetries + 1} seeds: ${lastError?.message}; text="${chunkText.slice(0, 80)}"`);
    return best.audioBuffer;
  }
  throw lastError || new Error('Live Fast synthesis produced no audio');
}

export async function handleLiveTtsRequest(body, {
  resolveParams = resolveRefAudioParams,
  synthesize = (params) => inferenceServer.synthesize(params),
  verifyChunk,
  retryCount,
} = {}) {
  const resolvedParams = await resolveParams(body);
  // Client-only flag: the first clip of a reply gates time-to-first-audio, so the
  // client asks to skip its verification. Never forwarded to the engine.
  const skipVerify = Boolean(resolvedParams.skip_verify);
  delete resolvedParams.skip_verify;
  // Scheduler/residency metadata, consumed upstream by ensureRequestVoiceModel in
  // acquireSynthesisLease. The weights it names are already loaded by the time we
  // get here, and these params are forwarded to GPT-SoVITS' /tts verbatim, so drop
  // it the same way the Full path does (services/longTextInference.js).
  delete resolvedParams.voice_model;
  const emphasizedText = await prepareTextBeforeNormalization(resolvedParams.text);
  // Formula expansion is a deterministic in-process text rewrite, not a quality
  // pass. Reuse it on Live Fast so scientific notation is spoken consistently
  // without adding a model call, verifier pass, or synthesis retry.
  const normalizedText = prepareTextForFullSynthesis(emphasizedText);
  const normalizedParams = {
    ...resolvedParams,
    text: normalizedText,
    // cut0 = "no forced split": feed the whole chunk in and let the model choose its
    // own pauses (natural prosody), same as Live Full. The Live Fast lambda always
    // sends cut0; this fallback only applies if a caller omits it.
    text_split_method: resolvedParams.text_split_method || 'cut0',
    // Comma/clause pause length (GPT-SoVITS fragment_interval), tunable via COMMA_PAUSE_SECONDS.
    fragment_interval: resolvedParams.fragment_interval ?? COMMA_PAUSE_SECONDS,
  };
  // skip_verify (first clip of a reply) and LIVE_TRANSCRIPTION_VERIFY_ENABLED both
  // switch verification off for the live path without touching Full/Queue.
  const liveVerifyAllowed = LIVE_TRANSCRIPTION_VERIFY_ENABLED && !skipVerify;
  const activeVerifyChunk = verifyChunk !== undefined
    ? verifyChunk
    : (liveVerifyAllowed
      ? (verificationOptions(normalizedParams, { phonemeVerification: true }).verifyChunk || null)
      : null);
  const { speechText, leadingBreakMs, trailingBreakMs } = partitionBreaks(normalizedText);
  const breakSegments = [];
  for (const segment of splitOnBreaks(speechText)) {
    const text = String(segment.text || '').trim();
    if (text) {
      breakSegments.push({ text, breakMsAfter: segment.breakMsAfter });
    } else if (segment.breakMsAfter != null && breakSegments.length > 0) {
      // Match Full's handling of back-to-back breaks: the latest explicit break
      // controls the next real audio boundary instead of synthesizing an empty clip.
      breakSegments[breakSegments.length - 1].breakMsAfter = segment.breakMsAfter;
    }
  }
  if (breakSegments.length === 0) {
    throw new Error('No text to synthesize');
  }

  const buffers = [];
  for (const segment of breakSegments) {
    buffers.push(await synthesizeLiveFastChunk(
      { ...normalizedParams, text: segment.text },
      {
        synthesize,
        verifyChunk: activeVerifyChunk,
        retryCount,
      },
    ));
  }
  const joined = buffers.length === 1
    ? buffers[0]
    : concatWavs(
      buffers,
      breakSegments.slice(0, -1).map(segment => segment.breakMsAfter ?? 0),
    );
  // Gain is deliberately post-verification: it changes only delivered PCM level,
  // never synthesis, retry selection, ASR, or phoneme decisions.
  const audioBuffer = applyWavOutputGain(
    padWavBoundaries(joined, leadingBreakMs, trailingBreakMs),
    body.output_gain_db,
  );
  return { audioBuffer, resolvedParams: normalizedParams };
}

router.get('/inference/status', async (_req, res) => {
  try {
    const status = await inferenceServer.getStatus();
    res.json({
      ...status,
      verification: {
        enabled: TRANSCRIPTION_VERIFY_ENABLED,
        ...transcriptionVerifier.getStatus(),
      },
      speaker: {
        enabled: SPEAKER_VERIFY_ENABLED,
        ...speakerSimilarity.getStatus(),
      },
    });
  } catch (err) {
    res.status(500).json({
      ready: false,
      error: err.message,
      loaded: inferenceServer.getLoadedWeights(),
      managed: false,
    });
  }
});

router.post('/inference/start', async (_req, res) => {
  try {
    const sync = await syncHotDictionaryOverrides();
    // engdict-hot.rep is only read by api_v2.py when it rebuilds the compiled
    // dictionary (engdict_cache.pickle). The sync rewrites the hot file AND drops a
    // stale cache so the rebuild actually happens; either event means a running
    // process still holds the previous pronunciations in memory. Stop it so start()
    // below respawns it, regenerates the cache from the hot file, and reloads the
    // updated dictionary. (cacheInvalidated covers an already-current hot file whose
    // entries never made it into a pre-existing stale cache.)
    if ((sync.changed || sync.cacheInvalidated) && inferenceServer.isRunning()) {
      console.log('[pronunciation] restarting inference server so the rebuilt dictionary cache is loaded');
      inferenceServer.stop();
    }
    const status = await inferenceServer.start();
    activityState.mark();
    res.json(status);
  } catch (err) {
    res.status(500).json({
      ready: false,
      error: err.message,
      loaded: inferenceServer.getLoadedWeights(),
      managed: false,
    });
  }
});

router.post('/inference/stop', (_req, res) => {
  try {
    const status = inferenceServer.stop();
    activityState.mark();
    res.json(status);
  } catch (err) {
    res.status(500).json({
      ready: false,
      error: err.message,
      loaded: inferenceServer.getLoadedWeights(),
      managed: false,
    });
  }
});

router.post('/inference/weights/gpt', async (req, res) => {
  const { weightsPath } = req.body;
  if (!weightsPath) {
    return res.status(400).json({ error: 'weightsPath is required' });
  }
  if (!fs.existsSync(weightsPath)) {
    return res.status(404).json({ error: `GPT weights file not found: ${weightsPath}` });
  }

  let lease = null;
  try {
    lease = await synthesisScheduler.acquire({ modelKey: `admin:gpt:${weightsPath}` });
    const status = await inferenceServer.setGPTWeights(weightsPath);
    activityState.mark();
    res.json(status);
  } catch (err) {
    sendSynthesisError(res, err);
  } finally {
    lease?.release();
  }
});

router.post('/inference/weights/sovits', async (req, res) => {
  const { weightsPath } = req.body;
  if (!weightsPath) {
    return res.status(400).json({ error: 'weightsPath is required' });
  }
  if (!fs.existsSync(weightsPath)) {
    return res.status(404).json({ error: `SoVITS weights file not found: ${weightsPath}` });
  }

  let lease = null;
  try {
    lease = await synthesisScheduler.acquire({ modelKey: `admin:sovits:${weightsPath}` });
    const status = await inferenceServer.setSoVITSWeights(weightsPath);
    activityState.mark();
    res.json(status);
  } catch (err) {
    sendSynthesisError(res, err);
  } finally {
    lease?.release();
  }
});

router.post('/inference/weights/pair', async (req, res) => {
  const gptPath = String(req.body?.gptPath || '').trim();
  const sovitsPath = String(req.body?.sovitsPath || '').trim();
  if (!gptPath && !sovitsPath) {
    return res.status(400).json({ error: 'gptPath or sovitsPath is required' });
  }
  if (gptPath && !fs.existsSync(gptPath)) {
    return res.status(404).json({ error: `GPT weights file not found: ${gptPath}` });
  }
  if (sovitsPath && !fs.existsSync(sovitsPath)) {
    return res.status(404).json({ error: `SoVITS weights file not found: ${sovitsPath}` });
  }

  let lease = null;
  try {
    lease = await synthesisScheduler.acquire({
      modelKey: `admin:pair:${gptPath}:${sovitsPath}`,
    });
    if (sovitsPath) await inferenceServer.setSoVITSWeights(sovitsPath);
    if (gptPath) await inferenceServer.setGPTWeights(gptPath);
    activityState.mark();
    return res.json(inferenceServer.getStatusSnapshot());
  } catch (err) {
    return sendSynthesisError(res, err);
  } finally {
    lease?.release();
  }
});

router.post('/inference/tts', async (req, res) => {
  let lease = null;
  try {
    lease = await acquireSynthesisLease(req, res);
    activityState.mark();
    // Demo Live Fast requests take GPU priority: cancel any in-flight Live Full session
    // so this phrase runs next. (No-op if nothing is running. The in-flight Live Fast
    // phrase, if any, is not tracked/cancellable and simply finishes — see demoPreempt.)
    const { audioBuffer } = await handleLiveTtsRequest(req.body);
    activityState.mark();

    res.set({
      'Content-Type': 'audio/wav',
      'Content-Length': audioBuffer.length,
    });
    res.send(audioBuffer);
  } catch (err) {
    sendSynthesisError(res, err);
  } finally {
    lease?.release();
  }
});

// Barge-in: the user talked over this reply, so free any of its clips still waiting
// for the GPU and refuse any that are still in transit. A clip already synthesizing
// cannot be stopped — the GPT-SoVITS call is blocking — so `freed` is 0 when the
// phrase had already reached the GPU. Idempotent: repeat cancels are harmless.
router.post('/live/cancel', (req, res) => {
  const replyToken = String(req.body?.replyToken || '').trim();
  if (!replyToken) {
    return res.status(400).json({ error: 'replyToken is required' });
  }
  const freed = synthesisScheduler.cancel(replyToken);
  return res.json({ freed, queue: synthesisScheduler.getStats() });
});

// Scan the input text for words the running engine would pronounce by NEURAL GUESS
// (not from the dictionary) — the deterministically-mispronounced set an admin should
// add an ARPAbet override for. Read-only and cheap; safe to call on every keystroke-lull.
router.post('/inference/scan-oov', (req, res) => {
  try {
    const text = String(req.body?.text || '');
    if (!text.trim()) {
      return res.json({ flagged: [], totalWords: 0, coveredWords: 0, dictionaryLoaded: true });
    }
    return res.json(scanOovWords(text));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/inference', async (req, res) => {
  const params = readInferenceParams(req.body);
  let lease = null;

  if (!params.text) {
    return res.status(400).json({ error: 'text is required' });
  }
  if (!params.ref_audio_path) {
    return res.status(400).json({ error: 'ref_audio_path is required' });
  }

  try {
    lease = await acquireSynthesisLease(req, res);
    const status = await inferenceServer.getStatus();
    if (!status.ready) {
      return res.status(503).json({ error: status.error || 'Inference server is not ready. Load models first.' });
    }

    activityState.mark();
    const resolvedParams = await resolveRefAudioParams(params);
    resolvedParams.text = await prepareTextBeforeNormalization(resolvedParams.text);
    const qualityParams = {
      ...applyFullInferenceQualityPreset(resolvedParams),
      ...(req.body?.voice_model ? { voice_model: { ...req.body.voice_model } } : {}),
    };
    const { audioBuffer, chunks } = await synthesizeLongText(qualityParams, fullInferenceQualityOptions({
      ...readFullChunkingOptions(req.body),
      ...verificationOptions(qualityParams, { finalWordTailCheck: true }),
      avoidChunkFinalWords: await chunkingDictionaryWords(),
    }));
    activityState.mark();

    res.set({
      'Content-Type': 'audio/wav',
      'Content-Length': audioBuffer.length,
      'X-Chunk-Count': String(chunks.length),
      'X-Chunk-Retries': String(chunks.reduce((sum, chunk) => sum + Math.max(0, chunk.attempts - 1), 0)),
    });
    res.send(audioBuffer);
  } catch (err) {
    sendSynthesisError(res, err);
  } finally {
    lease?.release();
  }
});

router.post('/inference/generate', async (req, res) => {
  const params = readInferenceParams(req.body);
  let lease = null;

  if (!params.text) {
    return res.status(400).json({ error: 'text is required' });
  }
  if (!params.ref_audio_path) {
    return res.status(400).json({ error: 'ref_audio_path is required' });
  }

  try {
    lease = await acquireSynthesisLease(req, res);
    const status = await inferenceServer.getStatus();
    if (!status.ready) {
      return res.status(503).json({ error: status.error || 'Inference server is not ready. Load models first.' });
    }
    const resolvedParams = await resolveRefAudioParams(params);
    resolvedParams.text = await prepareTextBeforeNormalization(resolvedParams.text);
    const qualityParams = {
      ...applyFullInferenceQualityPreset(resolvedParams),
      ...(req.body?.voice_model ? { voice_model: { ...req.body.voice_model } } : {}),
    };
    const sessionId = crypto.randomUUID();
    inferenceState.resetForNewSession({ sessionId, params: qualityParams });
    sseManager.prepareSession(sessionId);
    res.json({ sessionId });

    const streamingLease = lease;
    synthesizeLongTextStreaming(sessionId, qualityParams, fullInferenceQualityOptions({
      ...readFullChunkingOptions(req.body),
      ...verificationOptions(qualityParams, { finalWordTailCheck: true }),
      avoidChunkFinalWords: await chunkingDictionaryWords(),
    })).catch((err) => {
      console.error(`[inference/generate] failed for ${sessionId}:`, err.message);
      inferenceState.setError(err.message);
      sseManager.send(sessionId, 'error', { message: err.message });
    }).finally(() => {
      streamingLease.release();
    });
    lease = null;
  } catch (err) {
    sendSynthesisError(res, err);
  } finally {
    if (lease) {
      lease.release();
    }
  }
});

router.get('/inference/queue', (_req, res) => {
  res.json(synthesisScheduler.getStats());
});

router.post('/inference/regenerate-chunk', async (req, res) => {
  const sessionId = String(req.body?.sessionId || '');
  const index = Number(req.body?.index);
  const replacementText = String(req.body?.text || '').trim();
  const previousDisplayText = String(req.body?.previousText || '').trim();
  const previousFallback = req.body?.previousFallback === true;
  const previousFallbackReason = String(req.body?.previousFallbackReason || '');
  if (!/^[A-Za-z0-9-]+$/u.test(sessionId)) return res.status(400).json({ error: 'Invalid sessionId' });
  if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: 'Invalid chunk index' });
  let lease = null;
  try {
    activityState.mark();
    const acquired = await acquireSessionLease(req, res, sessionId);
    lease = acquired.lease;
    const { session } = acquired;
    let preparedReplacement = '';
    if (replacementText) {
      preparedReplacement = await prepareTextBeforeNormalization(replacementText);
    }
    const result = await regenerateLongTextChunk(sessionId, index, fullInferenceQualityOptions({
      ...(session.options || {}),
      ...verificationOptions(session.params || {}, { finalWordTailCheck: true }),
      avoidChunkFinalWords: await chunkingDictionaryWords(),
    }),
    preparedReplacement,
    replacementText,
    previousDisplayText,
    previousFallback,
    previousFallbackReason);
    await persistLongTextSession(sessionId);
    activityState.mark();
    return res.json(result);
  } catch (err) {
    if (err instanceof SynthesisQueueError) return sendSynthesisError(res, err);
    const status = /no longer available|unavailable/iu.test(err.message) ? 404 : 500;
    return res.status(status).json({ error: err.message });
  } finally {
    lease?.release();
  }
});

router.post('/inference/restore-chunk', async (req, res) => {
  const sessionId = String(req.body?.sessionId || '');
  const index = Number(req.body?.index);
  const versionId = String(req.body?.versionId || '');
  if (!/^[A-Za-z0-9-]+$/u.test(sessionId)) return res.status(400).json({ error: 'Invalid sessionId' });
  if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: 'Invalid chunk index' });
  if (!/^[A-Za-z0-9-]+$/u.test(versionId)) return res.status(400).json({ error: 'Invalid versionId' });
  let lease = null;
  try {
    activityState.mark();
    const acquired = await acquireSessionLease(req, res, sessionId);
    lease = acquired.lease;
    const { session } = acquired;
    const result = await restoreLongTextChunkVersion(
      sessionId,
      index,
      versionId,
      session.options || {},
      String(req.body?.currentText || ''),
      req.body?.currentFallback === true,
      String(req.body?.currentFallbackReason || ''),
    );
    await persistLongTextSession(sessionId);
    activityState.mark();
    return res.json(result);
  } catch (err) {
    if (err instanceof SynthesisQueueError) return sendSynthesisError(res, err);
    const status = /no longer available|unavailable/iu.test(err.message) ? 404 : 500;
    return res.status(status).json({ error: err.message });
  } finally {
    lease?.release();
  }
});

router.post('/inference/delete-chunk', async (req, res) => {
  const sessionId = String(req.body?.sessionId || '');
  const index = Number(req.body?.index);
  if (!/^[A-Za-z0-9-]+$/u.test(sessionId)) return res.status(400).json({ error: 'Invalid sessionId' });
  if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: 'Invalid chunk index' });
  let lease = null;
  try {
    activityState.mark();
    const acquired = await acquireSessionLease(req, res, sessionId);
    lease = acquired.lease;
    const { session } = acquired;
    const result = await deleteLongTextChunk(sessionId, index, session.options || {});
    await persistLongTextSession(sessionId);
    activityState.mark();
    return res.json(result);
  } catch (err) {
    if (err instanceof SynthesisQueueError) return sendSynthesisError(res, err);
    const status = /no longer available|unavailable/iu.test(err.message) ? 404 : 500;
    return res.status(status).json({ error: err.message });
  } finally {
    lease?.release();
  }
});

router.post('/inference/insert-chunk', async (req, res) => {
  const sessionId = String(req.body?.sessionId || '');
  const index = Number(req.body?.index);
  const displayText = String(req.body?.text || '').trim();
  if (!/^[A-Za-z0-9-]+$/u.test(sessionId)) return res.status(400).json({ error: 'Invalid sessionId' });
  if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: 'Invalid chunk index' });
  if (!displayText) return res.status(400).json({ error: 'Chunk text is required' });
  let lease = null;
  try {
    activityState.mark();
    const acquired = await acquireSessionLease(req, res, sessionId);
    lease = acquired.lease;
    const { session } = acquired;
    const preparedText = await prepareTextBeforeNormalization(displayText);
    const result = await insertLongTextChunk(sessionId, index, fullInferenceQualityOptions({
      ...(session.options || {}),
      ...verificationOptions(session.params || {}, { finalWordTailCheck: true }),
      avoidChunkFinalWords: await chunkingDictionaryWords(),
    }), preparedText, displayText);
    await persistLongTextSession(sessionId);
    activityState.mark();
    return res.json(result);
  } catch (err) {
    if (err instanceof SynthesisQueueError) return sendSynthesisError(res, err);
    const status = /no longer available|unavailable/iu.test(err.message) ? 404 : 500;
    return res.status(status).json({ error: err.message });
  } finally {
    lease?.release();
  }
});

router.get('/inference/progress/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  if (hasActiveInferenceSession(sessionId) || sseManager.hasPreparedSession(sessionId)) {
    sseManager.addClient(sessionId, res);
    return;
  }
  sseManager.addSharedClient(sessionId, res);
});

router.post('/inference/cancel', async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  let cancelled;
  try {
    cancelled = await requestSessionCancellation(sessionId);
  } catch {
    // S3 is best-effort for a local single-target deployment.
    cancelled = cancelSession(sessionId);
  }
  // Always drive state terminal so a stale non-terminal state can be cleared,
  // even if the session already ended (no active session left to signal).
  if (['waiting', 'generating'].includes(inferenceState.getState().status)) {
    inferenceState.setError('Generation cancelled by user', 'cancelled');
  }
  res.json({ cancelled });
});

router.get('/inference/current', (_req, res) => {
  res.json(inferenceState.getState());
});

export default router;
