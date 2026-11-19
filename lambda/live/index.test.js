import test from 'node:test';
import assert from 'node:assert/strict';

import { createHandler, handler, liveAuthRequired } from './index.js';

test('live tts handler resolves voiceProfileId to a saved full profile before synthesis', async () => {
  const calls = [];
  const timestamps = [100, 103, 118];
  const handler = createHandler({
    now: () => timestamps.shift(),
    resolveSynthesisBody: async (body) => ({
      ...body,
      ref_audio_path: 'training/datasets/lecturer-a/reference.wav',
      prompt_text: 'Reference transcript',
      prompt_lang: 'en',
      text_lang: 'en',
      aux_ref_audio_paths: ['training/datasets/lecturer-a/aux1.wav'],
      top_k: 6,
      top_p: 0.88,
      temperature: 0.69,
      repetition_penalty: 1.3,
      speed_factor: 1.0,
    }),
    postBinary: async (routePath, payload) => {
      calls.push({ routePath, payload });
      return {
        buffer: Buffer.from('RIFFdemo'),
        contentType: 'audio/wav',
        queueWaitMs: '4',
        capacityRetryCount: 2,
        capacityRetrySleepMs: 750,
      };
    },
  });

  const response = await handler({
    requestContext: { http: { method: 'POST' } },
    rawPath: '/api/live/tts-sentence',
    body: JSON.stringify({
      text: 'Hello there.',
      voiceProfileId: 'lecturer-a-v1',
    }),
  }, { awsRequestId: 'request-123' });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Content-Type'], 'audio/wav');
  assert.equal(response.headers['X-VCS-Profile-Resolve-Ms'], '3.0');
  assert.equal(response.headers['X-VCS-Worker-Round-Trip-Ms'], '15.0');
  assert.equal(response.headers['X-VCS-Lambda-Total-Ms'], '18.0');
  assert.equal(response.headers['X-VCS-GPU-Queue-Wait-Ms'], '4');
  assert.equal(response.headers['X-VCS-Lambda-Cold-Start'], '1');
  assert.equal(response.headers['X-VCS-Lambda-Request-Id'], 'request-123');
  assert.equal(response.headers['X-VCS-Capacity-Retry-Count'], '2');
  assert.equal(response.headers['X-VCS-Capacity-Retry-Sleep-Ms'], '750');
  assert.ok(response.headers['X-VCS-Lambda-Environment-Id']);
  assert.match(response.headers['Access-Control-Expose-Headers'], /X-VCS-GPU-Queue-Wait-Ms/u);
  assert.equal('X-Word-Timestamps' in response.headers, false);
  assert.equal(Buffer.from(response.body, 'base64').toString('utf-8'), 'RIFFdemo');
  assert.deepEqual(calls, [
    {
      routePath: '/inference/tts',
      payload: {
        text: 'Hello there. ',
        voiceProfileId: 'lecturer-a-v1',
        ref_audio_path: 'training/datasets/lecturer-a/reference.wav',
        prompt_text: 'Reference transcript',
        prompt_lang: 'en',
        text_lang: 'en',
        aux_ref_audio_paths: ['training/datasets/lecturer-a/aux1.wav'],
        top_k: 6,
        top_p: 0.88,
        temperature: 0.69,
        repetition_penalty: 1.3,
        speed_factor: 1.0,
        text_split_method: 'cut0',
        batch_size: 1,
        streaming_mode: false,
        split_bucket: true,
        parallel_infer: false,
        fragment_interval: 0.1,
      },
    },
  ]);
});

test('live tts handler proxies synthesis through the inference worker URL', async () => {
  const previousFetch = globalThis.fetch;
  const previousInferenceWorkerUrl = process.env.INFERENCE_WORKER_URL;
  const previousGpuWorkerUrl = process.env.GPU_WORKER_URL;
  const calls = [];

  process.env.INFERENCE_WORKER_URL = 'http://inference-worker.local:3003';
  process.env.GPU_WORKER_URL = 'http://gpu-worker.local:3001';
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return new Response(Buffer.from('RIFFdemo'), {
      status: 200,
      headers: { 'Content-Type': 'audio/wav' },
    });
  };

  try {
    const response = await handler({
      requestContext: { http: { method: 'POST' } },
      rawPath: '/api/live/tts-sentence',
      body: JSON.stringify({
        text: 'Hello there.',
        ref_audio_path: 'training/datasets/lecturer-a/reference.wav',
      }),
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['Content-Type'], 'audio/wav');
    assert.equal('X-Word-Timestamps' in response.headers, false);
    assert.equal(calls[0].url, 'http://inference-worker.local:3003/inference/tts');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousInferenceWorkerUrl === undefined) {
      delete process.env.INFERENCE_WORKER_URL;
    } else {
      process.env.INFERENCE_WORKER_URL = previousInferenceWorkerUrl;
    }
    if (previousGpuWorkerUrl === undefined) {
      delete process.env.GPU_WORKER_URL;
    } else {
      process.env.GPU_WORKER_URL = previousGpuWorkerUrl;
    }
  }
});

test('live tts marks only the first invocation in one Lambda environment as cold', async () => {
  const invocationState = { cold: true, environmentId: 'environment-a' };
  const localHandler = createHandler({
    invocationState,
    resolveSynthesisBody: async (body) => ({ ...body, ref_audio_path: 'ref.wav' }),
    postBinary: async () => ({ buffer: Buffer.from('RIFF'), contentType: 'audio/wav' }),
  });
  const event = {
    requestContext: { http: { method: 'POST' } },
    rawPath: '/api/live/tts-sentence',
    body: JSON.stringify({ text: 'Hello.' }),
  };

  const first = await localHandler(event);
  const second = await localHandler(event);

  assert.equal(first.headers['X-VCS-Lambda-Cold-Start'], '1');
  assert.equal(second.headers['X-VCS-Lambda-Cold-Start'], '0');
  assert.equal(first.headers['X-VCS-Lambda-Environment-Id'], 'environment-a');
  assert.equal(second.headers['X-VCS-Lambda-Environment-Id'], 'environment-a');
});

test('live tts preserves worker busy status for multi-user feedback', async () => {
  const previousFetch = globalThis.fetch;
  const previousInferenceWorkerUrl = process.env.INFERENCE_WORKER_URL;
  process.env.INFERENCE_WORKER_URL = 'http://inference-worker.local:3003';
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: 'Another generation is already running on this instance',
  }), {
    status: 409,
    headers: { 'Content-Type': 'application/json' },
  });

  try {
    const response = await handler({
      requestContext: { http: { method: 'POST' } },
      rawPath: '/api/live/tts-sentence',
      body: JSON.stringify({
        text: 'Hello there.',
        ref_audio_path: 'training/datasets/lecturer-a/reference.wav',
      }),
    });

    assert.equal(response.statusCode, 409);
    assert.match(JSON.parse(response.body).error, /another generation/iu);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousInferenceWorkerUrl === undefined) {
      delete process.env.INFERENCE_WORKER_URL;
    } else {
      process.env.INFERENCE_WORKER_URL = previousInferenceWorkerUrl;
    }
  }
});

test('a queued-while-scaling coordinator answer reaches the browser with its code, not as a bare 503', async () => {
  for (const code of ['MODEL_QUEUE_FULL', 'MODEL_QUEUE_TIMEOUT', 'MODEL_ADMISSION_BUSY', 'MODEL_CAPACITY_STARTING']) {
    const handler = createHandler({
      resolveSynthesisBody: async (body) => ({ ...body, ref_audio_path: 'training/datasets/a/ref.wav' }),
      postBinary: async () => {
        const error = new Error('This voice is busy and its waiting list is full.');
        error.statusCode = 503;
        error.code = code;
        error.retryAfterSeconds = 5;
        throw error;
      },
    });
    const response = await handler({
      requestContext: { http: { method: 'POST' } },
      rawPath: '/api/live/tts-sentence',
      body: JSON.stringify({ text: 'Hello there.' }),
    });
    assert.equal(response.statusCode, 503);
    assert.equal(JSON.parse(response.body).code, code);
    assert.equal(response.headers['Retry-After'], '5');
  }
});

test('barge-in cancel forwards the reply token to the worker without resolving a voice profile', async () => {
  const calls = [];
  const handler = createHandler({
    resolveSynthesisBody: async () => {
      throw new Error('cancel must not resolve a voice profile');
    },
    post: async (routePath, payload) => {
      calls.push({ routePath, payload });
      return { freed: 1 };
    },
  });

  const response = await handler({
    requestContext: { http: { method: 'POST' } },
    rawPath: '/api/live/cancel',
    body: JSON.stringify({ replyToken: 'reply-abc' }),
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { freed: 1 });
  assert.deepEqual(calls, [{ routePath: '/live/cancel', payload: { replyToken: 'reply-abc' } }]);
});

test('cancel rejects a missing reply token', async () => {
  const handler = createHandler({
    post: async () => {
      throw new Error('should not reach the worker');
    },
  });

  const response = await handler({
    requestContext: { http: { method: 'POST' } },
    rawPath: '/api/live/cancel',
    body: JSON.stringify({}),
  });

  assert.equal(response.statusCode, 400);
});

test('a worker that refuses the cancel degrades to one wasted clip, not a broken conversation', async () => {
  const handler = createHandler({
    post: async () => {
      throw new Error('worker unreachable');
    },
  });

  const response = await handler({
    requestContext: { http: { method: 'POST' } },
    rawPath: '/api/live/cancel',
    body: JSON.stringify({ replyToken: 'reply-abc' }),
  });

  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).freed, 0);
});

test('the reply token rides along with each clip so the worker can free it later', async () => {
  const headerCalls = [];
  const handler = createHandler({
    resolveSynthesisBody: async (body) => ({ ...body, ref_audio_path: 'ref.wav' }),
    postBinary: async (routePath, payload, headers) => {
      headerCalls.push(headers);
      return { buffer: Buffer.from('RIFF'), contentType: 'audio/wav' };
    },
  });

  await handler({
    requestContext: { http: { method: 'POST' } },
    rawPath: '/api/live/tts-sentence',
    headers: { 'x-vcs-reply-token': 'reply-abc' },
    body: JSON.stringify({ text: 'Hello.' }),
  });

  assert.equal(headerCalls[0]['X-VCS-Reply-Token'], 'reply-abc');
});

test('a clip sent without a reply token carries no token header', async () => {
  const headerCalls = [];
  const handler = createHandler({
    resolveSynthesisBody: async (body) => ({ ...body, ref_audio_path: 'ref.wav' }),
    postBinary: async (routePath, payload, headers) => {
      headerCalls.push(headers);
      return { buffer: Buffer.from('RIFF'), contentType: 'audio/wav' };
    },
  });

  await handler({
    requestContext: { http: { method: 'POST' } },
    rawPath: '/api/live/tts-sentence',
    body: JSON.stringify({ text: 'Hello.' }),
  });

  assert.equal('X-VCS-Reply-Token' in headerCalls[0], false);
});

test('an unauthenticated synthesis request is refused before any GPU work', async () => {
  // The gateway authenticates the conversation; without this the same GPU is
  // still reachable by calling /api/live/tts-sentence directly.
  const calls = [];
  const handler = createHandler({
    authGuard: {
      authorize: async () => {
        const error = new Error('Token signature does not verify.');
        error.code = 'bad_signature';
        throw error;
      },
    },
    resolveSynthesisBody: async (body) => body,
    postBinary: async (routePath, payload) => {
      calls.push({ routePath, payload });
      return { buffer: Buffer.from('RIFFdemo'), contentType: 'audio/wav' };
    },
  });

  const response = await handler({
    requestContext: { http: { method: 'POST' } },
    rawPath: '/api/live/tts-sentence',
    body: JSON.stringify({ text: 'Hello there.', voiceProfileId: 'lecturer-a-v1' }),
  }, { awsRequestId: 'request-401' });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(calls, [], 'no synthesis may be requested for an unauthorized caller');
});

test('dev demo-only auth protects tagged GI requests and leaves other dev clients public', async () => {
  const env = { LIVE_AUTH_DEMO_ONLY: 'true' };
  assert.equal(liveAuthRequired({ headers: { 'x-demo-request': 'true' } }, env), true);
  assert.equal(liveAuthRequired({ headers: {} }, env), false);
  assert.equal(liveAuthRequired({ headers: {} }, { LIVE_AUTH_DEMO_ONLY: 'false' }), true);

  let authorized = false;
  const publicHandler = createHandler({
    authRequired: () => false,
    authGuard: { authorize: async () => { authorized = true; throw new Error('missing token'); } },
    resolveSynthesisBody: async (body) => ({ ...body, ref_audio_path: 'ref.wav' }),
    postBinary: async () => ({ buffer: Buffer.from('RIFFdemo'), contentType: 'audio/wav' }),
  });
  const response = await publicHandler({
    requestContext: { http: { method: 'POST' } },
    rawPath: '/api/live/tts-sentence',
    headers: {},
    body: JSON.stringify({ text: 'Public dev TTS.' }),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(authorized, false);
});

test('an authorized synthesis request proceeds as normal', async () => {
  const calls = [];
  const handler = createHandler({
    authGuard: { authorize: async () => ({ oid: 'abc', email: '', synthetic: false }) },
    resolveSynthesisBody: async (body) => ({
      ...body,
      ref_audio_path: 'training/datasets/lecturer-a/reference.wav',
      prompt_text: 'Reference transcript',
      prompt_lang: 'en',
      text_lang: 'en',
    }),
    postBinary: async (routePath, payload) => {
      calls.push({ routePath, payload });
      return { buffer: Buffer.from('RIFFdemo'), contentType: 'audio/wav' };
    },
  });

  const response = await handler({
    requestContext: { http: { method: 'POST' } },
    rawPath: '/api/live/tts-sentence',
    body: JSON.stringify({ text: 'Hello there.', voiceProfileId: 'lecturer-a-v1' }),
  }, { awsRequestId: 'request-200' });

  assert.equal(response.statusCode, 200);
  assert.equal(calls.length, 1);
});

test('a barge-in cancel is authenticated too', async () => {
  // replyToken belongs to someone else's in-flight reply, so an open cancel
  // route would let anyone interrupt another student's answer.
  const calls = [];
  const handler = createHandler({
    authGuard: {
      authorize: async () => { throw new Error('nope'); },
    },
    post: async (routePath, payload) => {
      calls.push({ routePath, payload });
      return { freed: 1 };
    },
  });

  const response = await handler({
    requestContext: { http: { method: 'POST' } },
    rawPath: '/api/live/cancel',
    body: JSON.stringify({ replyToken: 'someone-elses-token' }),
  }, { awsRequestId: 'request-cancel' });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(calls, []);
});

test('a standard voice synthesizes without touching the GPU or resolving a profile', async () => {
  const calls = [];
  const handler = createHandler({
    now: () => 0,
    resolveSynthesisBody: async () => {
      throw new Error('voice profile resolution must not run for a standard voice');
    },
    postBinary: async () => {
      throw new Error('the GPU worker must not be called for a standard voice');
    },
    synthesizeStandardVoice: async (body) => {
      calls.push(body);
      return { buffer: Buffer.from('ID3'), contentType: 'audio/mpeg', characterCount: 6 };
    },
  });

  const response = await handler({
    requestContext: { http: { method: 'POST' } },
    rawPath: '/api/live/tts-sentence',
    body: JSON.stringify({ text: 'Hello.', voiceProfileId: 'elevenlabs:v1' }),
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Content-Type'], 'audio/mpeg');
  assert.equal(response.headers['X-VCS-Voice-Provider'], 'elevenlabs');
  assert.equal(response.headers['X-VCS-Voice-Characters'], '6');
  assert.equal(Buffer.from(response.body, 'base64').toString(), 'ID3');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].voiceProfileId, 'elevenlabs:v1');
});

test('a standard-voice failure keeps its upstream status instead of becoming a 500', async () => {
  const handler = createHandler({
    now: () => 0,
    resolveSynthesisBody: async () => { throw new Error('must not run'); },
    postBinary: async () => { throw new Error('must not run'); },
    synthesizeStandardVoice: async () => {
      const error = new Error('Standard voice quota reached. Try again later.');
      error.statusCode = 429;
      throw error;
    },
  });

  const response = await handler({
    requestContext: { http: { method: 'POST' } },
    rawPath: '/api/live/tts-sentence',
    body: JSON.stringify({ text: 'Hello.', voiceProfileId: 'elevenlabs:v1' }),
  });

  assert.equal(response.statusCode, 429);
});

test('a cloned voice still goes to the GPU worker', async () => {
  let gpuCalls = 0;
  const handler = createHandler({
    now: () => 0,
    resolveSynthesisBody: async (body) => ({ ...body, ref_audio_path: 'ref.wav' }),
    postBinary: async () => {
      gpuCalls += 1;
      return { buffer: Buffer.from('RIFF'), contentType: 'audio/wav' };
    },
    synthesizeStandardVoice: async () => {
      throw new Error('a cloned voice must not go to ElevenLabs');
    },
  });

  const response = await handler({
    requestContext: { http: { method: 'POST' } },
    rawPath: '/api/live/tts-sentence',
    body: JSON.stringify({ text: 'Hello.', voiceProfileId: 'deanvoice-v1' }),
  });

  assert.equal(response.statusCode, 200);
  assert.equal(gpuCalls, 1);
});
