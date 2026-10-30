import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { inferenceServer } from './inferenceServer.js';
import { sseManager } from './sseManager.js';
import { inferenceState } from './inferenceState.js';
import { LOCAL_TEMP_ROOT, COMMA_PAUSE_SECONDS, COMMA_PAUSE_MS, FULL_MAX_CHUNK_LENGTH } from '../config.js';
import { getObject, headObject, listObjects, uploadBuffer } from './s3Storage.js';
import { prepareTextForFullSynthesis } from './textPronunciation.js';
import {
  splitOnBreaks,
  appendBreakSentinel,
  extractBreakMs,
  stripBreakSentinels,
  renderBreakSentinels,
  BREAK_SENTINEL_RE,
  partitionBreaks,
} from './ssml.js';

const TEMP_DIR = LOCAL_TEMP_ROOT;

// Track active streaming sessions for cancellation
const activeSessions = new Map(); // sessionId -> { cancelled: boolean }

const DEFAULTS = {
  maxChunkLength: 280,
  maxSentencesPerChunk: 3,
  // 0 = seamless natural join. Live Fast sounds better than Full not because of
  // sampling (they match) but because Fast plays its phrase clips back-to-back with
  // each clip's NATURAL trailing decay intact, inserting no synthetic silence. Full
  // used to trim that natural tail and splice a fixed synthetic pause at every chunk
  // seam, which reads as mechanical. With base pause 0, concatWavs skips the
  // trim+silence+fade branches (all gated on gap>0) and concatenates chunks
  // byte-for-byte with their natural tails — identical in spirit to Fast's playback.
  // The model's own sentence-final decay governs the gap. The punctuation-scaled
  // pause machinery still exists and re-activates for any caller that passes a
  // non-zero base, so nothing is lost — this only changes the default.
  chunkJoinPauseMs: 0,
  retryCount: 2,
};

// Mirror the Live Fast sampling settings: in real GPU tests Live Fast (top_k 5,
// temperature 0.7) pronounced hard medical words cleanly while this path's hotter
// sampling (top_k 15) destabilized on the same words. Higher top_k samples from 3×
// more candidate tokens, which is what let the model wander into "central" /
// "Tools and Tools" on short isolated chunks. Match Live Fast so Full Inference is
// at least as stable as the path the user confirmed works.
const FULL_QUALITY_PRESET = {
  top_k: 5,
  top_p: 0.85,
  temperature: 0.7,
  repetition_penalty: 1.35,
  speed_factor: 1.0,
};

const FULL_QUALITY_OPTIONS = {
  // Keep each take to at most two normal sentences. Real-user testing found one- or
  // two-sentence requests materially more faithful than a whole script; the character
  // cap remains the primary guard, while this ceiling preserves useful neighbouring
  // context without allowing many tiny sentences to accumulate into one drifting take.
  // Sentences longer than maxChunkLength still use the guarded splitter below.
  maxChunkLength: FULL_MAX_CHUNK_LENGTH,
  maxSentencesPerChunk: 2,
  // Seamless natural join — match Live Fast, which inserts no synthetic silence and
  // keeps each clip's natural tail. See DEFAULTS.chunkJoinPauseMs for the full why.
  chunkJoinPauseMs: 0,
  // Adaptive voice-faithful tournament: rank the first three takes and stop when at
  // least one passes; only stubborn text expands to five total takes. Live Fast uses
  // a separate path and is unchanged.
  retryCount: 4,
  initialTakeCount: 3,
  selectBestVerifiedCandidate: true,
  isolateRiskySentences: true,
  // After whole-chunk and sentence-level 3→5 recovery, keep the strongest audio-usable
  // full-sentence candidate rather than failing the entire user request.
  allowBestEffortFallback: true,
  outputGainDb: 0,
  // Default cut0-only (COMMA_PAUSE_MS=0). Timestamp-spliced comma breaths still glitch
  // in practice (drift lands the cut too close to speech), so the breath is opt-in via
  // COMMA_PAUSE_MS rather than on by default.
  commaPauseMs: COMMA_PAUSE_MS,
};

// Minimum length (chars) before a pause-worthy boundary is honoured. Prevents a
// short lead-in clause like "Typically," from being stranded as its own rushed
// 1-2 word chunk; it merges forward into the following clause instead.
const MIN_CHUNK_LENGTH = 24;
// A handful of very short sentences gives GPT-SoVITS too little context and can
// produce rushed or near-silent audio. When the configured sentence ceiling is
// reached below this total word count, permit exactly one neighbouring sentence.
const MIN_CONTEXT_WORDS = 8;
const SESSION_OPTION_KEYS = [
  'maxChunkLength',
  'maxChunkWords',
  'maxSentencesPerChunk',
  'chunkJoinPauseMs',
  'retryCount',
  'initialTakeCount',
  'selectBestVerifiedCandidate',
  'isolateRiskySentences',
  'allowBestEffortFallback',
  'commaPauseMs',
  'outputGainDb',
];

function clampNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function applyFullInferenceQualityPreset(params = {}) {
  return {
    ...FULL_QUALITY_PRESET,
    ...params,
  };
}

export function fullInferenceQualityOptions(overrides = {}) {
  return {
    ...FULL_QUALITY_OPTIONS,
    ...overrides,
  };
}

function normalizeWhitespace(text) {
  return prepareTextForFullSynthesis(text);
}

// Common multi-word phrases that should not be split across chunks
const SEMANTIC_UNITS = [
  'of the', 'in the', 'to the', 'for the', 'on the', 'at the', 'by the',
  'to a', 'of a', 'in a', 'for a', 'on a',
  'it is', 'that is', 'there is', 'this is', 'it was', 'that was', 'there was',
  'as well', 'such as', 'due to', 'in order', 'as a',
  'would be', 'could be', 'should be', 'will be', 'has been', 'have been',
  'do not', 'does not', 'did not', 'is not', 'was not', 'are not',
];

const NBSP = '\u00A0'; // non-breaking space used as internal sentinel

function protectSemanticUnits(text) {
  let result = text;
  for (const phrase of SEMANTIC_UNITS) {
    // Replace normal spaces within the phrase with NBSP (case-insensitive)
    const pattern = new RegExp(phrase.replace(/ /g, ' '), 'gi');
    result = result.replace(pattern, (match) => match.replace(/ /g, NBSP));
  }
  return result;
}

function restoreSemanticUnits(text) {
  return text.replace(/\u00A0/g, ' ');
}

function splitIntoSentences(text) {
  const normalized = normalizeWhitespace(String(text || ''));
  if (!normalized) return [];

  const sentences = normalized
    // Only terminal punctuation ends a sentence. Newlines are layout, not speech
    // boundaries, so headings and wrapped textarea lines stay with the prose that
    // follows. Colons, semicolons, and em dashes also remain inside the sentence.
    .replace(/\n+/gu, ' ')
    .split(/(?<=[.!?。！？…])\s+/u)
    .map(part => part.trim())
    .filter(Boolean);

  if (sentences.length > 0) return sentences;
  return [normalized];
}

function countChunkWords(text) {
  return String(text || '').match(/[\p{L}\p{N}']+/gu)?.length || 0;
}

function containsRiskySynthesisContent(sentence, options = {}) {
  if (!options.isolateRiskySentences) return false;
  const text = String(sentence || '').trim();
  if (!text || text.length < MIN_CHUNK_LENGTH) return false;

  const tokens = text.toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
  const clauseBreaks = (text.match(/[,;:—]/gu) || []).length;
  // A dictionary term inside a sentence is not itself a reason to discard useful
  // neighbouring context. With thousands of ARPAbet entries that rule reduced most
  // technical prose to one sentence per card. Dictionary protection is positional:
  // keepDictionaryWordsOffChunkTails handles a term only when it would actually land
  // at the risky decoder edge. Isolation remains for genuinely long/clause-dense text.
  return tokens.length >= 28 || clauseBreaks >= 3;
}

function wordLimitCutIndex(text, maxWords) {
  if (!(maxWords > 0)) return text.length;
  const matches = Array.from(text.matchAll(/[\p{L}\p{N}']+/gu));
  if (matches.length <= maxWords) return text.length;
  const last = matches[maxWords - 1];
  return last.index + last[0].length;
}

function splitLongSentence(sentence, maxChunkLength, maxChunkWords = 0) {
  if (sentence.length <= maxChunkLength && (!(maxChunkWords > 0) || countChunkWords(sentence) <= maxChunkWords)) return [sentence];

  // Protect semantic units before splitting
  const protected_ = protectSemanticUnits(sentence);

  const parts = [];
  let remaining = protected_.trim();

  // Priority tiers for split points. Do not prefer commas here: a comma-ended
  // synthesized chunk plus a chunk join can sound like a skipped or merged word.
  const clauseSeparators = [';', ':', '；', '：'];      // clause boundaries (preferred)

  while (remaining.length > maxChunkLength || (maxChunkWords > 0 && countChunkWords(remaining) > maxChunkWords)) {
    const wordCut = wordLimitCutIndex(remaining, maxChunkWords);
    const hardLimit = Math.min(maxChunkLength, wordCut);
    const minCut = Math.floor(hardLimit * 0.6);
    const searchWindow = remaining.slice(0, hardLimit + 1);
    let cut = -1;

    // Tier 1: prefer clause-level separators
    for (const sep of clauseSeparators) {
      const idx = searchWindow.lastIndexOf(sep);
      if (idx > cut) cut = idx;
    }

    // Tier 2: break at a normal space (never at NBSP — that's a protected unit)
    if (cut < minCut) {
      cut = searchWindow.lastIndexOf(' ');
    }

    // Tier 3: hard cut at max length
    if (cut < minCut) {
      cut = hardLimit;
    }

    const slice = remaining.slice(0, cut + (cut === hardLimit ? 0 : 1)).trim();
    parts.push(restoreSemanticUnits(slice));
    remaining = remaining.slice(cut + (cut === hardLimit ? 0 : 1)).trim();
  }

  if (remaining) parts.push(restoreSemanticUnits(remaining));
  return parts.filter(Boolean);
}

// Break-aware wrapper: force a chunk boundary at every SSML <break> so the sentinel
// always lands on a chunk tail (where computeChunkPauses reads it into the inter-chunk
// silence). Text with no breaks goes straight through chunkSegment unchanged.
export function splitTextIntoChunks(text, options = {}) {
  const segments = splitOnBreaks(text);
  if (segments.length <= 1) return chunkSegment(text, options);

  const out = [];
  for (const { text: segText, breakMsAfter } of segments) {
    const segChunks = chunkSegment(segText, options);
    if (segChunks.length === 0) {
      // Empty segment (e.g. back-to-back breaks): fold the pause onto the last chunk.
      if (breakMsAfter != null && out.length > 0) {
        out[out.length - 1] = appendBreakSentinel(stripBreakSentinels(out[out.length - 1]), breakMsAfter);
      }
      continue;
    }
    if (breakMsAfter != null) {
      const last = segChunks.length - 1;
      segChunks[last] = appendBreakSentinel(segChunks[last], breakMsAfter);
    }
    out.push(...segChunks);
  }
  return out;
}

// Review/output chunks follow the ordinary Full sentence/word/context rules. An
// explicit break is retained inside that parent chunk and only split later by
// synthesizeBreakAwareFullChunk. This keeps `hello <break/> hello` as one editable
// review card while still generating two internal clips around deterministic silence.
export function splitTextIntoReviewChunks(text, options = {}) {
  const chunks = chunkSegment(text, options);

  // If ordinary sentence limits put a break sentinel at the start of a later parent
  // chunk, move it to the previous tail so the final top-level join retains the pause.
  for (let index = 1; index < chunks.length; index += 1) {
    let current = chunks[index].trimStart();
    while (current) {
      const match = BREAK_SENTINEL_RE.exec(current);
      if (!match || match.index !== 0) break;
      chunks[index - 1] = appendBreakSentinel(chunks[index - 1], Number.parseInt(match[1], 10));
      current = current.slice(match[0].length).trimStart();
    }
    chunks[index] = current;
  }
  return chunks.filter(Boolean);
}

function chunkSegment(text, options = {}) {
  const maxChunkWords = Math.max(0, clampNumber(options.maxChunkWords, 0));
  // An explicit word override takes priority over the default character heuristic.
  const maxChunkLength = maxChunkWords > 0
    ? Number.MAX_SAFE_INTEGER
    : Math.max(80, clampNumber(options.maxChunkLength, DEFAULTS.maxChunkLength));
  const maxSentencesPerChunk = Math.max(1, clampNumber(options.maxSentencesPerChunk, DEFAULTS.maxSentencesPerChunk));

  const rawSentences = splitIntoSentences(text).flatMap(sentence => splitLongSentence(sentence, maxChunkLength, maxChunkWords));
  const chunks = [];
  let current = '';
  let sentenceCount = 0;

  for (const sentence of rawSentences) {
    if (containsRiskySynthesisContent(sentence, options)) {
      if (current.trim()) chunks.push(current.trim());
      // Start a fresh chunk for guarded content, but leave it open so a short
      // technical sentence can gain context from the sentence that follows.
      current = sentence.trim();
      sentenceCount = 1;
      continue;
    }
    const candidate = current ? `${current} ${sentence}` : sentence;
    const exceedsLength = candidate.length > maxChunkLength;
    const exceedsWords = maxChunkWords > 0 && countChunkWords(candidate) > maxChunkWords;
    const mayAbsorbOneForContext = sentenceCount === maxSentencesPerChunk
      && countChunkWords(current) < MIN_CONTEXT_WORDS;
    const exceedsSentenceCount = sentenceCount >= maxSentencesPerChunk
      && !mayAbsorbOneForContext;

    if (current && (exceedsLength || exceedsWords || exceedsSentenceCount)) {
      chunks.push(current.trim());
      current = sentence;
      sentenceCount = 1;
    } else {
      current = candidate;
      sentenceCount += 1;
    }

    // Do not flush merely because one sentence reached a percentage of the size
    // limit. The next sentence is the only reliable way to know whether the pair
    // fits, and the checks above will flush before adding it when it does not. This
    // makes maxSentencesPerChunk=2 actually group two fitting sentences instead of
    // prematurely emitting a single sentence at the old 60% threshold.
    const hasEnoughContext = countChunkWords(current) >= MIN_CONTEXT_WORDS;
    const usedExtraContextSentence = sentenceCount > maxSentencesPerChunk;
    if (sentenceCount >= maxSentencesPerChunk && (hasEnoughContext || usedExtraContextSentence)) {
      chunks.push(current.trim());
      current = '';
      sentenceCount = 0;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  const merged = mergeShortChunks(chunks, MIN_CHUNK_LENGTH, maxChunkWords);
  const regrouped = keepDictionaryWordsOffChunkTails(
    merged,
    options.avoidChunkFinalWords,
    maxChunkLength,
    maxChunkWords,
  );
  return borrowOneSentenceAfterDictionaryTail(
    regrouped,
    options.avoidChunkFinalWords,
    maxChunkLength,
    maxChunkWords,
    maxSentencesPerChunk,
  );
}

// Last spoken word of a chunk, lowercased and stripped of punctuation.
function chunkFinalWord(text) {
  const tokens = String(text || '').toLowerCase().match(/[\p{L}\p{N}']+/gu);
  return tokens && tokens.length > 0 ? tokens[tokens.length - 1] : '';
}

// The chunk-final position is where the AR decoder is most likely to clip or rush a
// word (it is about to emit end-of-sequence), and pronunciation-dictionary terms are
// exactly the words that must NOT be degraded. When a dictionary term would land as
// the last word of a chunk, move that sentence to the FRONT of the next chunk instead,
// so the term is followed by more speech and sits away from the risky edge. Purely a
// re-grouping: chunk boundaries stay on sentence ends, no text is altered, and the
// move is skipped whenever it would violate the existing length invariants.
function keepDictionaryWordsOffChunkTails(chunks, avoidWords, maxChunkLength, maxChunkWords = 0) {
  const words = new Set(
    (Array.isArray(avoidWords) ? avoidWords : [])
      .map((w) => chunkFinalWord(w))
      .filter(Boolean),
  );
  if (words.size === 0 || chunks.length < 2) return chunks;

  const out = chunks.slice();
  for (let i = 0; i < out.length - 1; i += 1) {
    if (!words.has(chunkFinalWord(out[i]))) continue;
    const sentences = splitIntoSentences(out[i]);
    if (sentences.length < 2) continue; // single sentence: nowhere safe to re-group
    const lastSentence = sentences[sentences.length - 1];
    const remainder = sentences.slice(0, -1).join(' ').trim();
    const movedNext = `${lastSentence} ${out[i + 1]}`.trim();
    // Respect the existing invariants: never create an over-long or under-short chunk.
    if (movedNext.length > maxChunkLength || (maxChunkWords > 0 && countChunkWords(movedNext) > maxChunkWords) || remainder.length < MIN_CHUNK_LENGTH) continue;
    out[i] = remainder;
    out[i + 1] = movedNext;
  }
  return out;
}

function borrowOneSentenceAfterDictionaryTail(
  chunks,
  avoidWords,
  maxChunkLength,
  maxChunkWords,
  maxSentencesPerChunk,
) {
  const words = new Set(
    (Array.isArray(avoidWords) ? avoidWords : []).map(chunkFinalWord).filter(Boolean),
  );
  if (words.size === 0 || chunks.length < 2) return chunks;

  const out = chunks.slice();
  const charCeiling = Number.isFinite(maxChunkLength) && maxChunkLength < Number.MAX_SAFE_INTEGER
    ? Math.ceil(maxChunkLength * 1.15)
    : Number.MAX_SAFE_INTEGER;
  const wordCeiling = maxChunkWords > 0
    ? Math.min(maxChunkWords + 15, Math.ceil(maxChunkWords * 1.15))
    : Number.MAX_SAFE_INTEGER;

  for (let index = 0; index < out.length - 1; index += 1) {
    const currentSentences = splitIntoSentences(out[index]);
    if (!words.has(chunkFinalWord(out[index])) || currentSentences.length < maxSentencesPerChunk) continue;
    const nextSentences = splitIntoSentences(out[index + 1]);
    if (nextSentences.length === 0) continue;
    const borrowed = nextSentences[0];
    const candidate = `${out[index]} ${borrowed}`.trim();
    const remainder = nextSentences.slice(1).join(' ').trim();
    if (candidate.length > charCeiling || countChunkWords(candidate) > wordCeiling) continue;
    if (remainder && remainder.length < MIN_CHUNK_LENGTH) continue;

    console.log(
      `[chunking] borrowed context sentence reason=dictionary-tail word=${JSON.stringify(chunkFinalWord(out[index]))} `
      + `sentences=${currentSentences.length + 1} chars=${candidate.length} words=${countChunkWords(candidate)}`,
    );
    out[index] = candidate;
    if (remainder) out[index + 1] = remainder;
    else out.splice(index + 1, 1);
  }
  return out;
}

// GPT-SoVITS frequently renders a very short fragment (a lone "Yes." or a
// stranded lead-in clause) as a near-silent buffer — its AR decoder predicts an
// early end-of-sequence. Long passages spawn more such fragments, so the odds
// that one of them defeats every retry (and aborts the whole job) climb with
// length. Fold any sub-minLength fragment into a neighbour so no chunk is ever
// short enough to trigger that failure mode.
function endsSentence(text) {
  const trimmed = String(text || '').trimEnd();
  if (trimmed.endsWith('...') || trimmed.endsWith('…')) return true;
  return '.!?。！？'.includes(trimmed.slice(-1));
}

function mergeShortChunks(chunks, minLength, maxChunkWords = 0) {
  if (chunks.length <= 1) return chunks;
  const canMerge = (left, right) => !(maxChunkWords > 0) || countChunkWords(`${left} ${right}`) <= maxChunkWords;

  // Pass 1: fold a short fragment backward into the previous chunk — but NOT when
  // that previous chunk already ends a sentence. Gluing e.g. "Structurally," onto
  // "…microtubules." makes a chunk that straddles a full stop and trails a dangling
  // lead-in, which the model reliably mangles. Such a fragment is a lead-in to what
  // FOLLOWS, so leave it standalone here and let pass 2 fold it forward.
  const merged = [];
  for (const chunk of chunks) {
    const text = chunk.trim();
    if (!text) continue;
    const prev = merged.length > 0 ? merged[merged.length - 1] : null;
    if (prev && text.length < minLength && !endsSentence(prev) && canMerge(prev, text)) {
      merged[merged.length - 1] = `${prev} ${text}`.trim();
    } else {
      merged.push(text);
    }
  }

  // Pass 2: fold any remaining short chunk forward into its following neighbour.
  // Covers a short leading fragment ("Typically,") and a lead-in deferred from a
  // completed sentence ("Structurally,") — both belong with the clause after them.
  for (let i = 0; i < merged.length - 1;) {
    if (merged[i].length < minLength && canMerge(merged[i], merged[i + 1])) {
      merged[i + 1] = `${merged[i]} ${merged[i + 1]}`.trim();
      merged.splice(i, 1);
    } else {
      i += 1;
    }
  }

  // Pass 3: a short *trailing* chunk has no forward neighbour left — fold it
  // backward as a last resort so no chunk is ever short enough to render silent.
  while (merged.length > 1 && merged[merged.length - 1].length < minLength
    && canMerge(merged[merged.length - 2], merged[merged.length - 1])) {
    merged[merged.length - 2] = `${merged[merged.length - 2]} ${merged[merged.length - 1]}`.trim();
    merged.pop();
  }
  return merged;
}

function readChunk(buffer, offset) {
  if (offset + 8 > buffer.length) return null;
  const id = buffer.toString('ascii', offset, offset + 4);
  const size = buffer.readUInt32LE(offset + 4);
  const start = offset + 8;
  const end = start + size;
  if (end > buffer.length) return null;
  return { id, size, start, end, next: end + (size % 2) };
}

export function parseWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) {
    throw new Error('Invalid WAV buffer');
  }
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Expected a RIFF/WAVE audio buffer');
  }

  let offset = 12;
  let fmtChunk = null;
  let dataChunk = null;

  while (offset + 8 <= buffer.length) {
    const chunk = readChunk(buffer, offset);
    if (!chunk) break;
    if (chunk.id === 'fmt ') {
      fmtChunk = buffer.slice(chunk.start, chunk.end);
    } else if (chunk.id === 'data') {
      dataChunk = buffer.slice(chunk.start, chunk.end);
    }
    offset = chunk.next;
  }

  if (!fmtChunk || !dataChunk) {
    throw new Error('WAV file is missing fmt or data chunk');
  }

  return {
    audioFormat: fmtChunk.readUInt16LE(0),
    numChannels: fmtChunk.readUInt16LE(2),
    sampleRate: fmtChunk.readUInt32LE(4),
    byteRate: fmtChunk.readUInt32LE(8),
    blockAlign: fmtChunk.readUInt16LE(12),
    bitsPerSample: fmtChunk.readUInt16LE(14),
    fmtChunk,
    dataChunk,
  };
}

function buildWav(fmtChunk, dataChunk) {
  const riffSize = 4 + (8 + fmtChunk.length) + (8 + dataChunk.length);
  const output = Buffer.alloc(12 + 8 + fmtChunk.length + 8 + dataChunk.length);

  output.write('RIFF', 0, 4, 'ascii');
  output.writeUInt32LE(riffSize, 4);
  output.write('WAVE', 8, 4, 'ascii');

  output.write('fmt ', 12, 4, 'ascii');
  output.writeUInt32LE(fmtChunk.length, 16);
  fmtChunk.copy(output, 20);

  const dataHeaderOffset = 20 + fmtChunk.length;
  output.write('data', dataHeaderOffset, 4, 'ascii');
  output.writeUInt32LE(dataChunk.length, dataHeaderOffset + 4);
  dataChunk.copy(output, dataHeaderOffset + 8);

  return output;
}

// Index (among spoken words, in order) of every expected word that is immediately
// followed by a comma / clause break — i.e. where we want a small breath. Counts a
// "word" the same way ASR lists them (one per whitespace-separated token containing a
// letter/digit) so the index lines up with the Whisper `words` array.
function commaBreakWordIndices(text) {
  const set = new Set();
  const tokens = String(text || '').trim().split(/\s+/u);
  let wordIndex = -1;
  for (const tok of tokens) {
    if (!/[\p{L}\p{N}]/u.test(tok)) continue; // punctuation-only token: not a word
    wordIndex += 1;
    // strip trailing closing quotes/brackets, then check for a clause-break mark.
    const tail = tok.replace(/['")\]]+$/u, '');
    if (/[,;:，；：]$/u.test(tail)) set.add(wordIndex);
  }
  return set;
}

/**
 * Splice a small silence into finished (cut0) audio at each comma/clause break, using
 * the Whisper word timestamps for placement. Keeps cut0's smooth, natural prosody but
 * adds the gentle comma breath cut0 lacks — without cut5's per-fragment choppiness.
 *
 * Degrades safely: if the audio isn't PCM16, there are no breaks, the timestamps are
 * missing, or the heard word count doesn't line up with the expected words (so
 * placement would be unreliable), it returns the audio unchanged (plain cut0).
 *
 * @param {Buffer} audioBuffer  finished chunk WAV (PCM16)
 * @param {string} expectedText the chunk text (source of comma positions)
 * @param {Array<{w:string,start:number,end:number}>} words Whisper word timings
 * @param {number} pauseMs      silence to insert per break
 */
// Linearly ramp the first (`in`) or last (`out`) `frames` of a PCM16 buffer so the
// boundary touching an inserted silence fades smoothly instead of jumping (which
// clicks/pops). Mutates the buffer in place.
function fadeEdge(buf, channels, frames, direction) {
  const bytesPerFrame = channels * 2;
  const total = Math.floor(buf.length / bytesPerFrame);
  const n = Math.min(frames, total);
  for (let k = 0; k < n; k += 1) {
    const frame = direction === 'in' ? k : total - 1 - k;
    const gain = (k + 1) / (n + 1); // ramps 0→1 from the silent edge inward
    for (let c = 0; c < channels; c += 1) {
      const pos = frame * bytesPerFrame + c * 2;
      buf.writeInt16LE(Math.round(buf.readInt16LE(pos) * gain), pos);
    }
  }
}

// Returns { audioBuffer, inserted, reason }. `reason` is set only when nothing was
// inserted, so callers can log WHY the breath was skipped.
function computeCommaPauses(audioBuffer, expectedText, words, pauseMs) {
  if (!(pauseMs > 0)) return { audioBuffer, inserted: 0, reason: 'disabled' };
  if (!Array.isArray(words) || words.length === 0) return { audioBuffer, inserted: 0, reason: 'no-timings' };
  const breakIndices = commaBreakWordIndices(expectedText);
  if (breakIndices.size === 0) return { audioBuffer, inserted: 0, reason: 'no-comma' };

  let wav;
  try { wav = parseWav(audioBuffer); } catch { return { audioBuffer, inserted: 0, reason: 'unparseable-wav' }; }
  if (wav.bitsPerSample !== 16 || wav.sampleRate <= 0) return { audioBuffer, inserted: 0, reason: 'not-pcm16' };

  // Alignment guard: only place breaths when the heard word count is close to the
  // expected count, otherwise the index→timestamp mapping would drift and drop a
  // breath in the wrong place. (A real skip would already have been re-rolled.)
  const expectedWordCount = String(expectedText || '').trim().split(/\s+/u)
    .filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
  if (expectedWordCount === 0 || Math.abs(words.length - expectedWordCount) > 2) {
    return { audioBuffer, inserted: 0, reason: `word-count-drift(expected ${expectedWordCount}, heard ${words.length})` };
  }

  const bytesPerFrame = wav.numChannels * 2;
  const silence = Buffer.alloc(Math.round((pauseMs / 1000) * wav.sampleRate) * bytesPerFrame);
  if (silence.length === 0) return { audioBuffer, inserted: 0, reason: 'zero-silence' };

  const frameToByte = (frame) => Math.max(0, Math.min(wav.dataChunk.length,
    Math.round(frame) * bytesPerFrame));

  // Place each breath in the natural GAP after the pre-break word, NOT exactly at the
  // word's end timestamp. Whisper marks word-end slightly early, so splicing at end
  // clipped the word's tail and sounded like a cut. We nudge into the silent gap
  // before the next word (capped), landing the pause where the audio is already quiet.
  const offsets = [];
  for (const idx of breakIndices) {
    const word = words[idx];
    if (!word || !Number.isFinite(word.end)) continue;
    const next = words[idx + 1];
    const gap = next && Number.isFinite(next.start) ? Math.max(0, next.start - word.end) : 0;
    const insertSec = word.end + Math.min(gap * 0.5, 0.05); // up to 50ms into the gap
    offsets.push(frameToByte(insertSec * wav.sampleRate));
  }
  if (offsets.length === 0) return { audioBuffer, inserted: 0, reason: 'no-valid-offsets' };
  offsets.sort((a, b) => a - b);

  // Build segments, then taper the edge touching each inserted silence so the
  // transition into/out of silence is smooth (a hard amplitude jump clicks/pops,
  // which also reads as a glitch). ~5ms ramp.
  const fadeFrames = Math.max(1, Math.round(0.005 * wav.sampleRate));
  const audioSegs = [];
  let prev = 0;
  for (const off of offsets) {
    audioSegs.push(Buffer.from(wav.dataChunk.slice(prev, off)));
    prev = off;
  }
  audioSegs.push(Buffer.from(wav.dataChunk.slice(prev)));

  const parts = [];
  for (let i = 0; i < audioSegs.length; i += 1) {
    const seg = audioSegs[i];
    if (i > 0) fadeEdge(seg, wav.numChannels, fadeFrames, 'in');   // follows a silence
    if (i < audioSegs.length - 1) fadeEdge(seg, wav.numChannels, fadeFrames, 'out'); // precedes a silence
    parts.push(seg);
    if (i < audioSegs.length - 1) parts.push(silence);
  }
  return { audioBuffer: buildWav(wav.fmtChunk, Buffer.concat(parts)), inserted: offsets.length, reason: null };
}

/**
 * Splice a small silence into finished (cut0) audio at each comma/clause break, using
 * the Whisper word timestamps for placement. Keeps cut0's smooth, natural prosody but
 * adds the gentle comma breath cut0 lacks — without cut5's per-fragment choppiness.
 *
 * Degrades safely: if the audio isn't PCM16, there are no breaks, the timestamps are
 * missing, or the heard word count doesn't line up with the expected words (so
 * placement would be unreliable), it returns the audio unchanged (plain cut0).
 *
 * @param {Buffer} audioBuffer  finished chunk WAV (PCM16)
 * @param {string} expectedText the chunk text (source of comma positions)
 * @param {Array<{w:string,start:number,end:number}>} words Whisper word timings
 * @param {number} pauseMs      silence to insert per break
 */
export function insertCommaPauses(audioBuffer, expectedText, words, pauseMs) {
  return computeCommaPauses(audioBuffer, expectedText, words, pauseMs).audioBuffer;
}

/**
 * Measure the peak amplitude (0..1) of PCM16 chunk data. Returns 0 for silent
 * or empty buffers.
 */
function getChunkAbsPeak(data) {
  const bytesPerSample = 2;
  const sampleCount = Math.floor(data.length / bytesPerSample);
  if (sampleCount === 0) return 0;

  let absPeak = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = Math.abs(data.readInt16LE(i * bytesPerSample));
    if (sample > absPeak) absPeak = sample;
  }
  return absPeak / 32767;
}

/**
 * Compute a shared target peak from per-chunk peaks so chunks can be matched to a
 * common loudness WITHOUT inflating the overall level. Uses the median of the
 * non-silent chunk peaks, which preserves the model's natural loudness (and the
 * similarity to the reference voice) instead of forcing an absolute target.
 * A single chunk yields its own peak, so it is left untouched.
 */
export function computeSharedChunkPeak(peaks) {
  const audible = peaks.filter((peak) => peak >= 0.003).sort((a, b) => a - b);
  if (audible.length === 0) return 0;
  const mid = Math.floor(audible.length / 2);
  return audible.length % 2 === 0
    ? (audible[mid - 1] + audible[mid]) / 2
    : audible[mid];
}

/**
 * Scale PCM16 chunk data so its peak matches targetPeak. Used to even out
 * volume jumps between chunks. Skips if effectively silent, already within 2%
 * of target, or the target is not a usable level.
 */
function normalizeChunkPeak(data, targetPeak) {
  if (!(targetPeak > 0)) return;

  const currentPeak = getChunkAbsPeak(data);
  // Skip if effectively silent or already within 2% of target
  if (currentPeak < 0.003) return;
  if (Math.abs(currentPeak - targetPeak) / targetPeak < 0.02) return;

  const bytesPerSample = 2;
  const sampleCount = Math.floor(data.length / bytesPerSample);
  const scale = targetPeak / currentPeak;
  for (let i = 0; i < sampleCount; i++) {
    const offset = i * bytesPerSample;
    const sample = data.readInt16LE(offset);
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * scale))), offset);
  }
}

/**
 * Find the nearest zero crossing within searchRange samples from a chunk edge.
 * Returns the sample index of the crossing, or the edge itself if none found.
 * @param {Buffer} data - PCM16 data
 * @param {'start'|'end'} edge - which end to search from
 * @param {number} searchRange - max samples to scan (~1.3ms at 48kHz for 64)
 */
function findZeroCrossing(data, edge, searchRange = 64) {
  const bytesPerSample = 2;
  const totalSamples = Math.floor(data.length / bytesPerSample);
  if (totalSamples < 2) return 0;

  const range = Math.min(searchRange, totalSamples - 1);

  if (edge === 'start') {
    for (let i = 0; i < range; i++) {
      const s0 = data.readInt16LE(i * bytesPerSample);
      const s1 = data.readInt16LE((i + 1) * bytesPerSample);
      if ((s0 >= 0 && s1 < 0) || (s0 < 0 && s1 >= 0)) return i + 1;
    }
    return 0;
  }

  // edge === 'end'
  for (let i = totalSamples - 1; i > totalSamples - 1 - range; i--) {
    const s0 = data.readInt16LE((i - 1) * bytesPerSample);
    const s1 = data.readInt16LE(i * bytesPerSample);
    if ((s0 >= 0 && s1 < 0) || (s0 < 0 && s1 >= 0)) return i;
  }
  return totalSamples;
}

/**
 * Trim leading/trailing near-silence from a PCM16 chunk so the ONLY gap between
 * chunks is the deterministic join pause we insert ourselves.
 *
 * GPT-SoVITS appends a variable amount of trailing silence (and sometimes a
 * leading lead-in) to every chunk. Because Live Full forces a chunk boundary
 * after each punctuation mark, a passage spawns many chunks, and that model
 * silence STACKS on top of our join pause — so the same sentence pauses for very
 * different lengths run to run, which reads as "the pause is sometimes too long".
 * Stripping it makes every inter-chunk gap equal to pauseForPunctuation alone.
 *
 * A guard margin is preserved at each edge so a real speech onset/offset (a soft
 * consonant, a trailing breath) is never clipped — we only remove the dead air
 * past that margin.
 */
function trimEdgeSilence(data, parsedWav, { thresholdAbs = 0.0035, guardMs = 30 } = {}) {
  const blockAlign = parsedWav.blockAlign;
  const totalFrames = Math.floor(data.length / blockAlign);
  if (totalFrames < 256) return data; // too short to safely trim

  const threshold = Math.round(thresholdAbs * 32768);
  const guardFrames = Math.round((guardMs / 1000) * parsedWav.sampleRate);

  const frameAbsPeak = (frame) => {
    let peak = 0;
    for (let ch = 0; ch < parsedWav.numChannels; ch++) {
      const offset = frame * blockAlign + ch * 2;
      if (offset + 1 < data.length) {
        const sample = Math.abs(data.readInt16LE(offset));
        if (sample > peak) peak = sample;
      }
    }
    return peak;
  };

  let firstAudible = 0;
  while (firstAudible < totalFrames && frameAbsPeak(firstAudible) <= threshold) firstAudible += 1;
  if (firstAudible >= totalFrames) return data; // entirely silent — leave for analysis to reject

  let lastAudible = totalFrames - 1;
  while (lastAudible > firstAudible && frameAbsPeak(lastAudible) <= threshold) lastAudible -= 1;

  const startFrame = Math.max(0, firstAudible - guardFrames);
  const endFrame = Math.min(totalFrames, lastAudible + 1 + guardFrames);
  if (startFrame === 0 && endFrame === totalFrames) return data;

  return data.subarray(startFrame * blockAlign, endFrame * blockAlign);
}

/**
 * Trim a PCM16 chunk buffer to nearest zero crossings at both edges.
 */
function trimToZeroCrossings(data, blockAlign) {
  const bytesPerSample = 2;
  const totalSamples = Math.floor(data.length / bytesPerSample);
  if (totalSamples < 128) return data; // too short to trim

  const startSample = findZeroCrossing(data, 'start');
  const endSample = findZeroCrossing(data, 'end');

  if (startSample === 0 && endSample === totalSamples) return data;

  const startByte = startSample * blockAlign;
  const endByte = endSample * blockAlign;
  if (endByte <= startByte) return data;

  return data.subarray(startByte, endByte);
}

/**
 * Create shaped silence with micro-ramp edges to prevent the "dead zone"
 * perception of digital silence. Adds inaudible noise (amplitude +/-2)
 * in 3ms ramps at both edges.
 */
function createSilenceBytes(durationMs, parsedWav) {
  const frameCount = Math.max(0, Math.round((durationMs / 1000) * parsedWav.sampleRate));
  const byteLength = frameCount * parsedWav.blockAlign;
  const buf = Buffer.alloc(byteLength, 0);

  if (parsedWav.audioFormat !== 1 || parsedWav.bitsPerSample !== 16 || frameCount < 2) return buf;

  const rampFrames = Math.min(frameCount >> 1, Math.round(0.003 * parsedWav.sampleRate)); // 3ms
  const maxAmp = 2; // inaudible

  for (let i = 0; i < rampFrames; i++) {
    const amp = Math.round(maxAmp * (i / rampFrames));
    const val = (i % 2 === 0) ? amp : -amp;
    for (let ch = 0; ch < parsedWav.numChannels; ch++) {
      const offset = i * parsedWav.blockAlign + ch * 2;
      if (offset + 1 < buf.length) buf.writeInt16LE(val, offset);
    }
  }

  for (let i = 0; i < rampFrames; i++) {
    const frameIdx = frameCount - 1 - i;
    const amp = Math.round(maxAmp * (i / rampFrames));
    const val = (i % 2 === 0) ? amp : -amp;
    for (let ch = 0; ch < parsedWav.numChannels; ch++) {
      const offset = frameIdx * parsedWav.blockAlign + ch * 2;
      if (offset + 1 < buf.length) buf.writeInt16LE(val, offset);
    }
  }

  return buf;
}

/**
 * Apply a raised-cosine (Hann window) fade to PCM16 audio data in-place.
 * S-curve fades eliminate the sharp "corner" at boundaries that causes clicks.
 * @param {Buffer} data - raw PCM16 data (modified in-place)
 * @param {number} sampleRate
 * @param {number} numChannels
 * @param {number} fadeMs - fade duration in milliseconds
 * @param {'in'|'out'} direction
 */
function applyFade(data, sampleRate, numChannels, fadeMs, direction) {
  const bytesPerSample = 2; // PCM16
  const blockAlign = numChannels * bytesPerSample;
  const totalFrames = Math.floor(data.length / blockAlign);
  const fadeFrames = Math.min(totalFrames, Math.round((fadeMs / 1000) * sampleRate));
  if (fadeFrames <= 0) return;

  for (let frame = 0; frame < fadeFrames; frame++) {
    // `frame` counts outward from the boundary that touches the silence (the first
    // sample for 'in', the last sample for 'out'). Gain must be 0 AT that boundary and
    // rise to 1 fadeFrames inward, for BOTH directions — only the end differs. The old
    // 'out' branch used (1 + cos), which inverted the ramp: it left the final sample at
    // full amplitude right before the inserted silence, producing a click at every join
    // (audible "glitch" on fullstops/commas).
    const t = frame / fadeFrames;
    const appliedGain = 0.5 * (1 - Math.cos(Math.PI * t));
    const frameOffset = direction === 'in'
      ? frame * blockAlign
      : (totalFrames - 1 - frame) * blockAlign;

    for (let ch = 0; ch < numChannels; ch++) {
      const offset = frameOffset + ch * bytesPerSample;
      if (offset + 1 >= data.length) continue;
      const sample = data.readInt16LE(offset);
      data.writeInt16LE(Math.round(sample * appliedGain), offset);
    }
  }
}

// Determine pause duration (ms) based on trailing punctuation of a chunk
function pauseForPunctuation(chunkText, basePauseMs) {
  // An explicit SSML <break> at this chunk's tail sets the gap directly (absolute ms),
  // overriding the punctuation-scaled default — the user asked for exactly this pause.
  const breakMs = extractBreakMs(chunkText);
  if (breakMs != null) return breakMs;

  const trimmed = chunkText.trimEnd();
  const tail = trimmed.slice(-3); // check last few chars for multi-char punctuation
  const last = trimmed[trimmed.length - 1] || '';

  // Ellipsis — trailing thought, moderate pause
  if (tail.includes('...') || tail.includes('\u2026')) return Math.round(basePauseMs * 3.6);
  // Em dash / double dash — brief dramatic pause
  if (last === '\u2014' || tail.includes('--')) return Math.round(basePauseMs * 1.2);
  // Period, question mark, exclamation
  if ('.!?\u3002\uff01\uff1f'.includes(last)) return Math.round(basePauseMs * 3.2);
  // Colon
  if (':\uff1a'.includes(last)) return Math.round(basePauseMs * 2.0);
  // Semicolon
  if (';\uff1b'.includes(last)) return Math.round(basePauseMs * 1.6);
  // Comma — should be brief, not a full pause
  if (',\uff0c'.includes(last)) return Math.round(basePauseMs * 0.4);
  // No terminal punctuation — gentle transition
  return Math.round(basePauseMs * 0.6);
}

// Determine crossfade duration (ms) based on trailing punctuation
function fadeForPunctuation(chunkText) {
  const trimmed = chunkText.trimEnd();
  const tail = trimmed.slice(-3);
  const last = trimmed[trimmed.length - 1] || '';

  if (tail.includes('...') || tail.includes('\u2026')) return 60;
  if (last === '\u2014' || tail.includes('--')) return 40;
  if ('.!?\u3002\uff01\uff1f'.includes(last)) return 30;
  if (':;\uff1a\uff1b'.includes(last)) return 30;
  if (',\uff0c'.includes(last)) return 20;
  return 20; // no punctuation — almost seamless
}

// Build an array of per-gap pause durations from chunk texts
export function computeChunkPauses(chunkTexts, basePauseMs = DEFAULTS.chunkJoinPauseMs) {
  return chunkTexts.slice(0, -1).map(text => pauseForPunctuation(text, basePauseMs));
}

// Build an array of per-gap crossfade durations from chunk texts
export function computeChunkFades(chunkTexts) {
  return chunkTexts.slice(0, -1).map(text => fadeForPunctuation(text));
}

// Inaudible edge fade applied ONLY to the audio touching an inserted silence, so the
// audio->silence->audio step never clicks. 3ms is far shorter than any phoneme, so it
// removes the click without shaving consonants — unlike the 20-60ms punctuation
// crossfade removed in e3e03a2. This is what fixes the mid-sentence "glitch / word cut
// off" heard when a chunk was split and rejoined (best-effort passes) mid-sentence.
const JOIN_EDGE_FADE_MS = 3;
// The model appends a variable tail of near-silence after a sentence. Left in, it
// STACKS on top of the inserted join pause, so the same fullstop is much longer at a
// chunk boundary than mid-chunk ("fullstop too long, only sometimes"). Trim that tail
// before a join so the inserted pause alone governs the gap. The threshold is low
// enough that soft trailing consonants (fricatives) stay above it and are preserved,
// and the cap guarantees we never eat into speech even if detection misfires.
const JOIN_TRIM_THRESHOLD = 0.006; // ~ -44 dBFS
const JOIN_TRIM_KEEP_MS = 30;      // leave this much tail after the last loud sample
// Cap on how much edge silence a single join may remove. Raised from 400ms so an
// inserted pause (an SSML <break>, the only source of inserted gaps on the Full paths)
// fully replaces the model's own trailing/leading silence instead of STACKING on top of
// it — otherwise a "700ms" break plays as several seconds. 2s covers the model's
// longest sentence-edge silence while still guarding against a misfire eating speech.
const JOIN_TRIM_MAX_MS = 2000;

// Trim trailing near-silence from a PCM16 chunk, returning a view (never mutates).
// Only used before an inserted pause; mid-sentence continuous joins are left intact.
function trimTrailingSilencePCM16(data, parsedWav) {
  const { numChannels, sampleRate, blockAlign } = parsedWav;
  const totalFrames = Math.floor(data.length / blockAlign);
  if (totalFrames < 2) return data;

  const threshold = Math.round(JOIN_TRIM_THRESHOLD * 32768);
  let lastLoud = totalFrames - 1;
  for (; lastLoud >= 0; lastLoud -= 1) {
    let peak = 0;
    for (let ch = 0; ch < numChannels; ch += 1) {
      const offset = lastLoud * blockAlign + ch * 2;
      if (offset + 1 < data.length) peak = Math.max(peak, Math.abs(data.readInt16LE(offset)));
    }
    if (peak > threshold) break;
  }
  if (lastLoud < 0) return data; // all quiet — leave as-is (e.g. an intentional pause)

  const keepFrames = Math.round((JOIN_TRIM_KEEP_MS / 1000) * sampleRate);
  const maxTrimFrames = Math.round((JOIN_TRIM_MAX_MS / 1000) * sampleRate);
  const naiveCut = Math.min(totalFrames, lastLoud + 1 + keepFrames);
  // Never remove more than the cap, no matter how much trailing silence was found.
  const cutFrame = Math.max(naiveCut, totalFrames - maxTrimFrames);
  if (cutFrame >= totalFrames) return data;
  return data.subarray(0, cutFrame * blockAlign);
}

// Trim LEADING near-silence from a PCM16 chunk (mirror of the trailing trim). Applied
// to the chunk that FOLLOWS an inserted pause so the model's own lead-in silence does
// not stack after the inserted <break> — the audible gap then equals the requested
// break duration. Same threshold/keep/cap guarantees as the trailing side.
function trimLeadingSilencePCM16(data, parsedWav) {
  const { numChannels, sampleRate, blockAlign } = parsedWav;
  const totalFrames = Math.floor(data.length / blockAlign);
  if (totalFrames < 2) return data;

  const threshold = Math.round(JOIN_TRIM_THRESHOLD * 32768);
  let firstLoud = 0;
  for (; firstLoud < totalFrames; firstLoud += 1) {
    let peak = 0;
    for (let ch = 0; ch < numChannels; ch += 1) {
      const offset = firstLoud * blockAlign + ch * 2;
      if (offset + 1 < data.length) peak = Math.max(peak, Math.abs(data.readInt16LE(offset)));
    }
    if (peak > threshold) break;
  }
  if (firstLoud >= totalFrames) return data; // all quiet — leave as-is

  const keepFrames = Math.round((JOIN_TRIM_KEEP_MS / 1000) * sampleRate);
  const maxTrimFrames = Math.round((JOIN_TRIM_MAX_MS / 1000) * sampleRate);
  const naiveStart = Math.max(0, firstLoud - keepFrames);
  // Never remove more than the cap from the front, even if more silence was found.
  const startFrame = Math.min(naiveStart, maxTrimFrames);
  if (startFrame <= 0) return data;
  return data.subarray(startFrame * blockAlign);
}

export function concatWavs(buffers, pauseMs = DEFAULTS.chunkJoinPauseMs, fadeDurations = null) {
  if (!Array.isArray(buffers) || buffers.length === 0) {
    throw new Error('No audio buffers to concatenate');
  }

  const parsed = buffers.map(parseWav);
  const first = parsed[0];

  for (const wav of parsed.slice(1)) {
    if (
      wav.audioFormat !== first.audioFormat ||
      wav.numChannels !== first.numChannels ||
      wav.sampleRate !== first.sampleRate ||
      wav.bitsPerSample !== first.bitsPerSample ||
      wav.blockAlign !== first.blockAlign
    ) {
      throw new Error('Cannot concatenate WAV chunks with mismatched audio formats');
    }
  }

  const isPCM16 = first.audioFormat === 1 && first.bitsPerSample === 16;
  const pauses = Array.isArray(pauseMs) ? pauseMs : Array(parsed.length - 1).fill(pauseMs);

  // Match chunks to a shared, natural loudness (median of their own peaks) so we
  // even out inter-chunk jumps without boosting the overall level above what the
  // model produced — preserving similarity to the reference voice.
  const sharedPeak = isPCM16
    ? computeSharedChunkPeak(parsed.map((wav) => getChunkAbsPeak(wav.dataChunk)))
    : 0;

  const gapFor = (index) => (
    index >= 0 && index < parsed.length - 1
      ? (pauses[index] ?? DEFAULTS.chunkJoinPauseMs)
      : 0
  );

  const joinedChunks = [];
  parsed.forEach((wav, index) => {
    let chunk = Buffer.from(wav.dataChunk);
    if (isPCM16) {
      normalizeChunkPeak(chunk, sharedPeak);
    }

    const prevGap = gapFor(index - 1); // silence inserted before this chunk
    const nextGap = gapFor(index);     // silence inserted after this chunk

    // Only touch edges that meet an INSERTED silence. A no-gap (mid-sentence) join is
    // continuous speech and is left byte-for-byte intact — no trim, no fade — so we
    // never shave a consonant across a seamless boundary.
    if (isPCM16 && nextGap > 0) {
      // Drop the model's trailing near-silence so the pause length alone governs the
      // gap (consistent fullstops), then micro-fade so the cut is click-free.
      chunk = trimTrailingSilencePCM16(chunk, first);
      applyFade(chunk, first.sampleRate, first.numChannels, JOIN_EDGE_FADE_MS, 'out');
    }
    if (isPCM16 && prevGap > 0) {
      // Drop the model's lead-in near-silence so it doesn't stack after the inserted
      // pause, then micro-fade the new leading edge click-free.
      chunk = trimLeadingSilencePCM16(chunk, first);
      applyFade(chunk, first.sampleRate, first.numChannels, JOIN_EDGE_FADE_MS, 'in');
    }

    joinedChunks.push(chunk);
    if (nextGap > 0) joinedChunks.push(createSilenceBytes(nextGap, first));
  });

  return buildWav(first.fmtChunk, Buffer.concat(joinedChunks));
}

export function padWavBoundaries(buffer, leadingMs = 0, trailingMs = 0) {
  const before = Math.max(0, Math.min(10000, Math.round(clampNumber(leadingMs, 0))));
  const after = Math.max(0, Math.min(10000, Math.round(clampNumber(trailingMs, 0))));
  if (before === 0 && after === 0) return buffer;
  const wav = parseWav(buffer);
  return buildWav(wav.fmtChunk, Buffer.concat([
    createSilenceBytes(before, wav),
    wav.dataChunk,
    createSilenceBytes(after, wav),
  ]));
}

// Full-only caller option. Gain is applied after synthesis/verification and is capped
// at -1 dBFS, so it cannot change pronunciation decisions or clip the saved PCM.
export function applyWavOutputGain(buffer, gainDb = 0, ceilingPeak = 0.891) {
  const requestedDb = Math.max(-6, Math.min(6, clampNumber(gainDb, 0)));
  if (Math.abs(requestedDb) < 0.001) return buffer;
  const wav = parseWav(buffer);
  if (wav.audioFormat !== 1 || wav.bitsPerSample !== 16) return buffer;
  const data = Buffer.from(wav.dataChunk);
  const currentPeak = getChunkAbsPeak(data);
  if (currentPeak <= 0) return buffer;
  const requestedScale = 10 ** (requestedDb / 20);
  const protectedScale = requestedScale > 1
    ? Math.min(requestedScale, ceilingPeak / currentPeak)
    : requestedScale;
  for (let offset = 0; offset + 1 < data.length; offset += 2) {
    const sample = data.readInt16LE(offset);
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * protectedScale))), offset);
  }
  return buildWav(wav.fmtChunk, data);
}

export function normalizeWavChunksForPreview(buffers) {
  if (!Array.isArray(buffers) || buffers.length === 0) return [];
  const parsed = buffers.map(parseWav);
  const first = parsed[0];
  const compatible = parsed.every((wav) => (
    wav.audioFormat === first.audioFormat
    && wav.numChannels === first.numChannels
    && wav.sampleRate === first.sampleRate
    && wav.bitsPerSample === first.bitsPerSample
    && wav.blockAlign === first.blockAlign
  ));
  if (!compatible) throw new Error('Cannot normalize WAV chunks with mismatched audio formats');
  if (first.audioFormat !== 1 || first.bitsPerSample !== 16) return buffers.map(buffer => Buffer.from(buffer));
  const sharedPeak = computeSharedChunkPeak(parsed.map((wav) => getChunkAbsPeak(wav.dataChunk)));
  return parsed.map((wav) => {
    const data = Buffer.from(wav.dataChunk);
    normalizeChunkPeak(data, sharedPeak);
    return buildWav(wav.fmtChunk, data);
  });
}

// Speaking pace of the voice's own reference clip (prompt_text chars / clip seconds).
// Lets the duration check follow fast or slow speakers instead of a fixed 15 chars/s.
// Returns null when the clip is unreadable or the measurement is implausible.
const referencePaceCache = new Map();
export function estimateReferenceCharsPerSec(refAudioPath, promptText) {
  const text = String(promptText || '').trim();
  if (!refAudioPath || text.length < 10) return null;
  const key = `${refAudioPath}|${text}`;
  if (referencePaceCache.has(key)) return referencePaceCache.get(key);
  let pace = null;
  try {
    const wav = parseWav(fs.readFileSync(refAudioPath));
    const durationSec = Math.floor(wav.dataChunk.length / wav.blockAlign) / wav.sampleRate;
    const measured = durationSec > 1 ? text.length / durationSec : null;
    pace = measured && measured >= 6 && measured <= 35 ? measured : null;
  } catch {
    pace = null;
  }
  referencePaceCache.set(key, pace);
  return pace;
}

export function analyzeAudioQuality(buffer, expectedText = '', { charsPerSec = null } = {}) {
  const wav = parseWav(buffer);
  const bytes = wav.dataChunk;
  const bytesPerSample = Math.max(1, wav.bitsPerSample / 8);
  const frameCount = Math.floor(bytes.length / wav.blockAlign);
  const durationSec = frameCount / wav.sampleRate;
  // A natural read is ~15 characters/second. If a chunk's audio runs well under
  // the time its text should take, the model almost certainly dropped words; we
  // flag it so the chunk is re-rolled (a new seed usually produces a full read).
  // Tune REQUIRED_DURATION_FRACTION up to catch smaller drops (more retries) or
  // down to be more permissive. Assumes speed_factor near 1.0 or slower.
  const NATURAL_CHARS_PER_SEC = 15;
  const REQUIRED_DURATION_FRACTION = 0.65;
  // A double-read runs ~2x its text's natural length. Flag audio well past that so a
  // repeat gets re-rolled — a backstop for when ASR verification is unavailable (the
  // extra-word check is the precise signal when it is). Deliberately generous (1.9x)
  // with an absolute floor so ordinary slow delivery on a short chunk isn't caught.
  const MAX_DURATION_FRACTION = 1.9;
  const MAX_DURATION_FLOOR_SEC = 1.5;
  const expectedDurationSec = Math.max(0.3, Math.min(20, expectedText.length / NATURAL_CHARS_PER_SEC));
  // A measured voice pace may only RELAX each bound: a fast speaker lowers the
  // too-short floor, a slow speaker raises the too-long ceiling. Never stricter.
  const voicePace = Number.isFinite(charsPerSec) && charsPerSec > 0 ? charsPerSec : NATURAL_CHARS_PER_SEC;
  const shortExpectedSec = Math.max(0.3, Math.min(20, expectedText.length / Math.max(NATURAL_CHARS_PER_SEC, voicePace)));
  const longExpectedSec = Math.max(0.3, Math.min(20, expectedText.length / Math.min(NATURAL_CHARS_PER_SEC, voicePace)));

  let sampleCount = 0;
  let absPeak = 0;
  let rmsSum = 0;
  let zeroishCount = 0;
  let clippedCount = 0;

  let currentQuietRun = 0;
  let longestQuietRun = 0;

  if (wav.audioFormat === 1 && wav.bitsPerSample === 16) {
    for (let offset = 0; offset + 1 < bytes.length; offset += bytesPerSample) {
      const sample = bytes.readInt16LE(offset) / 32768;
      const abs = Math.abs(sample);

      absPeak = Math.max(absPeak, abs);
      rmsSum += sample * sample;

      if (abs < 0.002) zeroishCount += 1;
      if (abs > 0.98) clippedCount += 1;

      if (abs < 0.0035) {
        currentQuietRun += 1;
        if (currentQuietRun > longestQuietRun) {
          longestQuietRun = currentQuietRun;
        }
      } else {
        currentQuietRun = 0;
      }

      sampleCount += 1;
    }
  } else if (wav.audioFormat === 3 && wav.bitsPerSample === 32) {
    for (let offset = 0; offset + 3 < bytes.length; offset += bytesPerSample) {
      const sample = bytes.readFloatLE(offset);
      const abs = Math.abs(sample);

      absPeak = Math.max(absPeak, abs);
      rmsSum += sample * sample;

      if (abs < 0.002) zeroishCount += 1;
      if (abs > 0.98) clippedCount += 1;

      if (abs < 0.0035) {
        currentQuietRun += 1;
        if (currentQuietRun > longestQuietRun) {
          longestQuietRun = currentQuietRun;
        }
      } else {
        currentQuietRun = 0;
      }

      sampleCount += 1;
    }
  } else {
    return {
      ok: buffer.length > 44,
      durationSec,
      reason: null,
      metrics: { unsupportedAnalysisFormat: true, bitsPerSample: wav.bitsPerSample, audioFormat: wav.audioFormat },
    };
  }

  const rms = sampleCount > 0 ? Math.sqrt(rmsSum / sampleCount) : 0;
  const zeroishRatio = sampleCount > 0 ? zeroishCount / sampleCount : 1;
  const clippedRatio = sampleCount > 0 ? clippedCount / sampleCount : 0;
  const longestQuietSec = longestQuietRun / wav.sampleRate;

  // Detect repetitive looping patterns by comparing short windows of audio.
  // A looping stutter repeats the same waveform segment many times, yielding
  // high autocorrelation at a short lag.
  let loopScore = 0;
  if (wav.audioFormat === 1 && wav.bitsPerSample === 16 && sampleCount > 0) {
    // Use a window of ~30ms (typical phoneme length) and check correlation
    const windowFrames = Math.round(0.03 * wav.sampleRate);
    const stepFrames = windowFrames;
    const totalWindows = Math.floor(sampleCount / windowFrames);

    if (totalWindows >= 6) {
      let matchingPairs = 0;
      let totalPairs = 0;

      for (let w = 0; w < totalWindows - 1; w++) {
        const offsetA = w * windowFrames * 2; // 2 bytes per sample (PCM16)
        const offsetB = (w + 1) * windowFrames * 2;
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < windowFrames; i++) {
          const posA = offsetA + i * 2;
          const posB = offsetB + i * 2;
          if (posA + 1 >= bytes.length || posB + 1 >= bytes.length) break;
          const a = bytes.readInt16LE(posA);
          const b = bytes.readInt16LE(posB);
          dotProduct += a * b;
          normA += a * a;
          normB += b * b;
        }

        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        if (denom > 0) {
          const correlation = dotProduct / denom;
          if (correlation > 0.85) matchingPairs++;
          totalPairs++;
        }
      }

      if (totalPairs > 0) {
        loopScore = matchingPairs / totalPairs;
      }
    }
  }

  let reason = null;
  if (durationSec < shortExpectedSec * REQUIRED_DURATION_FRACTION) {
    reason = `Audio too short for its text — likely dropped words (${durationSec.toFixed(2)}s vs ~${shortExpectedSec.toFixed(1)}s expected)`;
  } else if (durationSec > MAX_DURATION_FLOOR_SEC && durationSec > longExpectedSec * MAX_DURATION_FRACTION) {
    reason = `Audio too long for its text — likely repeated words (${durationSec.toFixed(2)}s vs ~${longExpectedSec.toFixed(1)}s expected)`;
  } else if (rms < 0.003 && absPeak < 0.003) {
    reason = 'Generated audio is effectively silent';
  } else if (zeroishRatio > 0.995) {
    reason = 'Generated audio contains almost no speech energy';
  } else if (clippedRatio > 0.2) {
    reason = 'Generated audio appears heavily clipped or corrupted';
  } else if (durationSec > 1.2 && longestQuietSec > 2.0) {
    reason = `Generated audio contains a long internal pause (${longestQuietSec.toFixed(2)}s)`;
  } else if (loopScore > 0.5) {
    // Lowered from 0.6: the dragging "aaaa" / laughing drone is a repetition loop,
    // and 0.6 let milder (but still audible) loops through. 0.5 catches them while
    // staying above the autocorrelation of normal sustained vowels.
    reason = `Audio appears to contain repetitive looping (score: ${loopScore.toFixed(2)})`;
  }

  return {
    ok: !reason,
    durationSec,
    reason,
    metrics: { rms, absPeak, zeroishRatio, clippedRatio, longestQuietSec, loopScore, expectedDurationSec },
  };
}

export function buildAttemptVariants(baseParams, attemptIndex) {
  // Scheduler/session metadata must never be forwarded to GPT-SoVITS' /tts schema.
  const { voice_model: _voiceModel, ...synthesisBaseParams } = baseParams;
  const speed = clampNumber(baseParams.speed_factor, 1);

  const requestedSeed = Number(baseParams.seed);
  const baseSeed = Number.isInteger(requestedSeed) && requestedSeed >= 0
    ? requestedSeed
    : Number.parseInt(crypto.randomUUID().replace(/-/g, '').slice(0, 8), 16);

  const safeRepPenalty = clampNumber(baseParams.repetition_penalty, 1.35);

  // Base comma/clause pause (GPT-SoVITS fragment_interval). Configurable via
  // COMMA_PAUSE_SECONDS; a caller-supplied value still wins. Retries nudge it up.
  const baseInterval = clampNumber(baseParams.fragment_interval, COMMA_PAUSE_SECONDS);

  const base = {
    ...synthesisBaseParams,
    aux_ref_audio_paths: baseParams.aux_ref_audio_paths || [],
    seed: baseSeed,
    // cut0 = "no forced split": feed the whole chunk in and let the model decide its
    // own pauses, the same as Live Fast (lambda/live sends cut0). cut5 forced a
    // deterministic pause at EVERY comma, which the user confirmed sounds robotic /
    // choppy for Live Full; cut0 gives natural prosody. Chunks are kept short (~2-3
    // sentences) so cut0's pacing stays controlled without forced fragment pauses.
    text_split_method: baseParams.text_split_method || 'cut0',
    batch_size: 1,
    streaming_mode: false,
    split_bucket: true,
    parallel_infer: false,
    fragment_interval: baseInterval,
    repetition_penalty: safeRepPenalty,
    speed_factor: speed,
  };

  // Best-of-N strategy (voice-faithful): every take keeps the natural quality
  // parameters (temperature, top_k, top_p, cut0, repetition_penalty) — identical to
  // the Live Fast settings that pronounce correctly — and varies ONLY the seed. Each
  // take is a full, faithful read; the caller keeps generating (up to retryCount)
  // Full/Queue evaluate the complete five-take tournament; other callers may still
  // early-accept. Nothing about HOW the model speaks changes between takes, so the
  // cloned voice never drifts.

  if (attemptIndex === 0) {
    return base;
  }

  // Deterministic, well-spread seed offsets so each take explores a genuinely
  // different generation without changing any voice-shaping parameter.
  const SEED_OFFSETS = [0, 17, 31, 47, 67, 89];
  const seedOffset = attemptIndex < SEED_OFFSETS.length
    ? SEED_OFFSETS[attemptIndex]
    : SEED_OFFSETS[SEED_OFFSETS.length - 1] + attemptIndex;

  return {
    ...base,
    seed: (baseSeed + seedOffset) >>> 0,
    // Keep repetition_penalty pinned at the base (1.35), like Live Fast. Relaxing it
    // toward 1.0 to "reduce clipping" was what invited the "barrels of barrels" /
    // "darrels of darrels" repetition; Live Fast never relaxes it and never stutters.
    // Retries now vary ONLY the seed — a genuinely different read, no degeneration.
    repetition_penalty: safeRepPenalty,
    // Tiny pause nudge only; does not alter the voice.
    fragment_interval: baseInterval + 0.01 * attemptIndex,
  };
}

export function scoreAudioCandidate(analysis, verification = null) {
  const metrics = analysis?.metrics || {};
  const rms = clampNumber(metrics.rms, 0);
  const zeroishRatio = clampNumber(metrics.zeroishRatio, 1);
  const clippedRatio = clampNumber(metrics.clippedRatio, 1);
  const longestQuietSec = clampNumber(metrics.longestQuietSec, 99);
  const loopScore = clampNumber(metrics.loopScore, 1);
  const durationSec = clampNumber(analysis?.durationSec, 0);
  const expectedDurationSec = Math.max(0.1, clampNumber(metrics.expectedDurationSec, durationSec || 0.1));
  const durationRatio = durationSec / expectedDurationSec;
  const naturalPaceBonus = Math.max(0, 2.5 - Math.abs(Math.log(Math.max(0.01, durationRatio))) * 3);

  const absPeak = clampNumber(metrics.absPeak, 0);
  // A clear repetition loop (the dragging "aaaa" / laughing drone) is as
  // unacceptable as silence — rank it down in the deeply-negative band so a
  // best-effort fallback prefers ANY non-looping take and never ships the loop
  // unless every single take looped.
  if ((rms < 0.003 && absPeak < 0.003) || zeroishRatio > 0.995 || clippedRatio > 0.2 || loopScore > 0.5) {
    // Unacceptable audio still earns a finite, comparable score (deeply negative,
    // ordered by residual energy) so a last-resort fallback can pick the
    // least-bad take instead of discarding them all and aborting the whole job.
    return -1000 + Math.min(rms * 100, 1) + Math.min(absPeak * 100, 1) - clippedRatio;
  }

  // Word coverage (when ASR verification ran) dominates the comparison: among
  // takes with acceptable audio, the one that actually spoke the most of the
  // intended words wins, so the best-effort fallback never keeps a take that
  // dropped words when a more complete one exists. Speaker similarity is a
  // secondary tie-breaker so, between two equally complete takes, the one that
  // sounds most like the reference voice is preferred.
  const coverageBonus = verification ? clampNumber(verification.coverage, 1) * 10 : 0;
  const similarityBonus = Number.isFinite(verification?.similarity)
    ? clampNumber(verification.similarity, 0) * 8
    : 0;

  // A half-cut word PASSES coverage (Whisper fills it in from context), so coverage
  // alone can't tell a clipped take from a clean one — they tie, and noise decides
  // which ships. That's why a best-effort fallback was landing on a clipped take
  // even when a clean one was in the same batch. Penalize the explicit clipped /
  // missing word lists so the cleanest take wins decisively. Clipped is weighted
  // heaviest: it's the exact "half-said word" defect we're trying not to ship.
  const clippedCount = verification?.suspectWords?.length || 0;
  const missingCount = verification?.missingWords?.length || 0;
  const clippedWordPenalty = clippedCount * 6;
  const missingWordPenalty = missingCount * 4;

  // A double-read (a surplus of an intended word) passes coverage — every expected
  // word is present — so without this a doubled-but-complete take could out-score a
  // clean one and be shipped as best-effort. Penalize it like a missing word so the
  // clean take always wins when both exist.
  const extraCount = verification?.extraWords?.length || 0;
  const extraWordPenalty = extraCount * 4;

  // A consecutive double-read ("cell one cell one") is the defect the extra-word
  // surplus can miss entirely (doubled number words are uncountable there). Weight it
  // like a clipped word so a best-effort fallback never prefers a stuttering take.
  const repeatedCount = verification?.repeatedPhrases?.length || 0;
  const repeatedPhrasePenalty = repeatedCount * 6;

  // The verifier reports single-word echoes separately from phrase-level repeats.
  // They also preserve 100% coverage, so include them explicitly in fallback
  // ranking; otherwise a take rejected for "treatment and treatment" can still
  // beat a clean take when the normal retry budget is exhausted.
  const duplicatedCount = verification?.duplicatedWords?.length || 0;
  const duplicatedWordPenalty = duplicatedCount * 6;

  // When all Full takes miss the strict bar and best-effort must choose one,
  // prefer a take whose independently measured technical-word phones were closer
  // to the saved dictionary pronunciation. A clear reject gets the full penalty;
  // uncertainty gets only a small ranking nudge because it is not evidence of a
  // bad pronunciation and must never behave like a hard failure.
  const failedPhonemeAssessments = (verification?.phonemeAssessments || [])
    .filter((assessment) => assessment?.decision === 'reject'
      || (assessment?.decision == null && assessment?.ok === false && !assessment?.inconclusive));
  const phonemePenalty = failedPhonemeAssessments.reduce((penalty, assessment) => (
    penalty + 8 + ((1 - clampNumber(assessment?.similarity, 0)) * 4)
  ), 0) + (verification?.phonemeAssessments || [])
    .filter((assessment) => assessment?.decision === 'uncertain')
    .length * 2;

  return (
    coverageBonus
    + similarityBonus
    + naturalPaceBonus
    + Math.min(rms * 20, 3)
    - clippedWordPenalty
    - missingWordPenalty
    - extraWordPenalty
    - repeatedPhrasePenalty
    - duplicatedWordPenalty
    - phonemePenalty
    - (zeroishRatio * 2)
    - (clippedRatio * 8)
    - Math.max(0, longestQuietSec - 1.4)
    - (loopScore * 3)
  );
}

// Apply the custom comma breath to a finished take, if enabled and we have the
// Whisper word timings from verification. No-op (returns audio unchanged) otherwise,
// so the non-verified path just keeps plain cut0.
function withCommaPauses(audioBuffer, chunkText, verification, options) {
  const pauseMs = clampNumber(options.commaPauseMs, 0);
  if (!(pauseMs > 0)) return audioBuffer;
  const words = verification && Array.isArray(verification.words) ? verification.words : [];
  const { audioBuffer: out, inserted, reason } = computeCommaPauses(audioBuffer, chunkText, words, pauseMs);
  const preview = chunkText.slice(0, 50);
  if (inserted > 0) {
    console.log(`[comma-pause] inserted ${inserted} breath(s) @${pauseMs}ms into "${preview}"`);
  } else if (reason && reason !== 'no-comma' && reason !== 'disabled') {
    // 'no-comma'/'disabled' are normal and silent; log only the informative skips
    // (esp. word-count-drift / no-timings) so a missing pause is explainable.
    console.log(`[comma-pause] skipped (${reason}) for "${preview}"`);
  }
  return out;
}

async function synthesizeChunkWithRetry(chunkText, baseParams, options = {}) {
  const retryCount = Math.max(0, clampNumber(options.retryCount, DEFAULTS.retryCount));
  const totalTakeCount = retryCount + 1;
  const initialTakeCount = Math.min(
    totalTakeCount,
    Math.max(1, Math.round(clampNumber(options.initialTakeCount, 3))),
  );
  const allowBestEffortFallback = Boolean(options.allowBestEffortFallback);
  const verifyChunk = typeof options.verifyChunk === 'function' ? options.verifyChunk : null;
  let lastError = null;
  let bestCandidate = null;
  let bestVerifiedCandidate = null;
  let verifiedCandidateCount = 0;

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    const paddedText = `${chunkText.trim()} `;
    const params = buildAttemptVariants({ ...baseParams, text: paddedText }, attempt);
    try {
      const audioBuffer = await inferenceServer.synthesize(params, { timeoutMs: 180000 });
      const analysis = analyzeAudioQuality(audioBuffer, chunkText, {
        charsPerSec: estimateReferenceCharsPerSec(baseParams.ref_audio_path, baseParams.prompt_text),
      });

      // Only spend ASR on takes whose audio already looks usable; a silent or
      // clipped take is rejected by analysis alone and needs no transcript.
      let verification = null;
      if (verifyChunk && analysis.ok) {
        verification = await verifyChunk(audioBuffer, chunkText);
      }

      const score = scoreAudioCandidate(analysis, verification);
      if (!bestCandidate || score > bestCandidate.score) {
        bestCandidate = { audioBuffer, analysis, verification, paramsUsed: params, attempts: attempt + 1, score };
      }
      if (!analysis.ok) {
        throw new Error(analysis.reason);
      }
      // A different synthesis take cannot repair an unavailable ASR sidecar. Retrying
      // here previously spent up to five GPU generations, each followed by the same
      // verifier timeout, before returning best effort anyway. Keep the first
      // acoustically usable take and surface that verification was unavailable.
      if (verification?.verificationUnavailable) {
        return {
          audioBuffer: withCommaPauses(audioBuffer, chunkText, verification, options),
          analysis,
          verification,
          paramsUsed: params,
          attempts: attempt + 1,
          fallback: true,
          fallbackReason: 'Transcription verification unavailable; kept the strongest usable take.',
        };
      }
      if (verification && !verification.ok) {
        const missing = verification.missingWords.slice(0, 6).join(', ');
        const clipped = (verification.suspectWords || []).slice(0, 6).join(', ');
        const doubled = (verification.repeatedPhrases || []).slice(0, 6).join(' | ');
        const phonemeRejected = (verification.phonemeAssessments || [])
          .filter(assessment => assessment?.decision === 'reject')
          .map(assessment => assessment.word)
          .filter(Boolean)
          .slice(0, 6)
          .join(', ');
        const phonemeUncertain = (verification.phonemeAssessments || [])
          .filter(assessment => assessment?.decision === 'uncertain')
          .map(assessment => assessment.word)
          .filter(Boolean)
          .slice(0, 6)
          .join(', ');
        const voiceDrift = verification.similarityOk === false
          ? `voice drift (similarity ${(clampNumber(verification.similarity, 0) * 100).toFixed(0)}%)`
          : '';
        const unavailable = verification.verificationUnavailable
          ? 'transcription verification unavailable'
          : '';
        const speakerUnavailable = verification.speakerVerificationUnavailable
          ? 'voice verification unavailable'
          : '';
        const detail = [
          missing ? `missing: ${missing}` : '',
          clipped ? `clipped: ${clipped}` : '',
          doubled ? `doubled: ${doubled}` : '',
          phonemeRejected ? `phoneme mismatch: ${phonemeRejected}` : '',
          phonemeUncertain ? `phoneme uncertain: ${phonemeUncertain}` : '',
          voiceDrift,
          unavailable,
          speakerUnavailable,
        ].filter(Boolean).join('; ');
        throw new Error(
          `Take rejected — covered ${(verification.coverage * 100).toFixed(0)}% of the text`
          + (detail ? ` (${detail})` : ''),
        );
      }
      if (options.selectBestVerifiedCandidate) {
        verifiedCandidateCount += 1;
        if (!bestVerifiedCandidate || score > bestVerifiedCandidate.score) {
          bestVerifiedCandidate = { audioBuffer, analysis, verification, paramsUsed: params, score };
        }
        // Evaluate/rank three takes in the normal case. Only when none of those three
        // passes do we spend takes four and five; after escalation the full set runs.
        if (attempt + 1 === initialTakeCount && bestVerifiedCandidate) {
          return {
            audioBuffer: withCommaPauses(
              bestVerifiedCandidate.audioBuffer,
              chunkText,
              bestVerifiedCandidate.verification,
              options,
            ),
            analysis: bestVerifiedCandidate.analysis,
            verification: bestVerifiedCandidate.verification,
            paramsUsed: bestVerifiedCandidate.paramsUsed,
            attempts: attempt + 1,
            verifiedCandidateCount,
            tournament: true,
          };
        }
        continue;
      }
      const paused = withCommaPauses(audioBuffer, chunkText, verification, options);
      return { audioBuffer: paused, analysis, verification, paramsUsed: params, attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
    }
  }

  if (bestVerifiedCandidate) {
    return {
      audioBuffer: withCommaPauses(
        bestVerifiedCandidate.audioBuffer,
        chunkText,
        bestVerifiedCandidate.verification,
        options,
      ),
      analysis: bestVerifiedCandidate.analysis,
      verification: bestVerifiedCandidate.verification,
      paramsUsed: bestVerifiedCandidate.paramsUsed,
      attempts: totalTakeCount,
      verifiedCandidateCount,
      tournament: true,
    };
  }

  if (
    allowBestEffortFallback
    && bestCandidate?.analysis?.ok
  ) {
    return {
      audioBuffer: withCommaPauses(bestCandidate.audioBuffer, chunkText, bestCandidate.verification, options),
      analysis: bestCandidate.analysis,
      verification: bestCandidate.verification,
      paramsUsed: bestCandidate.paramsUsed,
      attempts: totalTakeCount,
      fallback: true,
      fallbackReason: lastError?.message || bestCandidate.analysis?.reason || 'Used best available chunk candidate',
    };
  }

  // Carry the best audio on the error for explicitly best-effort callers. Strict
  // Live Full/Queue callers ignore it and surface a failed completeness check.
  const failure = lastError || new Error('Chunk synthesis failed');
  if (bestCandidate) failure.bestCandidate = bestCandidate;
  throw failure;
}

// Synthesize one chunk (1-3 sentences) reliably WITHOUT ever splitting below a
// sentence. Sub-sentence fragmenting was removed: independently generated fragments
// differ in pitch/energy so joining them mid-clause produced audible seams, and the
// lost context degraded pronunciation. Order:
//   (1) rank three whole-chunk takes; expand to five only when none passes;
//   (2) on failure, split at SENTENCE boundaries only and run the same 3→5 ladder;
//   (3) if a sentence still has no passing take, use its strongest usable full-sentence
//       candidate, then stitch every sentence in order. No partial span can replace one.
async function synthesizeChunkResilient(chunkText, baseParams, options = {}, { onSplit } = {}) {
  // A trailing SSML break sentinel is a routing hint for the pause stage, not text to
  // speak — strip it before anything reaches the model, ASR, or the sentence splitter.
  const cleanText = stripBreakSentinels(chunkText);
  const escalate = { ...options, allowBestEffortFallback: false };
  let lastError = null;
  let wholeBestCandidate = null;
  const totalTakeCount = Math.max(1, Math.round(clampNumber(options.retryCount, DEFAULTS.retryCount)) + 1);

  const useBestCandidate = (candidate, text) => {
    if (
      !candidate?.analysis?.ok
      || !Buffer.isBuffer(candidate.audioBuffer)
    ) return null;
    return {
      audioBuffer: withCommaPauses(candidate.audioBuffer, text, candidate.verification, options),
      attempts: totalTakeCount,
      analysis: candidate.analysis,
      fallback: true,
    };
  };

  // Pass 1: rank three whole-chunk takes; spend takes four and five only if needed.
  try {
    const result = await synthesizeChunkWithRetry(cleanText, { ...baseParams, text: cleanText }, escalate);
    return {
      audioBuffer: result.audioBuffer,
      attempts: result.attempts,
      analysis: result.analysis,
      fallback: result.fallback,
      fallbackReason: result.fallbackReason,
    };
  } catch (err) {
    lastError = err;
    wholeBestCandidate = err.bestCandidate || null;
  }

  const sentences = splitIntoSentences(cleanText);

  // Pass 2: sentence-boundary split. Each WHOLE sentence gets its own adaptive 3→5
  // tournament. If none passes after five, keep that sentence's strongest usable
  // candidate so every sentence is still represented in the final stitched chunk.
  if (sentences.length >= 2) {
    if (onSplit) onSplit(sentences);
    try {
      const buffers = [];
      let attempts = 0;
      let usedFallback = false;
      const fallbackReasons = [];
      for (const sentence of sentences) {
        let r;
        try {
          r = await synthesizeChunkWithRetry(sentence, { ...baseParams, text: sentence }, escalate);
        } catch (sentenceError) {
          if (!options.allowBestEffortFallback) throw sentenceError;
          r = useBestCandidate(sentenceError.bestCandidate, sentence);
          if (!r) throw sentenceError;
          usedFallback = true;
          fallbackReasons.push(sentenceError.message);
        }
        buffers.push(r.audioBuffer);
        attempts += r.attempts;
      }
      const audioBuffer = concatWavs(buffers, computeChunkPauses(sentences), computeChunkFades(sentences));
      if (usedFallback) {
        console.warn(
          `[inference] stitched strongest full-sentence candidates after adaptive retries; `
          + `text="${cleanText.slice(0, 80)}"`,
        );
      }
      return {
        audioBuffer,
        attempts,
        split: true,
        fallback: usedFallback,
        fallbackReason: usedFallback ? fallbackReasons.join(' | ') : undefined,
      };
    } catch (err) {
      lastError = err;
    }
  }

  // A one-sentence primary chunk has already completed the same 3→5 ladder, so do
  // not synthesize five duplicate takes again. Reuse the strongest usable candidate.
  if (options.allowBestEffortFallback) {
    const fallback = useBestCandidate(wholeBestCandidate, cleanText);
    if (fallback) {
      console.warn(
        `[inference] kept strongest full-sentence candidate after adaptive retries: `
        + `${lastError?.message}; text="${cleanText.slice(0, 80)}"`,
      );
      return { ...fallback, split: false, fallbackReason: lastError?.message };
    }
  }

  const detail = lastError?.message ? ` Last rejection: ${lastError.message}` : '';
  throw new Error(`Could not produce a usable full-sentence reading after all retries.${detail}`);
}

export function cancelSession(sessionId) {
  const session = activeSessions.get(sessionId);
  if (session) {
    session.cancelled = true;
    return true;
  }
  return false;
}

export function hasActiveInferenceSession(sessionId = null) {
  if (sessionId) {
    return activeSessions.has(sessionId);
  }
  return activeSessions.size > 0;
}

function getSessionDir(sessionId) {
  return path.join(TEMP_DIR, 'inference', sessionId);
}

export function getSessionFinalPath(sessionId) {
  return path.join(getSessionDir(sessionId), 'final.wav');
}

export function getSessionChunkPath(sessionId, index) {
  return path.join(getSessionDir(sessionId), `chunk_${String(index).padStart(3, '0')}.wav`);
}

export function getSessionChunkPreviewPath(sessionId, index) {
  return path.join(getSessionDir(sessionId), `chunk_preview_${String(index).padStart(3, '0')}.wav`);
}

function getSessionChunkVersionDir(sessionId, index) {
  return path.join(getSessionDir(sessionId), 'chunk_versions', String(index));
}

export function getSessionChunkVersionPath(sessionId, index, versionId) {
  return path.join(getSessionChunkVersionDir(sessionId, index), `${versionId}.wav`);
}

function archiveChunkVersion(sessionId, index, audioBuffer, {
  text = '',
  displayText = '',
  fallback = false,
  fallbackReason = '',
} = {}) {
  const versionId = crypto.randomUUID();
  const versionDir = getSessionChunkVersionDir(sessionId, index);
  fs.mkdirSync(versionDir, { recursive: true });
  fs.writeFileSync(getSessionChunkVersionPath(sessionId, index, versionId), audioBuffer);
  return {
    id: versionId,
    text,
    displayText: displayText || renderBreakSentinels(text),
    fallback,
    fallbackReason,
    createdAt: new Date().toISOString(),
  };
}

function publicChunkVersions(manifest, index) {
  return Array.isArray(manifest.chunkVersions?.[index])
    ? manifest.chunkVersions[index].map(({ id, displayText, fallback, fallbackReason, createdAt }) => ({
      id,
      text: displayText,
      fallback: fallback === true,
      fallbackReason: fallbackReason || '',
      createdAt,
    }))
    : [];
}

function clearChunkVersions(sessionId, manifest) {
  const versionsDir = path.join(getSessionDir(sessionId), 'chunk_versions');
  if (fs.existsSync(versionsDir)) fs.rmSync(versionsDir, { recursive: true, force: true });
  delete manifest.chunkVersions;
}

function writeNormalizedChunkPreviews(sessionId, chunkBuffers) {
  normalizeWavChunksForPreview(chunkBuffers).forEach((buffer, index) => {
    fs.writeFileSync(getSessionChunkPreviewPath(sessionId, index), buffer);
  });
}

function getSessionManifestPath(sessionId) {
  return path.join(getSessionDir(sessionId), 'session.json');
}

export function getLongTextSessionMetadata(sessionId) {
  const manifestPath = getSessionManifestPath(sessionId);
  if (!fs.existsSync(manifestPath)) throw new Error('Generation session is no longer available');
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

export async function requestSessionCancellation(sessionId) {
  cancelSession(sessionId);
  await uploadBuffer(
    `audio/output/${sessionId}/cancel.requested`,
    Buffer.from(new Date().toISOString()),
    'text/plain',
  );
  return true;
}

export async function hydrateLongTextSession(sessionId) {
  const sessionDir = getSessionDir(sessionId);
  const manifestPath = getSessionManifestPath(sessionId);
  if (fs.existsSync(manifestPath)) return getLongTextSessionMetadata(sessionId);

  const prefix = `audio/output/${sessionId}/`;
  const objects = await listObjects(prefix);
  const transferable = objects.filter((item) => {
    const relative = item.key.slice(prefix.length);
    return relative === 'session.json'
      || relative === 'final.wav'
      || /^chunk_(?:preview_)?\d+\.wav$/u.test(relative)
      || /^chunk_versions\/\d+\/[A-Za-z0-9-]+\.wav$/u.test(relative);
  });
  if (!transferable.some((item) => item.key.endsWith('/session.json'))) {
    throw new Error('Generation session is no longer available');
  }

  fs.mkdirSync(sessionDir, { recursive: true });
  await Promise.all(transferable.map(async (item) => {
    const relative = item.key.slice(prefix.length);
    const localPath = path.join(sessionDir, ...relative.split('/'));
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, await getObject(item.key));
  }));
  return getLongTextSessionMetadata(sessionId);
}

export async function persistLongTextSession(sessionId) {
  const sessionDir = getSessionDir(sessionId);
  if (!fs.existsSync(sessionDir)) return;
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(entryPath) : [entryPath];
  });
  await Promise.all(walk(sessionDir).map((filePath) => {
    const relative = path.relative(sessionDir, filePath).split(path.sep).join('/');
    const contentType = relative.endsWith('.json') ? 'application/json' : 'audio/wav';
    return uploadBuffer(
      `audio/output/${sessionId}/${relative}`,
      fs.readFileSync(filePath),
      contentType,
    );
  }));
}

export async function synthesizeBreakAwareFullChunk(
  chunkText,
  baseParams,
  options = {},
  { synthesizeChunk = synthesizeChunkResilient, onSplit = null } = {},
) {
  const { speechText, leadingBreakMs, trailingBreakMs } = partitionBreaks(chunkText);
  // Admin regeneration is an explicit request to replace exactly one review card.
  // Keep that edited text as one synthesis unit instead of reapplying initial-run
  // chunk sizing or dictionary-tail context rules. The resilient synthesizer below
  // still provides Full's normal verification, 3→5 retry ladder, and final fallback.
  const synthesisChunks = options.preserveReviewUnit
    ? [speechText.trim()].filter(Boolean)
    : splitTextIntoChunks(speechText, options);
  if (synthesisChunks.length === 0) throw new Error('No text to synthesize');

  const buffers = [];
  let attempts = 0;
  let usedFallback = false;
  const fallbackReasons = [];
  let singleAnalysis = null;
  for (const synthesisChunk of synthesisChunks) {
    const result = await synthesizeChunk(
      synthesisChunk,
      { ...baseParams, text: synthesisChunk },
      options,
      { onSplit },
    );
    buffers.push(result.audioBuffer);
    attempts += result.attempts;
    singleAnalysis = synthesisChunks.length === 1 ? result.analysis : null;
    if (result.fallback) {
      usedFallback = true;
      if (result.fallbackReason) fallbackReasons.push(result.fallbackReason);
    }
  }

  const joined = buffers.length === 1
      ? buffers[0]
      : concatWavs(
        buffers,
        computeChunkPauses(synthesisChunks, clampNumber(options.chunkJoinPauseMs, DEFAULTS.chunkJoinPauseMs)),
        computeChunkFades(synthesisChunks),
      );
  const padded = padWavBoundaries(joined, leadingBreakMs, trailingBreakMs);
  return {
    audioBuffer: applyWavOutputGain(padded, options.outputGainDb),
    attempts,
    synthesisChunks,
    analysis: singleAnalysis,
    fallback: usedFallback,
    fallbackReason: usedFallback ? fallbackReasons.join(' | ') : undefined,
  };
}

export function serializableSessionOptions(options = {}) {
  return Object.fromEntries(
    SESSION_OPTION_KEYS
      .filter(key => ['number', 'boolean'].includes(typeof options[key]))
      .map(key => [key, options[key]]),
  );
}

export async function regenerateLongTextChunk(
  sessionId,
  index,
  options = {},
  replacementText = '',
  replacementDisplayText = '',
  previousDisplayText = '',
  previousFallback = false,
  previousFallbackReason = '',
) {
  const manifest = getLongTextSessionMetadata(sessionId);
  const chunks = Array.isArray(manifest.chunks) ? manifest.chunks : [];
  const chunkIndex = Number(index);
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= chunks.length) {
    throw new Error('Invalid chunk index');
  }

  // Keep SSML break sentinels in the stored synthesis text. They are routing metadata
  // for the shared Full chunk/pause pipeline and are stripped only before model/ASR.
  const editedText = String(replacementText || '').trim();
  const chunkText = editedText || chunks[chunkIndex];
  const params = manifest.params || {};
  const result = await synthesizeBreakAwareFullChunk(
    chunkText,
    { ...params, text: chunkText },
    { ...options, preserveReviewUnit: true },
  );
  const chunkPath = getSessionChunkPath(sessionId, chunkIndex);
  if (!fs.existsSync(chunkPath)) throw new Error(`Chunk ${chunkIndex + 1} is unavailable`);
  const previousVersion = archiveChunkVersion(sessionId, chunkIndex, fs.readFileSync(chunkPath), {
    text: chunks[chunkIndex],
    displayText: String(previousDisplayText || '').trim() || renderBreakSentinels(chunks[chunkIndex]),
    fallback: previousFallback,
    fallbackReason: previousFallbackReason,
  });
  manifest.chunkVersions ||= {};
  manifest.chunkVersions[chunkIndex] ||= [];
  manifest.chunkVersions[chunkIndex].unshift(previousVersion);
  fs.writeFileSync(chunkPath, result.audioBuffer);

  // Commit edited text only after synthesis succeeds. A failed repair leaves the
  // prior manifest and the prior playable audio intact.
  if (editedText) {
    chunks[chunkIndex] = editedText;
    manifest.chunks = chunks;
  }
  fs.writeFileSync(getSessionManifestPath(sessionId), JSON.stringify(manifest, null, 2));

  const chunkBuffers = chunks.map((_, currentIndex) => {
    const chunkPath = getSessionChunkPath(sessionId, currentIndex);
    if (!fs.existsSync(chunkPath)) throw new Error(`Chunk ${currentIndex + 1} is unavailable`);
    return fs.readFileSync(chunkPath);
  });
  const basePause = clampNumber(options.chunkJoinPauseMs, DEFAULTS.chunkJoinPauseMs);
  const finalBuffer = concatWavs(
    chunkBuffers,
    computeChunkPauses(chunks, basePause),
    computeChunkFades(chunks),
  );
  writeNormalizedChunkPreviews(sessionId, chunkBuffers);
  fs.writeFileSync(getSessionFinalPath(sessionId), finalBuffer);
  await uploadBuffer(`audio/output/${sessionId}/final.wav`, finalBuffer, 'audio/wav');

  return {
    index: chunkIndex,
    text: String(replacementDisplayText || '').trim() || renderBreakSentinels(chunkText),
    attempts: result.attempts,
    fallback: result.fallback,
    fallbackReason: result.fallbackReason,
    versions: publicChunkVersions(manifest, chunkIndex),
    revision: Date.now(),
  };
}

export async function restoreLongTextChunkVersion(
  sessionId,
  index,
  versionId,
  options = {},
  currentDisplayText = '',
  currentFallback = false,
  currentFallbackReason = '',
) {
  const manifest = getLongTextSessionMetadata(sessionId);
  const chunks = Array.isArray(manifest.chunks) ? [...manifest.chunks] : [];
  const chunkIndex = Number(index);
  const versions = Array.isArray(manifest.chunkVersions?.[chunkIndex])
    ? [...manifest.chunkVersions[chunkIndex]]
    : [];
  const versionIndex = versions.findIndex(version => version.id === versionId);
  if (versionIndex < 0) throw new Error('Chunk version is no longer available');
  const selectedVersion = versions[versionIndex];
  const selectedPath = getSessionChunkVersionPath(sessionId, chunkIndex, versionId);
  if (!fs.existsSync(selectedPath)) throw new Error('Chunk version is no longer available');

  const chunkPath = getSessionChunkPath(sessionId, chunkIndex);
  if (!fs.existsSync(chunkPath)) throw new Error(`Chunk ${chunkIndex + 1} is unavailable`);
  const displacedVersion = archiveChunkVersion(sessionId, chunkIndex, fs.readFileSync(chunkPath), {
    text: chunks[chunkIndex],
    displayText: currentDisplayText,
    fallback: currentFallback,
    fallbackReason: currentFallbackReason,
  });
  fs.writeFileSync(chunkPath, fs.readFileSync(selectedPath));
  fs.unlinkSync(selectedPath);

  chunks[chunkIndex] = selectedVersion.text;
  versions.splice(versionIndex, 1);
  versions.unshift(displacedVersion);
  manifest.chunks = chunks;
  manifest.chunkVersions[chunkIndex] = versions;
  fs.writeFileSync(getSessionManifestPath(sessionId), JSON.stringify(manifest, null, 2));

  const chunkBuffers = chunks.map((_, currentIndex) => fs.readFileSync(getSessionChunkPath(sessionId, currentIndex)));
  const basePause = clampNumber(options.chunkJoinPauseMs, DEFAULTS.chunkJoinPauseMs);
  const finalBuffer = concatWavs(
    chunkBuffers,
    computeChunkPauses(chunks, basePause),
    computeChunkFades(chunks),
  );
  writeNormalizedChunkPreviews(sessionId, chunkBuffers);
  fs.writeFileSync(getSessionFinalPath(sessionId), finalBuffer);
  await uploadBuffer(`audio/output/${sessionId}/final.wav`, finalBuffer, 'audio/wav');

  return {
    index: chunkIndex,
    text: selectedVersion.displayText || renderBreakSentinels(chunks[chunkIndex]),
    fallback: selectedVersion.fallback === true,
    fallbackReason: selectedVersion.fallbackReason || '',
    versions: publicChunkVersions(manifest, chunkIndex),
    revision: Date.now(),
  };
}

export async function deleteLongTextChunk(sessionId, index, options = {}) {
  const manifest = getLongTextSessionMetadata(sessionId);
  const chunks = Array.isArray(manifest.chunks) ? [...manifest.chunks] : [];
  const chunkIndex = Number(index);
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= chunks.length) {
    throw new Error('Invalid chunk index');
  }
  if (chunks.length <= 1) throw new Error('Cannot delete the only audio chunk');

  fs.unlinkSync(getSessionChunkPath(sessionId, chunkIndex));
  for (let currentIndex = chunkIndex + 1; currentIndex < chunks.length; currentIndex += 1) {
    fs.renameSync(getSessionChunkPath(sessionId, currentIndex), getSessionChunkPath(sessionId, currentIndex - 1));
  }
  chunks.splice(chunkIndex, 1);

  const chunkBuffers = chunks.map((_, currentIndex) => fs.readFileSync(getSessionChunkPath(sessionId, currentIndex)));
  const basePause = clampNumber(options.chunkJoinPauseMs, DEFAULTS.chunkJoinPauseMs);
  const finalBuffer = concatWavs(
    chunkBuffers,
    computeChunkPauses(chunks, basePause),
    computeChunkFades(chunks),
  );
  writeNormalizedChunkPreviews(sessionId, chunkBuffers);
  const obsoletePreview = getSessionChunkPreviewPath(sessionId, chunks.length);
  if (fs.existsSync(obsoletePreview)) fs.unlinkSync(obsoletePreview);
  fs.writeFileSync(getSessionFinalPath(sessionId), finalBuffer);
  manifest.chunks = chunks;
  clearChunkVersions(sessionId, manifest);
  fs.writeFileSync(getSessionManifestPath(sessionId), JSON.stringify(manifest, null, 2));
  await uploadBuffer(`audio/output/${sessionId}/final.wav`, finalBuffer, 'audio/wav');

  return {
    deletedIndex: chunkIndex,
    chunks: chunks.map((text, currentIndex) => ({ index: currentIndex, text: renderBreakSentinels(text) })),
    revision: Date.now(),
  };
}

export async function insertLongTextChunk(
  sessionId,
  index,
  options = {},
  insertedText = '',
  insertedDisplayText = '',
) {
  const manifest = getLongTextSessionMetadata(sessionId);
  const chunks = Array.isArray(manifest.chunks) ? [...manifest.chunks] : [];
  const chunkIndex = Number(index);
  const chunkText = String(insertedText || '').trim();
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > chunks.length) {
    throw new Error('Invalid chunk index');
  }
  if (!chunkText) throw new Error('Chunk text is required');

  // Generate and verify before mutating the saved session. This is the same Full
  // synthesis path used by targeted regeneration, including SSML breaks, retries,
  // ASR/phoneme verification, best effort, and quality checks.
  const params = manifest.params || {};
  const result = await synthesizeBreakAwareFullChunk(
    chunkText,
    { ...params, text: chunkText },
    { ...options, preserveReviewUnit: true },
  );

  // Shift from the tail so every existing chunk remains intact while its index moves.
  for (let currentIndex = chunks.length - 1; currentIndex >= chunkIndex; currentIndex -= 1) {
    fs.renameSync(getSessionChunkPath(sessionId, currentIndex), getSessionChunkPath(sessionId, currentIndex + 1));
  }
  fs.writeFileSync(getSessionChunkPath(sessionId, chunkIndex), result.audioBuffer);
  chunks.splice(chunkIndex, 0, chunkText);

  const chunkBuffers = chunks.map((_, currentIndex) => fs.readFileSync(getSessionChunkPath(sessionId, currentIndex)));
  const basePause = clampNumber(options.chunkJoinPauseMs, DEFAULTS.chunkJoinPauseMs);
  const finalBuffer = concatWavs(
    chunkBuffers,
    computeChunkPauses(chunks, basePause),
    computeChunkFades(chunks),
  );
  writeNormalizedChunkPreviews(sessionId, chunkBuffers);
  fs.writeFileSync(getSessionFinalPath(sessionId), finalBuffer);
  manifest.chunks = chunks;
  clearChunkVersions(sessionId, manifest);
  fs.writeFileSync(getSessionManifestPath(sessionId), JSON.stringify(manifest, null, 2));
  await uploadBuffer(`audio/output/${sessionId}/final.wav`, finalBuffer, 'audio/wav');

  return {
    insertedIndex: chunkIndex,
    insertedText: String(insertedDisplayText || '').trim() || renderBreakSentinels(chunkText),
    attempts: result.attempts,
    chunks: chunks.map((text, currentIndex) => ({ index: currentIndex, text: renderBreakSentinels(text) })),
    revision: Date.now(),
  };
}

export async function synthesizeLongTextStreaming(sessionId, params, options = {}) {
  const chunks = splitTextIntoReviewChunks(params.text, options);
  if (chunks.length === 0) {
    inferenceState.setError('No text to synthesize');
    sseManager.send(sessionId, 'error', { message: 'No text to synthesize' });
    // The terminal event is durable in S3. Release local prepared-state so a
    // later reconnect uses shared replay instead of attaching to an empty buffer.
    sseManager.clearSession(sessionId);
    return;
  }

  const sessionDir = getSessionDir(sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const initialManifest = {
    params,
    chunks,
    options: serializableSessionOptions(options),
  };
  const initialManifestBuffer = Buffer.from(JSON.stringify(initialManifest, null, 2));
  fs.writeFileSync(getSessionManifestPath(sessionId), initialManifestBuffer);
  uploadBuffer(
    `audio/output/${sessionId}/session.json`,
    initialManifestBuffer,
    'application/json',
  ).catch((err) => {
    console.error(`[inference] Failed to upload session manifest: ${err.message}`);
  });

  const session = { cancelled: false };
  activeSessions.set(sessionId, session);
  const startTime = Date.now();

  sseManager.send(sessionId, 'inference-start', {
    totalChunks: chunks.length,
    chunks: chunks.map((text, index) => ({ index, text: renderBreakSentinels(text) })),
  });
  inferenceState.setGenerating({ totalChunks: chunks.length });

  const chunkPaths = [];

  try {
    for (let index = 0; index < chunks.length; index++) {
      if (
        session.cancelled
        || await headObject(`audio/output/${sessionId}/cancel.requested`).catch(() => null)
      ) {
        throw new Error('Generation cancelled by user');
      }

      const chunkText = chunks[index];
      const displayText = renderBreakSentinels(chunkText);
      sseManager.send(sessionId, 'chunk-start', {
        index,
        text: displayText,
        totalChunks: chunks.length,
      });
      inferenceState.setChunkStart({
        index,
        text: displayText,
        totalChunks: chunks.length,
      });

      const chunkStart = Date.now();
      const result = await synthesizeBreakAwareFullChunk(
        chunkText,
        { ...params, text: chunkText },
        options,
        { onSplit: (subChunks) => sseManager.send(sessionId, 'chunk-split', { index, originalText: displayText, subChunks }) },
      );
      const chunkBuffer = result.audioBuffer;
      const totalAttempts = result.attempts;
      if (result.fallback) {
        sseManager.send(sessionId, 'chunk-fallback', { index, reason: result.fallbackReason });
      }

      const chunkPath = path.join(sessionDir, `chunk_${String(index).padStart(3, '0')}.wav`);
      fs.writeFileSync(chunkPath, chunkBuffer);
      chunkPaths.push(chunkPath);
      uploadBuffer(
        `audio/output/${sessionId}/chunk_${String(index).padStart(3, '0')}.wav`,
        chunkBuffer,
        'audio/wav',
      ).catch((err) => {
        console.error(`[inference] Failed to upload chunk ${index}: ${err.message}`);
      });

      const chunkDuration = (Date.now() - chunkStart) / 1000;
      sseManager.send(sessionId, 'chunk-complete', {
        index,
        totalChunks: chunks.length,
        attempts: totalAttempts,
        durationSec: parseFloat(chunkDuration.toFixed(2)),
        fallback: result.fallback,
        fallbackReason: result.fallbackReason,
      });
      inferenceState.setChunkComplete({
        index,
        totalChunks: chunks.length,
      });
    }

    // Concatenate all chunk WAVs from disk
    const chunkBuffers = chunkPaths.map(p => fs.readFileSync(p));
    const basePause = clampNumber(options.chunkJoinPauseMs, DEFAULTS.chunkJoinPauseMs);
    const pauses = computeChunkPauses(chunks, basePause);
    const fades = computeChunkFades(chunks);
    const finalBuffer = concatWavs(chunkBuffers, pauses, fades);
    writeNormalizedChunkPreviews(sessionId, chunkBuffers);
    normalizeWavChunksForPreview(chunkBuffers).forEach((buffer, index) => {
      uploadBuffer(
        `audio/output/${sessionId}/chunk_preview_${String(index).padStart(3, '0')}.wav`,
        buffer,
        'audio/wav',
      ).catch((err) => {
        console.error(`[inference] Failed to upload chunk preview ${index}: ${err.message}`);
      });
    });

    const finalPath = path.join(sessionDir, 'final.wav');
    fs.writeFileSync(finalPath, finalBuffer);

    // Upload to S3 for persistence (non-blocking — don't fail the session on S3 error)
    const s3Key = `audio/output/${sessionId}/final.wav`;
    uploadBuffer(s3Key, finalBuffer, 'audio/wav').catch((err) => {
      console.error(`[inference] Failed to upload result to S3: ${err.message}`);
    });

    const totalDuration = (Date.now() - startTime) / 1000;
    sseManager.send(sessionId, 'inference-complete', {
      totalChunks: chunks.length,
      totalDurationSec: parseFloat(totalDuration.toFixed(2)),
      ...(s3Key ? { s3Key } : {}),
    });
    inferenceState.setComplete();
  } catch (err) {
    const status = err.message?.includes('cancelled') ? 'cancelled' : 'error';
    inferenceState.setError(err.message, status);
    sseManager.send(sessionId, 'error', { message: err.message });
  } finally {
    activeSessions.delete(sessionId);
    // `prepareSession` keeps an event sequence even after the original browser
    // disconnects. Leaving it behind makes a post-completion reconnect look local,
    // so addClient opens an empty stream and never replays the S3 terminal event.
    // Once generation is terminal, every reconnect must use durable shared replay.
    sseManager.clearSession(sessionId);
  }
}

export async function synthesizeLongText(params, options = {}) {
  const chunks = splitTextIntoReviewChunks(params.text, options);
  if (chunks.length === 0) {
    throw new Error('No text to synthesize');
  }

  const buffers = [];
  const metadata = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const result = await synthesizeBreakAwareFullChunk(chunk, { ...params, text: chunk }, options);
    buffers.push(result.audioBuffer);
    metadata.push({
      index,
      text: renderBreakSentinels(chunk),
      attempts: result.attempts,
      durationSec: result.analysis?.durationSec ?? 0,
      metrics: result.analysis?.metrics ?? {},
      ...(result.fallback ? { fallback: true } : {}),
    });
  }

  const basePause = clampNumber(options.chunkJoinPauseMs, DEFAULTS.chunkJoinPauseMs);
  const pauses = computeChunkPauses(chunks, basePause);
  const fades = computeChunkFades(chunks);
  const finalBuffer = concatWavs(buffers, pauses, fades);

  return { audioBuffer: finalBuffer, chunks: metadata };
}
