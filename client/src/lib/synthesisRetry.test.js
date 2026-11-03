import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CAPACITY_RETRY_INTERVAL_MS,
  isAutoRetryableCapacityError,
  runSynthesisWithRetry,
} from './synthesisRetry.js';

function capacityError(code = 'MODEL_CAPACITY_STARTING') {
  return Object.assign(new Error('Voice capacity is preparing.'), { code, status: 503 });
}

test('retries the same synthesis after capacity becomes ready', async () => {
  let calls = 0;
  const waits = [];
  const notices = [];
  const result = await runSynthesisWithRetry(async () => {
    calls += 1;
    if (calls < 3) throw capacityError();
    return 'audio';
  }, {
    wait: async (ms) => { waits.push(ms); },
    onCapacityWait: (err) => { notices.push(err.code); },
  });

  assert.equal(result, 'audio');
  assert.equal(calls, 3);
  assert.deepEqual(waits, [CAPACITY_RETRY_INTERVAL_MS, CAPACITY_RETRY_INTERVAL_MS]);
  assert.deepEqual(notices, ['MODEL_CAPACITY_STARTING', 'MODEL_CAPACITY_STARTING']);
});

test('does not auto-retry a hard fleet limit or Dev simulation', async () => {
  assert.equal(isAutoRetryableCapacityError(capacityError('MODEL_CAPACITY_LIMIT')), false);
  assert.equal(isAutoRetryableCapacityError(capacityError('DEV_CAPACITY_SIMULATED')), false);

  for (const code of ['MODEL_CAPACITY_LIMIT', 'DEV_CAPACITY_SIMULATED']) {
    let calls = 0;
    await assert.rejects(runSynthesisWithRetry(async () => {
      calls += 1;
      throw capacityError(code);
    }, { wait: async () => {} }));
    assert.equal(calls, 1);
  }
});

test('automatically retries queue overflow and admission contention using the server hint', async () => {
  for (const code of ['MODEL_QUEUE_FULL', 'MODEL_QUEUE_TIMEOUT', 'MODEL_ADMISSION_BUSY']) {
    let calls = 0;
    const waits = [];
    const result = await runSynthesisWithRetry(async () => {
      calls += 1;
      if (calls === 1) {
        const error = capacityError(code);
        error.retryAfterSeconds = 2;
        throw error;
      }
      return 'audio';
    }, { wait: async (ms) => { waits.push(ms); } });
    assert.equal(result, 'audio');
    assert.equal(calls, 2);
    assert.deepEqual(waits, [2_000]);
  }
});

test('stopping the conversation cancels a capacity retry', async () => {
  let cancelled = false;
  let calls = 0;
  await assert.rejects(runSynthesisWithRetry(async () => {
    calls += 1;
    throw capacityError();
  }, {
    isCancelled: () => cancelled,
    wait: async () => { cancelled = true; },
  }));

  assert.equal(calls, 1);
});

test('an interactive caller polls a capacity switch sooner than the worst-case hint', async () => {
  const waits = [];
  let calls = 0;
  const result = await runSynthesisWithRetry(async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('switching'), { code: 'MODEL_CAPACITY_STARTING', retryAfterSeconds: 60 });
    return 'wav';
  }, { wait: async (ms) => { waits.push(ms); }, maxCapacityWaitMs: 5_000 });
  assert.equal(result, 'wav');
  assert.deepEqual(waits, [5_000]);
});
