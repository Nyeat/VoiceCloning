import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseBestReferenceSet,
  findForeignReferencePaths,
  describeReferenceCandidate,
  shouldAutoApplyBestReferenceSet,
} from './referenceSelection.js';

test('chooseBestReferenceSet prefers clean transcript-rich wav files and adds auxiliaries', () => {
  const result = chooseBestReferenceSet([
    {
      filename: 'noisy_long_take.mp3',
      path: 'training/datasets/alex/denoised/noisy_long_take.mp3',
      transcript: 'This is a long noisy take with music behind it and lots of room sound.',
      lang: 'en',
    },
    {
      filename: 'clean_reference_02_0_160000.wav',
      path: 'training/datasets/alex/denoised/clean_reference_02_0_160000.wav',
      transcript: 'The quick brown fox jumps over the lazy dog.',
      lang: 'EN',
    },
    {
      filename: 'short_0_32000.wav',
      path: 'training/datasets/alex/denoised/short_0_32000.wav',
      transcript: 'Hi.',
      lang: 'en',
    },
    {
      filename: 'bright_best_aux_0_160000.flac',
      path: 'training/datasets/alex/denoised/bright_best_aux_0_160000.flac',
      transcript: 'Please keep this voice natural and steady for the assistant.',
      lang: 'en',
    },
  ], { maxAux: 2 });

  // Strict-only: the noisy/long take (risky name, unknown duration) and the 1-word
  // "Hi." clip are rejected, leaving the two clean sentence clips.
  assert.equal(result.primary.filename, 'clean_reference_02_0_160000.wav');
  assert.deepEqual(result.aux.map((file) => file.filename), ['bright_best_aux_0_160000.flac']);
  assert.match(result.reason, /transcript/i);
});

test('chooseBestReferenceSet hard-filters clips outside strict reference requirements before ranking', () => {
  const result = chooseBestReferenceSet([
    {
      filename: 'clean_reference_0_64000.wav',
      path: 'training/datasets/alex/denoised/clean_reference_0_64000.wav',
      transcript: 'This clip sounds fine but is too short.',
      lang: 'en',
    },
    {
      filename: 'clean_reference_0_160000.wav',
      path: 'training/datasets/alex/denoised/clean_reference_0_160000.wav',
      transcript: 'This clip has no sentence ending',
      lang: 'en',
    },
    {
      filename: 'noisy_reference_0_160000.wav',
      path: 'training/datasets/alex/denoised/noisy_reference_0_160000.wav',
      transcript: 'This clip ends properly.',
      lang: 'en',
    },
    {
      filename: 'steady_neutral_0_160000.wav',
      path: 'training/datasets/alex/denoised/steady_neutral_0_160000.wav',
      transcript: 'This clip is steady, clean, and complete.',
      lang: 'en',
    },
  ], { maxAux: 2 });

  assert.equal(result.primary.filename, 'steady_neutral_0_160000.wav');
  assert.deepEqual(result.aux, []);
  assert.equal(result.mode, 'strict');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.rejected.length, 3);
  assert.match(result.rejected[0].reasons.join(' '), /duration/i);
  assert.match(result.rejected[1].reasons.join(' '), /sentence/i);
  assert.match(result.rejected[2].reasons.join(' '), /risky/i);
});

test('chooseBestReferenceSet exposes score metadata for selected reference clips', () => {
  const result = chooseBestReferenceSet([
    {
      filename: 'steady_neutral_0_160000.wav',
      path: 'training/datasets/alex/denoised/steady_neutral_0_160000.wav',
      transcript: 'This clip is steady, clean, and complete.',
      lang: 'en',
    },
  ]);

  assert.equal(result.primaryMetadata.filename, 'steady_neutral_0_160000.wav');
  assert.equal(result.primaryMetadata.eligible, true);
  assert.equal(result.primaryMetadata.durationSeconds, 5);
  assert.equal(result.primaryMetadata.checks.idealDuration, true);
  assert.equal(result.primaryMetadata.checks.endsWithSentence, true);
  assert.ok(result.primaryMetadata.breakdown.duration > 0);
  assert.ok(result.primaryMetadata.breakdown.speakerConsistency > 0);
});

test('describeReferenceCandidate reports why a clip was rejected', () => {
  const candidate = describeReferenceCandidate({
    filename: 'bad_long_take_0_480000.wav',
    path: 'training/datasets/alex/denoised/bad_long_take_0_480000.wav',
    transcript: 'This is not stable enough',
    lang: 'en',
  });

  assert.equal(candidate.eligible, false);
  assert.deepEqual(candidate.reasons, [
    'Duration 15.0s is outside the strict 3-9s reference range.',
    'Transcript should end with sentence punctuation.',
    'Filename contains risky reference hints.',
  ]);
});

test('chooseBestReferenceSet returns no primary for an empty audio list', () => {
  assert.deepEqual(chooseBestReferenceSet([]), {
    primary: null,
    aux: [],
    reason: 'No training audio clips are available.',
  });
});

test('chooseBestReferenceSet chooses five auxiliary clips by default', () => {
  const files = [
    {
      filename: 'clean_reference_0_160000.wav',
      path: 'training/datasets/alex/denoised/clean_reference_0_160000.wav',
      transcript: 'The quick brown fox jumps over the lazy dog.',
      lang: 'en',
    },
    ...Array.from({ length: 7 }, (_, index) => ({
      filename: `steady_aux_${index + 1}_0_160000.wav`,
      path: `training/datasets/alex/denoised/steady_aux_${index + 1}_0_160000.wav`,
      transcript: `This is auxiliary reference clip number ${index + 1}.`,
      lang: 'en',
    })),
  ];

  const result = chooseBestReferenceSet(files);

  assert.equal(result.primary.filename, 'clean_reference_0_160000.wav');
  assert.equal(result.aux.length, 5);
});

test('chooseBestReferenceSet prefers a fuller prompt over a tiny intro clip', () => {
  const result = chooseBestReferenceSet([
    {
      filename: 'a_intro_0_100000.wav',
      path: 'training/datasets/alex/denoised/a_intro_0_100000.wav',
      transcript: 'Good morning to all.',
      lang: 'en',
    },
    {
      filename: 'b_balanced_0_160000.wav',
      path: 'training/datasets/alex/denoised/b_balanced_0_160000.wav',
      transcript: 'The morning air was calm and clear as people gathered outside.',
      lang: 'en',
    },
  ], { maxAux: 2 });

  assert.equal(result.primary.filename, 'b_balanced_0_160000.wav');
});

test('shouldAutoApplyBestReferenceSet waits for the selected voice clip list instead of using stale files', () => {
  assert.equal(
    shouldAutoApplyBestReferenceSet({
      selectedSourceKey: 'PMWongVoice',
      loadedSourceKey: 'LHLChinese',
      loading: false,
      fileCount: 6,
      lastAppliedSourceKey: '',
    }),
    false,
  );

  assert.equal(
    shouldAutoApplyBestReferenceSet({
      selectedSourceKey: 'PMWongVoice',
      loadedSourceKey: 'PMWongVoice',
      loading: false,
      fileCount: 6,
      lastAppliedSourceKey: '',
    }),
    true,
  );
});

test('chooseBestReferenceSet ranks by audio quality score when present', () => {
  const result = chooseBestReferenceSet([
    { filename: 'a_0_160000.wav', path: 'd/a_0_160000.wav', transcript: 'A clear sentence here for the reference.', lang: 'en', qualityScore: 40 },
    { filename: 'b_160000_320000.wav', path: 'd/b_160000_320000.wav', transcript: 'Another clear sentence here for reference.', lang: 'en', qualityScore: 85 },
    { filename: 'c_320000_480000.wav', path: 'd/c_320000_480000.wav', transcript: 'Yet another clear sentence for the reference.', lang: 'en', qualityScore: 60 },
  ], { maxAux: 2 });

  assert.equal(result.primary.filename, 'b_160000_320000.wav');
  assert.deepEqual(result.aux.map((file) => file.filename), ['c_320000_480000.wav', 'a_0_160000.wav']);
  assert.match(result.reason, /quality/i);
});

test('chooseBestReferenceSet transcript guard avoids an empty-transcript primary', () => {
  const result = chooseBestReferenceSet([
    { filename: 'pristine_empty_0_160000.wav', path: 'd/pristine_empty_0_160000.wav', transcript: '', lang: 'en', qualityScore: 85 },
    { filename: 'good_text_0_160000.wav', path: 'd/good_text_0_160000.wav', transcript: 'This is a perfectly usable reference sentence for cloning.', lang: 'en', qualityScore: 75 },
  ], { maxAux: 1 });

  assert.equal(result.primary.filename, 'good_text_0_160000.wav');
});

test('chooseBestReferenceSet rejects clips failed by measured acoustic gates', () => {
  const result = chooseBestReferenceSet([
    {
      filename: 'loud_clipped_0_160000.wav',
      path: 'd/loud_clipped_0_160000.wav',
      transcript: 'This sentence looks suitable but the waveform is clipped.',
      lang: 'en',
      qualityScore: 99,
      qualityMetrics: { score: 99, eligible: false, rejection_reasons: ['clipping_above_0.1pct'] },
    },
    {
      filename: 'clean_160000_320000.wav',
      path: 'd/clean_160000_320000.wav',
      transcript: 'A clean measured sentence remains eligible for cloning.',
      lang: 'en',
      qualityScore: 72,
      qualityMetrics: { score: 72, eligible: true },
    },
  ]);

  assert.equal(result.primary.filename, 'clean_160000_320000.wav');
  assert.match(result.rejected[0].reasons.join(' '), /clipping_above_0.1pct/);
});

test('auxiliary selection favors transcript coverage over a near-duplicate second rank', () => {
  const result = chooseBestReferenceSet([
    { filename: 'primary_0_160000.wav', path: 'd/primary_0_160000.wav', transcript: 'The patient has severe hypertension today.', lang: 'en', qualityScore: 95 },
    { filename: 'duplicate_160000_320000.wav', path: 'd/duplicate_160000_320000.wav', transcript: 'The patient has hypertension today.', lang: 'en', qualityScore: 94 },
    { filename: 'diverse_960000_1120000.wav', path: 'd/diverse_960000_1120000.wav', transcript: 'Bright questions require careful vocal rhythm.', lang: 'en', qualityScore: 82 },
  ], { maxAux: 1 });

  assert.equal(result.primary.filename, 'primary_0_160000.wav');
  assert.deepEqual(result.aux.map((file) => file.filename), ['diverse_960000_1120000.wav']);
});

test('references from another voice dataset are reported as foreign', () => {
  const own = 'training/datasets/cs-tengyu-liu_2/denoised/a.wav';
  const dean = 'training/datasets/deanvoice/denoised/b.wav';
  assert.deepEqual(findForeignReferencePaths([own, dean, ''], 'cs-tengyu-liu_2'), [dean]);
  assert.deepEqual(findForeignReferencePaths([`echolect-staging/${own}`], 'cs-tengyu-liu_2'), []);
  // A shared-prefix voice name is still another voice.
  assert.deepEqual(findForeignReferencePaths(['training/datasets/cs-tengyu-liu_20/x.wav'], 'cs-tengyu-liu_2').length, 1);
  assert.deepEqual(findForeignReferencePaths([dean], ''), []);
  assert.deepEqual(findForeignReferencePaths(['uploads/custom.wav'], 'cs-tengyu-liu_2'), []);
});
