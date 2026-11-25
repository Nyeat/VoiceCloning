import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseVoiceFailure, trainingRunName, MIN_TRAINING_AUDIO_SECONDS } from './voiceFailureDiagnosis.js';

const files = {
  'voice-profiles/cs-nat_6-v1.json': { gptKey: 'models/user-models/gpt/cs-nat_6-e15.ckpt' },
  'training/datasets/cs-nat_6/training-quality-report.json': { keptDurationSeconds: 29.1 },
  'voice-profiles/cs-nat_4-v1.json': { gptKey: 'models/user-models/gpt/cs-nat_4-e15.ckpt' },
  'training/datasets/cs-nat_4/training-quality-report.json': { keptDurationSeconds: 1500 },
};
const readJson = async (key) => files[key] || null;

test('the run name comes from the GPT weights key', () => {
  assert.equal(trainingRunName({ gptKey: 'models/user-models/gpt/cs-nathanael-ng_6-e15.ckpt' }), 'cs-nathanael-ng_6');
  assert.equal(trainingRunName({}), '');
});

test('a voice trained on 29 s is "too short: re-record" (the 2026-11-25 root cause)', async () => {
  const result = await diagnoseVoiceFailure('cs-nat_6-v1', { readJson });
  assert.equal(result.action, 'rerecord');
  assert.equal(result.trainedSeconds, 29.1);
  assert.match(result.reason, /too short.*29 s.*10 min/u);
  assert.equal(MIN_TRAINING_AUDIO_SECONDS, 600);
});

test('enough audio: "retrain", with how much it had', async () => {
  const result = await diagnoseVoiceFailure('cs-nat_4-v1', { readJson });
  assert.equal(result.action, 'retrain');
  assert.match(result.reason, /25 min/u);
});

test('nothing readable: a generic reason, never a throw', async () => {
  const result = await diagnoseVoiceFailure('missing-v1', { readJson, error: 'tts failed' });
  assert.equal(result.action, 'retrain');
  assert.equal(result.detail, 'tts failed');
  assert.equal((await diagnoseVoiceFailure('', {})).action, 'retrain');
});
