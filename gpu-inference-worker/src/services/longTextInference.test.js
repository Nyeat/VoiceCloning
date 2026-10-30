import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  splitTextIntoChunks,
  analyzeAudioQuality,
  estimateReferenceCharsPerSec,
  applyFullInferenceQualityPreset,
  fullInferenceQualityOptions,
  buildAttemptVariants,
  synthesizeLongText,
  concatWavs,
  normalizeWavChunksForPreview,
  insertCommaPauses,
  parseWav,
  scoreAudioCandidate,
  serializableSessionOptions,
  applyWavOutputGain,
  synthesizeBreakAwareFullChunk,
} from './longTextInference.js';
import { inferenceServer } from './inferenceServer.js';

// A valid PCM16 mono WAV that is genuinely silent (all zero samples) — exactly
// what GPT-SoVITS returns when the AR decoder predicts an early end-of-sequence.
function makeSilentWav(durationSec = 1.0, sampleRate = 32000) {
  const blockAlign = 2;
  const frameCount = Math.round(durationSec * sampleRate);
  const dataSize = frameCount * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * blockAlign, 28); buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
  return buf;
}

// Build a valid PCM16 mono WAV of a given duration filled with mild noise
// (healthy RMS, not silent, not clipped, low autocorrelation so it isn't
// mistaken for a loop). Lets us probe the duration-based skip detector.
function makeNoiseWav(durationSec, sampleRate = 32000) {
  const blockAlign = 2; // mono, 16-bit
  const frameCount = Math.round(durationSec * sampleRate);
  const dataSize = frameCount * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * blockAlign, 28); buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
  let seed = 12345;
  for (let i = 0; i < frameCount; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const v = ((seed / 0x7fffffff) * 2 - 1) * 0.3 * 32767;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), 44 + i * blockAlign);
  }
  return buf;
}

function makeSparseQuietWav(durationSec, sampleRate = 32000) {
  const blockAlign = 2;
  const frameCount = Math.round(durationSec * sampleRate);
  const dataSize = frameCount * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * blockAlign, 28); buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < frameCount; i++) {
    const value = i % 100 === 0 ? 140 : 0;
    buf.writeInt16LE(value, 44 + i * blockAlign);
  }
  return buf;
}

test('Full session manifests retain regeneration-relevant synthesis settings only', () => {
  assert.deepEqual(serializableSessionOptions({
    maxChunkWords: 24,
    maxSentencesPerChunk: 2,
    retryCount: 4,
    allowBestEffortFallback: true,
    verifyChunk: () => true,
    unrelated: 'not persisted',
  }), {
    maxChunkWords: 24,
    maxSentencesPerChunk: 2,
    retryCount: 4,
    allowBestEffortFallback: true,
  });
});

test('admin regeneration preserves edited review text as one synthesis unit', async () => {
  const text = 'The membrane organization is structural. These proteins provide context.';
  const seen = [];
  const result = await synthesizeBreakAwareFullChunk(
    text,
    { text },
    {
      preserveReviewUnit: true,
      maxSentencesPerChunk: 1,
      maxChunkWords: 5,
      avoidChunkFinalWords: ['structural'],
    },
    {
      synthesizeChunk: async (chunk) => {
        seen.push(chunk);
        return { audioBuffer: makeNoiseWav(1), attempts: 3, fallback: false };
      },
    },
  );

  assert.deepEqual(seen, [text]);
  assert.deepEqual(result.synthesisChunks, [text]);
  assert.equal(result.attempts, 3);
});

// A hyphen used as a dash with spaces around it (" - ") reaches GPT-SoVITS as a
// bare hyphen-minus, which the English G2P verbalizes as the word "minus".
// It must be normalized to a comma pause before chunking (the shared
// prepareTextForSynthesis converts " - " to ", " rather than an em-dash).
test('spaced hyphen dash is converted to a comma pause so TTS does not say "minus"', () => {
  const chunks = splitTextIntoChunks('every cell must obey - how energy flows.');
  const joined = chunks.join(' ');
  assert.ok(!/\s-\s/.test(joined), `no spaced hyphen should survive: "${joined}"`);
  assert.ok(!/[–—]/.test(joined), `no en/em-dash should survive either: "${joined}"`);
});

test('multiple spaced dashes in one line are all converted', () => {
  const chunks = splitTextIntoChunks('the total disorder - or entropy - always increases.');
  const joined = chunks.join(' ');
  assert.ok(!/\s-\s/.test(joined), `no spaced hyphen should survive: "${joined}"`);
});

// Regression guard: intra-word hyphens must still become a plain space
// ("real-time" → "real time"), the existing behavior.
test('intra-word hyphen still becomes a space', () => {
  const chunks = splitTextIntoChunks('this is a real-time system.');
  const joined = chunks.join(' ');
  assert.ok(joined.includes('real time'), `intra-word hyphen should split: "${joined}"`);
});

// The delta symbol must be spoken as the word "delta", never "triangle".
// Handles both attached ("ΔG") and spaced ("Δ G") forms.
test('attached delta symbol becomes "delta G"', () => {
  const chunks = splitTextIntoChunks('The free-energy change ΔG is negative.');
  const joined = chunks.join(' ');
  assert.ok(/delta\s+G/i.test(joined), `delta symbol should become the word "delta": "${joined}"`);
  assert.ok(!joined.includes('Δ'), `no raw delta symbol should survive: "${joined}"`);
});

test('increment symbol also becomes "delta"', () => {
  const chunks = splitTextIntoChunks('Here ∆G equals zero.');
  const joined = chunks.join(' ');
  assert.ok(/delta\s+G/i.test(joined), `increment symbol should become "delta": "${joined}"`);
  assert.ok(!joined.includes('∆'), `no raw increment symbol should survive: "${joined}"`);
});

test('Live Full chunking expands chemical formulas before synthesis', () => {
  const chunks = splitTextIntoChunks('Glucose has formula C6H12O6, peroxide is H2O2, and a carboxyl group contains COOH.');
  const joined = chunks.join(' ');

  assert.match(joined, /see six, aitch twelve, oh six/u);
  assert.match(joined, /aitch two, oh two/u);
  assert.match(joined, /see oh oh aitch/u);
  assert.doesNotMatch(joined, /\bcee\b/u);
  assert.doesNotMatch(joined, /C6H12O6|H2O2|COOH/u);
});

// A short lead-in clause ("Typically,", "However,", "Therefore,") must not be
// stranded as its own 1-2 word chunk — GPT-SoVITS has no context to pace a lone
// word and rushes it. It should merge forward into the following clause.
test('a short lead-in clause is merged forward, not left as a rushed micro-chunk', () => {
  const chunks = splitTextIntoChunks('Typically, large fuel molecules are broken down into smaller biomolecules.');
  assert.ok(
    !chunks.some(c => c.trim() === 'Typically,'),
    `"Typically," should not be its own chunk: ${JSON.stringify(chunks)}`,
  );
  assert.ok(
    chunks.some(c => /Typically,\s+large fuel/i.test(c)),
    `"Typically" should merge with the next clause: ${JSON.stringify(chunks)}`,
  );
});

// A pronunciation-dictionary medical term must not land as the last word of a chunk
// when it can be avoided — the chunk-final position is where the AR decoder most often
// clips or rushes. The chunker re-groups by moving the sentence forward so the term is
// followed by more speech, without ever changing text or crossing a non-sentence break.
test('a dictionary term is kept off the chunk-final position when re-grouping is possible', () => {
  const text = 'The cells continued to divide rapidly. The lesion showed metastasis. It spread widely today for sure.';
  const plain = splitTextIntoChunks(text, { maxChunkLength: 55 });
  // Sanity: without the rule a multi-sentence chunk ends on "metastasis".
  assert.ok(plain.some(c => /metastasis\.$/i.test(c)), JSON.stringify(plain));

  const guarded = splitTextIntoChunks(text, { maxChunkLength: 55, avoidChunkFinalWords: ['metastasis'] });
  assert.ok(
    !guarded.some(c => /metastasis[.!?]?$/i.test(c)),
    `"metastasis" should not be a chunk-final word: ${JSON.stringify(guarded)}`,
  );
  // No text is lost or altered by the re-grouping.
  assert.equal(guarded.join(' ').replace(/\s+/g, ' '), plain.join(' ').replace(/\s+/g, ' '));
});

test('the dictionary-tail rule is a no-op when it would break length invariants', () => {
  // Single-sentence chunk ending on the term: nowhere safe to re-group, leave as-is.
  const chunks = splitTextIntoChunks('The biopsy confirmed carcinoma.', { avoidChunkFinalWords: ['carcinoma'] });
  assert.deepEqual(chunks, ['The biopsy confirmed carcinoma.']);
});

// Skip detector: a chunk whose audio is far too short for its text almost
// certainly dropped words and must be flagged so it gets re-rolled.
const SKIP_TEXT = 'large fuel molecules are broken down into smaller biomolecules and energy currency';

test('audio far too short for its text is flagged as likely dropped words', () => {
  const result = analyzeAudioQuality(makeNoiseWav(1.0), SKIP_TEXT); // ~82 chars in 1s = impossibly fast
  assert.equal(result.ok, false, `should be flagged (${result.durationSec?.toFixed(2)}s): ${result.reason}`);
  assert.match(result.reason || '', /too short/i);
});

test('audio of natural length for its text is not flagged short', () => {
  const result = analyzeAudioQuality(makeNoiseWav(6.0), SKIP_TEXT); // ~82 chars in 6s = normal pace
  assert.doesNotMatch(result.reason || '', /too short/i, `should not be flagged short: ${result.reason}`);
});

test('audio far too long for its text is flagged as likely repeated words', () => {
  // A double-read produces ~2x the natural duration. SKIP_TEXT (~82 chars) is ~5.5s
  // at a natural pace; 14s is a clear repeat and must be flagged so it re-rolls.
  const result = analyzeAudioQuality(makeNoiseWav(14.0), SKIP_TEXT);
  assert.equal(result.ok, false, `should be flagged (${result.durationSec?.toFixed(2)}s): ${result.reason}`);
  assert.match(result.reason || '', /too long|repeat/i);
});

test('audio of natural length for its text is not flagged too long', () => {
  const result = analyzeAudioQuality(makeNoiseWav(6.0), SKIP_TEXT);
  assert.doesNotMatch(result.reason || '', /too long|repeat/i, `should not be flagged long: ${result.reason}`);
});

test('a short chunk at a slow natural pace is not falsely flagged too long', () => {
  // Guards against a short chunk (min ~24 chars) tripping the over-duration net on
  // ordinary slow delivery — the absolute-duration floor protects it.
  const result = analyzeAudioQuality(makeNoiseWav(2.4), 'the patient rested well');
  assert.doesNotMatch(result.reason || '', /too long|repeat/i, `slow short chunk: ${result.reason}`);
});

test('a doubled-word take scores lower than a clean take, all else equal', () => {
  const analysis = analyzeAudioQuality(makeNoiseWav(4.0), 'the patient was given antibiotics');
  const base = { coverage: 1, missingWords: [], suspectWords: [], skippedWords: [] };
  const clean = scoreAudioCandidate(analysis, { ...base, extraWords: [] });
  const doubled = scoreAudioCandidate(analysis, { ...base, extraWords: ['patient'] });
  assert.ok(doubled < clean, `doubled (${doubled}) should score below clean (${clean})`);
});

test('a verifier-detected duplicated word lowers fallback candidate score', () => {
  const analysis = analyzeAudioQuality(makeNoiseWav(4.0), 'treatment and monitoring continued');
  const base = {
    coverage: 1,
    missingWords: [],
    suspectWords: [],
    extraWords: [],
    repeatedPhrases: [],
  };
  const clean = scoreAudioCandidate(analysis, { ...base, duplicatedWords: [] });
  const duplicated = scoreAudioCandidate(analysis, { ...base, duplicatedWords: ['treatment'] });
  assert.ok(duplicated < clean, `duplicated (${duplicated}) should score below clean (${clean})`);
});

test('candidate scoring prefers a verified technical-word pronunciation', () => {
  const analysis = analyzeAudioQuality(makeNoiseWav(4.0), 'the Michaelis constant');
  const base = {
    coverage: 1,
    missingWords: [],
    suspectWords: [],
    extraWords: [],
    repeatedPhrases: [],
  };
  const correct = scoreAudioCandidate(analysis, {
    ...base,
    phonemeAssessments: [{ word: 'michaelis', ok: true, similarity: 0.9 }],
  });
  const incorrect = scoreAudioCandidate(analysis, {
    ...base,
    phonemeAssessments: [{ word: 'michaelis', ok: false, similarity: 0.3 }],
  });
  const unavailable = scoreAudioCandidate(analysis, {
    ...base,
    phonemeAssessments: [{ word: 'michaelis', ok: false, inconclusive: true }],
  });

  assert.ok(correct > incorrect);
  assert.equal(correct, unavailable);
});

test('quiet recoverable audio with a real waveform is not rejected as silent', () => {
  const result = analyzeAudioQuality(makeSparseQuietWav(6.0), 'short phrase');
  assert.doesNotMatch(result.reason || '', /silent/i, `quiet non-empty audio should be recoverable: ${result.reason}`);
});

test('full inference quality preset keeps caller sampling controls when provided', () => {
  const params = applyFullInferenceQualityPreset({
    text: 'Photosynthesis converts light into chemical energy.',
    top_k: 1,
    top_p: 1,
    temperature: 1,
    repetition_penalty: 1,
    speed_factor: 1.8,
  });

  assert.equal(params.top_k, 1);
  assert.equal(params.top_p, 1);
  assert.equal(params.temperature, 1);
  assert.equal(params.repetition_penalty, 1);
  assert.equal(params.speed_factor, 1.8);
});

test('full inference quality preset fills system defaults when controls are omitted', () => {
  const params = applyFullInferenceQualityPreset({
    text: 'Photosynthesis converts light into chemical energy.',
  });

  assert.equal(params.top_k, 5);
  assert.equal(params.top_p, 0.85);
  assert.equal(params.temperature, 0.7);
  assert.equal(params.repetition_penalty, 1.35);
  assert.equal(params.speed_factor, 1.0);
});

test('full inference quality chunks keep normal sentences together for flow', () => {
  const text = 'The first sentence should stay intact for natural prosody. The second sentence should also stay intact.';
  const chunks = splitTextIntoChunks(text, { maxChunkLength: 220, maxSentencesPerChunk: 1 });

  assert.deepEqual(chunks, [
    'The first sentence should stay intact for natural prosody.',
    'The second sentence should also stay intact.',
  ]);
});

test('long sentences avoid comma-ended chunk boundaries', () => {
  const text = 'This extended introductory clause contains enough descriptive words to reach the safe split zone, and the following phrase continues with several more words so the sentence exceeds the chunk limit without requiring a comma cut.';
  const chunks = splitTextIntoChunks(text, { maxChunkLength: 120, maxSentencesPerChunk: 50 });

  assert.ok(chunks.length > 1, `expected a split for an over-limit sentence: ${JSON.stringify(chunks)}`);
  assert.ok(
    !chunks.slice(0, -1).some(chunk => /,\s*$/u.test(chunk)),
    `no intermediate chunk should end at a comma: ${JSON.stringify(chunks)}`,
  );
});

test('full inference quality keeps comma splicing off by default (opt-in via env)', () => {
  const options = fullInferenceQualityOptions();
  // Timestamp-spliced comma breaths still glitch in practice, so default is cut0-only.
  assert.equal(options.commaPauseMs, 0);
  assert.equal(options.allowBestEffortFallback, true);
  assert.equal(options.retryCount, 4);
  assert.equal(options.initialTakeCount, 3);
  assert.equal(options.selectBestVerifiedCandidate, true);
  assert.equal(options.isolateRiskySentences, true);
});

test('full inference quality keeps two sentences when they provide enough context', () => {
  const options = fullInferenceQualityOptions();
  const chunks = splitTextIntoChunks(
    'First, cells grow. Next, their DNA is copied. Finally, the cell divides.',
    options,
  );

  assert.equal(options.maxSentencesPerChunk, 2);
  assert.deepEqual(chunks, [
    'First, cells grow. Next, their DNA is copied.',
    'Finally, the cell divides.',
  ]);
});

test('an internal ARPAbet word does not force a one-sentence review chunk', () => {
  const text = 'The Michaelis constant describes an enzyme affinity for its substrate. Researchers measure this value carefully during analysis.';
  const chunks = splitTextIntoChunks(text, {
    maxChunkLength: 170,
    maxSentencesPerChunk: 2,
    isolateRiskySentences: true,
    avoidChunkFinalWords: ['michaelis'],
  });

  assert.deepEqual(chunks, [text]);
});

test('a dictionary-tail chunk may borrow exactly one sentence within the 15 percent ceiling', () => {
  const text = 'Cells divided today. The membrane contained glycoprotein. This added context keeps the decoder speaking naturally.';
  const chunks = splitTextIntoChunks(text, {
    maxChunkLength: 100,
    maxSentencesPerChunk: 2,
    avoidChunkFinalWords: ['glycoprotein'],
  });
  assert.equal(chunks[0], text);
  assert.equal(chunks.length, 1);
});

test('saved output gain raises PCM level but respects the minus-one dBFS ceiling', () => {
  const source = makeNoiseWav(1);
  const before = analyzeAudioQuality(source, 'normal test audio').metrics.absPeak;
  const gained = applyWavOutputGain(source, 6);
  const after = analyzeAudioQuality(gained, 'normal test audio').metrics.absPeak;
  assert.ok(after > before, `${before} -> ${after}`);
  assert.ok(after <= 0.892, `peak exceeded ceiling: ${after}`);
});

test('two fitting sentences are not split by the old percentage-full heuristic', () => {
  const chunks = splitTextIntoChunks(
    'The first moderately detailed sentence is deliberately longer than sixty percent of the configured limit. The second one still fits.',
    { maxChunkLength: 160, maxSentencesPerChunk: 2 },
  );

  assert.deepEqual(chunks, [
    'The first moderately detailed sentence is deliberately longer than sixty percent of the configured limit. The second one still fits.',
  ]);
});

test('a sentence-limited chunk may absorb exactly one more sentence when context is too short', () => {
  const chunks = splitTextIntoChunks(
    'Cells grow. DNA copies. Division begins. The longer final sentence provides enough words by itself today.',
    { maxChunkLength: 170, maxSentencesPerChunk: 2 },
  );

  assert.deepEqual(chunks, [
    'Cells grow. DNA copies. Division begins.',
    'The longer final sentence provides enough words by itself today.',
  ]);
});

test('the short-context exception never absorbs more than one extra sentence', () => {
  const chunks = splitTextIntoChunks(
    'Alpha one. Beta two. Gamma three. Delta four. Epsilon five. Zeta six.',
    { maxChunkLength: 170, maxSentencesPerChunk: 2 },
  );

  assert.deepEqual(chunks, [
    'Alpha one. Beta two. Gamma three.',
    'Delta four. Epsilon five. Zeta six.',
  ]);
});

test('full inference starts guarded content in a fresh chunk but adds following context', () => {
  const chunks = splitTextIntoChunks(
    'Cells continue growing steadily today. The biopsy confirmed metastasis. Recovery continued normally.',
    {
      maxChunkLength: 170,
      maxSentencesPerChunk: 2,
      isolateRiskySentences: true,
      avoidChunkFinalWords: ['metastasis'],
    },
  );

  assert.deepEqual(chunks, [
    'Cells continue growing steadily today.',
    'The biopsy confirmed metastasis. Recovery continued normally.',
  ]);
});

test('explicit max chunk words overrides the default character limit', () => {
  const text = `${'extraordinary '.repeat(12).trim()}.`;
  const chunks = splitTextIntoChunks(text, {
    maxChunkLength: 80,
    maxChunkWords: 20,
    maxSentencesPerChunk: 2,
  });

  assert.equal(chunks.length, 1, `word override should take priority over 80 characters: ${JSON.stringify(chunks)}`);
  assert.ok(chunks[0].length > 80);
  assert.ok(chunks[0].match(/[\p{L}\p{N}']+/gu).length <= 20);
});

test('explicit max chunk words is enforced for a long sentence', () => {
  const text = Array.from({ length: 27 }, (_, index) => `word${index + 1}`).join(' ');
  const chunks = splitTextIntoChunks(text, { maxChunkWords: 10, maxSentencesPerChunk: 5 });
  assert.ok(chunks.length >= 3);
  for (const chunk of chunks) {
    assert.ok(chunk.match(/[\p{L}\p{N}']+/gu).length <= 10, JSON.stringify(chunks));
  }
});

test('retry takes are voice-faithful: ONLY the seed changes', () => {
  const base = applyFullInferenceQualityPreset({
    text: 'Cellular respiration releases energy from glucose.',
    seed: 100,
  });

  const first = buildAttemptVariants(base, 0);
  const second = buildAttemptVariants(base, 1);
  const third = buildAttemptVariants(base, 2);

  // Sampling params mirror Live Fast (top_k 5, temperature 0.7).
  assert.equal(first.temperature, 0.7);
  assert.equal(first.top_p, 0.85);
  assert.equal(first.top_k, 5);
  assert.equal(first.text_split_method, 'cut0');

  // Every later take keeps the SAME voice-shaping parameters as the first — the
  // cloned voice never drifts to recover a word, and repetition_penalty stays pinned
  // (relaxing it was what caused the "barrels of barrels" stutter).
  for (const take of [second, third]) {
    assert.equal(take.temperature, first.temperature, 'temperature must not change');
    assert.equal(take.top_p, first.top_p, 'top_p must not change');
    assert.equal(take.top_k, first.top_k, 'top_k must not change');
    assert.equal(take.text_split_method, first.text_split_method, 'split method must not change');
    assert.equal(take.speed_factor, first.speed_factor, 'speed must not change');
    assert.equal(take.repetition_penalty, first.repetition_penalty, 'repetition_penalty must not change');
  }

  // Only the seed varies (to explore a different read).
  assert.equal(second.seed, 117);
  assert.notEqual(third.seed, second.seed);
});

test('full inference never emits a tiny standalone chunk (silent-buffer trigger)', () => {
  const text = "Yes. The mitochondria produce most of the cell's usable chemical energy through respiration.";
  const chunks = splitTextIntoChunks(text, { maxChunkLength: 220, maxSentencesPerChunk: 1 });
  for (const chunk of chunks) {
    assert.ok(chunk.trim().length >= 24, `chunk too short, will render silent: ${JSON.stringify(chunks)}`);
  }
});

test('newlines do not create heading-only chunks and the hard character limit still applies', () => {
  const chunks = splitTextIntoChunks(
    `Deep reasoning, criticism and architecture

Opus 4.8 Low > Sol Low > Terra Low

Opus is preferable when you need the model to challenge your approach, detect conceptual weaknesses and reason through unfamiliar problems.

Implementing and debugging code

Sol Low is probably the best choice.`,
    fullInferenceQualityOptions(),
  );

  assert.deepEqual(chunks, [
    'Deep reasoning, criticism and architecture Opus 4.8 Low greater than Sol Low greater than Terra Low Opus is preferable when you need the model to challenge your approach, detect conceptual weaknesses and reason through unfamiliar problems.',
    'Implementing and debugging code Sol Low is probably the best choice.',
  ]);
  assert.ok(chunks.every((chunk) => chunk.length <= 240), JSON.stringify(chunks));
  assert.ok(!chunks.includes('Deep reasoning, criticism and architecture'));
  assert.ok(!chunks.includes('Implementing and debugging code'));
});

test('colons and semicolons do not create sentence fragments', () => {
  const chunks = splitTextIntoChunks(
    'Final verdict\nOpus 4.8 Low: better thinker and critic. Sol Low: better coding executor; stronger all rounder.',
    { maxChunkLength: 170, maxSentencesPerChunk: 2 },
  );

  assert.deepEqual(chunks, [
    'Final verdict Opus 4.8 Low: better thinker and critic. Sol Low: better coding executor; stronger all rounder.',
  ]);
});

test('a short trailing clause is folded back instead of stranded as a tiny chunk', () => {
  const text = 'The reaction releases a very large amount of usable energy almost instantly, so fast.';
  const chunks = splitTextIntoChunks(text, { maxChunkLength: 220, maxSentencesPerChunk: 1 });
  for (const chunk of chunks) {
    assert.ok(chunk.trim().length >= 24, `chunk too short, will render silent: ${JSON.stringify(chunks)}`);
  }
});

// A short lead-in to the NEXT sentence ("Structurally,") used to be folded
// backward onto the previous COMPLETE sentence, producing a chunk that straddled a
// full stop with a dangling trailing word — the exact chunk the model mangled and
// dropped words from. It must fold forward into the clause it introduces instead.
test('a lead-in fragment folds forward, never straddling the previous full stop', () => {
  const text = 'Each centriole is made up of barrels of nine triplet microtubules. Structurally, three microtubule filaments arrange themselves repeatedly.';
  const chunks = splitTextIntoChunks(text, { maxChunkLength: 220, maxSentencesPerChunk: 1 });
  for (const chunk of chunks) {
    assert.ok(chunk.trim().length >= 24, `chunk too short: ${JSON.stringify(chunks)}`);
    // No chunk should contain a sentence-final period followed by more words.
    assert.ok(
      !/[.!?]\s+\S/.test(chunk),
      `chunk straddles a sentence boundary: ${JSON.stringify(chunk)}`,
    );
  }
  assert.ok(
    chunks.some(c => /Structurally,\s+three microtubule/i.test(c)),
    `"Structurally," should lead the next clause: ${JSON.stringify(chunks)}`,
  );
});

test('full-quality options hard-fail instead of publishing a known-bad silent chunk', async () => {
  mock.method(inferenceServer, 'synthesize', async () => makeSilentWav(1.0));
  try {
    await assert.rejects(
      synthesizeLongText(
        applyFullInferenceQualityPreset({ text: 'A short standalone sentence for synthesis.' }),
        fullInferenceQualityOptions({ retryCount: 1 }),
      ),
      /could not produce a usable full-sentence reading/iu,
    );
  } finally {
    mock.restoreAll();
  }
});

test('single-sentence Full does not regenerate usable audio when ASR itself is unavailable', async () => {
  let synthCalls = 0;
  mock.method(inferenceServer, 'synthesize', async () => {
    synthCalls += 1;
    return makeNoiseWav(4);
  });
  try {
    const result = await synthesizeLongText(
      applyFullInferenceQualityPreset({ text: 'This sentence still needs a usable fallback.' }),
      fullInferenceQualityOptions({
        verifyChunk: async () => ({
          ok: false,
          coverage: 0,
          missingWords: [],
          suspectWords: [],
          verificationUnavailable: true,
        }),
      }),
    );
    assert.ok(Buffer.isBuffer(result.audioBuffer) && result.audioBuffer.length > 44);
    assert.equal(synthCalls, 1);
    assert.equal(result.chunks[0].fallback, true);
  } finally {
    mock.restoreAll();
  }
});

test('full-quality tournament ranks three takes and stops when at least one passes', async () => {
  const text = 'The selected take should be complete, natural, and voice faithful.';
  const buffers = [];
  const similarities = [0.7, 0.76, 0.94, 0.81, 0.79];
  let synthCalls = 0;
  mock.method(inferenceServer, 'synthesize', async () => {
    const buffer = makeNoiseWav(4 + synthCalls * 0.05);
    buffers.push(buffer);
    synthCalls += 1;
    return buffer;
  });
  const verifyChunk = async () => ({
    ok: true,
    coverage: 1,
    missingWords: [],
    extraWords: [],
    repeatedPhrases: [],
    suspectWords: [],
    skippedWords: [],
    similarity: similarities[synthCalls - 1],
    similarityOk: true,
  });

  try {
    const result = await synthesizeLongText(
      applyFullInferenceQualityPreset({ text }),
      fullInferenceQualityOptions({ verifyChunk }),
    );
    assert.equal(synthCalls, 3);
    assert.equal(result.audioBuffer.length, buffers[2].length);
  } finally {
    mock.restoreAll();
  }
});

test('full-quality tournament expands from three to five when the first three all fail', async () => {
  const text = 'Stubborn text should receive two additional voice-faithful takes.';
  const buffers = [];
  const similarities = [0.4, 0.45, 0.5, 0.78, 0.93];
  let synthCalls = 0;
  mock.method(inferenceServer, 'synthesize', async () => {
    const buffer = makeNoiseWav(4 + synthCalls * 0.05);
    buffers.push(buffer);
    synthCalls += 1;
    return buffer;
  });
  const verifyChunk = async () => ({
    ok: synthCalls >= 4,
    coverage: synthCalls >= 4 ? 1 : 0.8,
    missingWords: synthCalls >= 4 ? [] : ['stubborn'],
    extraWords: [],
    repeatedPhrases: [],
    suspectWords: [],
    skippedWords: [],
    similarity: similarities[synthCalls - 1],
    similarityOk: synthCalls >= 4,
  });

  try {
    const result = await synthesizeLongText(
      applyFullInferenceQualityPreset({ text }),
      fullInferenceQualityOptions({ verifyChunk }),
    );
    assert.equal(synthCalls, 5);
    assert.equal(result.audioBuffer.length, buffers[4].length);
  } finally {
    mock.restoreAll();
  }
});

// Regression: when no clean read exists, the best-effort fallback must speak the
// WHOLE chunk. It used to substitute a single passing sub-span (e.g. a good first
// half) for the entire chunk, dropping the rest — that was "it skipped barrels all
// the way". The fallback must synthesize every span so no words are lost.
test('best-effort fallback covers the whole chunk, never a partial span', async () => {
  const text = 'Each centriole is made up of barrels of nine triplet microtubules.';
  const seen = [];
  mock.method(inferenceServer, 'synthesize', async (params) => {
    seen.push(params.text);
    return makeNoiseWav(Math.max(2, params.text.length * 0.1)); // natural length so audio isn't flagged "too short"
  });
  try {
    const result = await synthesizeLongText(
      applyFullInferenceQualityPreset({ text }),
      fullInferenceQualityOptions({
        retryCount: 0,
        allowBestEffortFallback: true,
        // Always-reject verifier forces every clean retry to fail and the full-span
        // best-effort fallback to run.
        verifyChunk: async () => ({ ok: false, coverage: 0.5, missingWords: ['centriole'], suspectWords: [] }),
      }),
    );
    assert.ok(Buffer.isBuffer(result.audioBuffer) && result.audioBuffer.length > 44);
    // The spans synthesized in the fallback must together reconstruct the full text.
    const joined = seen.join(' ').toLowerCase();
    for (const word of ['barrels', 'nine', 'triplet', 'microtubules']) {
      assert.ok(joined.includes(word), `fallback dropped "${word}": synthesized ${JSON.stringify(seen)}`);
    }
  } finally {
    mock.restoreAll();
  }
});

// When the whole chunk fails, recovery splits ONLY at sentence boundaries and retries
// each whole sentence — it must never synthesize a sub-sentence fragment (those caused
// mid-clause seams).
test('resilient synthesis splits only at sentence boundaries, never below a sentence', async () => {
  const text = 'The first cell divides quickly. The second cell divides slowly.';
  const seen = [];
  mock.method(inferenceServer, 'synthesize', async (params) => {
    seen.push(params.text.trim());
    return makeNoiseWav(Math.max(2, params.text.length * 0.1));
  });
  // Reject any text with more than one sentence terminator (the whole chunk), accept a
  // single sentence — forces the sentence-boundary split path.
  const verifyChunk = async (_buf, expectedText) => {
    const terminators = (expectedText.match(/[.!?]/gu) || []).length;
    return terminators > 1
      ? { ok: false, coverage: 0.5, missingWords: [], suspectWords: [] }
      : { ok: true, coverage: 1, missingWords: [], suspectWords: [] };
  };
  try {
    const result = await synthesizeLongText(
      applyFullInferenceQualityPreset({ text }),
      fullInferenceQualityOptions({ retryCount: 1, verifyChunk }),
    );
    assert.ok(Buffer.isBuffer(result.audioBuffer) && result.audioBuffer.length > 44);
    // Every synthesized unit is a whole sentence or the full chunk — each ends in
    // terminal punctuation. A sub-sentence fragment would not.
    const fragments = seen.filter((t) => !/[.!?]$/u.test(t));
    assert.deepEqual(fragments, [], `synthesized a sub-sentence fragment: ${JSON.stringify(seen)}`);
    assert.ok(seen.includes('The first cell divides quickly.'), JSON.stringify(seen));
    assert.ok(seen.includes('The second cell divides slowly.'), JSON.stringify(seen));
  } finally {
    mock.restoreAll();
  }
});

test('sentence recovery uses up to five takes and stitches the best full-sentence fallbacks', async () => {
  const first = 'The first sentence must be complete.';
  const second = 'The second sentence must also be complete.';
  const counts = new Map();
  mock.method(inferenceServer, 'synthesize', async (params) => {
    const text = params.text.trim();
    counts.set(text, (counts.get(text) || 0) + 1);
    return makeNoiseWav(Math.max(2, params.text.length * 0.1));
  });
  const verifyChunk = async (_buffer, expectedText) => {
    const text = expectedText.trim();
    if (text === first && counts.get(text) === 5) {
      return { ok: true, coverage: 1, missingWords: [], suspectWords: [] };
    }
    return {
      ok: false,
      coverage: 1,
      missingWords: [],
      suspectWords: [],
      skippedWords: [],
      repeatedPhrases: ['must also'],
    };
  };

  try {
    const result = await synthesizeLongText(
      applyFullInferenceQualityPreset({ text: `${first} ${second}` }),
      fullInferenceQualityOptions({ retryCount: 4, verifyChunk }),
    );
    assert.ok(Buffer.isBuffer(result.audioBuffer) && result.audioBuffer.length > 44);
    assert.equal(counts.get(first), 5);
    assert.equal(counts.get(second), 5);
  } finally {
    mock.restoreAll();
  }
});

test('single-sentence Full returns the best take after five coverage rejections', async () => {
  const text = 'A complete reading keeps every word.';
  let synthCalls = 0;
  mock.method(inferenceServer, 'synthesize', async () => {
    synthCalls += 1;
    return makeNoiseWav(4);
  });
  try {
    const result = await synthesizeLongText(
      applyFullInferenceQualityPreset({ text }),
      fullInferenceQualityOptions({
        retryCount: 4,
        verifyChunk: async () => ({
          ok: false,
          coverage: 0.9,
          missingWords: ['a'],
          suspectWords: [],
          skippedWords: [],
        }),
      }),
    );
    assert.ok(Buffer.isBuffer(result.audioBuffer) && result.audioBuffer.length > 44);
    assert.equal(synthCalls, 5);
  } finally {
    mock.restoreAll();
  }
});

test('sentence recovery stops at three takes per sentence when valid candidates exist', async () => {
  const first = 'The first recovered sentence is complete.';
  const second = 'The second recovered sentence is complete too.';
  const whole = `${first} ${second}`;
  const counts = new Map();
  mock.method(inferenceServer, 'synthesize', async (params) => {
    const text = params.text.trim();
    counts.set(text, (counts.get(text) || 0) + 1);
    return makeNoiseWav(Math.max(2, params.text.length * 0.1));
  });
  const verifyChunk = async (_buffer, expectedText) => ({
    ok: expectedText.trim() !== whole,
    coverage: expectedText.trim() === whole ? 0.8 : 1,
    missingWords: expectedText.trim() === whole ? ['complete'] : [],
    suspectWords: [],
  });

  try {
    const result = await synthesizeLongText(
      applyFullInferenceQualityPreset({ text: whole }),
      fullInferenceQualityOptions({ verifyChunk }),
    );
    assert.ok(Buffer.isBuffer(result.audioBuffer) && result.audioBuffer.length > 44);
    assert.equal(counts.get(whole), 5);
    assert.equal(counts.get(first), 3);
    assert.equal(counts.get(second), 3);
  } finally {
    mock.restoreAll();
  }
});

test('insertCommaPauses splices exactly one silence per comma using word timings', () => {
  const sampleRate = 32000;
  const audio = makeNoiseWav(2.0, sampleRate); // 2.0s mono PCM16
  const words = [
    { w: 'hello', start: 0.0, end: 0.5 },
    { w: 'world', start: 0.5, end: 1.0 },
    { w: 'goodbye', start: 1.1, end: 1.6 },
    { w: 'now', start: 1.6, end: 2.0 },
  ];
  const pauseMs = 120;
  const out = insertCommaPauses(audio, 'hello world, goodbye now', words, pauseMs);
  const before = parseWav(audio).dataChunk.length;
  const after = parseWav(out).dataChunk.length;
  const expectedSilence = Math.round((pauseMs / 1000) * sampleRate) * 2; // mono, 2 bytes/frame
  assert.equal(after - before, expectedSilence, 'exactly one comma breath inserted');
});

test('insertCommaPauses is a no-op when disabled, no comma, or word count drifts', () => {
  const audio = makeNoiseWav(1.0, 32000);
  const words = [{ w: 'a', start: 0, end: 0.5 }, { w: 'b', start: 0.5, end: 1.0 }];
  // disabled
  assert.equal(insertCommaPauses(audio, 'a, b', words, 0).length, audio.length);
  // no comma
  assert.equal(insertCommaPauses(audio, 'a b', words, 120).length, audio.length);
  // word-count drift > 2 (placement would be unreliable) → unchanged
  assert.equal(insertCommaPauses(audio, 'a, b c d e f', words, 120).length, audio.length);
});

test('single-chunk full inference preserves the model\'s natural loudness', async () => {
  // makeNoiseWav generates audio at ~0.3 peak. A single chunk has no siblings to
  // even out against, so it must NOT be boosted toward an absolute target — that
  // inflation is what made Live Full sound louder and less like the reference.
  mock.method(inferenceServer, 'synthesize', async () => makeNoiseWav(4.0));
  try {
    const result = await synthesizeLongText(
      applyFullInferenceQualityPreset({ text: 'A normal sentence should keep its natural playback volume.' }),
      fullInferenceQualityOptions({ retryCount: 0 }),
    );
    const analysis = analyzeAudioQuality(result.audioBuffer, 'A normal sentence should keep its natural playback volume.');
    assert.ok(
      analysis.metrics.absPeak < 0.4,
      `single chunk should keep its natural peak, not be boosted: ${JSON.stringify(analysis.metrics)}`,
    );
  } finally {
    mock.restoreAll();
  }
});

test('joined chunks are matched to a shared loudness without inflation', () => {
  // Two chunks at different peaks (0.3 and 0.6) should converge toward their
  // median (~0.45) so playback is even — but the result must not be pushed above
  // the louder source chunk.
  const quiet = makeNoiseWav(1.0);          // ~0.3 peak
  const loud = makeNoiseWav(1.0);
  for (let i = 44; i + 1 < loud.length; i += 2) {
    const doubled = Math.max(-32768, Math.min(32767, loud.readInt16LE(i) * 2));
    loud.writeInt16LE(doubled, i);          // ~0.6 peak
  }
  const joined = concatWavs([Buffer.from(quiet), Buffer.from(loud)], 0);
  const analysis = analyzeAudioQuality(joined, 'shared loudness check');
  assert.ok(
    analysis.metrics.absPeak > 0.3 && analysis.metrics.absPeak <= 0.62,
    `joined chunks should sit near the median, not be inflated: ${JSON.stringify(analysis.metrics)}`,
  );
});

test('sentence previews use the same shared peak as the joined full output', () => {
  const quiet = makeNoiseWav(1.0);
  const loud = makeNoiseWav(1.0);
  for (let i = 44; i + 1 < loud.length; i += 2) {
    loud.writeInt16LE(Math.max(-32768, Math.min(32767, loud.readInt16LE(i) * 2)), i);
  }
  const previews = normalizeWavChunksForPreview([quiet, loud]);
  const previewPeaks = previews.map((buffer) => analyzeAudioQuality(buffer, '').metrics.absPeak);
  const joinedPeak = analyzeAudioQuality(concatWavs([quiet, loud], 0), '').metrics.absPeak;

  assert.ok(Math.abs(previewPeaks[0] - previewPeaks[1]) < 0.01);
  assert.ok(Math.abs(previewPeaks[0] - joinedPeak) < 0.01);
});

test('concatWavs preserves generated chunk samples at joins', () => {
  const first = makeNoiseWav(0.25);
  const second = makeNoiseWav(0.25);
  const joined = concatWavs([Buffer.from(first), Buffer.from(second)], 0);

  const expected = Buffer.concat([
    parseWav(first).dataChunk,
    parseWav(second).dataChunk,
  ]);

  assert.deepEqual(parseWav(joined).dataChunk, expected);
});

// Constant full-amplitude PCM16 (no trailing silence to trim), so the edge value we
// read back reflects the fade alone.
function makeConstantWav(durationSec, amplitude = 8000, sampleRate = 32000) {
  const blockAlign = 2;
  const frameCount = Math.round(durationSec * sampleRate);
  const dataSize = frameCount * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * blockAlign, 28); buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < frameCount; i++) buf.writeInt16LE(amplitude, 44 + i * blockAlign);
  return buf;
}

test('concatWavs fades chunk edges to ~zero at an inserted silence (no click)', () => {
  const amp = 8000;
  const a = makeConstantWav(0.25, amp);
  const b = makeConstantWav(0.25, amp);
  const joined = parseWav(concatWavs([Buffer.from(a), Buffer.from(b)], 120));
  const framesA = parseWav(a).dataChunk.length / 2;

  // The sample touching the inserted silence must be faded toward zero, not left at
  // full amplitude (the old inverted 'out' fade caused a click on every fullstop).
  const lastOfA = joined.dataChunk.readInt16LE((framesA - 1) * 2);
  assert.ok(Math.abs(lastOfA) < amp * 0.1, `end of chunk A not faded: ${lastOfA}`);
  // And a few samples inward should still be near full amplitude (fade is short).
  const innerA = joined.dataChunk.readInt16LE((framesA - 400) * 2);
  assert.ok(Math.abs(innerA) > amp * 0.5, `fade too long, inner sample=${innerA}`);
});

test('concatWavs trims trailing model silence before an inserted pause', () => {
  // A chunk of speech (noise) followed by the model's 0.3s trailing near-silence.
  const withTail = concatWavs(
    [Buffer.from(makeNoiseWav(0.25)), Buffer.from(makeSilentWav(0.3))],
    0, // pure concat, no trim/fade — just build the tailed chunk
  );
  const second = makeNoiseWav(0.25);

  const sampleRate = 32000;
  const gapMs = 120;
  const joined = concatWavs([Buffer.from(withTail), Buffer.from(second)], gapMs);
  const joinedFrames = parseWav(joined).dataChunk.length / 2;

  // If the 0.3s tail were kept it would stack on the 0.12s pause. Trimming drops the
  // tail (keeping a ~30ms margin), so the join is far shorter than the untrimmed sum.
  const untrimmedFrames = Math.round((0.25 + 0.3 + gapMs / 1000 + 0.25) * sampleRate);
  assert.ok(
    joinedFrames < untrimmedFrames - 0.2 * sampleRate,
    `expected trim: joinedFrames=${joinedFrames} untrimmed=${untrimmedFrames}`,
  );
});

// A genuine inference-server failure (no audio ever produced) must still surface
// as an error — best-effort fallback only applies when we actually got audio.
test('long-text synthesis still surfaces a genuine inference-server failure', async () => {
  mock.method(inferenceServer, 'synthesize', async () => { throw new Error('inference server exploded'); });
  try {
    await assert.rejects(
      synthesizeLongText(
        applyFullInferenceQualityPreset({ text: 'A short standalone sentence for synthesis.' }),
        fullInferenceQualityOptions({ retryCount: 0 }),
      ),
    );
  } finally {
    mock.restoreAll();
  }
});

test('seed -1 is treated as random instead of a deterministic retry seed base', () => {
  const params = buildAttemptVariants(applyFullInferenceQualityPreset({
    text: 'Seed minus one should let the worker choose a usable random seed.',
    seed: -1,
  }), 0);

  assert.notEqual(params.seed, -1);
  assert.equal(Number.isInteger(params.seed), true);
  assert.ok(params.seed >= 0);
});

test('even a late retry take stays voice-faithful (natural params, just a new seed)', () => {
  const base = applyFullInferenceQualityPreset({
    text: 'The final attempt should still sound like the cloned voice.',
    seed: 200,
  });
  const first = buildAttemptVariants(base, 0);
  const params = buildAttemptVariants(base, 4);

  assert.equal(params.seed, 267); // 200 + seed offset for index 4
  // Voice-shaping parameters are unchanged from the first take.
  assert.equal(params.temperature, first.temperature);
  assert.equal(params.top_p, first.top_p);
  assert.equal(params.top_k, first.top_k);
  assert.equal(params.text_split_method, first.text_split_method);
  // repetition_penalty stays pinned at the base across every take (no relaxation).
  assert.equal(params.repetition_penalty, first.repetition_penalty);
});

test('a fast voice pace relaxes the too-short floor but never tightens it', () => {
  // 180 chars read by a ~22 chars/s speaker in 7.3s is a complete take (2026-10-26
  // cs-tengyu-liu_2): the fixed 15 chars/s rule wanted >= 7.8s and rejected it.
  const text = 'x'.repeat(180);
  assert.match(analyzeAudioQuality(makeNoiseWav(7.3), text).reason || '', /too short/i);
  assert.doesNotMatch(analyzeAudioQuality(makeNoiseWav(7.3), text, { charsPerSec: 21 }).reason || '', /too short/i);
  // A slow measured pace must not make the short check stricter.
  assert.doesNotMatch(analyzeAudioQuality(makeNoiseWav(8.0), text, { charsPerSec: 9 }).reason || '', /too short/i);
});

test('reference pace is measured from the clip and prompt text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-pace-'));
  const refPath = path.join(dir, 'ref.wav');
  fs.writeFileSync(refPath, makeNoiseWav(4.0));
  const pace = estimateReferenceCharsPerSec(refPath, 'y'.repeat(80));
  assert.ok(Math.abs(pace - 20) < 0.01, `pace ${pace}`);
  assert.equal(estimateReferenceCharsPerSec(path.join(dir, 'missing.wav'), 'y'.repeat(80)), null);
  assert.equal(estimateReferenceCharsPerSec(refPath, 'short'), null);
});
