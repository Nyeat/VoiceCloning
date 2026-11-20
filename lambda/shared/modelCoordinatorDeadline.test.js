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

test('only the training site origin turns on one-GPU-per-person switching', async () => {
  const { isTrainingSiteRequest } = await import('./modelCoordinator.js');
  const env = { TRAINING_PUBLIC_URL: 'https://voicecloning.lkcmedicine.org/', TRAINING_SITE_ORIGINS: 'https://d1qh0ebsvevhy3.cloudfront.net' };
  assert.equal(isTrainingSiteRequest({ headers: { origin: 'https://voicecloning.lkcmedicine.org' } }, env), true);
  assert.equal(isTrainingSiteRequest({ headers: { Origin: 'https://d1qh0ebsvevhy3.cloudfront.net' } }, env), true);
  assert.equal(isTrainingSiteRequest({ headers: { origin: 'https://lectures.lkcmedicine.org' } }, env), false);
  assert.equal(isTrainingSiteRequest({ headers: {} }, env), false);
});

test('one-GPU-per-person ownership is the signed-in account, only on the training site', async () => {
  const { trainingOwnerKey } = await import('./modelCoordinator.js');
  const env = { TRAINING_PUBLIC_URL: 'https://voicecloning.lkcmedicine.org' };
  const guard = { authorize: async () => ({ oid: 'account-1', email: 'a@ntu.edu.sg', synthetic: false }) };
  const training = { headers: { origin: 'https://voicecloning.lkcmedicine.org' } };
  const key = await trainingOwnerKey(training, guard, env);
  assert.match(key, /^[0-9a-f]{24}$/u);
  assert.equal(key.includes('account-1'), false);
  assert.equal(await trainingOwnerKey({ headers: { origin: 'https://lectures.lkcmedicine.org' } }, guard, env), '');
  assert.equal(await trainingOwnerKey(training, { authorize: async () => { throw new Error('no'); } }, env), '');
  assert.equal(await trainingOwnerKey(training, null, env), '');
});

test('only the admin TTS site gets single-GPU switching', async () => {
  const { ttsSiteOption } = await import('./modelCoordinator.js');
  const env = { TTS_SITE_ORIGINS: 'https://dfzrfr93t2ruf.cloudfront.net' };
  assert.deepEqual(ttsSiteOption({ headers: { origin: 'https://dfzrfr93t2ruf.cloudfront.net/' } }, env), { singleGpu: true });
  assert.deepEqual(ttsSiteOption({ headers: { origin: 'https://lectures.lkcmedicine.org' } }, env), {});
  assert.deepEqual(ttsSiteOption({ headers: {} }, env), {});
});
