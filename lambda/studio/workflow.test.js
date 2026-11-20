import test from 'node:test';
import assert from 'node:assert/strict';
import * as wf from './workflow.js';
import { validatePronunciation } from './pronunciation.js';

const T0 = Date.parse('2026-11-20T01:00:00Z');
const MIN = 60_000;

function job(state, id, owner, queuedAtMin) {
  const created = wf.createJob(state, { id, ownerEmail: owner, expName: `${id}-voice`, now: T0 });
  created.status = 'queued';
  created.queuedAt = new Date(T0 + queuedAtMin * MIN).toISOString();
  return created;
}

test('queue keeps one lecturer\'s recordings together, then the next lecturer', () => {
  const state = wf.emptyState();
  job(state, 'a1', 'a@ntu.edu.sg', 0);
  job(state, 'b1', 'b@ntu.edu.sg', 1);
  job(state, 'a2', 'a@ntu.edu.sg', 2);
  assert.deepEqual(wf.orderQueue(state.jobs).map((j) => j.id), ['a1', 'a2', 'b1']);
});

test('estimates chain one job after another and skip booked slots', () => {
  const state = wf.emptyState();
  job(state, 'a1', 'a@ntu.edu.sg', 0);
  job(state, 'b1', 'b@ntu.edu.sg', 1);
  state.slots.push({ id: 's', jobId: 'x', status: 'booked', start: new Date(T0 + 30 * MIN).toISOString(), end: new Date(T0 + 90 * MIN).toISOString() });
  const [first, second] = wf.estimateQueue(state, { now: T0, env: {} });
  assert.equal(first.finishAt, new Date(T0 + 30 * MIN).toISOString());
  // b1 would start at T0+30 inside the slot, so it waits for the slot to end.
  assert.equal(second.startAt, new Date(T0 + 90 * MIN).toISOString());
  assert.equal(second.finishAt, new Date(T0 + 120 * MIN).toISOString());
});

test('nothing trains while a slot holds the GPU or another job runs', () => {
  const state = wf.emptyState();
  job(state, 'a1', 'a@ntu.edu.sg', 0);
  state.slots.push({ id: 's', jobId: 'x', status: 'booked', start: new Date(T0 - MIN).toISOString(), end: new Date(T0 + MIN).toISOString() });
  assert.equal(wf.nextJobToTrain(state, T0), null);
  assert.equal(wf.nextJobToTrain(state, T0 + 2 * MIN).id, 'a1');
  wf.markTrainingStarted(state.jobs[0], { now: T0 });
  job(state, 'b1', 'b@ntu.edu.sg', 1);
  assert.equal(wf.nextJobToTrain(state, T0 + 2 * MIN), null);
});

test('finished runs go to review and teach the ETA', () => {
  const state = wf.emptyState();
  const a = job(state, 'a1', 'a@ntu.edu.sg', 0);
  wf.markTrainingStarted(a, { now: T0 });
  wf.markTrainingFinished(state, a, { ok: true, now: T0 + 42 * MIN });
  assert.equal(a.status, 'review');
  assert.equal(wf.trainingMinutes(state, {}), 42);
});

test('reject retrains a new voice name with a changed recipe', () => {
  const state = wf.emptyState();
  const a = job(state, 'a1', 'a@ntu.edu.sg', 0);
  a.status = 'review';
  wf.reviewJob(a, { decision: 'reject', reasons: ['not-their-voice'], reviewer: 'su@ntu.edu.sg', nextExpName: 'a_2', now: T0 });
  assert.equal(a.status, 'queued');
  assert.equal(a.expName, 'a_2');
  assert.equal(a.sourceExpName, 'a1-voice');
  assert.equal(a.trainingConfig.sovitsEpochs, 12);
  assert.equal(a.attempt, 2);
});

test('retrain recipes differ by reason and honour overrides', () => {
  assert.equal(wf.retrainConfig({}, ['mispronounces']).gptEpochs, 23);
  assert.equal(wf.retrainConfig({}, ['noisy']).sovitsEpochs, 6);
  assert.equal(wf.retrainConfig({}, ['noisy']).skipDenoise, false);
  const generic = wf.retrainConfig({}, []);
  assert.deepEqual([generic.sovitsEpochs, generic.gptEpochs], [10, 20]);
  assert.equal(wf.retrainConfig({}, ['noisy'], { sovitsEpochs: 9 }).sovitsEpochs, 9);
});

test('attempts are capped unless forced', () => {
  const state = wf.emptyState();
  const a = job(state, 'a1', 'a@ntu.edu.sg', 0);
  a.status = 'review';
  a.attempt = wf.MAX_TRAINING_ATTEMPTS;
  assert.throws(() => wf.reviewJob(a, { decision: 'reject', nextExpName: 'x', now: T0 }), /attempts/u);
});

test('slots cannot overlap — one GPU, one voice at a time', () => {
  const state = wf.emptyState();
  const a = job(state, 'a1', 'a@ntu.edu.sg', 0);
  const b = job(state, 'b1', 'b@ntu.edu.sg', 0);
  a.status = 'approved'; a.approvedExpName = 'a1-voice';
  b.status = 'approved'; b.approvedExpName = 'b1-voice';
  const at = (min) => new Date(T0 + min * MIN).toISOString();
  wf.bookSlot(state, a, { start: at(60), end: at(120), slotId: 's1', now: T0 });
  assert.throws(() => wf.bookSlot(state, b, { start: at(90), end: at(150), slotId: 's2', now: T0 }), (e) => e.code === 'SLOT_CLASH');
  wf.bookSlot(state, b, { start: at(120), end: at(180), slotId: 's2', now: T0 });
  // Moving a's own slot does not clash with itself.
  const { moved } = wf.bookSlot(state, a, { start: at(70), end: at(115), now: T0 });
  assert.equal(moved, true);
  assert.equal(state.slots.length, 2);
});

test('lecturers use only their own voice inside their slot; super users not during someone else\'s', () => {
  const state = wf.emptyState();
  const a = job(state, 'a1', 'a@ntu.edu.sg', 0);
  a.status = 'approved'; a.approvedExpName = 'a';
  wf.bookSlot(state, a, { start: new Date(T0 + 60 * MIN).toISOString(), end: new Date(T0 + 120 * MIN).toISOString(), slotId: 's1', now: T0 });
  const asA = (now) => wf.voiceAccess(state, { email: 'A@staff.main.ntu.edu.sg', voiceName: 'a', now, superuser: false });
  assert.equal(asA(T0).reason, 'too-early');
  assert.equal(asA(T0 + 61 * MIN).allowed, true);
  assert.equal(asA(T0 + 121 * MIN).reason, 'slot-ended');
  assert.equal(wf.voiceAccess(state, { email: 'b@ntu.edu.sg', voiceName: 'a', now: T0 + 61 * MIN, superuser: false }).allowed, false);
  assert.equal(wf.voiceAccess(state, { email: 'su@ntu.edu.sg', voiceName: 'other', now: T0 + 61 * MIN, superuser: true }).reason, 'slot-in-use');
  assert.equal(wf.voiceAccess(state, { email: 'su@ntu.edu.sg', voiceName: 'other', now: T0, superuser: true }).allowed, true);
  assert.equal(wf.gpuDemand(state, T0 + 55 * MIN), 'slot');
  assert.equal(wf.gpuDemand(state, T0), '');
});

test('super users: bootstrap list is locked, last one cannot be removed', () => {
  const state = wf.emptyState();
  const env = { STUDIO_SUPERUSERS: 'boss@ntu.edu.sg' };
  assert.equal(wf.isSuperuser(state, 'BOSS@staff.main.ntu.edu.sg', env), true);
  wf.addSuperuser(state, { email: 'two@ntu.edu.sg', name: 'Two' }, 'boss@ntu.edu.sg', T0);
  assert.throws(() => wf.addSuperuser(state, { email: 'two@ntu.edu.sg' }, 'x', T0), /already/u);
  assert.throws(() => wf.removeSuperuser(state, 'boss@ntu.edu.sg', 'two@ntu.edu.sg', env), /configuration/u);
  wf.removeSuperuser(state, 'two@ntu.edu.sg', 'boss@ntu.edu.sg', env);
  const solo = wf.emptyState();
  wf.addSuperuser(solo, { email: 'only@ntu.edu.sg' }, 'x', T0);
  assert.throws(() => wf.removeSuperuser(solo, 'only@ntu.edu.sg', 'only@ntu.edu.sg', {}), /At least one/u);
});

test('pronunciation entries are validated', () => {
  assert.deepEqual(validatePronunciation({ word: 'cohesin', arpabet: 'k ow hh iy1 s ih n' }), { word: 'cohesin', arpabet: 'K OW0 HH IY1 S IH0 N', notes: '' });
  assert.throws(() => validatePronunciation({ word: 'x', arpabet: 'QQ' }), /ARPAbet/u);
  assert.throws(() => validatePronunciation({ word: 'x' }), /Give/u);
  assert.equal(validatePronunciation({ word: 'GI bleed', soundsLike: 'gee eye bleed' }).soundsLike, 'gee eye bleed');
});
