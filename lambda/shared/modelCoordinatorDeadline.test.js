import test from 'node:test';
import assert from 'node:assert/strict';
import { invokeCoordinator } from './modelCoordinator.js';

test('a coordinator call that outlives its deadline ends as a retryable queue timeout', async () => {
  process.env.MODEL_COORDINATOR_FUNCTION_NAME = 'test-coordinator';
  const lambdaClient = {
    send: (_command, { abortSignal }) => new Promise((_resolve, reject) => {
      abortSignal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  };
  await assert.rejects(
    invokeCoordinator({ action: 'synthesize' }, { lambdaClient, timeoutMs: 20 }),
    (error) => error.statusCode === 503 && error.code === 'MODEL_QUEUE_TIMEOUT' && error.retryAfterSeconds === 2,
  );
  delete process.env.MODEL_COORDINATOR_FUNCTION_NAME;
});

test('a prompt coordinator answer passes through unchanged', async () => {
  process.env.MODEL_COORDINATOR_FUNCTION_NAME = 'test-coordinator';
  const lambdaClient = { send: async () => ({ Payload: Buffer.from(JSON.stringify({ statusCode: 200, ok: true })) }) };
  const result = await invokeCoordinator({ action: 'prepare' }, { lambdaClient, timeoutMs: 1_000 });
  assert.equal(result.ok, true);
  delete process.env.MODEL_COORDINATOR_FUNCTION_NAME;
});
