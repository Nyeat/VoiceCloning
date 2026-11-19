import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  shortenFirstFastPhrase,
  splitLiveReplyChunks,
} from '../client/src/hooks/liveConversation.js';

const requireFromGateway = createRequire(
  new URL('../live-gateway/package.json', import.meta.url),
);
const WebSocket = requireFromGateway('ws');

const concurrency = Number.parseInt(process.argv[2] || '1', 10);
const wsUrl = process.env.VCS_CHATBOT_WS_URL
  || 'wss://d25sg72wp8oj5g.cloudfront.net/api/live/chat/realtime?language=en';
const ttsUrl = process.env.VCS_CHATBOT_TTS_URL
  || 'https://d25sg72wp8oj5g.cloudfront.net/api/live/tts-sentence';
const origin = process.env.VCS_CHATBOT_ORIGIN
  || 'https://d25sg72wp8oj5g.cloudfront.net';
const fixedAudioPath = process.env.VCS_CHATBOT_AUDIO_WAV || '';
const QUESTION_POOL = [
  'What is gastrointestinal bleeding?',
  'How should I prepare for a gastroscopy?',
  'What are the warning signs of internal bleeding that I should watch for?',
  'How long does the endoscopy procedure usually take?',
  'Can you explain what happens after the doctor finds the source of the bleeding?',
];
const timeoutMs = Number.parseInt(process.env.VCS_CHATBOT_TIMEOUT_MS || '180000', 10);
const keepAliveIntervalMs = 15_000;
const audioFrameMs = Number.parseInt(process.env.VCS_CHATBOT_AUDIO_FRAME_MS || '100', 10);
const turnCount = Number.parseInt(process.env.VCS_CHATBOT_TURNS || '1', 10);
const fixedThinkMs = process.env.VCS_CHATBOT_THINK_MS
  ? Number.parseInt(process.env.VCS_CHATBOT_THINK_MS, 10)
  : null;
const thinkMsMin = fixedThinkMs
  ?? Number.parseInt(process.env.VCS_CHATBOT_THINK_MS_MIN || '2000', 10);
const thinkMsMax = fixedThinkMs
  ?? Number.parseInt(process.env.VCS_CHATBOT_THINK_MS_MAX || '6000', 10);
const rampSeconds = Number.parseInt(process.env.VCS_CHATBOT_RAMP_SECONDS || '0', 10);
const paceAudio = process.env.VCS_CHATBOT_PACE_AUDIO !== 'false';
const pacePlayback = process.env.VCS_CHATBOT_PACE_PLAYBACK !== 'false';
const prefetchLeadMs = Number.parseInt(process.env.VCS_CHATBOT_PREFETCH_LEAD_MS || '750', 10);
const bucketMs = Number.parseInt(process.env.VCS_CHATBOT_BUCKET_MS || '15000', 10);
const sloFirstVoiceP95Ms = Number.parseInt(
  process.env.VCS_CHATBOT_SLO_FIRST_VOICE_P95_MS || '0',
  10,
);
const sloErrorRate = Number.parseFloat(process.env.VCS_CHATBOT_SLO_ERROR_RATE || '0');
const PCM_BYTES_PER_SECOND = 24_000 * 2;
const MAX_PLAYBACK_PACE_MS = 30_000;
const PLAYBACK_TIMEOUT_ALLOWANCE_MS = pacePlayback ? 90_000 : 0;
const manualCommit = process.env.VCS_CHATBOT_MANUAL_COMMIT === 'true';
const voiceProfileId = process.env.VCS_CHATBOT_VOICE_PROFILE_ID || 'deanvoice-v1';
const reportFile = process.env.VCS_CHATBOT_REPORT_FILE || '';
const skipFirstVerify = process.env.VCS_CHATBOT_SKIP_FIRST_VERIFY === 'true';
const firstChunkOnly = process.env.VCS_CHATBOT_FIRST_CHUNK_ONLY === 'true';
const pinVoiceSnapshot = process.env.VCS_CHATBOT_PIN_VOICE_SNAPSHOT !== 'false';
// Matches LIVE_AUTH_LOADTEST_SECRET on the gateway. Load tests have no
// interactive sign-in, so this is how they get past the auth gate once
// LIVE_AUTH_ENABLED is on. Safe to set before then: a gateway with auth off
// ignores the frame.
const loadTestAuthSecret = process.env.VCS_CHATBOT_LOADTEST_SECRET || '';

if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 200) {
  throw new Error('Concurrency must be an integer from 1 to 200.');
}
if (!Number.isInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 600_000) {
  throw new Error('VCS_CHATBOT_TIMEOUT_MS must be from 10000 to 600000.');
}
if (!Number.isInteger(audioFrameMs) || audioFrameMs < 20 || audioFrameMs > 1000) {
  throw new Error('VCS_CHATBOT_AUDIO_FRAME_MS must be from 20 to 1000.');
}
if (!Number.isInteger(turnCount) || turnCount < 1 || turnCount > 10) {
  throw new Error('VCS_CHATBOT_TURNS must be from 1 to 10.');
}
if (!Number.isInteger(thinkMsMin) || !Number.isInteger(thinkMsMax)
  || thinkMsMin < 0 || thinkMsMax < thinkMsMin || thinkMsMax > 60_000) {
  throw new Error('Think time bounds must satisfy 0 <= min <= max <= 60000.');
}
if (!Number.isInteger(rampSeconds) || rampSeconds < 0 || rampSeconds > 3600) {
  throw new Error('VCS_CHATBOT_RAMP_SECONDS must be from 0 to 3600.');
}
if (!Number.isInteger(prefetchLeadMs) || prefetchLeadMs < 0 || prefetchLeadMs > 10_000) {
  throw new Error('VCS_CHATBOT_PREFETCH_LEAD_MS must be from 0 to 10000.');
}
if (!Number.isInteger(bucketMs) || bucketMs < 1000 || bucketMs > 300_000) {
  throw new Error('VCS_CHATBOT_BUCKET_MS must be from 1000 to 300000.');
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return {
    min: sorted.length ? Math.round(sorted[0]) : null,
    p50: percentile(sorted, 0.50) == null ? null : Math.round(percentile(sorted, 0.50)),
    p95: percentile(sorted, 0.95) == null ? null : Math.round(percentile(sorted, 0.95)),
    p99: percentile(sorted, 0.99) == null ? null : Math.round(percentile(sorted, 0.99)),
    max: sorted.length ? Math.round(sorted.at(-1)) : null,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function ensureLoadTestAudio(pathOrUrl, questionText) {
  const path = pathOrUrl instanceof URL ? fileURLToPath(pathOrUrl) : pathOrUrl;
  if (existsSync(path)) return;
  if (process.platform !== 'win32') {
    throw new Error(
      `Load-test audio does not exist at ${path}. Set VCS_CHATBOT_AUDIO_WAV to `
      + 'a PCM 24000 Hz 16-bit mono WAV containing a spoken question.',
    );
  }

  mkdirSync(dirname(path), { recursive: true });
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      [
        'Add-Type -AssemblyName System.Speech',
        '$format = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(',
        '  24000,',
        '  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,',
        '  [System.Speech.AudioFormat.AudioChannel]::Mono',
        ')',
        '$synth = [System.Speech.Synthesis.SpeechSynthesizer]::new()',
        'try {',
        '  $synth.SetOutputToWaveFile($env:VCS_CHATBOT_GENERATED_WAV, $format)',
        '  $synth.Speak($env:VCS_CHATBOT_GENERATED_TEXT)',
        '} finally {',
        '  $synth.Dispose()',
        '}',
      ].join('\n'),
    ],
    {
      env: {
        ...process.env,
        VCS_CHATBOT_GENERATED_WAV: path,
        VCS_CHATBOT_GENERATED_TEXT: questionText,
      },
    },
  );
}

function buildAudioPool() {
  if (fixedAudioPath) {
    return [readPcmWav(fixedAudioPath)];
  }
  return QUESTION_POOL.map((questionText, index) => {
    const path = fileURLToPath(
      new URL(`../.tmp/chatbot-load-question-${index + 1}.wav`, import.meta.url),
    );
    ensureLoadTestAudio(path, questionText);
    return readPcmWav(path);
  });
}

function readPcmWav(pathOrUrl) {
  const wav = readFileSync(pathOrUrl);
  if (wav.subarray(0, 4).toString('ascii') !== 'RIFF'
    || wav.subarray(8, 12).toString('ascii') !== 'WAVE') {
    throw new Error('Load-test audio must be a RIFF/WAVE file.');
  }

  let format = null;
  let pcm = null;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const id = wav.subarray(offset, offset + 4).toString('ascii');
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > wav.length) break;
    if (id === 'fmt ') {
      format = {
        audioFormat: wav.readUInt16LE(start),
        channels: wav.readUInt16LE(start + 2),
        sampleRate: wav.readUInt32LE(start + 4),
        blockAlign: wav.readUInt16LE(start + 12),
        bitsPerSample: wav.readUInt16LE(start + 14),
      };
    } else if (id === 'data') {
      pcm = wav.subarray(start, end);
    }
    offset = end + (size % 2);
  }

  if (!format || !pcm) throw new Error('Load-test WAV is missing fmt or data.');
  if (format.audioFormat !== 1
    || format.channels !== 1
    || format.sampleRate !== 24_000
    || format.bitsPerSample !== 16) {
    throw new Error(
      `Expected PCM 24000 Hz 16-bit mono; received format=${format.audioFormat}, `
      + `channels=${format.channels}, rate=${format.sampleRate}, bits=${format.bitsPerSample}.`,
    );
  }
  return { ...format, pcm };
}

function loadProductionSystemPrompt() {
  if (process.env.VCS_CHATBOT_SYSTEM_PROMPT_FILE) {
    return readFileSync(process.env.VCS_CHATBOT_SYSTEM_PROMPT_FILE, 'utf8').trim();
  }
  const source = execFileSync(
    'git',
    ['show', 'staging-chatbot:client/src/lib/chatbotSystemPrompt.js'],
    { encoding: 'utf8' },
  );
  const match = source.match(/DEFAULT_CHATBOT_SYSTEM_PROMPT\s*=\s*`([\s\S]*?)`;/u);
  if (!match) throw new Error('Could not extract the staging chatbot system prompt.');
  return match[1].trim();
}

function markerFor(index) {
  return `Load test user ${String(index + 1).padStart(3, '0')}`;
}

const SMALL_NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];
const TENS_NUMBER_WORDS = [
  '', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
];

function numberWords(value) {
  if (value < 20) return SMALL_NUMBER_WORDS[value];
  if (value < 100) {
    return `${TENS_NUMBER_WORDS[Math.floor(value / 10)]} ${SMALL_NUMBER_WORDS[value % 10]}`
      .replace(/\s+zero$/u, '');
  }
  if (value < 200) {
    return `one hundred ${numberWords(value - 100)}`.replace(/\s+zero$/u, '');
  }
  return String(value);
}

function containsUserMarker(text, userNumber) {
  const words = numberWords(userNumber).replace(/\s+/gu, '\\s+');
  return new RegExp(
    `\\bload\\s+test\\s+user\\s+(?:0*${userNumber}|${words})\\b`,
    'iu',
  ).test(text);
}

function makeSession(index, audioPool, productionPrompt, synthesisProfile) {
  const marker = markerFor(index);
  const createdAt = performance.now();
  const ready = deferred();
  const result = deferred();
  let settled = false;
  let started = false;
  let turnIndex = -1;
  let connectedAt = null;
  let readyAt = null;
  let currentTurn = null;
  let keepAliveTimer = null;
  let keepAliveSent = 0;
  const completedTurns = [];

  const socket = new WebSocket(wsUrl, {
    headers: { Origin: origin },
    handshakeTimeout: Math.min(timeoutMs, 30_000),
  });

  const finish = (payload) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    ready.resolve(false);
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(1000, 'Load-test session complete');
    }
    result.resolve({
      user: index + 1,
      marker,
      keepAliveSent,
      turns: completedTurns,
      ...payload,
    });
  };

  const fail = (error) => finish({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });

  const sessionBudgetMs = (timeoutMs + PLAYBACK_TIMEOUT_ALLOWANCE_MS) * turnCount;
  const timer = setTimeout(
    () => fail(new Error(`Session timed out after ${sessionBudgetMs} ms`)),
    sessionBudgetMs,
  );

  socket.on('open', () => {
    connectedAt = performance.now();
    if (loadTestAuthSecret) {
      // Must be the first frame; the gateway queues whatever follows while it
      // verifies, so there is no need to wait for session.authenticated.
      socket.send(JSON.stringify({
        type: 'session.auth',
        loadTestSecret: loadTestAuthSecret,
        loadTestUser: index,
      }));
    }
    const systemPrompt = `${productionPrompt}

# Controlled staging load-test instruction
Reply to every question in exactly one short sentence of no more than 24 words.
Begin that sentence exactly with "${marker}."`;
    socket.send(JSON.stringify({
      type: 'session.init',
      systemPrompt,
    }));
    keepAliveTimer = setInterval(() => {
      if (!settled && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'keepalive' }));
        keepAliveSent += 1;
      }
    }, keepAliveIntervalMs);
  });

  socket.on('message', async (raw) => {
    if (settled) return;
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      fail(new Error('Gateway returned invalid JSON.'));
      return;
    }

    if (message.type === 'session.ready') {
      readyAt = performance.now();
      ready.resolve(true);
      return;
    }
    if (message.type === 'user.text.done') {
      if (!currentTurn) return;
      currentTurn.transcript = String(message.text || '');
      currentTurn.transcriptAt = performance.now();
      return;
    }
    if (message.type === 'assistant.text.delta' && currentTurn?.assistantFirstTokenAt == null) {
      currentTurn.assistantFirstTokenAt = performance.now();
      return;
    }
    if (message.type === 'assistant.text.done') {
      if (!currentTurn || currentTurn.processingAssistant) return;
      currentTurn.processingAssistant = true;
      currentTurn.assistantDoneAt = performance.now();
      currentTurn.assistantText = String(message.text || '').trim();
      try {
        const chunks = shortenFirstFastPhrase(
          splitLiveReplyChunks(currentTurn.assistantText),
        );
        if (chunks.length === 0) throw new Error('Assistant response contained no speakable text.');
        const requestedChunks = firstChunkOnly ? chunks.slice(0, 1) : chunks;
        const ttsStartedAt = performance.now();
        const chunkResults = [];
        let playbackEndsAt = null;
        for (let chunkIndex = 0; chunkIndex < requestedChunks.length; chunkIndex += 1) {
          if (pacePlayback && chunkIndex > 0 && playbackEndsAt != null) {
            const waitMs = playbackEndsAt - prefetchLeadMs - performance.now();
            if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
          }
          const chunkStartedAt = performance.now();
          const requestBody = JSON.stringify({
            ...synthesisProfile,
            text: requestedChunks[chunkIndex],
            ...(chunkIndex === 0 && skipFirstVerify ? { skip_verify: true } : {}),
          });
          const response = await fetch(
            `${ttsUrl}?chatbotLoadTest=${Date.now()}-${index}-${turnIndex}-${chunkIndex}`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache',
                // CloudFront signs the Lambda URL origin (AWS_IAM) and needs the body hash.
                'x-amz-content-sha256': createHash('sha256').update(requestBody).digest('hex'),
                ...(loadTestAuthSecret
                  ? { Authorization: `Bearer ${loadTestAuthSecret}` }
                  : {}),
              },
              body: requestBody,
              signal: AbortSignal.timeout(timeoutMs),
            },
          );
          const responseHeadersAt = performance.now();
          const audioResponse = Buffer.from(await response.arrayBuffer());
          const chunkDoneAt = performance.now();
          if (chunkIndex === 0) currentTurn.firstVoiceAt = chunkDoneAt;
          const chunkPlaybackMs = Math.min(
            MAX_PLAYBACK_PACE_MS,
            (audioResponse.length / PCM_BYTES_PER_SECOND) * 1000,
          );
          playbackEndsAt = Math.max(playbackEndsAt ?? chunkDoneAt, chunkDoneAt) + chunkPlaybackMs;
          const numericHeader = (name) => {
            const rawValue = response.headers.get(name);
            if (rawValue == null || rawValue.trim() === '') return null;
            const value = Number(rawValue);
            return Number.isFinite(value) ? value : null;
          };
          chunkResults.push({
            index: chunkIndex + 1,
            status: response.status,
            bytes: audioResponse.length,
            latencyMs: chunkDoneAt - chunkStartedAt,
            requestToHeadersMs: responseHeadersAt - chunkStartedAt,
            bodyTransferMs: chunkDoneAt - responseHeadersAt,
            backendTimingMs: {
              profileResolve: numericHeader('x-vcs-profile-resolve-ms'),
              workerRoundTrip: numericHeader('x-vcs-worker-round-trip-ms'),
              lambdaTotal: numericHeader('x-vcs-lambda-total-ms'),
              gpuQueueWait: numericHeader('x-vcs-gpu-queue-wait-ms'),
              capacityRetryCount: numericHeader('x-vcs-capacity-retry-count'),
              capacityRetrySleep: numericHeader('x-vcs-capacity-retry-sleep-ms'),
            },
            lambdaColdStart: response.headers.get('x-vcs-lambda-cold-start') === '1',
            lambdaEnvironmentId: response.headers.get('x-vcs-lambda-environment-id'),
            lambdaRequestId: response.headers.get('x-vcs-lambda-request-id'),
            ok: response.ok
              && response.headers.get('content-type')?.startsWith('audio/wav')
              && audioResponse.subarray(0, 4).toString('ascii') === 'RIFF',
          });
          if (!chunkResults.at(-1).ok) break;
        }
        const ttsDoneAt = performance.now();
        const ownMarker = containsUserMarker(currentTurn.assistantText, index + 1);
        const foreignMarkers = Array.from(
          { length: concurrency },
          (_, markerIndex) => markerIndex + 1,
        ).filter(
          (value) => value !== index + 1
            && containsUserMarker(currentTurn.assistantText, value),
        );
        const validWavs = chunkResults.length === requestedChunks.length
          && chunkResults.every((chunk) => chunk.ok);

        const turnResult = {
          turn: turnIndex + 1,
          atSec: Math.round((ttsDoneAt - wallStartedAt) / 1000),
          ok: validWavs && foreignMarkers.length === 0,
          transcript: currentTurn.transcript || '',
          responseWords: currentTurn.assistantText.split(/\s+/u).filter(Boolean).length,
          responseChunks: chunks.length,
          requestedChunks: requestedChunks.length,
          ownMarker,
          foreignMarkers,
          ttsStatus: chunkResults.map((chunk) => chunk.status),
          ttsBytes: chunkResults.reduce((sum, chunk) => sum + chunk.bytes, 0),
          chunkLatencyMs: chunkResults.map((chunk) => Math.round(chunk.latencyMs)),
          chunkRequestToHeadersMs: chunkResults.map((chunk) => Math.round(chunk.requestToHeadersMs)),
          chunkBodyTransferMs: chunkResults.map((chunk) => Math.round(chunk.bodyTransferMs)),
          chunkBackendTimingMs: chunkResults.map((chunk) => chunk.backendTimingMs),
          chunkLambdaColdStart: chunkResults.map((chunk) => chunk.lambdaColdStart),
          chunkLambdaEnvironmentId: chunkResults.map((chunk) => chunk.lambdaEnvironmentId),
          chunkLambdaRequestId: chunkResults.map((chunk) => chunk.lambdaRequestId),
          timingsMs: {
            speechToTranscript: currentTurn.transcriptAt == null
              || currentTurn.speechEndedAt == null
              ? null
              : currentTurn.transcriptAt - currentTurn.speechEndedAt,
            speechToFirstToken: currentTurn.assistantFirstTokenAt == null
              || currentTurn.speechEndedAt == null
              ? null
              : currentTurn.assistantFirstTokenAt - currentTurn.speechEndedAt,
            speechToTextDone: currentTurn.speechEndedAt == null
              ? null
              : currentTurn.assistantDoneAt - currentTurn.speechEndedAt,
            timeToFirstVoice: currentTurn.firstVoiceAt == null
              || currentTurn.inputStartedAt == null
              ? null
              : currentTurn.firstVoiceAt - currentTurn.inputStartedAt,
            speechToFirstVoice: currentTurn.firstVoiceAt == null
              || currentTurn.speechEndedAt == null
              ? null
              : currentTurn.firstVoiceAt - currentTurn.speechEndedAt,
            voiceSynthesis: ttsDoneAt - ttsStartedAt,
            endToEnd: currentTurn.inputStartedAt == null
              ? null
              : ttsDoneAt - currentTurn.inputStartedAt,
          },
          responseSample: currentTurn.assistantText.slice(0, 240),
        };
        completedTurns.push(turnResult);
        if (!turnResult.ok) {
          finish({ ok: false, error: `Turn ${turnIndex + 1} voice generation failed.` });
        } else if (completedTurns.length === turnCount) {
          finish({
            ok: true,
            connectMs: Math.round(connectedAt - createdAt),
            sessionReadyMs: Math.round(readyAt - createdAt),
          });
        } else {
          const pauseMs = thinkMsMin + Math.random() * (thinkMsMax - thinkMsMin);
          await new Promise((resolve) => setTimeout(resolve, pauseMs));
          await startNextTurn();
        }
      } catch (error) {
        fail(error);
      }
      return;
    }
    if (message.type === 'error') {
      fail(new Error(message.message || message.code || 'Gateway error'));
    }
  });

  socket.on('error', (error) => fail(error));
  socket.on('close', (code, reason) => {
    if (!settled) fail(new Error(`WebSocket closed (${code}): ${reason.toString()}`));
  });

  async function startNextTurn() {
    if (settled) return;
    turnIndex += 1;
    const audio = audioPool[Math.floor(Math.random() * audioPool.length)];
    currentTurn = {
      inputStartedAt: performance.now(),
      assistantFirstTokenAt: null,
      assistantText: '',
      transcript: '',
      processingAssistant: false,
    };
    const frameBytes = Math.max(
      audio.blockAlign,
      Math.floor((audio.sampleRate * audio.blockAlign * audioFrameMs) / 1000),
    );
    const trailingSilence = Buffer.alloc(
      Math.round(audio.sampleRate * audio.blockAlign * 0.36),
    );
    const sendPcm = async (payload) => {
      for (let offset = 0; offset < payload.length; offset += frameBytes) {
        if (settled) return false;
        const frame = payload.subarray(offset, Math.min(payload.length, offset + frameBytes));
        socket.send(JSON.stringify({
          type: 'audio.chunk',
          audio: frame.toString('base64'),
        }));
        if (paceAudio) {
          const frameDurationMs = (frame.length / audio.blockAlign / audio.sampleRate) * 1000;
          await new Promise((resolve) => setTimeout(resolve, frameDurationMs));
        }
      }
      return true;
    };
    if (!await sendPcm(audio.pcm)) return;
    currentTurn.speechEndedAt = performance.now();
    if (!await sendPcm(trailingSilence)) return;
    currentTurn.inputCommittedAt = performance.now();
    if (manualCommit) {
      socket.send(JSON.stringify({ type: 'input.commit' }));
    }
  }

  async function start() {
    if (settled || started) return;
    started = true;
    await startNextTurn();
  }

  return {
    ready: ready.promise,
    result: result.promise,
    start,
  };
}

function synthesisSnapshotFromProfile(profile) {
  const profileId = String(profile?.voiceProfileId || '').trim();
  const gptRef = String(profile?.gptKey || profile?.gptPath || '').trim();
  const sovitsRef = String(profile?.sovitsKey || profile?.sovitsPath || '').trim();
  const refAudioPath = String(profile?.ref_audio_path || '').trim();
  if (!profileId || !gptRef || !sovitsRef || !refAudioPath) {
    throw new Error('Active voice profile is missing its id, model refs, or reference audio.');
  }
  if (voiceProfileId && profileId !== voiceProfileId) {
    throw new Error(`Expected active voice profile ${voiceProfileId}; received ${profileId}.`);
  }

  const defaults = profile.defaults || {};
  return {
    voiceProfileId: profileId,
    ref_audio_path: refAudioPath,
    prompt_text: String(profile.prompt_text || ''),
    prompt_lang: String(profile.prompt_lang || 'en'),
    text_lang: String(profile.text_lang || profile.prompt_lang || 'en'),
    aux_ref_audio_paths: Array.isArray(profile.aux_ref_audio_paths)
      ? profile.aux_ref_audio_paths.filter(Boolean).slice(0, 5)
      : [],
    voice_model: {
      voiceProfileId: profileId,
      gptRef,
      sovitsRef,
      revision: String(profile.updatedAt || profile.revision || profile.activatedAt || ''),
    },
    speed_factor: Number(defaults.speed ?? defaults.speed_factor ?? 1),
    top_k: Number(defaults.topK ?? defaults.top_k ?? 5),
    top_p: Number(defaults.topP ?? defaults.top_p ?? 0.85),
    temperature: Number(defaults.temperature ?? 0.7),
    repetition_penalty: Number(defaults.repPenalty ?? defaults.repetition_penalty ?? 1.35),
  };
}

async function loadSynthesisProfile(index) {
  if (!pinVoiceSnapshot) return { voiceProfileId };
  const profileUrl = new URL('/api/voice-profile/active', ttsUrl);
  profileUrl.searchParams.set('full', '1');
  profileUrl.searchParams.set('chatbotProfileWarmup', `${Date.now()}-${index}`);
  const response = await fetch(profileUrl, {
    headers: { 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Active voice profile warmup failed (${response.status}).`);
  }
  return synthesisSnapshotFromProfile(await response.json());
}

const audioPool = buildAudioPool();
const productionPrompt = loadProductionSystemPrompt();
const profileWarmupStartedAt = performance.now();
const synthesisProfiles = await Promise.all(
  Array.from({ length: concurrency }, (_, index) => loadSynthesisProfile(index)),
);
const profileWarmupMs = performance.now() - profileWarmupStartedAt;
const startedAt = new Date().toISOString();
const wallStartedAt = performance.now();
const readyStates = new Array(concurrency).fill(false);
let results;
if (rampSeconds > 0) {
  // Staggered joins: each virtual user connects at an evenly spaced, jittered
  // offset across the ramp window and starts speaking as soon as its own
  // session is ready — no global barrier, like a real crowd arriving.
  const spacingMs = (rampSeconds * 1000) / concurrency;
  results = await Promise.all(
    Array.from({ length: concurrency }, async (_, index) => {
      const joinDelayMs = index * spacingMs + Math.random() * spacingMs;
      await new Promise((resolve) => setTimeout(resolve, joinDelayMs));
      const session = makeSession(index, audioPool, productionPrompt, synthesisProfiles[index]);
      readyStates[index] = await session.ready;
      if (readyStates[index]) await session.start();
      return session.result;
    }),
  );
} else {
  // Legacy barrier mode: connect everyone, wait for all sessions to be ready,
  // then start every turn at once (deliberate connection-storm test).
  const sessions = Array.from(
    { length: concurrency },
    (_, index) => makeSession(index, audioPool, productionPrompt, synthesisProfiles[index]),
  );
  const states = await Promise.all(sessions.map((session) => session.ready));
  states.forEach((state, index) => { readyStates[index] = state; });
  await Promise.all(
    sessions.map((session, index) => (readyStates[index] ? session.start() : undefined)),
  );
  results = await Promise.all(sessions.map((session) => session.result));
}
const readyCount = readyStates.filter(Boolean).length;
const wallMs = performance.now() - wallStartedAt;
const finishedAt = new Date().toISOString();
const successful = results.filter((item) => item.ok);
const failures = results.filter((item) => !item.ok);

const turnSummaries = Array.from({ length: turnCount }, (_, index) => {
  const turnResults = results
    .map((item) => item.turns?.[index])
    .filter(Boolean);
  const metric = (name) => summarize(
    turnResults.map((item) => item.timingsMs?.[name]).filter(Number.isFinite),
  );
  return {
    turn: index + 1,
    completed: turnResults.filter((item) => item.ok).length,
    failed: concurrency - turnResults.filter((item) => item.ok).length,
    responseWords: summarize(turnResults.map((item) => item.responseWords)),
    responseChunks: summarize(turnResults.map((item) => item.responseChunks)),
    latencyMs: {
      speechToTranscript: metric('speechToTranscript'),
      speechToFirstToken: metric('speechToFirstToken'),
      speechToTextDone: metric('speechToTextDone'),
      timeToFirstVoice: metric('timeToFirstVoice'),
      speechToFirstVoice: metric('speechToFirstVoice'),
      firstVoiceChunk: summarize(
        turnResults.map((item) => item.chunkLatencyMs?.[0]).filter(Number.isFinite),
      ),
      firstVoiceRequestToHeaders: summarize(
        turnResults.map((item) => item.chunkRequestToHeadersMs?.[0]).filter(Number.isFinite),
      ),
      firstVoiceBodyTransfer: summarize(
        turnResults.map((item) => item.chunkBodyTransferMs?.[0]).filter(Number.isFinite),
      ),
      firstVoiceProfileResolve: summarize(
        turnResults
          .map((item) => item.chunkBackendTimingMs?.[0]?.profileResolve)
          .filter(Number.isFinite),
      ),
      firstVoiceWorkerRoundTrip: summarize(
        turnResults
          .map((item) => item.chunkBackendTimingMs?.[0]?.workerRoundTrip)
          .filter(Number.isFinite),
      ),
      firstVoiceLambdaTotal: summarize(
        turnResults
          .map((item) => item.chunkBackendTimingMs?.[0]?.lambdaTotal)
          .filter(Number.isFinite),
      ),
      firstVoiceGpuQueueWait: summarize(
        turnResults
          .map((item) => item.chunkBackendTimingMs?.[0]?.gpuQueueWait)
          .filter(Number.isFinite),
      ),
      firstVoiceCapacityRetryCount: summarize(
        turnResults
          .map((item) => item.chunkBackendTimingMs?.[0]?.capacityRetryCount)
          .filter(Number.isFinite),
      ),
      firstVoiceCapacityRetrySleep: summarize(
        turnResults
          .map((item) => item.chunkBackendTimingMs?.[0]?.capacityRetrySleep)
          .filter(Number.isFinite),
      ),
      voiceSynthesis: metric('voiceSynthesis'),
      endToEnd: metric('endToEnd'),
    },
    lambdaColdStarts: turnResults.filter((item) => item.chunkLambdaColdStart?.[0]).length,
    lambdaEnvironments: new Set(
      turnResults.map((item) => item.chunkLambdaEnvironmentId?.[0]).filter(Boolean),
    ).size,
  };
});

const allTurns = results.flatMap((item) => item.turns ?? []);
const bucketCount = Math.max(1, Math.ceil(wallMs / bucketMs));
const timeline = Array.from({ length: bucketCount }, (_, index) => {
  const bucketTurns = allTurns.filter(
    (turn) => Number.isFinite(turn.atSec)
      && turn.atSec * 1000 >= index * bucketMs
      && (turn.atSec * 1000 < (index + 1) * bucketMs || index === bucketCount - 1),
  );
  return {
    bucket: index + 1,
    fromSec: Math.round((index * bucketMs) / 1000),
    toSec: Math.round(Math.min(wallMs, (index + 1) * bucketMs) / 1000),
    turnsCompleted: bucketTurns.filter((turn) => turn.ok).length,
    turnsFailed: bucketTurns.filter((turn) => !turn.ok).length,
    speechToFirstVoiceMs: summarize(
      bucketTurns.map((turn) => turn.timingsMs?.speechToFirstVoice).filter(Number.isFinite),
    ),
    lambdaColdStarts: bucketTurns.filter((turn) => turn.chunkLambdaColdStart?.[0]).length,
  };
});

const firstVoiceOverall = summarize(
  allTurns.map((turn) => turn.timingsMs?.speechToFirstVoice).filter(Number.isFinite),
);
const turnErrorRate = allTurns.length === 0
  ? 1
  : allTurns.filter((turn) => !turn.ok).length / allTurns.length;
const slo = {};
if (sloFirstVoiceP95Ms > 0) {
  slo.speechToFirstVoiceP95Ms = {
    threshold: sloFirstVoiceP95Ms,
    actual: firstVoiceOverall.p95,
    pass: firstVoiceOverall.p95 != null && firstVoiceOverall.p95 <= sloFirstVoiceP95Ms,
  };
}
if (sloErrorRate > 0) {
  slo.turnErrorRate = {
    threshold: sloErrorRate,
    actual: Number(turnErrorRate.toFixed(4)),
    pass: turnErrorRate <= sloErrorRate,
  };
}
const sloChecks = Object.values(slo);
const sloPass = sloChecks.length === 0 ? null : sloChecks.every((check) => check.pass);
if (sloPass === false) process.exitCode = 1;

const report = {
  wsUrl,
  ttsUrl,
  startedAt,
  finishedAt,
  concurrency,
  turnCount,
  rampSeconds,
  thinkMs: { min: thinkMsMin, max: thinkMsMax },
  pacePlayback,
  prefetchLeadMs,
  audioPoolSize: audioPool.length,
  keepAliveIntervalMs,
  keepAliveMessagesSent: results.reduce(
    (sum, item) => sum + (Number.isInteger(item.keepAliveSent) ? item.keepAliveSent : 0),
    0,
  ),
  skipFirstVerify,
  firstChunkOnly,
  pinVoiceSnapshot,
  profileWarmupMs: Math.round(profileWarmupMs),
  ready: readyCount,
  success: successful.length,
  failed: failures.length,
  wallMs: Math.round(wallMs),
  turnSummaries,
  timeline,
  ...(sloPass == null ? {} : { slo: { pass: sloPass, ...slo } }),
  isolation: {
    ownMarker: results.filter((item) => item.ownMarker).length,
    foreignMarker: results.filter((item) => item.foreignMarkers?.length > 0).length,
  },
  responseSamples: successful.slice(0, 3).map((item) => ({
    user: item.user,
    transcript: item.turns?.[0]?.transcript,
    response: item.turns?.[0]?.responseSample,
  })),
  sessions: results,
};
if (reportFile) {
  mkdirSync(dirname(reportFile), { recursive: true });
  writeFileSync(reportFile, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({
  ...report,
  ...(reportFile ? { reportFile, sessions: undefined } : {}),
}, null, 2));
