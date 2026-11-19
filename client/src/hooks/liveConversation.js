export const LIVE_TEXT_LANG = 'en';
export const LIVE_REPLY_MODES = {
  full: 'full',
  phrases: 'phrases',
};

export function createLiveSynthesisSnapshot({
  engine = 'fast',
  refParams = null,
  fullRefParams = null,
  voiceProfileId = '',
  voiceModel = null,
} = {}) {
  const activeEngine = engine === 'full' ? 'full' : 'fast';
  const activeRefParams = activeEngine === 'full' ? (fullRefParams || refParams) : refParams;
  if (!activeRefParams) {
    // A saved voice profile carries its own references and the server resolves
    // them per request (lambda/shared/voiceProfileRuntime.js), which is why the
    // page counts such a voice ready before its own reference clip has loaded.
    // Refusing here contradicted that: Send was enabled right after a voice
    // was picked, then failed with "No reference audio configured".
    return { engine: activeEngine, refParams: voiceProfileId ? { voiceProfileId } : null };
  }
  return {
    engine: activeEngine,
    refParams: {
      ...activeRefParams,
      ...(voiceProfileId ? { voiceProfileId } : {}),
      ...(voiceModel?.gptRef && voiceModel?.sovitsRef
        ? { voice_model: { ...voiceModel } }
        : {}),
    },
  };
}

export const LIVE_LANGUAGES = {
  en: 'en',
  zh: 'zh',
};
export const LIVE_LANGUAGE_OPTIONS = [
  { value: LIVE_LANGUAGES.en, label: 'English', replyLabel: 'English replies' },
  { value: LIVE_LANGUAGES.zh, label: 'Chinese', replyLabel: 'Chinese replies' },
];

export function normalizeLiveLanguage(language) {
  return language === LIVE_LANGUAGES.zh ? LIVE_LANGUAGES.zh : LIVE_LANGUAGES.en;
}

export function getLiveLanguageConfig(language) {
  const value = normalizeLiveLanguage(language);
  return LIVE_LANGUAGE_OPTIONS.find((option) => option.value === value) || LIVE_LANGUAGE_OPTIONS[0];
}

export function getLiveTtsLanguage(language) {
  return normalizeLiveLanguage(language) === LIVE_LANGUAGES.zh ? 'all_zh' : LIVE_LANGUAGES.en;
}

const ENGLISH_NUMBER_WORDS = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const ENGLISH_TENS_WORDS = new Set([
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
]);
const ENGLISH_ONES_WORDS = new Set([
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
]);
const ENGLISH_NUMBER_WORD_RE =
  /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[-\s]+(?:one|two|three|four|five|six|seven|eight|nine))?\b/gi;
const LATIN_WORD_RE = /\p{Script=Latin}+(?:[-'’]\p{Script=Latin}+)*/gu;
const QUESTION_START_RE =
  /^(who|what|where|when|why|how|which|whose|can|could|should|would|will|do|does|did|is|are|am|was|were|have|has|had)\b/i;
const PHRASE_END_RE = /[.!?;:…。！？；：]$/u;
const PHRASE_SPLIT_RE = /[^.!?;:。！？；：]+[.!?;:。！？；：]+|[^.!?;:。！？；：]+$/gu;
const DOTTED_INITIALISM_DOT = '\uE000';
const SSML_BREAK_OPEN = '\uE010';
const SSML_BREAK_CLOSE = '\uE011';
const SSML_BREAK_TAG_RE = /<\s*break\b[^>]*\/?\s*>/giu;

// Silence inserted between an ended reply clip and the next ready one, keyed by
// how the ended clip's text stops: a finished sentence gets a full breath, a
// mid-sentence continuation (dash/ellipsis/clause split) a short one. The gap
// only runs when the next clip is already synthesized — when it isn't, the
// synthesis wait is the pause — so it never delays the first clip of a reply.
export const INTER_CLIP_GAP_MS = {
  continuation: 180,
  sentence: 420,
};

const CONTINUATION_FINAL_RE = /(?:…|\.{3})["')\]]*$/u;
const SENTENCE_FINAL_RE = /[.!?。！？]["')\]]*$/u;

export function interClipGapMs(previousClipText) {
  const text = String(previousClipText || '').trim();
  if (!text) return 0;
  // '...' ends in '.' character-wise, so test continuation marks first:
  // '…', '...', ';' and ':' all hang mid-thought.
  if (CONTINUATION_FINAL_RE.test(text)) return INTER_CLIP_GAP_MS.continuation;
  if (SENTENCE_FINAL_RE.test(text)) return INTER_CLIP_GAP_MS.sentence;
  return INTER_CLIP_GAP_MS.continuation;
}

export function cleanLiveText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

// A question typed instead of spoken. The cap keeps one paste from pushing a
// wall of text into the Realtime conversation; the gateway enforces the same
// limit (live-gateway/src/services/openaiRealtimeEvents.js).
export const MAX_TYPED_MESSAGE_LENGTH = 2000;

export function normalizeTypedMessage(value) {
  return String(value ?? '').trim().slice(0, MAX_TYPED_MESSAGE_LENGTH);
}

function englishNumberWordsToDigits(match) {
  const words = match.toLowerCase().split(/[-\s]+/u).filter(Boolean);
  if (words.length === 1) {
    return String(ENGLISH_NUMBER_WORDS[words[0]]);
  }
  if (
    words.length === 2
    && ENGLISH_TENS_WORDS.has(words[0])
    && ENGLISH_ONES_WORDS.has(words[1])
  ) {
    return String(ENGLISH_NUMBER_WORDS[words[0]] + ENGLISH_NUMBER_WORDS[words[1]]);
  }
  return match;
}

function cleanChineseTtsText(text) {
  return cleanLiveText(text)
    .replace(ENGLISH_NUMBER_WORD_RE, englishNumberWordsToDigits)
    .replace(LATIN_WORD_RE, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([,，.。!?！？;；:：、%])\s*/gu, '$1')
    .replace(/[,，、;；:：]+([.。!?！？])/gu, '$1')
    .replace(/([\u3400-\u9FFF])\s+([\u3400-\u9FFF])/gu, '$1$2')
    .trim();
}

export function cleanLiveTtsText(text, language = LIVE_TEXT_LANG) {
  return normalizeLiveLanguage(language) === LIVE_LANGUAGES.zh
    ? cleanChineseTtsText(text)
    : cleanLiveText(text);
}

export function isLiveInputPhase(phase) {
  return phase === 'listening' || phase === 'thinking';
}

// Turn-based is strictly half duplex: once a turn ends the mic is closed until
// the reply has finished, so nothing can cancel it. fullDuplex (Live MC
// continuous) also streams while the AI speaks, so OpenAI's VAD hears a barge-in.
export function shouldSendLiveMicAudio({ phase, micInputEnabled, listeningMode = 'continuous', fullDuplex = false }) {
  if (!micInputEnabled) return false;
  if (phase === 'listening') return true;
  if (listeningMode === 'turns') return false;
  return phase === 'thinking' || (phase === 'speaking' && fullDuplex);
}

export function shouldTriggerLiveBargeIn({
  phase,
  micInputEnabled,
  rms,
  threshold = 0.04,
  listeningMode = 'continuous',
}) {
  return listeningMode !== 'turns' && phase === 'speaking' && Boolean(micInputEnabled) && Number(rms) >= threshold;
}

export function getMicOffAction({ phase, hasPendingAudio, hasVoiceEvidence = true }) {
  if (phase === 'listening' && hasPendingAudio) {
    // A pending turn with no real voice behind it was opened by noise (OpenAI's
    // VAD firing on breath/clicks in the open mic). Muting should drop it, not
    // "send what you said".
    return hasVoiceEvidence ? 'commit' : 'discard';
  }

  if (phase === 'listening' || phase === 'speaking') {
    return 'pause';
  }

  return 'wait';
}

// Client-side noise gate for the outbound mic stream. OpenAI's server VAD hears
// whatever we send; streaming every frame lets it flag breaths, clicks, and room
// noise as speech (phantom turns, phantom barge-ins). Frames are ~85ms
// (ScriptProcessor 4096 samples @48k). The gate opens only after `openFrames`
// consecutive voiced frames, stays open through pauses up to `hangoverFrames`
// so mid-sentence lulls don't chop the turn, and callers replay `prerollFrames`
// of buffered audio on opening so soft speech onsets aren't clipped.
export const VOICE_GATE = {
  threshold: 0.02,
  openFrames: 2,
  hangoverFrames: 18,
  prerollFrames: 4,
};

// Minimum voiced (above-threshold) frames in a turn (~340ms) for a manual mute
// to treat it as real speech worth committing.
export const MIN_COMMIT_VOICE_FRAMES = 4;

export function createVoiceGateState() {
  return { open: false, justOpened: false, loudStreak: 0, quietStreak: 0 };
}

export function nextVoiceGateState(state, rms, config = VOICE_GATE) {
  const current = state || createVoiceGateState();
  const voiced = Number(rms) >= config.threshold;

  if (!current.open) {
    const loudStreak = voiced ? current.loudStreak + 1 : 0;
    if (loudStreak >= config.openFrames) {
      return { open: true, justOpened: true, loudStreak, quietStreak: 0 };
    }
    return { open: false, justOpened: false, loudStreak, quietStreak: 0 };
  }

  const quietStreak = voiced ? 0 : current.quietStreak + 1;
  if (quietStreak >= config.hangoverFrames) {
    return createVoiceGateState();
  }
  return { open: true, justOpened: false, loudStreak: current.loudStreak, quietStreak };
}

// `continuation: true` marks a fragment that is mid-sentence (the half before an
// em dash, or a clause split off for latency). It gets an ellipsis — GPT-SoVITS
// reads '…' with a hanging, unfinished contour, where a '.' produces a falling
// end-of-sentence read and a '?' a rising one, both wrong mid-thought.
function ensurePhraseEnding(text, { continuation = false } = {}) {
  if (PHRASE_END_RE.test(text)) return text;
  if (continuation) return `${text.replace(/[,，]$/u, '')}…`;
  return `${text}${QUESTION_START_RE.test(text) ? '?' : '.'}`;
}

function protectDottedInitialisms(text) {
  return text.replace(/\b[A-Z](?:\.[A-Z])+(?:\.)?/gu, (match, offset, input) => {
    const afterMatch = input.slice(offset + match.length);
    const terminalDotEndsSentence = match.endsWith('.') && !/^\s+[a-z]/u.test(afterMatch);
    if (!terminalDotEndsSentence) return match.replace(/\./g, DOTTED_INITIALISM_DOT);
    return `${match.slice(0, -1).replace(/\./g, DOTTED_INITIALISM_DOT)}.`;
  });
}

function restoreDottedInitialisms(text) {
  return text.replaceAll(DOTTED_INITIALISM_DOT, '.');
}

// SSML <break> tags survive chunking as opaque placeholders: the tag text would
// otherwise be split on its own punctuation and stop being a valid tag.
function protectSsmlBreakTags(text) {
  const tags = [];
  return {
    text: String(text || '').replace(SSML_BREAK_TAG_RE, (tag) => {
      const index = tags.push(tag) - 1;
      return `${SSML_BREAK_OPEN}${index}${SSML_BREAK_CLOSE}`;
    }),
    tags,
  };
}

function restoreSsmlBreakTags(text, tags) {
  return String(text || '').replace(
    new RegExp(`${SSML_BREAK_OPEN}(\\d+)${SSML_BREAK_CLOSE}`, 'gu'),
    (_match, index) => tags[Number(index)] || '',
  );
}

function mergeChunksAcrossSsmlBreaks(chunks) {
  const merged = [];
  for (const chunk of chunks) {
    const previous = merged[merged.length - 1] || '';
    const beginsWithBreak = /^\s*<\s*break\b[^>]*\/?\s*>/iu.test(chunk);
    const previousEndsWithBreak = /<\s*break\b[^>]*\/?\s*>\s*$/iu.test(previous);
    if (merged.length > 0 && (beginsWithBreak || previousEndsWithBreak)) {
      merged[merged.length - 1] = `${previous} ${chunk}`.trim();
    } else {
      merged.push(chunk);
    }
  }
  return merged;
}

export function splitLiveReplyPhrases(text) {
  const clean = protectDottedInitialisms(cleanLiveText(text));
  if (!clean) return [];

  // Em/en dashes mark a pause but aren't sentence-enders, so GPT-SoVITS reads
  // straight through them. Break phrases at dashes first so each side becomes its
  // own synthesized clip with a real pause between (matching full-mode behavior).
  // The fragment left dangling before a dash is mid-sentence, so it takes the
  // continuation ellipsis rather than a sentence-final '.' or '?'.
  const segments = clean.split(/\s*[—–]+\s*/u).map((part) => part.trim()).filter(Boolean);
  return segments
    .flatMap((segment, segmentIndex) => {
      const matches = (segment.match(PHRASE_SPLIT_RE) || [segment]).map((part) => part.trim());
      const beforeDash = segmentIndex < segments.length - 1;
      return matches.map((part, partIndex) =>
        restoreDottedInitialisms(ensurePhraseEnding(part, {
          continuation: beforeDash && partIndex === matches.length - 1,
        }))
      );
    })
    .filter(Boolean);
}

const FAST_FIRST_PHRASE_MAX_CHARS = 70;
const FAST_PHRASE_MIN_CHARS = 24;
const FAST_PHRASE_MIN_WORDS = 3;
const CLAUSE_BREAK_RE = /[,;:，；：]/u;
const STREAMED_SENTENCE_BOUNDARY_RE = /[.!?。！？](?:["'”’)\]]*)\s+(?=\S)/gu;
const NON_TERMINAL_PERIOD_RE = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|e\.g|i\.e)\.$/iu;
const STREAMED_SENTENCE_MIN_CHARS = 18;
const STREAMED_SENTENCE_MIN_CJK_CHARS = 6;

function countWords(text) {
  return (String(text).trim().match(/\S+/gu) || []).length;
}

// A streamed period is not enough evidence that a sentence is complete: the next
// delta may turn "Dr." into "Dr. Smith" or append more words. Wait until at least
// one non-space character from the following sentence has arrived, then return the
// completed prefix. This lets Live Fast start TTS while OpenAI streams the remainder
// without guessing from an unfinished clause.
export function takeCompleteStreamedSentence(text, {
  minChars = STREAMED_SENTENCE_MIN_CHARS,
  minCjkChars = STREAMED_SENTENCE_MIN_CJK_CHARS,
} = {}) {
  const source = String(text || '');
  STREAMED_SENTENCE_BOUNDARY_RE.lastIndex = 0;
  let match;
  while ((match = STREAMED_SENTENCE_BOUNDARY_RE.exec(source)) !== null) {
    const completeText = source.slice(0, match.index + match[0].trimEnd().length).trim();
    const cjkChars = (completeText.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) || []).length;
    if (
      (completeText.length < minChars && cjkChars < minCjkChars)
      || NON_TERMINAL_PERIOD_RE.test(completeText)
    ) {
      continue;
    }
    return {
      completeText,
      remainderText: source.slice(STREAMED_SENTENCE_BOUNDARY_RE.lastIndex).trimStart(),
    };
  }
  return null;
}

// Live Fast plays the first clip the moment it is ready, so a long opening phrase
// delays the very first audio. When the first phrase is long, break it at its first
// natural clause boundary so audio starts sooner. To keep the shortened first phrase
// sounding clean (GPT-SoVITS reads tiny fragments poorly), only split when BOTH halves
// stay above a minimum length/word count and land on a real clause boundary, and give
// each half proper terminal punctuation. If no boundary leaves two healthy halves, the
// phrase is returned untouched.
export function shortenFirstFastPhrase(phrases, {
  maxFirstChars = FAST_FIRST_PHRASE_MAX_CHARS,
  minChars = FAST_PHRASE_MIN_CHARS,
  minWords = FAST_PHRASE_MIN_WORDS,
} = {}) {
  if (!Array.isArray(phrases) || phrases.length === 0) return phrases;
  const first = phrases[0];
  if (!first || first.length <= maxFirstChars) return phrases;

  for (let i = 0; i < first.length; i += 1) {
    if (!CLAUSE_BREAK_RE.test(first[i])) continue;
    const head = first.slice(0, i).trim();
    const tail = first.slice(i + 1).trim();
    if (
      head.length >= minChars
      && tail.length >= minChars
      && countWords(head) >= minWords
      && countWords(tail) >= minWords
    ) {
      return [
        // The head is mid-sentence — a continuation ellipsis keeps its contour
        // open instead of a falling sentence-final period.
        ensurePhraseEnding(head, { continuation: true }),
        ensurePhraseEnding(tail),
        ...phrases.slice(1),
      ];
    }
  }
  return phrases;
}

// Live Fast keeps whole sentences together, then applies the saved word and
// sentence ceilings before submitting each independently queued TTS request.
const CHUNK_MAX_LENGTH = 280;
const CHUNK_MAX_SENTENCES = 1;
const CHUNK_MIN_LENGTH = 24;
const CHUNK_MIN_CONTEXT_WORDS = 8;
const CHUNK_NBSP = ' ';

const CHUNK_SEMANTIC_UNITS = [
  'of the', 'in the', 'to the', 'for the', 'on the', 'at the', 'by the',
  'to a', 'of a', 'in a', 'for a', 'on a',
  'it is', 'that is', 'there is', 'this is', 'it was', 'that was', 'there was',
  'as well', 'such as', 'due to', 'in order', 'as a',
  'would be', 'could be', 'should be', 'will be', 'has been', 'have been',
  'do not', 'does not', 'did not', 'is not', 'was not', 'are not',
];

function protectChunkSemanticUnits(text) {
  let result = text;
  for (const phrase of CHUNK_SEMANTIC_UNITS) {
    result = result.replace(new RegExp(phrase, 'gi'), (match) => match.replace(/ /g, CHUNK_NBSP));
  }
  return result;
}

function restoreChunkSemanticUnits(text) {
  return text.replace(/\u00a0/g, ' ');
}

function splitIntoChunkSentences(text) {
  const normalized = cleanLiveText(text);
  if (!normalized) return [];
  const sentences = normalized
    .split(/(?<=[.!?。！？…:：;；])\s+|(?<=—)\s*(?=\S)|\n+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  return sentences.length > 0 ? sentences : [normalized];
}

function countChunkWords(text) {
  return (String(text || '').match(/[\p{L}\p{N}']+/gu) || []).length;
}

function wordLimitCutIndex(text, maxWords) {
  if (!(maxWords > 0)) return text.length;
  const matches = Array.from(text.matchAll(/[\p{L}\p{N}']+/gu));
  if (matches.length <= maxWords) return text.length;
  const last = matches[maxWords - 1];
  return last.index + last[0].length;
}

function splitLongChunkSentence(sentence, maxChunkLength, maxChunkWords = 0) {
  if (sentence.length <= maxChunkLength
    && (!(maxChunkWords > 0) || countChunkWords(sentence) <= maxChunkWords)) return [sentence];

  const parts = [];
  let remaining = protectChunkSemanticUnits(sentence).trim();
  const clauseSeparators = [';', ':', '；', '：'];
  while (remaining.length > maxChunkLength
    || (maxChunkWords > 0 && countChunkWords(remaining) > maxChunkWords)) {
    const hardLimit = Math.min(maxChunkLength, wordLimitCutIndex(remaining, maxChunkWords));
    const searchWindow = remaining.slice(0, hardLimit + 1);
    const minCut = Math.floor(hardLimit * 0.6);
    let cut = -1;
    for (const separator of clauseSeparators) {
      cut = Math.max(cut, searchWindow.lastIndexOf(separator));
    }
    if (cut < minCut) cut = searchWindow.lastIndexOf(' ');
    if (cut < minCut) cut = hardLimit;
    const includeSeparator = cut === hardLimit ? 0 : 1;
    parts.push(restoreChunkSemanticUnits(remaining.slice(0, cut + includeSeparator).trim()));
    remaining = remaining.slice(cut + includeSeparator).trim();
  }
  if (remaining) parts.push(restoreChunkSemanticUnits(remaining));
  return parts.filter(Boolean);
}

function chunkEndsSentence(text) {
  const trimmed = String(text || '').trimEnd();
  if (trimmed.endsWith('...') || trimmed.endsWith('…')) return true;
  return '.!?。！？'.includes(trimmed.slice(-1));
}

function mergeShortChunks(chunks, minLength, {
  maxChunkLength,
  maxChunkWords,
  maxSentencesPerChunk,
}) {
  if (chunks.length <= 1) return chunks;
  const merged = chunks.map((chunk) => chunk.trim()).filter(Boolean);
  const canMerge = (left, right, shortChunk) => {
    const candidate = `${left} ${right}`.trim();
    return (shortChunk.length < minLength || countChunkWords(shortChunk) < CHUNK_MIN_CONTEXT_WORDS)
      && candidate.length <= maxChunkLength
      && (!(maxChunkWords > 0) || countChunkWords(candidate) <= maxChunkWords)
      && splitIntoChunkSentences(candidate).length <= maxSentencesPerChunk + 1;
  };

  for (let index = 0; index < merged.length;) {
    const chunk = merged[index];
    if (index < merged.length - 1 && canMerge(chunk, merged[index + 1], chunk)) {
      merged[index + 1] = `${chunk} ${merged[index + 1]}`.trim();
      merged.splice(index, 1);
      continue;
    }
    if (index === merged.length - 1 && index > 0 && canMerge(merged[index - 1], chunk, chunk)) {
      merged[index - 1] = `${merged[index - 1]} ${chunk}`.trim();
      merged.splice(index, 1);
      break;
    }
    index += 1;
  }
  return merged;
}

export function splitLiveReplyChunks(text, {
  maxChunkLength = CHUNK_MAX_LENGTH,
  maxChunkWords = 0,
  maxSentencesPerChunk = CHUNK_MAX_SENTENCES,
} = {}) {
  const protectedBreaks = protectSsmlBreakTags(cleanLiveText(text));
  const clean = protectDottedInitialisms(protectedBreaks.text);
  if (!clean) return [];
  const activeMaxChunkLength = maxChunkWords > 0 ? Number.MAX_SAFE_INTEGER : maxChunkLength;
  const rawSentences = splitIntoChunkSentences(clean)
    .flatMap((sentence) => splitLongChunkSentence(sentence, activeMaxChunkLength, maxChunkWords));
  const chunks = [];
  let current = '';
  let sentenceCount = 0;

  for (const sentence of rawSentences) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    const exceedsLength = candidate.length > activeMaxChunkLength;
    const exceedsWords = maxChunkWords > 0 && countChunkWords(candidate) > maxChunkWords;
    const exceedsSentenceCount = sentenceCount >= maxSentencesPerChunk;
    const canAbsorbShortContext = exceedsSentenceCount
      && sentenceCount === maxSentencesPerChunk
      && countChunkWords(current) < CHUNK_MIN_CONTEXT_WORDS;

    if (current && (exceedsLength || exceedsWords || (exceedsSentenceCount && !canAbsorbShortContext))) {
      chunks.push(current.trim());
      current = sentence;
      sentenceCount = 1;
    } else {
      current = candidate;
      sentenceCount += 1;
    }

    const trimmed = current.trimEnd();
    const fullEnough = maxChunkWords > 0
      ? countChunkWords(trimmed) >= Math.floor(maxChunkWords * 0.6)
      : trimmed.length >= Math.floor(activeMaxChunkLength * 0.6);
    if (trimmed && chunkEndsSentence(trimmed) && fullEnough) {
      chunks.push(trimmed);
      current = '';
      sentenceCount = 0;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  const boundedChunks = mergeShortChunks(chunks, CHUNK_MIN_LENGTH, {
    maxChunkLength: activeMaxChunkLength,
    maxChunkWords,
    maxSentencesPerChunk,
  })
    .map((chunk) => restoreSsmlBreakTags(restoreDottedInitialisms(chunk), protectedBreaks.tags))
    .filter(Boolean);
  // A break must reach one backend request with real speech on both sides. Otherwise
  // the browser's sentence queue would strand it at the start/end of a separate WAV
  // and the explicit pause would disappear when those WAVs are joined.
  return mergeChunksAcrossSsmlBreaks(boundedChunks);
}

export function buildLiveReplyParams(text, refParams = {}, language = LIVE_TEXT_LANG) {
  return {
    text: cleanLiveTtsText(text, language),
    text_lang: getLiveTtsLanguage(language),
    ref_audio_path: refParams.ref_audio_path,
    prompt_text: refParams.prompt_text || '',
    prompt_lang: refParams.prompt_lang || 'en',
    aux_ref_audio_paths: refParams.aux_ref_audio_paths || [],
    ...(refParams.voice_model ? { voice_model: { ...refParams.voice_model } } : {}),
    ...(refParams.top_k !== undefined ? { top_k: refParams.top_k } : {}),
    ...(refParams.top_p !== undefined ? { top_p: refParams.top_p } : {}),
    ...(refParams.temperature !== undefined ? { temperature: refParams.temperature } : {}),
    ...(refParams.repetition_penalty !== undefined ? { repetition_penalty: refParams.repetition_penalty } : {}),
    ...(refParams.speed_factor !== undefined ? { speed_factor: refParams.speed_factor } : {}),
    ...(refParams.voiceProfileId ? { voiceProfileId: refParams.voiceProfileId } : {}),
  };
}

// `skipVerify` marks the reply's first clip: the worker skips its ASR stutter
// check so verification never delays time-to-first-audio. Later clips verify
// behind playback. (The Full-inference route whitelists params, so the flag is
// harmless if it reaches that path.)
export function buildLiveSentenceParams(text, refParams = {}, language = LIVE_TEXT_LANG, { skipVerify = false } = {}) {
  return {
    ...buildLiveReplyParams(text, refParams, language),
    ...(skipVerify ? { skip_verify: true } : {}),
  };
}

export function createChatMessage({
  id,
  role,
  text = '',
  status = 'done',
  itemId = '',
  audioUrl = null,
  audioParts = [],
  error = null,
  createdAt = Date.now(),
  voiceStopped = false,
}) {
  return {
    id,
    role,
    text,
    status,
    itemId,
    audioUrl,
    audioParts,
    error,
    createdAt,
    voiceStopped,
  };
}

// How long a user bubble may sit in 'transcribing' before the client closes the
// turn itself. Realtime transcripts normally land within a couple of seconds of
// speech stopping; if the terminal user.text event is lost (gateway bug, WS drop,
// OpenAI never emitting transcription.completed), waiting forever leaves the
// bubble stuck and the next turn overwriting it.
export const USER_TRANSCRIPT_TIMEOUT_MS = 10000;

// The active-user-message ref may only be reused while the bubble is still
// collecting the current turn. A 'done' bubble is history — overwriting it
// destroys a previous message (a stale ref once turned a finished transcript
// into the next turn's "Transcribing...").
export function canReuseActiveUserMessage(message) {
  return Boolean(message)
    && message.role === 'user'
    && (message.status === 'listening' || message.status === 'transcribing');
}

// Terminal patch for a user bubble whose transcript never arrived: keep any
// words that already streamed in, otherwise fall back to the same generic label
// the gateway's suppressed-transcript path uses. Returns null when the bubble
// is not actually stuck.
export function resolvePendingTranscriptPatch(message) {
  if (!message || message.role !== 'user' || message.status !== 'transcribing') {
    return null;
  }
  const text = cleanLiveText(message.text);
  const hasPartialWords = text && text !== 'Transcribing...' && text !== 'Listening...';
  return {
    text: hasPartialWords ? text : 'Voice message sent.',
    status: 'done',
  };
}

export function updateMessage(messages, id, patch) {
  return messages.map((message) =>
    message.id === id ? { ...message, ...patch } : message
  );
}

export function findSelectedPlayback(messages, selectedId) {
  if (!selectedId) return null;

  for (const message of messages) {
    if (message.id === selectedId && message.audioUrl) {
      return { message, part: null, audioUrl: message.audioUrl };
    }

    const part = (message.audioParts || []).find((item) => item.id === selectedId);
    if (part?.audioUrl) {
      return { message, part, audioUrl: part.audioUrl };
    }
  }

  return null;
}

export function findNextPhrasePlayback(messages, selectedId) {
  if (!selectedId) return null;

  for (const message of messages) {
    const parts = message.audioParts || [];
    const currentIndex = parts.findIndex((part) => part.id === selectedId);
    if (currentIndex === -1) continue;

    const nextPart = parts
      .slice(currentIndex + 1)
      .find((part) => part.audioUrl && ['ready', 'played'].includes(part.status));

    return nextPart ? { message, part: nextPart, audioUrl: nextPart.audioUrl } : null;
  }

  return null;
}

// One spoken reply can arrive split across several assistant messages: OpenAI
// Realtime interrupts an in-progress response when it hears more user speech,
// then continues the answer in a new response. After the last clip of one
// message finishes, chain into the first still-unplayed ready clip of a LATER
// assistant message so the whole reply keeps reading aloud. Only 'ready'
// (never-played) parts count — replaying an old message must not cascade into
// messages that were already read out.
export function findNextReplyPlayback(messages, afterMessageId) {
  const startIndex = messages.findIndex((message) => message.id === afterMessageId);
  if (startIndex === -1) return null;

  for (const message of messages.slice(startIndex + 1)) {
    if (message.role !== 'assistant') continue;
    const part = (message.audioParts || []).find(
      (item) => item.audioUrl && item.status === 'ready'
    );
    if (part) return { message, part, audioUrl: part.audioUrl };
  }

  return null;
}

// True while any assistant reply is still producing voice clips. Playback
// end-detection uses this to stay in the 'speaking' phase when the clip that
// just finished belongs to an earlier message than the one being synthesized
// (a reply split across messages) — otherwise the phase would drop to
// 'listening' and the pending reply's audio would never auto-play. Errored and
// interrupted replies don't count: their synthesis loop has already stopped.
export function hasPendingReplyWork(messages) {
  return messages.some(
    (message) =>
      message.role === 'assistant'
      && message.status === 'generating_voice'
      && !message.voiceStopped
  );
}

// Decide how to continue when the app is in the 'speaking' phase with no clip
// selected. The ended-event handler and the synthesis loop hand playback to
// each other through refs that lag React's render cycle, so either side can
// miss the baton: a ready clip gets stranded (a sentence is skipped, or the
// reply cuts off mid-text in a silent 'speaking' phase). This runs from a
// render-driven effect with FRESH state and self-heals those races:
//   play   — start the earliest never-played ready clip
//   wait   — clips are still generating; stay in 'speaking'
//   settle — nothing left to play or generate; leave 'speaking'
// Voice-stopped replies generate in the background but must stay silent until
// the user presses Play voice, so they are never auto-played and never hold
// the phase. Interrupted/errored replies are dead: their loops have stopped.
export function resolveSpeakingContinuation(messages, { synthesisMessageId = '' } = {}) {
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    if (message.voiceStopped) continue;
    if (['interrupted', 'error'].includes(message.status)) continue;
    const part = (message.audioParts || []).find(
      (item) => item.audioUrl && item.status === 'ready'
    );
    if (part) return { action: 'play', part, message };
  }

  if (synthesisMessageId) {
    const synthesizing = messages.find((message) => message.id === synthesisMessageId);
    if (synthesizing && !synthesizing.voiceStopped) {
      return { action: 'wait' };
    }
  }
  if (hasPendingReplyWork(messages)) {
    return { action: 'wait' };
  }

  return { action: 'settle' };
}

// Decide what to do when the reply <audio> element fails on a clip. The player
// only advances on the `ended` event, so without this a failed clip would stall
// the whole reply forever. Retry the same clip once (transient decode/network
// hiccups usually recover on a reload), then skip it so the rest of the reply
// still plays. `retryState` is caller-held ({ src, retried }); a new src always
// gets a fresh retry.
export function nextAudioErrorAction(retryState, src) {
  if (!src) {
    return { action: 'ignore', retryState };
  }
  if (retryState.src === src && retryState.retried) {
    return { action: 'skip', retryState };
  }
  return { action: 'retry', retryState: { src, retried: true } };
}

// Some OpenAI Realtime "error" events are benign races that resolve on their own
// (most often a new response requested while one is still in progress, which
// happens with rapid barge-in). Surfacing them just confuses the user, so we
// swallow these specific ones instead of showing the red error banner.
export function isBenignRealtimeError(message) {
  const text = String(message || '').toLowerCase();
  return (
    text.includes('active response in progress')
    || text.includes('already has an active response')
    || text.includes('conversation_already_has_active_response')
  );
}

// The gateway letter-spaces initialisms for TTS (e.g. "GI" -> "G I"), which
// GPT-SoVITS reads with a long drag between the lone letters ("G……I"). For the
// SPOKEN text only, rejoin known initialisms into smooth phonetic spellings so
// they read naturally. The on-screen chat keeps the clean original ("GI").
// Add more entries here as other dragged terms turn up.
const SPEECH_PRONUNCIATION_FIXES = [
  [/\bG\s+I\b/g, 'gee eye'],
];

export function fixSpeechPronunciation(text) {
  let out = String(text || '');
  for (const [pattern, replacement] of SPEECH_PRONUNCIATION_FIXES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function findFirstReplayablePart(message) {
  return (message?.audioParts || []).find((part) => part.audioUrl) || null;
}

// A dropped live socket (venue Wi-Fi blip, gateway restart, OpenAI's session
// time limit) reconnects with a fresh OpenAI session, which starts with no
// memory. Carry the recent transcript in its instructions so the AI continues
// the same conversation instead of greeting the room again.
const RECONNECT_CONTEXT_TURNS = 12;
const RECONNECT_CONTEXT_CHARS = 4000;

export function buildReconnectSystemPrompt(systemPrompt, messages) {
  const lines = (messages || [])
    .filter((message) => (message.role === 'user' || message.role === 'assistant') && String(message.text || '').trim())
    .slice(-RECONNECT_CONTEXT_TURNS)
    .map((message) => `${message.role === 'user' ? 'Host' : 'You'}: ${String(message.text).trim()}`);
  let transcript = lines.join('\n');
  if (transcript.length > RECONNECT_CONTEXT_CHARS) transcript = transcript.slice(-RECONNECT_CONTEXT_CHARS);
  const base = String(systemPrompt || '');
  if (!transcript) return base;
  return `${base}\n\nThe live connection briefly dropped and has resumed. Continue the same conversation naturally; do not greet again or mention the interruption. Conversation so far:\n${transcript}`;
}

// 1s, 2s, 4s, then every 8s. Give up after this many consecutive failures
// (about a minute), so a real outage ends the session with a clear error.
export const LIVE_RECONNECT_MAX_ATTEMPTS = 10;

export function liveReconnectDelayMs(attempt) {
  return Math.min(8000, 1000 * 2 ** Math.max(0, attempt - 1));
}
