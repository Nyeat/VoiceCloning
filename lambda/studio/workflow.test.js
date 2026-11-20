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
  state.slots.push({ id: 's', assigneeEmail: 'x@ntu.edu.sg', status: 'published', start: new Date(T0 + 30 * MIN).toISOString(), end: new Date(T0 + 90 * MIN).toISOString() });
  const [first, second] = wf.estimateQueue(state, { now: T0, env: {} });
  assert.equal(first.finishAt, new Date(T0 + 30 * MIN).toISOString());
  // b1 would start at T0+30 inside the slot, so it waits for the slot to end.
  assert.equal(second.startAt, new Date(T0 + 90 * MIN).toISOString());
  assert.equal(second.finishAt, new Date(T0 + 120 * MIN).toISOString());
});

test('nothing trains while a slot holds the GPU or another job runs', () => {
  const state = wf.emptyState();
  job(state, 'a1', 'a@ntu.edu.sg', 0);
  state.slots.push({ id: 's', assigneeEmail: 'x@ntu.edu.sg', status: 'published', start: new Date(T0 - MIN).toISOString(), end: new Date(T0 + MIN).toISOString() });
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

test('slots cannot overlap, drafts included; edits and publish email only real changes', () => {
  const state = wf.emptyState();
  const at = (min) => new Date(T0 + min * MIN).toISOString();
  const s1 = wf.addSlot(state, { id: 's1', start: at(60), end: at(120), assigneeEmail: 'a@ntu.edu.sg', assigneeName: 'A', actor: 'su', now: T0 });
  // Recording sessions may overlap test slots and each other: they do not use the GPU.
  wf.addSlot(state, { id: 'r1', kind: 'recording', start: at(60), end: at(120), now: T0 });
  assert.throws(() => wf.addSlot(state, { id: 's2', start: at(90), end: at(150), assigneeEmail: 'b@ntu.edu.sg', now: T0 }), (e) => e.code === 'SLOT_CLASH');
  wf.addSlot(state, { id: 's2', start: at(120), end: at(180), assigneeEmail: 'c@ntu.edu.sg', now: T0 });
  assert.equal(s1.status, 'draft');
  let sent = wf.publishSlots(state, T0);
  assert.deepEqual(sent.map((n) => [n.kind, n.email]), [['slotBooked', 'a@ntu.edu.sg'], ['slotBooked', 'c@ntu.edu.sg']]);
  // Re-publishing with no change emails nobody.
  wf.editSlot(state, 's1', {}, T0);
  assert.equal(s1.status, 'draft', 'an edited slot goes back to draft');
  assert.deepEqual(wf.publishSlots(state, T0), []);
  // Moving the time emails "changed"; reassigning emails both people.
  wf.editSlot(state, 's1', { start: at(30), end: at(90) }, T0);
  sent = wf.publishSlots(state, T0);
  assert.equal(sent[0].moved, true);
  wf.editSlot(state, 's1', { assigneeEmail: 'b@ntu.edu.sg', assigneeName: 'B' }, T0);
  sent = wf.publishSlots(state, T0);
  assert.deepEqual(sent.map((n) => [n.kind, n.email]), [['slotCancelled', 'a@ntu.edu.sg'], ['slotBooked', 'b@ntu.edu.sg']]);
  // Deleting a slot someone was told about returns them for an email.
  assert.equal(wf.removeSlot(state, 's1').notify.assigneeEmail, 'b@ntu.edu.sg');
});

test('lecturers pick open published recording sessions, one upcoming each', () => {
  const state = wf.emptyState();
  const at = (min) => new Date(T0 + min * MIN).toISOString();
  job(state, 'a1', 'a@ntu.edu.sg', 0);
  wf.addSlot(state, { id: 'open1', kind: 'recording', start: at(60), end: at(120), now: T0 });
  wf.addSlot(state, { id: 'open2', kind: 'recording', start: at(120), end: at(180), now: T0 });
  assert.throws(() => wf.claimSlot(state, 'open1', { email: 'a@ntu.edu.sg', now: T0 }), /not available/u, 'drafts cannot be picked');
  wf.publishSlots(state, T0);
  assert.throws(() => wf.claimSlot(state, 'open1', { email: 'a@ntu.edu.sg', now: T0 }), /name/u);
  wf.claimSlot(state, 'open1', { email: 'a@ntu.edu.sg', name: 'A', now: T0 });
  assert.throws(() => wf.claimSlot(state, 'open2', { email: 'a@ntu.edu.sg', name: 'A', now: T0 }), /already have/u);
  assert.equal(wf.recordingAccess(state, { email: 'a@ntu.edu.sg', now: T0, superuser: false }).reason, 'too-early');
  assert.equal(wf.recordingAccess(state, { email: 'a@ntu.edu.sg', now: T0 + 61 * MIN, superuser: false }).allowed, true);
  assert.equal(wf.recordingAccess(state, { email: 'b@ntu.edu.sg', now: T0 + 61 * MIN, superuser: false }).reason, 'no-session');
  const table = wf.publicSlots(state, 'A@staff.main.ntu.edu.sg', T0);
  assert.deepEqual(table.map((row) => [row.id, row.mine, row.open]), [['open1', true, false], ['open2', false, true]]);
  wf.releaseSlot(state, 'open1', { email: 'a@ntu.edu.sg', now: T0 });
  assert.equal(wf.publicSlots(state, 'a@ntu.edu.sg', T0)[0].open, true);
});

test('in their slot a lecturer uses all their approved voices; super users are locked out', () => {
  const state = wf.emptyState();
  const a = job(state, 'a1', 'a@ntu.edu.sg', 0);
  const a2 = job(state, 'a2', 'a@ntu.edu.sg', 1);
  a.status = 'approved'; a.approvedExpName = 'a';
  a2.status = 'approved'; a2.approvedExpName = 'a_2';
  a2.reviews.push({ at: new Date(T0 + MIN).toISOString() });
  wf.addSlot(state, { id: 's1', start: new Date(T0 + 60 * MIN).toISOString(), end: new Date(T0 + 120 * MIN).toISOString(), assigneeEmail: 'a@ntu.edu.sg', now: T0 });
  // A draft does not hold the GPU.
  assert.equal(wf.voiceAccess(state, { email: 'su@ntu.edu.sg', voiceName: 'x', now: T0 + 61 * MIN, superuser: true }).allowed, true);
  wf.publishSlots(state, T0);
  const asA = (voiceName, now) => wf.voiceAccess(state, { email: 'A@staff.main.ntu.edu.sg', voiceName, now, superuser: false });
  assert.equal(asA('a', T0).reason, 'too-early');
  assert.equal(asA('a', T0 + 61 * MIN).allowed, true);
  assert.equal(asA('a_2', T0 + 61 * MIN).allowed, true);
  assert.equal(asA('a', T0 + 121 * MIN).reason, 'no-slot');
  assert.equal(wf.voiceAccess(state, { email: 'b@ntu.edu.sg', voiceName: 'a', now: T0 + 61 * MIN, superuser: false }).allowed, false);
  assert.equal(wf.voiceAccess(state, { email: 'su@ntu.edu.sg', voiceName: 'other', now: T0 + 61 * MIN, superuser: true }).reason, 'slot-in-use');
  assert.equal(wf.voiceAccess(state, { email: 'su@ntu.edu.sg', voiceName: 'other', now: T0, superuser: true }).allowed, true);
  assert.equal(wf.gpuDemand(state, T0 + 50 * MIN), 'slot', 'GPU is wanted 15 min early');
  assert.equal(wf.gpuDemand(state, T0 + 40 * MIN), '');
  assert.deepEqual(wf.slotsToPreload(state, T0 + 50 * MIN).map((s) => s.id), ['s1']);
  assert.equal(wf.preloadVoiceFor(state, state.slots[0]), 'a_2', 'most recently approved voice is preloaded');
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
