import assert from 'node:assert/strict';
import test from 'node:test';
import { siteOwnerOption, TTS_GPU_OWNER } from './modelCoordinator.js';

const env = {
  TTS_SITE_ORIGINS: 'https://tts.example',
  TRAINING_SITE_ORIGINS: 'https://train.example',
  STUDIO_SITE_ORIGINS: 'https://studio.example',
};
const ev = (origin, headers = {}) => ({ headers: { origin, ...headers } });
const guard = (oid) => ({ authorize: async () => ({ oid, email: 'x@ntu.edu.sg' }) });

test('every site gets a hard-reserved GPU owner', async () => {
  assert.deepEqual(await siteOwnerOption(ev('https://studio.example'), { env, studioOwner: 'reserved:studio-p-abc' }), { ownerKey: 'reserved:studio-p-abc' });
  assert.deepEqual(await siteOwnerOption(ev('https://tts.example'), { env, voiceProfileId: 'v' }), { singleGpu: true, ownerKey: TTS_GPU_OWNER });
  const train = await siteOwnerOption(ev('https://train.example'), { env, authGuard: guard('oid-1') });
  assert.match(train.ownerKey, /^reserved:train-/u);
  const amy = await siteOwnerOption(ev('https://faculty.example', { 'x-vcs-site': 'faculty' }), { env, authGuard: guard('amy'), voiceProfileId: 'v' });
  const ben = await siteOwnerOption(ev('https://faculty.example', { 'x-vcs-site': 'faculty' }), { env, authGuard: guard('ben'), voiceProfileId: 'v' });
  assert.match(amy.ownerKey, /^reserved:faculty-/u);
  assert.notEqual(amy.ownerKey, ben.ownerKey, 'one GPU per faculty member');
  const lecture = await siteOwnerOption(ev('https://lectures.example'), { env, voiceProfileId: 'deanvoice-v1' });
  assert.match(lecture.ownerKey, /^reserved:voice-/u);
  assert.equal((await siteOwnerOption(ev('https://lectures.example'), { env, voiceProfileId: 'deanvoice-v1' })).ownerKey, lecture.ownerKey, 'same lecture voice, same owner');
  assert.deepEqual(await siteOwnerOption(ev('https://lectures.example'), { env }), {}, 'no voice, no owner');
});
