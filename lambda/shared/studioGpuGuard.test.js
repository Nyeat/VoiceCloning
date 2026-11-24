import test from 'node:test';
import assert from 'node:assert/strict';
import { studioGpuRefusal, studioRequestRefusal, STUDIO_GPU_RESERVED, STUDIO_VOICE_NOT_NOW } from './studioGpuGuard.js';

const scopeOf = (answer) => async () => answer;
const studioEvent = { headers: { origin: 'https://studio.example' } };
const env = { STUDIO_SITE_ORIGINS: 'https://studio.example' };

test('non-studio callers are never affected', async () => {
  assert.equal(await studioGpuRefusal({ identity: { email: 'a@ntu.edu.sg' }, voiceProfileId: 'x-v1', studioScope: scopeOf({ allVoices: false, voiceNames: [] }) }), null);
  assert.equal(await studioRequestRefusal({ headers: { origin: 'https://other.example' } }, { env, authGuard: { authorize: async () => { throw new Error('no'); } } }), null);
});

test('super user: any voice when free, refused while a slot holds the GPU', async () => {
  const identity = { email: 'boss@ntu.edu.sg', studio: true };
  assert.equal(await studioGpuRefusal({ identity, voiceProfileId: 'anyone-v1', studioScope: scopeOf({ superuser: true, allVoices: true, voiceNames: ['anyone'] }) }), null);
  const held = await studioGpuRefusal({ identity, voiceProfileId: 'anyone-v1', studioScope: scopeOf({ superuser: true, allVoices: false, voiceNames: [] }) });
  assert.deepEqual(held, { status: 403, message: STUDIO_GPU_RESERVED });
});

test('lecturer: only their own voice, only when the studio allows it; a raw model load needs every voice', async () => {
  const identity = { email: 'a@ntu.edu.sg', studio: true };
  const inSlot = scopeOf({ superuser: false, allVoices: false, voiceNames: ['cs-a_2'] });
  assert.equal(await studioGpuRefusal({ identity, voiceProfileId: 'cs-a_2-v1', studioScope: inSlot }), null);
  assert.deepEqual(await studioGpuRefusal({ identity, voiceProfileId: 'cs-b-v1', studioScope: inSlot }), { status: 403, message: STUDIO_VOICE_NOT_NOW });
  assert.equal((await studioGpuRefusal({ identity, voiceProfileId: '', studioScope: inSlot })).status, 403);
});

test('studio-site requests must sign in first', async () => {
  const refusal = await studioRequestRefusal(studioEvent, { env, authGuard: { authorize: async () => { throw new Error('bad token'); } } });
  assert.equal(refusal.status, 401);
  const allowed = await studioRequestRefusal(studioEvent, {
    env,
    authGuard: { authorize: async () => ({ email: 'boss@ntu.edu.sg', studio: true }) },
    voiceProfileId: 'x-v1',
    studioScope: scopeOf({ superuser: true, allVoices: true, voiceNames: ['x'] }),
  });
  assert.equal(allowed, null);
});
