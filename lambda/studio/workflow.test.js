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
  assert.equal(wf.retrainConfig({ skipDenoise: false }, ['robotic']).skipDenoise, true);
  assert.equal(wf.BASE_TRAINING_CONFIG.skipDenoise, true);
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
  job(state, 'a1', 'a@ntu.edu.sg', 0).status = 'uploading';
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
  assert.equal(wf.gpuDemand(state, T0 + 41 * MIN), 'slot', 'GPU is wanted 20 min early');
  assert.equal(wf.gpuDemand(state, T0 + 39 * MIN), '');
  assert.equal(wf.gpuHold(state, T0 + 41 * MIN).slot.id, 's1');
  assert.equal(wf.voiceAccess(state, { email: 'su@ntu.edu.sg', voiceName: 'other', now: T0 + 41 * MIN, superuser: true }).reason, 'slot-in-use', 'super users locked from the warm-up');
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

test('test fixtures show up but never reach the GPU or real lecturers', () => {
  const state = wf.emptyState();
  const fixture = job(state, 'f1', 'queued@voice-studio.test', 0);
  fixture.fixture = true;
  const realJob = job(state, 'r1', 'real@ntu.edu.sg', 5);
  assert.equal(wf.nextJobToTrain(state, T0).id, 'r1', 'a fixture is never dispatched, even first in line');
  const estimates = wf.estimateQueue(state, { now: T0, env: {} });
  assert.deepEqual(estimates.map((entry) => entry.jobId), ['r1', 'f1'], 'fixtures queue behind real jobs');
  realJob.status = 'cancelled';
  assert.equal(wf.gpuDemand(state, T0), '', 'a queued fixture does not start the GPU');
  state.slots.push({ id: 'ts', kind: 'test', fixture: true, status: 'published', assigneeEmail: 'ready@voice-studio.test', start: new Date(T0).toISOString(), end: new Date(T0 + 60 * MIN).toISOString() });
  assert.equal(wf.currentSlot(state, T0 + MIN), null, 'a fixture test slot never locks the GPU');
  assert.equal(wf.gpuHold(state, T0), null);
  state.slots.push({ id: 'rs', kind: 'recording', fixture: true, status: 'published', assigneeEmail: '', start: new Date(T0 + 60 * MIN).toISOString(), end: new Date(T0 + 120 * MIN).toISOString() });
  assert.equal(wf.publicSlots(state, 'real@ntu.edu.sg', T0).length, 0, 'real lecturers do not see fixture sessions');
  assert.equal(wf.publicSlots(state, 'new@voice-studio.test', T0).length, 1);
  assert.throws(() => wf.claimSlot(state, 'rs', { email: 'real@ntu.edu.sg', name: 'R', now: T0 }), { statusCode: 404 });
});

test('one recording session per person: a submitted voice cannot book again', () => {
  const state = wf.emptyState();
  const at = (min) => new Date(T0 + min * MIN).toISOString();
  const a = job(state, 'a1', 'a@ntu.edu.sg', 0);
  wf.addSlot(state, { id: 'r1', kind: 'recording', start: at(60), end: at(120), now: T0 });
  wf.publishSlots(state, T0);
  assert.throws(() => wf.claimSlot(state, 'r1', { email: 'a@ntu.edu.sg', name: 'A', now: T0 }), /already in/u);
  a.status = 'cancelled'; // sent back for new recordings
  wf.claimSlot(state, 'r1', { email: 'a@ntu.edu.sg', name: 'A', now: T0 });
});

test('session reminders: recording day-before + soon, test slot on the day, each once per booking', () => {
  const state = wf.emptyState();
  const start = Date.parse('2026-12-02T06:00:00Z'); // 14:00 SGT
  const iso = (value) => new Date(value).toISOString();
  const now0 = start - 3 * 24 * 60 * MIN;
  wf.addSlot(state, { id: 'rec', kind: 'recording', start: iso(start), end: iso(start + 60 * MIN), assigneeEmail: 'a@ntu.edu.sg', now: now0 });
  wf.addSlot(state, { id: 'tst', kind: 'test', start: iso(start + 2 * 60 * MIN), end: iso(start + 3 * 60 * MIN), assigneeEmail: 'b@ntu.edu.sg', now: now0 });
  wf.publishSlots(state, now0);
  const due = (now) => wf.sessionRemindersDue(state, now).map((item) => `${item.slot.id}:${item.kind}`).sort();
  assert.deepEqual(due(start - 30 * 60 * MIN - 24 * 60 * MIN), [], 'nothing 24.5 h before');
  assert.deepEqual(due(start - 23 * 60 * MIN), ['rec:day']);
  const mark = (now) => { for (const item of wf.sessionRemindersDue(state, now)) item.slot.reminders = { ...(item.slot.reminders || {}), [item.kind]: item.key }; };
  mark(start - 23 * 60 * MIN);
  assert.deepEqual(due(start - 22 * 60 * MIN), [], 'sent once');
  // 07:00 SGT on the day = 23:00 UTC the day before.
  assert.deepEqual(due(Date.parse('2026-12-01T23:30:00Z')), ['tst:today']);
  assert.deepEqual(due(start - 30 * MIN), ['rec:soon', 'tst:today']);
  // Moving the recording session re-arms its reminders.
  mark(start - 30 * MIN);
  wf.findSlot(state, 'rec').start = iso(start + 24 * 60 * MIN);
  assert.deepEqual(due(start + 60 * MIN), ['rec:day'], '23 h before the new time');
});

test('fixtures: only fixture accounts and listed testers see them; other super users see real work only', () => {
  const state = wf.emptyState();
  const at = (min) => new Date(T0 + min * MIN).toISOString();
  wf.addSlot(state, { id: 'real', kind: 'recording', start: at(60), end: at(120), hostName: 'Dr Tan', now: T0 });
  wf.addSlot(state, { id: 'fake', kind: 'recording', start: at(60), end: at(120), now: T0 });
  wf.findSlot(state, 'fake').fixture = true;
  job(state, 'f1', 'queued@voice-studio.test', 0).fixture = true;
  wf.publishSlots(state, T0);
  const env = { STUDIO_FIXTURE_VIEWERS: 'Tester@Gmail.com' };
  assert.equal(wf.findSlot(state, 'real').hostName, 'Dr Tan');
  assert.deepEqual(wf.publicSlots(state, 'someone@gmail.com', T0, env).map((slot) => slot.id), ['real']);
  assert.deepEqual(wf.publicSlots(state, 'tester@gmail.com', T0, env).map((slot) => slot.id).sort(), ['fake', 'real']);
  assert.throws(() => wf.claimSlot(state, 'fake', { email: 'someone@gmail.com', name: 'S', now: T0, env }), /not available/u);
  wf.claimSlot(state, 'fake', { email: 'tester@gmail.com', name: 'T', now: T0, env });
  const boss = wf.viewFor(state, 'boss@ntu.edu.sg', env);
  assert.deepEqual([boss.jobs.length, boss.slots.map((slot) => slot.id)], [0, ['real']]);
  assert.equal(wf.viewFor(state, 'tester@gmail.com', env).slots.length, 2);
});

test('GPU hold: 20 min warm-up, whole slot, bridged across a gap under an hour', () => {
  const state = wf.emptyState();
  const at = (min) => new Date(T0 + min * MIN).toISOString();
  const add = (id, start, end, who) => wf.addSlot(state, { id, start: at(start), end: at(end), assigneeEmail: who, now: T0 });
  add('a', 60, 120, 'a@ntu.edu.sg');
  add('b', 150, 210, 'b@ntu.edu.sg'); // 30 min gap: bridged
  add('c', 330, 390, 'c@ntu.edu.sg'); // 2 h gap: GPU may stop
  wf.publishSlots(state, T0);
  const hold = (min) => { const h = wf.gpuHold(state, T0 + min * MIN); return h ? `${h.slot.id}:${h.phase}` : null; };
  assert.equal(hold(39), null);
  assert.equal(hold(41), 'a:warmup');
  assert.equal(hold(90), 'a:slot');
  assert.equal(hold(125), 'b:bridge');
  assert.equal(hold(135), 'b:warmup');
  assert.equal(hold(215), null, 'long gap: released');
  assert.equal(hold(315), 'c:warmup');
});

test('slot warm-up state: estimate from the coordinator answer, READY once it speaks', () => {
  const t = T0;
  const boot = wf.nextWarmState(null, { state: 'STARTING', canStartConversation: false, startedAt: t }, t + MIN);
  assert.equal(boot.state, 'STARTING');
  assert.equal(boot.estimatedReadyAt, new Date(t + 15 * MIN).toISOString());
  const still = wf.nextWarmState(boot, { state: 'STARTING', canStartConversation: false }, t + 6 * MIN);
  assert.equal(still.startedAt, boot.startedAt, 'same phase keeps its clock');
  const ready = wf.nextWarmState(still, { state: 'READY', canStartConversation: true }, t + 14 * MIN);
  assert.equal(ready.state, 'READY');
  assert.equal(wf.nextWarmState(ready, { canStartConversation: true }, t + 30 * MIN).readyAt, ready.readyAt);
});

test('jobs from fixture accounts are fixtures', () => {
  const state = wf.emptyState();
  const created = wf.createJob(state, { id: 'p', ownerEmail: 'recording@voice-studio.test', expName: 'x', now: T0 });
  assert.equal(created.fixture, true);
  assert.equal(wf.createJob(state, { id: 'r', ownerEmail: 'a@ntu.edu.sg', expName: 'y', now: T0 }).fixture, undefined);
});

test('a withdrawn set can be restored to where it was; nothing is lost', () => {
  const state = wf.emptyState();
  const inReview = job(state, 'r', 'a@ntu.edu.sg', 0);
  inReview.status = 'review';
  inReview.attempts.push({ attempt: 1, expName: 'a', result: 'trained' });
  wf.cancelJob(inReview);
  assert.equal(inReview.status, 'cancelled');
  wf.restoreJob(inReview, { now: T0 });
  assert.equal(inReview.status, 'review');
  const legacy = job(state, 'old', 'b@ntu.edu.sg', 0);
  legacy.status = 'cancelled';
  legacy.attempts.push({ attempt: 1, expName: 'b', result: 'trained' });
  assert.equal(wf.restoreJob(legacy, { now: T0 }).status, 'review', 'withdrawn before this existed: a trained set returns to review');
  assert.throws(() => wf.restoreJob(inReview, { now: T0 }), /Only a withdrawn set/u);
});

test('a password account is a super user only when listed in STUDIO_PASSWORD_SUPERUSERS', () => {
  const env = { STUDIO_PASSWORD_SUPERUSERS: 'Owner@Gmail.com' };
  assert.equal(wf.passwordSuperuserAllowed('owner@gmail.com', env), true);
  assert.equal(wf.passwordSuperuserAllowed('someone@gmail.com', env), false);
  assert.equal(wf.passwordSuperuserAllowed('owner@gmail.com', {}), false);
});

test('fixed GPU demand: super users testing keeps it on for 30 min after their last use', () => {
  const state = wf.emptyState();
  assert.equal(wf.gpuDemand(state, T0), '');
  state.lastSuperuserTestAt = new Date(T0).toISOString();
  assert.equal(wf.gpuDemand(state, T0 + 29 * MIN), 'testing');
  assert.equal(wf.gpuDemand(state, T0 + 31 * MIN), '');
});
