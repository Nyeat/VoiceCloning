import test from 'node:test';
import assert from 'node:assert/strict';

import { createHandler } from './index.js';

function createEvent({ method = 'GET', path = '/api/voice-profile/active', body, query } = {}) {
  return {
    requestContext: { http: { method } },
    rawPath: path,
    body: body === undefined ? undefined : JSON.stringify(body),
    queryStringParameters: query,
    headers: {},
  };
}

test('voice profile activate saves the full profile and marks it active', async () => {
  const uploads = [];
  const warmedProfiles = [];
  const handler = createHandler({
    readObject: async () => {
      throw new Error('not used');
    },
    writeObject: async (key, payload, contentType) => {
      uploads.push({
        key,
        contentType,
        body: JSON.parse(payload.toString('utf-8')),
      });
    },
    warmReferenceAudio: async (profile) => {
      warmedProfiles.push({
        ref_audio_path: profile.ref_audio_path,
        aux_ref_audio_paths: profile.aux_ref_audio_paths,
      });
    },
    now: () => '2026-05-18T10:00:00.000Z',
  });

  const response = await handler(createEvent({
    method: 'POST',
    path: '/api/voice-profile/activate',
    body: {
      voiceProfileId: 'michael-tan-v1',
      displayName: 'Michael Tan',
      gptKey: 'models/user-models/gpt/michael-tan.ckpt',
      sovitsKey: 'models/user-models/sovits/michael-tan.pth',
      ref_audio_path: 'training/datasets/michael-tan/reference.wav',
      prompt_text: 'Reference transcript',
      prompt_lang: 'en',
      text_lang: 'en',
      preferredRoute: 'sentence',
      aux_ref_audio_paths: ['training/datasets/michael-tan/aux1.wav'],
      defaults: {
        top_k: 5,
        top_p: 0.85,
        temperature: 0.7,
        repetition_penalty: 1.35,
        speed_factor: 1.0,
        max_chunk_words: 0,
        max_sentences_per_chunk: 1,
      },
    },
  }));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    voiceProfileId: 'michael-tan-v1',
    displayName: 'Michael Tan',
    activatedAt: '2026-05-18T10:00:00.000Z',
  });
  assert.deepEqual(uploads, [
    {
      key: 'voice-profiles/michael-tan-v1.json',
      contentType: 'application/json',
      body: {
        voiceProfileId: 'michael-tan-v1',
        displayName: 'Michael Tan',
        gptKey: 'models/user-models/gpt/michael-tan.ckpt',
        sovitsKey: 'models/user-models/sovits/michael-tan.pth',
        ref_audio_path: 'training/datasets/michael-tan/reference.wav',
        prompt_text: 'Reference transcript',
        prompt_lang: 'en',
        text_lang: 'en',
        preferredRoute: 'sentence',
        aux_ref_audio_paths: ['training/datasets/michael-tan/aux1.wav'],
        defaults: {
          top_k: 5,
          top_p: 0.85,
          temperature: 0.7,
          repetition_penalty: 1.35,
          speed_factor: 1.0,
          max_chunk_words: 0,
          max_sentences_per_chunk: 1,
        },
        updatedAt: '2026-05-18T10:00:00.000Z',
      },
    },
    {
      key: 'voice-profiles/active.json',
      contentType: 'application/json',
      body: {
        voiceProfileId: 'michael-tan-v1',
        displayName: 'Michael Tan',
        gptKey: 'models/user-models/gpt/michael-tan.ckpt',
        sovitsKey: 'models/user-models/sovits/michael-tan.pth',
        ref_audio_path: 'training/datasets/michael-tan/reference.wav',
        prompt_text: 'Reference transcript',
        prompt_lang: 'en',
        text_lang: 'en',
        preferredRoute: 'sentence',
        aux_ref_audio_paths: ['training/datasets/michael-tan/aux1.wav'],
        defaults: {
          top_k: 5,
          top_p: 0.85,
          temperature: 0.7,
          repetition_penalty: 1.35,
          speed_factor: 1.0,
          max_chunk_words: 0,
          max_sentences_per_chunk: 1,
        },
        updatedAt: '2026-05-18T10:00:00.000Z',
        activatedAt: '2026-05-18T10:00:00.000Z',
      },
    },
  ]);
  assert.deepEqual(warmedProfiles, [{
    ref_audio_path: 'training/datasets/michael-tan/reference.wav',
    aux_ref_audio_paths: ['training/datasets/michael-tan/aux1.wav'],
  }]);
});

test('voice profile activate saves metadata layers for reproducible Live Fast configs', async () => {
  const uploads = [];
  const handler = createHandler({
    readObject: async () => {
      throw new Error('not used');
    },
    writeObject: async (key, payload) => {
      uploads.push({ key, body: JSON.parse(payload.toString('utf-8')) });
    },
    warmReferenceAudio: async () => {},
    now: () => '2026-06-10T01:00:00.000Z',
  });

  const response = await handler(createEvent({
    method: 'POST',
    path: '/api/voice-profile/activate',
    body: {
      voiceProfileId: 'metadata-voice-v1',
      displayName: 'Metadata Voice',
      gptKey: 'models/user-models/gpt/metadata.ckpt',
      sovitsKey: 'models/user-models/sovits/metadata.pth',
      ref_audio_path: 'training/datasets/metadata/denoised/ref.wav',
      prompt_text: 'This reference is clean and steady.',
      prompt_lang: 'en',
      text_lang: 'en',
      aux_ref_audio_paths: ['training/datasets/metadata/denoised/aux.wav'],
      defaults: { top_k: 5, speed_factor: 1 },
      metadata: {
        training: {
          engineVersion: 'v2ProPlus',
          skipDenoise: true,
          batchSize: 2,
          sovitsEpochs: 8,
          gptEpochs: 15,
        },
        reference: {
          mode: 'strict',
          primary: { path: 'training/datasets/metadata/denoised/ref.wav', score: 124 },
          aux: [{ path: 'training/datasets/metadata/denoised/aux.wav', score: 118 }],
        },
        liveFast: {
          configName: 'Default',
          selected: true,
          rank: 1,
          defaults: {
            max_chunk_words: 35,
            max_sentences_per_chunk: 1,
          },
        },
      },
    },
  }));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(uploads[0].body.metadata, {
    training: {
      engineVersion: 'v2ProPlus',
      skipDenoise: true,
      batchSize: 2,
      sovitsEpochs: 8,
      gptEpochs: 15,
    },
    reference: {
      mode: 'strict',
      primary: { path: 'training/datasets/metadata/denoised/ref.wav', score: 124 },
      aux: [{ path: 'training/datasets/metadata/denoised/aux.wav', score: 118 }],
    },
    liveFast: {
      configName: 'Default',
      selected: true,
      rank: 1,
      defaults: {
        max_chunk_words: 35,
        max_sentences_per_chunk: 1,
      },
    },
  });
  assert.deepEqual(uploads[0].body.defaults, {
    top_k: 5,
    speed_factor: 1,
    max_chunk_words: 35,
    max_sentences_per_chunk: 1,
  });
  assert.deepEqual(uploads[1].body.metadata, uploads[0].body.metadata);
  assert.deepEqual(uploads[1].body.defaults, uploads[0].body.defaults);
});

test('voice profile activate rejects incomplete profile payloads', async () => {
  const handler = createHandler({
    readObject: async () => {
      throw new Error('not used');
    },
    writeObject: async () => {
      throw new Error('should not write');
    },
    now: () => '2026-05-18T10:00:00.000Z',
  });

  const response = await handler(createEvent({
    method: 'POST',
    path: '/api/voice-profile/activate',
    body: {
      voiceProfileId: 'michael-tan-v1',
      displayName: 'Michael Tan',
      gptKey: 'models/user-models/gpt/michael-tan.ckpt',
      sovitsKey: 'models/user-models/sovits/michael-tan.pth',
    },
  }));

  assert.equal(response.statusCode, 400);
  assert.match(JSON.parse(response.body).error, /ref_audio_path is required/u);
});

test('voice profile active returns only summary data', async () => {
  const handler = createHandler({
    readObject: async (key) => {
      assert.equal(key, 'voice-profiles/active.json');
      return Buffer.from(JSON.stringify({
        voiceProfileId: 'dr-lim-v1',
        displayName: 'Dr Lim',
        gptKey: 'models/user-models/gpt/dr-lim.ckpt',
        sovitsKey: 'models/user-models/sovits/dr-lim.pth',
        ref_audio_path: 'training/datasets/dr-lim/reference.wav',
        prompt_text: 'Reference transcript',
        prompt_lang: 'en',
        text_lang: 'en',
        preferredRoute: 'sentence',
        aux_ref_audio_paths: [],
        defaults: {
          top_k: 5,
          top_p: 0.85,
          temperature: 0.7,
          repetition_penalty: 1.35,
          speed_factor: 1.0,
        },
        updatedAt: '2026-05-18T10:00:00.000Z',
        activatedAt: '2026-05-18T10:00:00.000Z',
      }), 'utf-8');
    },
    writeObject: async () => {
      throw new Error('not used');
    },
    now: () => '2026-05-18T10:00:00.000Z',
  });

  const response = await handler(createEvent({
    method: 'GET',
    path: '/api/voice-profile/active',
  }));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    voiceProfileId: 'dr-lim-v1',
    displayName: 'Dr Lim',
    activatedAt: '2026-05-18T10:00:00.000Z',
  });
});

test('an authenticated GI user can load the configured saved profile without changing active voice', async () => {
  const reads = [];
  const handler = createHandler({
    authGuard: { authorize: async () => ({ oid: 'student-1' }) },
    readObject: async (key) => {
      reads.push(key);
      return Buffer.from(JSON.stringify({
        voiceProfileId: 'deanvoice-v1',
        displayName: 'DeanVoice',
        gptKey: 'models/user-models/gpt/dean.ckpt',
        sovitsKey: 'models/user-models/sovits/dean.pth',
        ref_audio_path: 'training/datasets/dean/ref.wav',
      }));
    },
    writeObject: async () => { throw new Error('pinned reads must not mutate active voice'); },
  });
  const response = await handler(createEvent({ path: '/api/voice-profile/pinned/deanvoice-v1' }));
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).voiceProfileId, 'deanvoice-v1');
  assert.deepEqual(reads, ['voice-profiles/deanvoice-v1.json']);
});

test('the pinned profile endpoint rejects an unsigned caller before reading storage', async () => {
  const handler = createHandler({
    authGuard: { authorize: async () => { throw new Error('missing token'); } },
    readObject: async () => { throw new Error('unauthorized requests must not read profiles'); },
  });
  const response = await handler(createEvent({ path: '/api/voice-profile/pinned/deanvoice-v1' }));
  assert.equal(response.statusCode, 401);
});

test('an authenticated lecture capacity preflight resolves the pinned model before coordinating', async () => {
  const resolved = [];
  const prepared = [];
  const prepareOptions = [];
  const handler = createHandler({
    authGuard: { authorize: async () => ({ oid: 'student-1' }) },
    resolveCapacityBody: async (body) => {
      resolved.push(body);
      return {
        ...body,
        ref_audio_path: 'training/datasets/dean/ref.wav',
        voice_model: { voiceProfileId: body.voiceProfileId, gptRef: 'g.ckpt', sovitsRef: 's.pth' },
      };
    },
    prepareModelCapacity: async (body, options) => {
      prepared.push(body);
      prepareOptions.push(options);
      return { state: 'STARTING', canStartConversation: false, retryAfterSeconds: 900 };
    },
  });
  const response = await handler(createEvent({
    method: 'POST',
    path: '/api/voice-profile/capacity',
    body: { voiceProfileId: 'deanvoice-v1' },
  }));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(resolved, [{
    voiceProfileId: 'deanvoice-v1',
    text: 'Lecture voice capacity preflight.',
  }]);
  assert.equal(prepared[0].voice_model.voiceProfileId, 'deanvoice-v1');
  assert.deepEqual(prepareOptions, [{ allowScale: true, source: 'lecture-preflight' }]);
  assert.deepEqual(JSON.parse(response.body), {
    state: 'STARTING',
    canStartConversation: false,
    retryAfterSeconds: 900,
  });
});

test('lecture capacity preflight rejects an unsigned caller before resolving a model', async () => {
  const handler = createHandler({
    authGuard: { authorize: async () => { throw new Error('missing token'); } },
    resolveCapacityBody: async () => { throw new Error('unauthorized requests must not resolve profiles'); },
  });
  const response = await handler(createEvent({
    method: 'POST',
    path: '/api/voice-profile/capacity',
    body: { voiceProfileId: 'deanvoice-v1' },
  }));
  assert.equal(response.statusCode, 401);
});

test('voice profile active can return the full stored profile for browser restore when full=1 is requested', async () => {
  const handler = createHandler({
    readObject: async (key) => {
      assert.equal(key, 'voice-profiles/active.json');
      return Buffer.from(JSON.stringify({
        voiceProfileId: 'dr-lim-v1',
        displayName: 'Dr Lim',
        gptKey: 'models/user-models/gpt/dr-lim.ckpt',
        sovitsKey: 'models/user-models/sovits/dr-lim.pth',
        ref_audio_path: 'training/datasets/dr-lim/reference.wav',
        prompt_text: 'Reference transcript',
        prompt_lang: 'en',
        text_lang: 'en',
        preferredRoute: 'sentence',
        aux_ref_audio_paths: ['training/datasets/dr-lim/aux-1.wav'],
        defaults: {
          top_k: 5,
          top_p: 0.85,
          temperature: 0.7,
          repetition_penalty: 1.35,
          speed_factor: 1.0,
        },
        updatedAt: '2026-05-18T10:00:00.000Z',
        activatedAt: '2026-05-18T10:00:00.000Z',
      }), 'utf-8');
    },
    writeObject: async () => {
      throw new Error('not used');
    },
    now: () => '2026-05-18T10:00:00.000Z',
  });

  const response = await handler(createEvent({
    method: 'GET',
    path: '/api/voice-profile/active',
    query: { full: '1' },
  }));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    voiceProfileId: 'dr-lim-v1',
    displayName: 'Dr Lim',
    gptKey: 'models/user-models/gpt/dr-lim.ckpt',
    sovitsKey: 'models/user-models/sovits/dr-lim.pth',
    ref_audio_path: 'training/datasets/dr-lim/reference.wav',
    prompt_text: 'Reference transcript',
    prompt_lang: 'en',
    text_lang: 'en',
    preferredRoute: 'sentence',
    aux_ref_audio_paths: ['training/datasets/dr-lim/aux-1.wav'],
    defaults: {
      top_k: 5,
      top_p: 0.85,
      temperature: 0.7,
      repetition_penalty: 1.35,
      speed_factor: 1.0,
    },
    updatedAt: '2026-05-18T10:00:00.000Z',
    activatedAt: '2026-05-18T10:00:00.000Z',
  });
});

test('voice profile active returns 404 when no active profile has been saved', async () => {
  const handler = createHandler({
    readObject: async () => null,
    writeObject: async () => {
      throw new Error('not used');
    },
    now: () => '2026-05-18T10:00:00.000Z',
  });

  const response = await handler(createEvent({
    method: 'GET',
    path: '/api/voice-profile/active',
  }));

  assert.equal(response.statusCode, 404);
  assert.match(JSON.parse(response.body).error, /No active voice profile/u);
});

test('voice profile internal returns the full stored profile when the shared secret matches', async () => {
  const handler = createHandler({
    readObject: async (key) => {
      assert.equal(key, 'voice-profiles/michael-tan-v1.json');
      return Buffer.from(JSON.stringify({
        voiceProfileId: 'michael-tan-v1',
        displayName: 'Michael Tan',
        preferredRoute: 'sentence',
        gptKey: 'models/user-models/gpt/michael-tan.ckpt',
        sovitsKey: 'models/user-models/sovits/michael-tan.pth',
        ref_audio_path: 'training/datasets/michael-tan/reference.wav',
        prompt_text: 'Reference transcript',
        prompt_lang: 'en',
        text_lang: 'en',
        aux_ref_audio_paths: ['training/datasets/michael-tan/aux1.wav'],
        defaults: {
          top_k: 5,
          top_p: 0.85,
          temperature: 0.7,
          repetition_penalty: 1.35,
          speed_factor: 1.0,
        },
        updatedAt: '2026-05-18T10:00:00.000Z',
      }), 'utf-8');
    },
    writeObject: async () => {
      throw new Error('not used');
    },
    internalAuthHeaderName: 'x-internal-key',
    internalAuthHeaderValue: 'super-secret',
    now: () => '2026-05-18T10:00:00.000Z',
  });

  const response = await handler({
    ...createEvent({
      method: 'GET',
      path: '/api/voice-profile/internal/michael-tan-v1',
    }),
    headers: {
      'x-internal-key': 'super-secret',
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    voiceProfileId: 'michael-tan-v1',
    displayName: 'Michael Tan',
    preferredRoute: 'sentence',
    gptKey: 'models/user-models/gpt/michael-tan.ckpt',
    sovitsKey: 'models/user-models/sovits/michael-tan.pth',
    ref_audio_path: 'training/datasets/michael-tan/reference.wav',
    prompt_text: 'Reference transcript',
    prompt_lang: 'en',
    text_lang: 'en',
    aux_ref_audio_paths: ['training/datasets/michael-tan/aux1.wav'],
    defaults: {
      top_k: 5,
      top_p: 0.85,
      temperature: 0.7,
      repetition_penalty: 1.35,
      speed_factor: 1.0,
    },
    updatedAt: '2026-05-18T10:00:00.000Z',
  });
});

test('voice profile internal rejects requests with missing or wrong shared secret', async () => {
  const handler = createHandler({
    readObject: async () => {
      throw new Error('not used');
    },
    writeObject: async () => {
      throw new Error('not used');
    },
    internalAuthHeaderName: 'x-internal-key',
    internalAuthHeaderValue: 'super-secret',
    now: () => '2026-05-18T10:00:00.000Z',
  });

  const response = await handler(createEvent({
    method: 'GET',
    path: '/api/voice-profile/internal/michael-tan-v1',
  }));

  assert.equal(response.statusCode, 403);
  assert.match(JSON.parse(response.body).error, /Forbidden/u);
});

test('a saved voice profile records the lecturer who owns it, inheriting it from the training run', async () => {
  const written = new Map();
  const handler = createHandler({
    readObject: async () => null,
    writeObject: async (key, body) => { written.set(key, JSON.parse(body.toString('utf-8'))); },
    warmReferenceAudio: async () => {},
    now: () => '2026-08-24T00:00:00.000Z',
  });

  const response = await handler({
    requestContext: { http: { method: 'POST' } },
    rawPath: '/api/voice-profile/activate',
    body: JSON.stringify({
      voiceProfileId: 'alice-tan_calm-v1',
      displayName: 'alice-tan_calm',
      gptKey: 'models/user-models/gpt/alice-tan_calm-e15.ckpt',
      sovitsKey: 'models/user-models/sovits/alice-tan_calm_e20_s260.pth',
      ref_audio_path: 'training/datasets/alice-tan_calm/denoised/ref.wav',
      metadata: { training: { ownerEmail: 'Alice.Tan@NTU.edu.sg' } },
    }),
  });

  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).ownerEmail, 'alice.tan@ntu.edu.sg');
  assert.equal(written.get('voice-profiles/alice-tan_calm-v1.json').ownerEmail, 'alice.tan@ntu.edu.sg');
});

test('a non-NTU owner is not recorded, so ownership can never point outside the university', async () => {
  const written = new Map();
  const handler = createHandler({
    readObject: async () => null,
    writeObject: async (key, body) => { written.set(key, JSON.parse(body.toString('utf-8'))); },
    warmReferenceAudio: async () => {},
    now: () => '2026-08-24T00:00:00.000Z',
  });

  await handler({
    requestContext: { http: { method: 'POST' } },
    rawPath: '/api/voice-profile/activate',
    body: JSON.stringify({
      voiceProfileId: 'demo-v1',
      displayName: 'demo',
      gptKey: 'g.ckpt',
      sovitsKey: 's.pth',
      ref_audio_path: 'ref.wav',
      ownerEmail: 'someone@gmail.com',
    }),
  });

  assert.equal('ownerEmail' in written.get('voice-profiles/demo-v1.json'), false);
});

// --- GET /api/voice-profile/mine -------------------------------------------

// What the model files say exists. cs-nathanael-ng is trained but has no saved
// profile — the case that shipped broken.
const TRAINED_VOICES = ['alice-tan', 'alice-tan_2', 'DeanVoice', 'Obama', 'cs-nathanael-ng'];

const STORED_PROFILES = {
  // Saved after ownerEmail existed.
  'voice-profiles/alice-tan-v1.json': {
    voiceProfileId: 'alice-tan-v1', displayName: 'alice-tan',
    ownerEmail: 'alice.tan@ntu.edu.sg', updatedAt: '2026-08-20T00:00:00.000Z',
  },
  'voice-profiles/alice-tan_2-v1.json': {
    voiceProfileId: 'alice-tan_2-v1', displayName: 'alice-tan_2',
    ownerEmail: 'alice.tan@ntu.edu.sg', updatedAt: '2026-08-21T00:00:00.000Z',
  },
  // Legacy: no ownerEmail at all, ownership must fall back to the name rule.
  'voice-profiles/deanvoice-v1.json': {
    voiceProfileId: 'deanvoice-v1', displayName: 'DeanVoice',
    updatedAt: '2026-06-24T00:00:00.000Z',
  },
  'voice-profiles/obama-v1.json': {
    voiceProfileId: 'obama-v1', displayName: 'Obama', updatedAt: '2026-05-01T00:00:00.000Z',
  },
};

function mineHandler(identity, { env = {}, trained = TRAINED_VOICES } = {}) {
  return createHandler({
    authGuard: { authorize: async () => identity },
    listVoiceNames: async () => trained,
    listProfileObjects: async () => [
      ...Object.keys(STORED_PROFILES).map((key) => ({ key })),
      // The shared active pointer lives in the same prefix and is not a voice.
      { key: 'voice-profiles/active.json' },
    ],
    readObject: async (key) => (STORED_PROFILES[key]
      ? Buffer.from(JSON.stringify(STORED_PROFILES[key]), 'utf-8')
      : null),
    ...env,
  });
}

function mineEvent(query = {}) {
  return {
    requestContext: { http: { method: 'GET' } },
    rawPath: '/api/voice-profile/mine',
    queryStringParameters: query,
  };
}

test('a lecturer sees only the voices they own', async () => {
  const response = await mineHandler({ email: 'Alice.Tan@ntu.edu.sg', oid: 'oid-alice' })(mineEvent());
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);

  assert.deepEqual(body.voices.map((voice) => voice.voiceProfileId), ['alice-tan-v1', 'alice-tan_2-v1']);
  assert.equal(body.voices.every((voice) => voice.hasSavedProfile), true);
  assert.equal(body.scope, 'mine');
  assert.equal(body.isAdmin, false);
  assert.equal(body.email, 'alice.tan@ntu.edu.sg');
});

test('a legacy profile with no ownerEmail is matched by its name', async () => {
  const response = await mineHandler({ email: 'josephsung@ntu.edu.sg', oid: 'oid-dean' })(mineEvent());
  const body = JSON.parse(response.body);

  assert.deepEqual(body.voices.map((voice) => voice.displayName), ['DeanVoice']);
  assert.equal(body.voices[0].isMine, true);
});

test('a lecturer with no voices gets an empty list, not an error', async () => {
  const response = await mineHandler({ email: 'newcomer@ntu.edu.sg', oid: 'oid-new' })(mineEvent());
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body).voices, []);
});

test('a freshly trained voice is listed even though no profile has been saved for it', async () => {
  // Training writes models and nothing else. Listing only voice-profiles/ hid
  // every new voice until the lecturer opened the TTS page — the bug this covers.
  const response = await mineHandler({
    email: 'CS-NATHANAEL.NG@assoc.main.ntu.edu.sg', oid: 'oid-nat',
  })(mineEvent());

  const voices = JSON.parse(response.body).voices;
  assert.deepEqual(voices.map((voice) => voice.displayName), ['cs-nathanael-ng']);
  assert.equal(voices[0].hasSavedProfile, false);
  assert.equal(voices[0].voiceProfileId, 'cs-nathanael-ng-v1', 'id is derived when no profile exists');
  assert.equal(voices[0].isMine, true);
});

test('a saved profile and its models are one voice, not two', async () => {
  const response = await mineHandler({ email: 'alice.tan@ntu.edu.sg', oid: 'oid-alice' })(mineEvent());
  const names = JSON.parse(response.body).voices.map((voice) => voice.displayName);
  assert.deepEqual(names, ['alice-tan', 'alice-tan_2']);
});

test('a saved profile whose models are gone is still listed', async () => {
  const response = await mineHandler(
    { email: 'alice.tan@ntu.edu.sg', oid: 'oid-alice' },
    { trained: [] },
  )(mineEvent());
  assert.deepEqual(
    JSON.parse(response.body).voices.map((voice) => voice.displayName),
    ['alice-tan', 'alice-tan_2'],
  );
});

test('scope=all is inert for a lecturer and honoured for an admin', async () => {
  const lecturer = await mineHandler({ email: 'alice.tan@ntu.edu.sg', oid: 'oid-alice' })(
    mineEvent({ scope: 'all' }),
  );
  const lecturerBody = JSON.parse(lecturer.body);
  assert.equal(lecturerBody.scope, 'mine', 'asking for all must not grant it');
  assert.equal(lecturerBody.voices.length, 2);

  const admin = await mineHandler({ email: 'dev@ntu.edu.sg', oid: 'oid-dev', roles: ['Supervisor'] })(
    mineEvent({ scope: 'all' }),
  );
  const adminBody = JSON.parse(admin.body);
  assert.equal(adminBody.isAdmin, true);
  assert.equal(adminBody.scope, 'all');
  assert.deepEqual(
    adminBody.voices.map((voice) => voice.voiceProfileId).sort(),
    ['alice-tan-v1', 'alice-tan_2-v1', 'cs-nathanael-ng-v1', 'deanvoice-v1', 'obama-v1'],
  );
  assert.equal(adminBody.voices.every((voice) => voice.isMine === false), true, 'none are the admin own');
});

test('an admin still defaults to their own voices until they ask for all', async () => {
  const response = await mineHandler({ email: 'dev@ntu.edu.sg', oid: 'oid-dev', roles: ['Supervisor'] })(mineEvent());
  const body = JSON.parse(response.body);
  assert.equal(body.isAdmin, true);
  assert.equal(body.scope, 'mine');
  assert.deepEqual(body.voices, []);
});

test('the shared active.json pointer is not listed as a voice', async () => {
  const response = await mineHandler({ email: 'dev@ntu.edu.sg', oid: 'oid-dev', roles: ['Supervisor'] })(
    mineEvent({ scope: 'all' }),
  );
  const ids = JSON.parse(response.body).voices.map((voice) => voice.voiceProfileId);
  assert.equal(ids.includes(undefined), false);
  assert.equal(ids.includes('active-v1'), false, 'the shared pointer is not a voice');
  assert.equal(ids.length, 5);
});

test('an unreadable record does not hide the rest', async () => {
  const handler = createHandler({
    authGuard: { authorize: async () => ({ email: 'alice.tan@ntu.edu.sg', oid: 'oid-alice' }) },
    listVoiceNames: async () => [],
    listProfileObjects: async () => [
      { key: 'voice-profiles/broken.json' },
      { key: 'voice-profiles/alice-tan-v1.json' },
    ],
    readObject: async (key) => (key === 'voice-profiles/broken.json'
      ? Buffer.from('{not json', 'utf-8')
      : Buffer.from(JSON.stringify(STORED_PROFILES['voice-profiles/alice-tan-v1.json']), 'utf-8')),
  });

  const response = await handler(mineEvent());
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body).voices.map((voice) => voice.displayName), ['alice-tan']);
});

test('an unauthenticated caller is refused before any storage is read', async () => {
  let listed = false;
  const handler = createHandler({
    authGuard: { authorize: async () => { throw new Error('no token'); } },
    listVoiceNames: async () => { listed = true; return []; },
    listProfileObjects: async () => { listed = true; return []; },
    readObject: async () => null,
  });

  const response = await handler(mineEvent());
  assert.equal(response.statusCode, 401);
  assert.equal(listed, false);
});

// --- POST /api/voice-profile/ensure ----------------------------------------

const SELECTION = {
  ref_audio_path: 'training/datasets/cs-nathanael-ng/denoised/clip.wav',
  aux_ref_audio_paths: ['training/datasets/cs-nathanael-ng/denoised/aux.wav'],
  prompt_text: 'a lot of technology.',
};

function ensureHandler(identity, overrides = {}) {
  return createHandler({
    authGuard: { authorize: async () => identity },
    readObject: async () => null,
    findBestModels: async () => ({
      gptKey: 'models/user-models/gpt/cs-nathanael-ng-e25.ckpt',
      sovitsKey: 'models/user-models/sovits/cs-nathanael-ng_e20_s2220.pth',
    }),
    resolveReferences: async () => SELECTION,
    persistProfile: async () => true,
    ...overrides,
  });
}

function ensureEvent(body) {
  return {
    requestContext: { http: { method: 'POST' } },
    rawPath: '/api/voice-profile/ensure',
    body: JSON.stringify(body),
  };
}

const NAT = { email: 'CS-NATHANAEL.NG@assoc.main.ntu.edu.sg', oid: 'oid-nat' };

test('ensure builds a saved profile for a trained voice that has none', async () => {
  const written = [];
  const handler = ensureHandler(NAT, {
    persistProfile: async (profile, selection) => { written.push({ profile, selection }); return true; },
  });

  const response = await handler(ensureEvent({ voiceName: 'cs-nathanael-ng' }));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    voiceProfileId: 'cs-nathanael-ng-v1',
    displayName: 'cs-nathanael-ng',
    created: true,
  });

  assert.equal(written.length, 1);
  const { profile } = written[0];
  assert.equal(profile.voiceProfileId, 'cs-nathanael-ng-v1');
  assert.equal(profile.ownerEmail, 'cs-nathanael.ng@assoc.main.ntu.edu.sg', 'the owner is recorded');
  assert.equal(profile.gptKey, 'models/user-models/gpt/cs-nathanael-ng-e25.ckpt');
  assert.equal(profile.ref_audio_path, SELECTION.ref_audio_path);
});

test('ensure is idempotent — an existing profile is returned, not rebuilt', async () => {
  let persisted = 0;
  const handler = ensureHandler(NAT, {
    readObject: async () => Buffer.from(JSON.stringify({
      voiceProfileId: 'cs-nathanael-ng-v1', displayName: 'cs-nathanael-ng',
    }), 'utf-8'),
    persistProfile: async () => { persisted += 1; return true; },
  });

  const response = await handler(ensureEvent({ voiceName: 'cs-nathanael-ng' }));
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).created, false);
  assert.equal(persisted, 0, 'an existing profile must not be overwritten');
});

test('ensure refuses a voice the caller does not own', async () => {
  let persisted = 0;
  const handler = ensureHandler(NAT, { persistProfile: async () => { persisted += 1; return true; } });

  for (const voiceName of ['DeanVoice', 'alice-tan', 'cs-nathanael-ng2']) {
    const response = await handler(ensureEvent({ voiceName }));
    assert.equal(response.statusCode, 403, `${voiceName} must be refused`);
  }
  assert.equal(persisted, 0);
});

test('ensure refuses a numbered copy the naming rule cannot produce', async () => {
  const handler = ensureHandler(NAT);
  // copies start at _2; _1 is never a name this email can own
  assert.equal((await handler(ensureEvent({ voiceName: 'cs-nathanael-ng_1' }))).statusCode, 403);
  assert.equal((await handler(ensureEvent({ voiceName: 'cs-nathanael-ng_2' }))).statusCode, 200);
});

test('ensure rejects an unsafe voice name before doing anything', async () => {
  const handler = ensureHandler(NAT);
  for (const voiceName of ['', '../escape', 'has space']) {
    const response = await handler(ensureEvent({ voiceName }));
    assert.equal(response.statusCode, 400, `${voiceName} must be rejected`);
  }
});

test('ensure reports a voice with no trained models rather than writing a stub', async () => {
  let persisted = 0;
  const handler = ensureHandler(NAT, {
    findBestModels: async () => null,
    persistProfile: async () => { persisted += 1; return true; },
  });

  const response = await handler(ensureEvent({ voiceName: 'cs-nathanael-ng' }));
  assert.equal(response.statusCode, 404);
  assert.equal(persisted, 0);
});

test('ensure refuses to write a profile with no reference audio', async () => {
  let persisted = 0;
  const handler = ensureHandler(NAT, {
    resolveReferences: async () => ({}),
    persistProfile: async () => { persisted += 1; return true; },
  });

  const response = await handler(ensureEvent({ voiceName: 'cs-nathanael-ng' }));
  assert.equal(response.statusCode, 409);
  assert.match(JSON.parse(response.body).error, /reference clip/u);
  assert.equal(persisted, 0, 'a voice with nothing to speak from must not be half-created');
});

test('ensure refuses an unauthenticated caller', async () => {
  const handler = createHandler({
    authGuard: { authorize: async () => { throw new Error('no token'); } },
    persistProfile: async () => { throw new Error('must not be reached'); },
  });
  assert.equal((await handler(ensureEvent({ voiceName: 'cs-nathanael-ng' }))).statusCode, 401);
});

test('the public active-profile route never reveals the owner email', async () => {
  const { withoutOwnerIdentity } = await import('./index.js');
  const profile = {
    voiceProfileId: 'v-1', displayName: 'V', ownerEmail: 'a@b.sg',
    metadata: { training: { ownerEmail: 'a@b.sg', expName: 'v' } },
  };
  const stripped = withoutOwnerIdentity(profile);
  assert.equal('ownerEmail' in stripped, false);
  assert.equal('ownerEmail' in stripped.metadata.training, false);
  assert.equal(stripped.metadata.training.expName, 'v');
  assert.equal(profile.ownerEmail, 'a@b.sg');
});
