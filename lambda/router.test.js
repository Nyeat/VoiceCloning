import test from 'node:test';
import assert from 'node:assert/strict';

import { findRoute, getRouteHandler } from './router.js';
import { handler as liveHandler } from './live/index.js';

test('router eagerly prepares the latency-sensitive Live handler', async () => {
  const route = findRoute('POST', '/api/live/tts-sentence');

  assert.equal(await getRouteHandler(route), liveHandler);
});

test('router resolves authenticated lesson analytics ingest', () => {
  const route = findRoute('POST', '/api/analytics/events');
  assert.equal(route.name, 'AnalyticsFunction');
  assert.equal(route.modulePath, './analytics/index.js');
});

test('router resolves learner and supervisor analytics reads', () => {
  assert.equal(findRoute('GET', '/api/learner/me')?.name, 'LearnersFunction');
  assert.equal(findRoute('GET', '/api/supervisor/users')?.name, 'LearnersFunction');
  assert.equal(findRoute('GET', '/api/supervisor/users/user-1')?.name, 'LearnersFunction');
  assert.equal(findRoute('GET', '/api/supervisor/users/user-1/events')?.name, 'LearnersFunction');
  assert.equal(findRoute('GET', '/api/supervisor/concepts')?.name, 'LearnersFunction');
  assert.equal(
    findRoute('DELETE', '/api/supervisor/users/user-1/lessons/gi-bleeding/concepts/endoscopy')?.name,
    'LearnersFunction',
  );
});

test('router resolves voice profile activation and active-summary routes', () => {
  assert.deepEqual(
    findRoute('POST', '/api/voice-profile/activate'),
    {
      name: 'VoiceProfileFunction',
      methods: ['GET', 'POST'],
      pattern: /^\/api\/voice-profile\/(?:activate|active|capacity|label|mine|ensure|(?:internal|pinned)\/[^/]+)\/?$/u,
      modulePath: './voice-profile/index.js',
      lambdaPath: '/api/voice-profile/activate',
    },
  );

  assert.deepEqual(
    findRoute('GET', '/api/voice-profile/active'),
    {
      name: 'VoiceProfileFunction',
      methods: ['GET', 'POST'],
      pattern: /^\/api\/voice-profile\/(?:activate|active|capacity|label|mine|ensure|(?:internal|pinned)\/[^/]+)\/?$/u,
      modulePath: './voice-profile/index.js',
      lambdaPath: '/api/voice-profile/active',
    },
  );

  assert.deepEqual(
    findRoute('GET', '/api/voice-profile/internal/michael-tan-v1'),
    {
      name: 'VoiceProfileFunction',
      methods: ['GET', 'POST'],
      pattern: /^\/api\/voice-profile\/(?:activate|active|capacity|label|mine|ensure|(?:internal|pinned)\/[^/]+)\/?$/u,
      modulePath: './voice-profile/index.js',
      lambdaPath: '/api/voice-profile/internal/michael-tan-v1',
    },
  );

  assert.equal(
    findRoute('GET', '/api/voice-profile/pinned/deanvoice-v1')?.name,
    'VoiceProfileFunction',
  );
  assert.equal(
    findRoute('POST', '/api/voice-profile/capacity')?.name,
    'VoiceProfileFunction',
  );
  assert.equal(
    findRoute('GET', '/api/voice-profile/mine')?.name,
    'VoiceProfileFunction',
  );
  assert.equal(
    findRoute('POST', '/api/voice-profile/ensure')?.name,
    'VoiceProfileFunction',
  );
});

test('router resolves shared training library routes', () => {
  assert.deepEqual(
    findRoute('GET', '/api/training-library'),
    {
      name: 'TrainingLibraryFunction',
      methods: ['GET', 'POST', 'DELETE'],
      pattern: /^\/api\/training-library(?:\/(?:snapshot|presign|confirm|[^/]+(?:\/(?:replace-presign|replace-confirm))?))?\/?$/u,
      modulePath: './training-library/index.js',
      lambdaPath: '/api/training-library',
    },
  );

  assert.deepEqual(
    findRoute('POST', '/api/training-library/snapshot'),
    {
      name: 'TrainingLibraryFunction',
      methods: ['GET', 'POST', 'DELETE'],
      pattern: /^\/api\/training-library(?:\/(?:snapshot|presign|confirm|[^/]+(?:\/(?:replace-presign|replace-confirm))?))?\/?$/u,
      modulePath: './training-library/index.js',
      lambdaPath: '/api/training-library/snapshot',
    },
  );

  assert.deepEqual(
    findRoute('DELETE', '/api/training-library/lib-123'),
    {
      name: 'TrainingLibraryFunction',
      methods: ['GET', 'POST', 'DELETE'],
      pattern: /^\/api\/training-library(?:\/(?:snapshot|presign|confirm|[^/]+(?:\/(?:replace-presign|replace-confirm))?))?\/?$/u,
      modulePath: './training-library/index.js',
      lambdaPath: '/api/training-library/lib-123',
    },
  );
});

test('router resolves training metadata route', () => {
  assert.deepEqual(
    findRoute('GET', '/api/train/metadata/demo'),
    {
      name: 'TrainingFunction',
      methods: ['GET', 'POST'],
      pattern: /^\/api\/train(?:\/(?:stop|current|next-name|metadata\/[^/]+))?\/?$/u,
      modulePath: './training/index.js',
      lambdaPath: '/api/train/metadata/demo',
    },
  );
});

test('router resolves generated inference chunk route', () => {
  assert.deepEqual(
    findRoute('GET', '/api/inference/chunk/abc-123/2'),
    {
      name: 'InferenceFunction',
      methods: ['GET', 'POST'],
      pattern: /^\/api\/inference(?:\/(?:generate|regenerate-chunk|restore-chunk|insert-chunk|delete-chunk|scan-oov|result\/[A-Za-z0-9-]+|chunk\/[A-Za-z0-9-]+\/\d+|chunk-preview\/[A-Za-z0-9-]+\/\d+|chunk-version\/[A-Za-z0-9-]+\/\d+\/[A-Za-z0-9-]+|cancel|current|status|start|stop))?\/?$/u,
      modulePath: './inference/index.js',
      lambdaPath: '/api/inference/chunk/abc-123/2',
    },
  );
});

test('router resolves normalized chunk previews and targeted regeneration', () => {
  assert.equal(findRoute('GET', '/api/inference/chunk-preview/abc-123/2')?.name, 'InferenceFunction');
  assert.equal(findRoute('POST', '/api/inference/regenerate-chunk')?.name, 'InferenceFunction');
  assert.equal(findRoute('POST', '/api/inference/restore-chunk')?.name, 'InferenceFunction');
  assert.equal(findRoute('GET', '/api/inference/chunk-version/abc-123/2/version-456')?.name, 'InferenceFunction');
  assert.equal(findRoute('POST', '/api/inference/delete-chunk')?.name, 'InferenceFunction');
  assert.equal(findRoute('POST', '/api/inference/insert-chunk')?.name, 'InferenceFunction');
});

test('router resolves per-person voice profile config routes', () => {
  assert.deepEqual(
    findRoute('GET', '/api/voice-profile/configs/michael-tan-v1'),
    {
      name: 'VoiceProfileConfigsFunction',
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      pattern: /^\/api\/voice-profile\/configs\/[^/]+(?:\/[^/]+)?\/?$/u,
      modulePath: './voice-profile-configs/index.js',
      lambdaPath: '/api/voice-profile/configs/michael-tan-v1',
    },
  );

  assert.deepEqual(
    findRoute('PUT', '/api/voice-profile/configs/michael-tan-v1/warm-ref'),
    {
      name: 'VoiceProfileConfigsFunction',
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      pattern: /^\/api\/voice-profile\/configs\/[^/]+(?:\/[^/]+)?\/?$/u,
      modulePath: './voice-profile-configs/index.js',
      lambdaPath: '/api/voice-profile/configs/michael-tan-v1/warm-ref',
    },
  );

  assert.deepEqual(
    findRoute('DELETE', '/api/voice-profile/configs/michael-tan-v1/warm-ref'),
    {
      name: 'VoiceProfileConfigsFunction',
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      pattern: /^\/api\/voice-profile\/configs\/[^/]+(?:\/[^/]+)?\/?$/u,
      modulePath: './voice-profile-configs/index.js',
      lambdaPath: '/api/voice-profile/configs/michael-tan-v1/warm-ref',
    },
  );
});

test('router resolves the voice-name allocation route', () => {
  const route = findRoute('POST', '/api/train/next-name');
  assert.equal(route?.modulePath, './training/index.js');
  assert.equal(route?.lambdaPath, '/api/train/next-name');
});

test('router resolves the my-voices route', () => {
  const route = findRoute('GET', '/api/voice-profile/mine');
  assert.equal(route?.modulePath, './voice-profile/index.js');
  assert.equal(route?.lambdaPath, '/api/voice-profile/mine');
});

test('router resolves the ensure-profile route', () => {
  const route = findRoute('POST', '/api/voice-profile/ensure');
  assert.equal(route?.modulePath, './voice-profile/index.js');
  assert.equal(route?.lambdaPath, '/api/voice-profile/ensure');
});

test('router reaches voice naming and GPU page activity (2026-11-20: naming 404d)', () => {
  assert.equal(findRoute('POST', '/api/voice-profile/label')?.name, 'VoiceProfileFunction');
  assert.equal(findRoute('POST', '/api/instance/activity')?.name, 'InstanceFunction');
});
