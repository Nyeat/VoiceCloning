import assert from 'node:assert/strict';
import test from 'node:test';
import { describeGpuStatus, smoothGpuStatus } from './gpuStatusModel.js';
import { synthesisResponseError } from './synthesisResponse.js';
import { isRetryableSynthesisError } from './backendErrors.js';
import { voiceCapacityBlocksConversation, voiceCapacityNotice, voiceCapacityWait } from './voiceCapacity.js';

const closed = {
  configured: true, state: 'stopped', workerReady: false, startable: false,
  closed: 'paused', message: 'The GPU has been turned off by an administrator.',
};

test('a closed GPU never reads "Starting", even on auto-start builds', () => {
  for (const autoStart of [true, false]) {
    const view = describeGpuStatus({ status: closed, autoStart });
    assert.equal(view.phase, 'closed');
    assert.equal(view.detail, closed.message);
  }
  // A paused GPU that is still running closes immediately, without the ready-miss delay.
  const ready = { configured: true, state: 'running', workerReady: true };
  assert.equal(smoothGpuStatus(ready, { ...closed, state: 'running' }).status.closed, 'paused');
});

test('GPU_PAUSED synthesis is a final message, never retried as "GPU offline"', () => {
  const error = synthesisResponseError(JSON.stringify({ error: 'Turned off.', code: 'GPU_PAUSED' }), 503);
  assert.equal(error.code, 'GPU_PAUSED');
  assert.equal(error.message, 'Turned off.');
  assert.equal(isRetryableSynthesisError(error), false);
});

test('a PAUSED voice locks the chat with the admin message and no wait popup', () => {
  const capacity = { state: 'PAUSED', message: 'Off for maintenance.' };
  assert.equal(voiceCapacityBlocksConversation(capacity), true);
  assert.equal(voiceCapacityNotice(capacity), 'Off for maintenance.');
  assert.equal(voiceCapacityWait(capacity), null);
});

test('busy states stay usable (no lock, no blocking popup)', () => {
  for (const state of ['BUSY_STARTING', 'BUSY_WARMING', 'BUSY_LIMIT']) {
    const capacity = { state, canStartConversation: true };
    assert.equal(voiceCapacityBlocksConversation(capacity), false);
    assert.equal(voiceCapacityWait(capacity), null);
    assert.ok(voiceCapacityNotice(capacity));
  }
});
