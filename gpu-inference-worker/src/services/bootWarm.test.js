import assert from 'node:assert/strict';
import test from 'node:test';

import { warmOnBoot, warmPayloadFromProfile } from './bootWarm.js';

test('warmPayloadFromProfile maps any active profile, not a hard-coded voice', () => {
  const payload = warmPayloadFromProfile({
    voiceProfileId: 'some-other-voice',
    gptKey: 'models/user-models/gpt/Other-e25.ckpt',
    sovitsKey: 'models/user-models/sovits/Other_e20.pth',
    ref_audio_path: 'training/datasets/Other/ref.wav',
    aux_ref_audio_paths: ['training/datasets/Other/aux1.wav', ''],
    prompt_text: 'hello',
    prompt_lang: 'en',
  });

  assert.equal(payload.voiceProfileId, 'some-other-voice');
  assert.equal(payload.ref_audio_path, 'training/datasets/Other/ref.wav');
  assert.deepEqual(payload.aux_ref_audio_paths, ['training/datasets/Other/aux1.wav']);
  // Weights must ride along or the warm heats the wrong model.
  assert.equal(payload.voice_model.gptRef, 'models/user-models/gpt/Other-e25.ckpt');
  assert.equal(payload.voice_model.sovitsRef, 'models/user-models/sovits/Other_e20.pth');
});

test('warmPayloadFromProfile refuses a profile with no reference audio', () => {
  assert.equal(warmPayloadFromProfile({ voiceProfileId: 'x' }), null);
  assert.equal(warmPayloadFromProfile(null), null);
});

test('warmOnBoot falls back to the active profile and loads its weights', async () => {
  const calls = [];
  const activePayload = {
    voiceProfileId: 'on-demand-voice',
    ref_audio_path: 'ref.wav',
    aux_ref_audio_paths: [],
    text_lang: 'en',
    voice_model: { voiceProfileId: 'on-demand-voice', gptRef: 'g.ckpt', sovitsRef: 's.pth' },
  };

  const warmed = await warmOnBoot({
    readPayload: () => null, // a fresh autoscaled instance has no local history
    readActivePayload: async () => activePayload,
    startServer: async () => ({ ready: true }),
    warmReferences: async (p) => { calls.push('refs'); return { ref_audio_path: p.ref_audio_path, aux_ref_audio_paths: [] }; },
    loadVoiceModel: async (p) => { calls.push(`weights:${p.voice_model.gptRef}`); },
    runSynth: async () => { calls.push('synth'); },
  });

  assert.equal(warmed, true);
  // Weights before references before synthesis.
  assert.deepEqual(calls, ['weights:g.ckpt', 'refs', 'synth']);
});

test('warmOnBoot skips cleanly when there is no payload and no active profile', async () => {
  const warmed = await warmOnBoot({
    readPayload: () => null,
    readActivePayload: async () => null,
    startServer: async () => { throw new Error('must not start the server'); },
    warmReferences: async () => {},
    runSynth: async () => {},
  });
  assert.equal(warmed, false);
});

test('a successful boot warm records the warmed weights as residency; a failed one does not', async () => {
  const payload = { voice_model: { voiceProfileId: 'dean-v1', gptRef: 'g.ckpt', sovitsRef: 's.pth' }, ref_audio_path: 'r.wav' };
  const warmed = [];
  const deps = {
    readPayload: () => payload,
    startServer: async () => ({ ready: true }),
    warmReferences: async (p) => ({ ref_audio_path: p.ref_audio_path, aux_ref_audio_paths: [] }),
    loadVoiceModel: async () => {},
    onWarmed: (p) => warmed.push(p.voice_model.voiceProfileId),
  };
  assert.equal(await warmOnBoot({ ...deps, runSynth: async () => {} }), true);
  assert.deepEqual(warmed, ['dean-v1']);
  assert.equal(await warmOnBoot({ ...deps, runSynth: async () => { throw new Error('cuda'); } }), false);
  assert.deepEqual(warmed, ['dean-v1']);
});

test('the resident voice is remembered with its weights, once per weight pair', async () => {
  const { rememberResidentVoice, readWarmPayload } = await import('./bootWarm.js');
  const files = new Map();
  const fsModule = {
    mkdirSync: () => {},
    writeFileSync: (p, d) => files.set(p, d),
    existsSync: (p) => files.has(p),
    readFileSync: (p) => files.get(p),
  };
  const body = { ref_audio_path: 'r.wav', voice_model: { voiceProfileId: 'v1', gptRef: 'g1.ckpt', sovitsRef: 's1.pth' }, prompt_text: 'hi', text: 'ignored' };
  assert.equal(rememberResidentVoice(body, { statePath: '/w.json', fsModule }), true);
  assert.equal(rememberResidentVoice(body, { statePath: '/w.json', fsModule }), false);
  const saved = readWarmPayload({ statePath: '/w.json', fsModule });
  assert.deepEqual(saved.voice_model, body.voice_model);
  assert.equal(saved.prompt_text, 'hi');
  assert.equal('text' in saved, false);
  assert.equal(rememberResidentVoice({ ref_audio_path: 'r.wav' }, { statePath: '/w.json', fsModule }), false);
});

test('a reference-only warm cannot erase the resident voice record', async () => {
  const { recordWarmPayload, readWarmPayload } = await import('./bootWarm.js');
  const files = new Map();
  const fsModule = { mkdirSync: () => {}, writeFileSync: (p, d) => files.set(p, d), existsSync: (p) => files.has(p), readFileSync: (p) => files.get(p) };
  recordWarmPayload({ ref_audio_path: 'a.wav', voice_model: { gptRef: 'g', sovitsRef: 's' } }, { statePath: '/w', fsModule });
  assert.equal(recordWarmPayload({ ref_audio_path: 'b.wav' }, { statePath: '/w', fsModule, preserveResidentVoice: true }), false);
  assert.equal(readWarmPayload({ statePath: '/w', fsModule }).ref_audio_path, 'a.wav');
  assert.equal(recordWarmPayload({ ref_audio_path: 'b.wav' }, { statePath: '/w2', fsModule, preserveResidentVoice: true }), true);
});

test('a payload holding local cache paths is never remembered', async () => {
  const { rememberResidentVoice } = await import('./bootWarm.js');
  const files = new Map();
  const fsModule = { mkdirSync: () => {}, writeFileSync: (p, d) => files.set(p, d), existsSync: (p) => files.has(p), readFileSync: (p) => files.get(p) };
  const local = { ref_audio_path: '/opt/gpt-sovits/worker_temp/ref_audio_cache/x.wav', voice_model: { gptRef: 'gL', sovitsRef: 'sL' } };
  assert.equal(rememberResidentVoice(local, { statePath: '/w', fsModule }), false);
  assert.equal(files.size, 0);
});
