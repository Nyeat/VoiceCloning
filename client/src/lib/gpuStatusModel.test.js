import test from 'node:test';
import assert from 'node:assert/strict';
import { describeGpuStatus, smoothGpuStatus } from './gpuStatusModel.js';

const ready = { configured: true, state: 'running', workerReady: true };
const warming = { configured: true, state: 'running', workerReady: false };

test('one failed poll does not flip a ready GPU back to warming', () => {
  const first = smoothGpuStatus(ready, warming, 0);
  assert.equal(first.status, ready);
  const second = smoothGpuStatus(first.status, warming, first.misses);
  assert.equal(second.status, warming);
});

test('a stopping GPU is shown immediately', () => {
  const next = { configured: true, state: 'stopping', workerReady: false };
  assert.equal(smoothGpuStatus(ready, next, 0).status, next);
});

test('a stopped GPU reads "GPU stopped" when the page does not auto-start it', () => {
  const status = { configured: true, state: 'stopped', workerReady: false, startable: true };
  assert.equal(describeGpuStatus({ status }).phase, 'stopped');
  assert.equal(describeGpuStatus({ status }).label, 'GPU stopped');
  assert.equal(describeGpuStatus({ status, autoStart: true }).phase, 'starting');
});

test('each EC2 state maps to one truthful phase', () => {
  assert.equal(describeGpuStatus({ status: warming }).phase, 'warming');
  assert.equal(describeGpuStatus({ status: ready }).phase, 'ready');
  assert.equal(describeGpuStatus({ status: { configured: true, state: 'pending' } }).phase, 'starting');
  assert.equal(describeGpuStatus({ status: { configured: true, state: 'shutting-down' } }).phase, 'stopping');
  assert.equal(describeGpuStatus({ status: { configured: true, state: 'unavailable' } }).phase, 'unavailable');
  assert.equal(describeGpuStatus({ checking: true }).phase, 'checking');
});
