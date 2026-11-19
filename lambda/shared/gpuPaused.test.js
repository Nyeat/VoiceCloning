import assert from 'node:assert/strict';
import test from 'node:test';
import { gpuClosure } from '../instance/index.js';
import {
  coordinatedInferencePost,
  coordinatedInferencePostBinary,
  gpuPausedMessage,
  prepareCoordinatedModel,
} from './modelCoordinator.js';

async function withEnv(values, run) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return await run(); } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('GPU_PAUSED closes the GPU in any state with one message; schedule closes only a stopped GPU off-hours', () => {
  const paused = gpuClosure('running', { env: { GPU_PAUSED: 'true' } });
  assert.equal(paused.reason, 'paused');
  assert.match(paused.message, /turned off by an administrator/);
  assert.equal(gpuClosure('running', { env: {} }), null);
  const night = new Date('2026-11-19T15:00:00Z'); // 00:00 Seoul
  const env = { GPU_SCHEDULE_ENABLED: 'true', GPU_SCHEDULE_START_HOUR: '7', GPU_SCHEDULE_END_HOUR: '19' };
  assert.equal(gpuClosure('stopped', { env, now: night }).reason, 'schedule');
  assert.equal(gpuClosure('running', { env, now: night }), null);
  assert.equal(gpuClosure('stopped', { env, now: new Date('2026-11-19T03:00:00Z') }), null);
});

test('a paused GPU never prepares, scales or synthesizes; cancel still works', async () => {
  await withEnv({ GPU_PAUSED: 'true', MODEL_COORDINATOR_FUNCTION_NAME: 'never-invoked' }, async () => {
    assert.ok(gpuPausedMessage());
    const prepared = await prepareCoordinatedModel({}, { allowScale: true });
    assert.equal(prepared.state, 'PAUSED');
    assert.equal(prepared.canStartConversation, false);
    await assert.rejects(coordinatedInferencePostBinary('/inference/tts', {}), { code: 'GPU_PAUSED', statusCode: 503 });
    await assert.rejects(coordinatedInferencePost('/inference', {}), { code: 'GPU_PAUSED' });
  });
  await withEnv({ GPU_PAUSED: 'false' }, async () => assert.equal(gpuPausedMessage(), ''));
});
