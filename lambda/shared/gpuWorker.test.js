import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchInferenceWithCapacityRetry, getCapacityRetryMetadata } from './gpuWorker.js';

function response(status, retryAfter = '') {
  return {
    status,
    headers: new Headers(retryAfter ? { 'Retry-After': retryAfter } : {}),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

test('capacity retry marks only retry attempts for worker priority', async () => {
  const previousUrl = process.env.INFERENCE_WORKER_URL;
  process.env.INFERENCE_WORKER_URL = 'https://inference.example';
  const requests = [];
  let clock = 0;
  try {
    const result = await fetchInferenceWithCapacityRetry('/inference/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }, {
      fetchImpl: async (_url, options) => {
        requests.push(options);
        return requests.length < 3 ? response(503) : response(200);
      },
      waitImpl: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });

    assert.equal(result.status, 200);
    assert.equal(requests[0].headers['X-VCS-Capacity-Retry'], undefined);
    assert.equal(requests[1].headers['X-VCS-Capacity-Retry'], '1');
    assert.equal(requests[2].headers['X-VCS-Capacity-Retry'], '2');
    assert.deepEqual(getCapacityRetryMetadata(result), {
      retryCount: 2,
      retrySleepMs: 750,
    });
  } finally {
    if (previousUrl == null) delete process.env.INFERENCE_WORKER_URL;
    else process.env.INFERENCE_WORKER_URL = previousUrl;
  }
});

test('worker calls carry the ALB origin-verify header only when configured', async () => {
  const { originVerifyHeaders } = await import('./gpuWorker.js');
  assert.deepEqual(originVerifyHeaders({}), {});
  assert.deepEqual(originVerifyHeaders({ ALB_ORIGIN_VERIFY_VALUE: 'abc' }), { 'X-VCS-Origin-Verify': 'abc' });
});

test('a worker call that outlives its deadline fails as a 504 instead of hanging', async () => {
  const { workerFetch } = await import('./gpuWorker.js');
  const neverAnswers = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  await assert.rejects(
    workerFetch('http://alb.example/inference/x', {}, { fetchImpl: neverAnswers, timeoutMs: 20 }),
    (error) => error.statusCode === 504 && error.code === 'WORKER_TIMEOUT' && !error.message.includes('alb.example'),
  );
});

test('the deadline is clamped below the CloudFront origin timeout', async () => {
  const { workerDeadlineMs } = await import('./gpuWorker.js');
  assert.equal(workerDeadlineMs({}), 55_000);
  assert.equal(workerDeadlineMs({ WORKER_REQUEST_DEADLINE_MS: '120000' }), 58_000);
});
