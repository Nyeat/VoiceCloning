// Voice Studio workflow: the pure rules behind the recording portal and the
// review/testing portal. No I/O lives here, so every rule (queue order, ETA,
// retrain strategy, slot clashes, who may do what) is unit-tested directly.
//
// One GPU does everything. Training runs one job at a time in a fair queue,
// and a tested voice gets the GPU only inside a slot a super user booked.

import { normalizeEmail } from '../shared/voiceIdentity.js';

export const JOB_STATUSES = Object.freeze([
  'uploading', // created; audio still going up
  'queued', // waiting for the training GPU
  'training', // running on the training GPU
  'review', // trained; waiting for a super user to listen
  'approved', // passed review; needs a test slot
  'scheduled', // passed review and has a slot booked
  'failed', // training errored; a super user decides
  'cancelled',
]);

export const REJECT_REASONS = Object.freeze({
  'not-their-voice': 'Does not sound like the speaker',
  mispronounces: 'Mispronounces or skips words',
  robotic: 'Robotic or unnatural rhythm',
  noisy: 'Noisy, buzzy or has artifacts',
  other: 'Other',
});

export const MAX_TRAINING_ATTEMPTS = 3;
export const DEFAULT_TRAINING_MINUTES = 30;
export const GPU_BOOT_MINUTES = 5;
export const MIN_SLOT_MINUTES = 15;
export const MAX_SLOT_MINUTES = 8 * 60;
// The GPU is started this long before a slot so the voice is ready at the start.
export const SLOT_WARMUP_MINUTES = 20;
// Back-to-back test slots: a gap shorter than this keeps the GPU on between them.
export const SLOT_BRIDGE_MINUTES = 60;

const MINUTE = 60_000;

// Worker defaults (gpu-worker/src/services/pipeline.js). Retrains move away
// from these, never back to them, so a second attempt is not a coin re-toss.
export const BASE_TRAINING_CONFIG = Object.freeze({
  sovitsEpochs: 8,
  gptEpochs: 15,
  skipDenoise: true,
  asrModel: 'large-v3',
});

// Test fixtures (seeded by lambda/scripts/seed-studio-fixtures.mjs) belong to
// accounts at this reserved domain. They show in the UI like real work but
// never reach the GPU (no training dispatch, no warm-up, no slot lock), and
// real lecturers never see fixture sessions.
export const FIXTURE_DOMAIN = 'voice-studio.test';

export function isFixtureEmail(email) {
  return normalizeEmail(email).endsWith(`@${FIXTURE_DOMAIN}`);
}

/**
 * Who sees fixtures at all: the fixture accounts themselves and the testers in
 * STUDIO_FIXTURE_VIEWERS. Everyone else — every other super user included —
 * sees only real work, so the console reflects the real world.
 */
export function isFixtureViewer(email, env = process.env) {
  if (isFixtureEmail(email)) return true;
  const viewers = String(env.STUDIO_FIXTURE_VIEWERS || '').split(',').map((value) => normalizeEmail(value)).filter(Boolean);
  return viewers.includes(normalizeEmail(email));
}

/** The state as this person may see it: fixtures removed unless they view them. */
export function viewFor(state, email, env = process.env) {
  if (isFixtureViewer(email, env)) return state;
  return { ...state, jobs: state.jobs.filter(real), slots: state.slots.filter(real) };
}

function real(item) {
  return item?.fixture !== true;
}

export function emptyState() {
  return { schemaVersion: 1, superusers: [], jobs: [], slots: [], lastTickAt: 0, history: [] };
}

export function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    superusers: Array.isArray(raw.superusers) ? raw.superusers : [],
    jobs: Array.isArray(raw.jobs) ? raw.jobs : [],
    slots: Array.isArray(raw.slots) ? raw.slots : [],
    history: Array.isArray(raw.history) ? raw.history : [],
  };
}

// ── Roles ────────────────────────────────────────────────────────────────

export function bootstrapSuperusers(env = process.env) {
  return String(env.STUDIO_SUPERUSERS || '')
    .split(',')
    .map((value) => normalizeEmail(value))
    .filter(Boolean);
}

// NTU issues two addresses per person (name@ntu.edu.sg and
// NAME@staff.main.ntu.edu.sg); the local part is what identifies them.
export function sameNtuPerson(left, right) {
  const a = normalizeEmail(left);
  const b = normalizeEmail(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const ntu = (value) => /(^|\.)ntu\.edu\.sg$/u.test(value.split('@')[1] || '');
  return ntu(a) && ntu(b) && a.split('@')[0] === b.split('@')[0];
}

/**
 * Email + password addresses are not verified, so they are never super users —
 * except the ones named in STUDIO_PASSWORD_SUPERUSERS (an owner's own account
 * that already exists; registering such an address is refused).
 */
export function passwordSuperuserAllowed(email, env = process.env) {
  const listed = String(env.STUDIO_PASSWORD_SUPERUSERS || '').split(',').map((value) => normalizeEmail(value)).filter(Boolean);
  return listed.includes(normalizeEmail(email));
}

export function isSuperuser(state, email, env = process.env) {
  if (!normalizeEmail(email)) return false;
  if (bootstrapSuperusers(env).some((entry) => sameNtuPerson(entry, email))) return true;
  return state.superusers.some((entry) => sameNtuPerson(entry.email, email));
}

export function listSuperusers(state, env = process.env) {
  const locked = bootstrapSuperusers(env).map((email) => ({
    email, name: '', locked: true, addedBy: 'configuration', addedAt: null,
  }));
  const stored = state.superusers
    .filter((entry) => !locked.some((lockedEntry) => sameNtuPerson(lockedEntry.email, entry.email)))
    .map((entry) => ({ ...entry, locked: false }));
  return [...locked, ...stored];
}

export function addSuperuser(state, { email, name = '' }, actor, now) {
  const normalized = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) throw clientError(400, 'Enter a valid email address');
  if (isSuperuser(state, normalized)) throw clientError(409, `${normalized} is already a super user`);
  state.superusers.push({
    email: normalized,
    name: cleanText(name, 80),
    addedBy: normalizeEmail(actor),
    addedAt: new Date(now).toISOString(),
  });
  return state;
}

export function updateSuperuser(state, email, { name }, env = process.env) {
  const entry = state.superusers.find((item) => sameNtuPerson(item.email, email));
  if (!entry) {
    if (bootstrapSuperusers(env).some((item) => sameNtuPerson(item, email))) {
      throw clientError(409, 'This super user is set in the server configuration and cannot be edited here');
    }
    throw clientError(404, 'Super user not found');
  }
  entry.name = cleanText(name, 80);
  return state;
}

export function removeSuperuser(state, email, actor, env = process.env) {
  if (bootstrapSuperusers(env).some((item) => sameNtuPerson(item, email))) {
    throw clientError(409, 'This super user is set in the server configuration and cannot be removed here');
  }
  const index = state.superusers.findIndex((item) => sameNtuPerson(item.email, email));
  if (index < 0) throw clientError(404, 'Super user not found');
  const remaining = listSuperusers(state, env).length - 1;
  if (remaining < 1) throw clientError(409, 'At least one super user must remain');
  if (sameNtuPerson(email, actor) && remaining < 1) throw clientError(409, 'You are the last super user');
  state.superusers.splice(index, 1);
  return state;
}

// ── Jobs ─────────────────────────────────────────────────────────────────

// The recipe fields a super user may set (record page, retrain form). Anything
// else, or out of range, is dropped so a bad value never reaches the GPU.
export function sanitizeTrainingConfig(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  if (typeof input.skipDenoise === 'boolean') out.skipDenoise = input.skipDenoise;
  for (const [key, min, max] of [['sovitsEpochs', 1, 30], ['gptEpochs', 1, 50], ['batchSize', 1, 4]]) {
    if (input[key] === '' || input[key] == null) continue;
    const value = Number(input[key]);
    if (Number.isInteger(value) && value >= min && value <= max) out[key] = value;
  }
  return out;
}

export function createJob(state, { id, ownerEmail, ownerName = '', expName, label = '', consent = null, trainingConfig = null, now }) {
  const job = {
    id,
    ownerEmail: normalizeEmail(ownerEmail),
    ownerName: cleanText(ownerName, 80),
    label: cleanText(label, 80) || 'My voice',
    ...(isFixtureEmail(ownerEmail) ? { fixture: true } : {}),
    expName,
    // What the lecturer agreed to on the recording portal, kept with the set.
    consent: consent ? { version: cleanText(consent.version, 40), acceptedAt: iso(now) } : null,
    // Every attempt trains a new voice name from the same recordings, so a
    // retrain never overwrites the take a super user just rejected.
    sourceExpName: expName,
    status: 'uploading',
    attempt: 1,
    attempts: [],
    files: [],
    totalBytes: 0,
    trainingConfig: { ...BASE_TRAINING_CONFIG, ...sanitizeTrainingConfig(trainingConfig) },
    createdAt: iso(now),
    queuedAt: null,
    startedAt: null,
    finishedAt: null,
    reviews: [],
    feedback: [],
    notifications: [],
    error: '',
  };
  state.jobs.push(job);
  return job;
}

export function findJob(state, id) {
  return state.jobs.find((job) => job.id === id) || null;
}

export function submitJob(job, { files, now }) {
  if (job.status !== 'uploading') throw clientError(409, 'This recording set was already submitted');
  if (!Array.isArray(files) || files.length === 0) throw clientError(400, 'Upload at least one audio file');
  job.files = files.map((file) => ({ name: file.name, bytes: Number(file.bytes) || 0, source: file.source || 'upload' }));
  job.totalBytes = job.files.reduce((sum, file) => sum + file.bytes, 0);
  job.status = 'queued';
  job.queuedAt = iso(now);
  return job;
}

// Fair queue: a lecturer's recordings run back to back (their second voice
// right after their first), and lecturers take turns in the order they first
// joined the queue.
export function orderQueue(jobs) {
  const queued = jobs.filter((job) => job.status === 'queued');
  const firstSeen = new Map();
  for (const job of [...queued].sort(byQueuedAt)) {
    if (!firstSeen.has(job.ownerEmail)) firstSeen.set(job.ownerEmail, ms(job.queuedAt));
  }
  return queued.sort((left, right) => {
    const groupDelta = firstSeen.get(left.ownerEmail) - firstSeen.get(right.ownerEmail);
    if (groupDelta !== 0) return groupDelta;
    if (left.ownerEmail !== right.ownerEmail) return left.ownerEmail.localeCompare(right.ownerEmail);
    return byQueuedAt(left, right);
  });
}

// Average of the last few real runs, so the estimate follows the GPU's actual
// speed instead of a guess. Falls back to the configured figure.
export function trainingMinutes(state, env = process.env) {
  const configured = Number(env.STUDIO_TRAINING_MINUTES) || DEFAULT_TRAINING_MINUTES;
  const recent = state.history.slice(-5).map((entry) => Number(entry.minutes)).filter((value) => value > 0);
  if (recent.length === 0) return configured;
  return Math.round(recent.reduce((sum, value) => sum + value, 0) / recent.length);
}

// A slot holds the GPU only once it is published AND someone is assigned to it.
// Drafts and open (unclaimed) slots never block training or super users.
// Two kinds of slot:
//   'recording' — an in-person recording session (no GPU). Super users publish
//                 open sessions; a lecturer picks one, and the record page
//                 unlocks for them only during it.
//   'test'      — GPU time to test an approved voice. Super users allocate it to
//                 one person after QC; test slots never overlap (one GPU).
export function slotKind(slot) {
  return slot?.kind === 'recording' ? 'recording' : 'test';
}

export function slotHoldsGpu(slot) {
  return real(slot) && slotKind(slot) === 'test' && slot.status === 'published' && Boolean(slot.assigneeEmail);
}

// When a test slot really ends: its booked end, or earlier if the lecturer
// finished testing (completeSlot). The GPU hold and release follow this.
export function slotEnd(slot) {
  const end = ms(slot.end);
  const done = slot.completedAt ? ms(slot.completedAt) : 0;
  return done && done < end ? done : end;
}

function activeSlotAt(slots, time) {
  return slots.find((slot) => slotHoldsGpu(slot) && ms(slot.start) <= time && time < slotEnd(slot)) || null;
}

/**
 * The lecturer ends their own test slot early ("I'm done"). The slot GPU is then
 * released on the next tick unless another slot starts within the hour.
 */
export function completeSlot(state, { slotId, email, now }) {
  const slot = state.slots.find((item) => item.id === slotId);
  if (!slot || !slotHoldsGpu(slot) || !sameNtuPerson(slot.assigneeEmail, email)) throw clientError(404, 'Test slot not found');
  if (now < ms(slot.start)) throw clientError(409, 'Your test slot has not started yet');
  if (now >= slotEnd(slot)) throw clientError(409, 'Your test slot has already ended');
  slot.completedAt = iso(now);
  return slot;
}

/**
 * Estimated start/finish for the running job and every queued job, in queue
 * order. Training does not start while a test slot holds the GPU, so a job
 * that would start inside a slot is pushed to its end.
 */
export function estimateQueue(state, { now, gpuRunning = true, env = process.env } = {}) {
  const perJob = trainingMinutes(state, env) * MINUTE;
  let cursor = now + (gpuRunning ? 0 : GPU_BOOT_MINUTES * MINUTE);
  const estimates = [];
  const running = state.jobs.find((job) => job.status === 'training');
  if (running) {
    const started = ms(running.startedAt) || now;
    const finish = Math.max(started + perJob, now + MINUTE);
    estimates.push({ jobId: running.id, position: 0, startAt: iso(started), finishAt: iso(finish) });
    cursor = finish;
  }
  // Fixtures queue behind every real job, so they never delay a real estimate.
  const ordered = orderQueue(state.jobs);
  [...ordered.filter(real), ...ordered.filter((job) => !real(job))].forEach((job, index) => {
    let start = cursor;
    for (let guard = 0; guard < 50; guard += 1) {
      const slot = activeSlotAt(state.slots, start);
      if (!slot) break;
      start = slotEnd(slot);
    }
    const finish = start + perJob;
    estimates.push({ jobId: job.id, position: index + 1, startAt: iso(start), finishAt: iso(finish) });
    cursor = finish;
  });
  return estimates;
}

export function nextJobToTrain(state, now) {
  if (state.jobs.some((job) => job.status === 'training')) return null;
  if (activeSlotAt(state.slots, now)) return null;
  return orderQueue(state.jobs).find(real) || null;
}

export function markTrainingStarted(job, { sessionId, now }) {
  job.status = 'training';
  job.startedAt = iso(now);
  job.sessionId = sessionId || '';
  job.error = '';
  return job;
}

export function markTrainingFinished(state, job, { ok: succeeded, error = '', now }) {
  const started = ms(job.startedAt) || now;
  job.finishedAt = iso(now);
  job.attempts.push({
    attempt: job.attempt,
    expName: job.expName,
    config: { ...job.trainingConfig },
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    result: succeeded ? 'trained' : 'failed',
    ...(error ? { error } : {}),
  });
  if (succeeded) {
    job.status = 'review';
    state.history.push({ minutes: Math.max(1, Math.round((now - started) / MINUTE)), at: iso(now) });
    state.history = state.history.slice(-20);
  } else {
    job.status = 'failed';
    job.error = cleanText(error, 400) || 'Training failed';
  }
  return job;
}

/**
 * The retrain is changed by what was wrong, not repeated: GPT-SoVITS' SoVITS
 * stage owns timbre (sounds like the speaker), its GPT stage owns words and
 * rhythm, and noise is a data problem (denoise only then, and stop before the
 * model memorises the hiss). Explicit settings from the reviewer win.
 */
export function retrainConfig(previous, reasons = [], overrides = {}) {
  const config = { ...BASE_TRAINING_CONFIG, ...previous };
  const has = (reason) => reasons.includes(reason);
  if (has('not-their-voice')) config.sovitsEpochs = Math.min(16, Math.ceil(config.sovitsEpochs * 1.5));
  if (has('mispronounces') || has('robotic')) config.gptEpochs = Math.min(30, Math.ceil(config.gptEpochs * 1.5));
  // Denoising (16 kHz FRCRN) muffles clean audio and adds a robotic rasp, so a
  // retrain only denoises when this review names noise — never by inheritance
  // from an older attempt that ran under the former denoise-on default.
  config.skipDenoise = !has('noisy');
  if (has('noisy')) config.sovitsEpochs = Math.max(4, config.sovitsEpochs - 2);
  // Nothing specific was named: still move off the previous run.
  if (!reasons.some((reason) => reason !== 'other')) {
    config.sovitsEpochs = Math.min(16, config.sovitsEpochs + 2);
    config.gptEpochs = Math.min(30, config.gptEpochs + 5);
  }
  // The reviewer's explicit settings (epochs, batch size, noise removal) win.
  Object.assign(config, sanitizeTrainingConfig(overrides));
  return config;
}

export function reviewJob(job, { decision, reasons = [], notes = '', overrides = {}, reviewer, nextExpName, now }) {
  if (job.status !== 'review') throw clientError(409, 'Only a voice waiting for review can be reviewed');
  const cleanReasons = (Array.isArray(reasons) ? reasons : []).filter((reason) => reason in REJECT_REASONS);
  job.reviews.push({
    attempt: job.attempt,
    expName: job.expName,
    decision,
    reasons: cleanReasons,
    notes: cleanText(notes, 1000),
    reviewer: normalizeEmail(reviewer),
    at: iso(now),
  });
  if (decision === 'approve') {
    job.status = 'approved';
    job.approvedExpName = job.expName;
    return job;
  }
  if (decision !== 'reject') throw clientError(400, 'decision must be approve or reject');
  if (job.attempt >= MAX_TRAINING_ATTEMPTS && overrides.force !== true) {
    throw clientError(409, `This voice has had ${job.attempt} attempts. Ask the lecturer for new recordings, or force another retrain.`);
  }
  if (!nextExpName) throw clientError(409, 'No free voice name is left for a retrain');
  job.trainingConfig = retrainConfig(job.trainingConfig, cleanReasons, overrides);
  job.attempt += 1;
  job.expName = nextExpName;
  job.status = 'queued';
  job.queuedAt = iso(now);
  job.startedAt = null;
  job.finishedAt = null;
  return job;
}

export function requeueFailedJob(job, { nextExpName, now }) {
  if (job.status !== 'failed') throw clientError(409, 'Only a failed job can be retried');
  if (!nextExpName) throw clientError(409, 'No free voice name is left for a retry');
  job.expName = nextExpName;
  job.status = 'queued';
  job.queuedAt = iso(now);
  job.startedAt = null;
  job.finishedAt = null;
  job.error = '';
  return job;
}

export function cancelJob(job) {
  if (['training', 'cancelled'].includes(job.status)) {
    throw clientError(409, job.status === 'training' ? 'Training is already running on the GPU' : 'Already cancelled');
  }
  // Kept so a mistaken withdrawal can be undone (restoreJob). Nothing is deleted:
  // the recordings and every trained voice stay where they are.
  job.cancelledFrom = job.status;
  job.status = 'cancelled';
  return job;
}

/** Undo a withdrawal: the set goes back to where it was. */
export function restoreJob(job, { now } = {}) {
  if (job.status !== 'cancelled') throw clientError(409, 'Only a withdrawn set can be restored');
  const trained = job.attempts.some((attempt) => attempt.result === 'trained');
  // Sets withdrawn before this was recorded: a trained one goes back to review.
  const previous = job.cancelledFrom || (trained ? 'review' : job.files.length ? 'queued' : 'uploading');
  job.status = previous === 'training' ? 'queued' : previous;
  if (job.status === 'queued') job.queuedAt = iso(now ?? Date.now());
  delete job.cancelledFrom;
  return job;
}

// What a lecturer can tick about their voice. Short on purpose: a few taps,
// then the words it got wrong, then anything else in their own words.
export const FEEDBACK_ISSUES = Object.freeze({
  'wrong-words': 'Says some words wrongly',
  'skips-words': 'Skips or repeats words',
  robotic: 'Sounds flat or robotic',
  pace: 'Too fast or too slow',
  'not-like-me': 'Does not sound like me',
  noise: 'Buzz, hiss or glitches',
});
export const FEEDBACK_LIKENESS = Object.freeze({ yes: 'Sounds like me', mostly: 'Mostly', no: 'Not really' });

export function addFeedback(job, { email, rating, comment, likeness = '', issues = [], words = '', now }) {
  const score = Number(rating);
  if (!Number.isInteger(score) || score < 1 || score > 5) throw clientError(400, 'rating must be 1 to 5');
  const entry = { email: normalizeEmail(email), rating: score, comment: cleanText(comment, 2000), at: iso(now) };
  if (likeness in FEEDBACK_LIKENESS) entry.likeness = likeness;
  const picked = [...new Set((Array.isArray(issues) ? issues : []).filter((issue) => issue in FEEDBACK_ISSUES))];
  if (picked.length) entry.issues = picked;
  const wordList = cleanText(words, 500);
  if (wordList) entry.words = wordList;
  job.feedback.push(entry);
  return job;
}

// ── Slots ────────────────────────────────────────────────────────────────
//
// A slot is GPU time for one PERSON (not one voice): inside it they can switch
// between all of their approved voices. Super users add slots as drafts (date,
// time, optionally a name), edit them, and Publish. Published slots with no
// name are open; a lecturer can pick one from the table. One GPU means no two
// slots may overlap, drafts included.

export function slotsOverlap(left, right) {
  return ms(left.start) < ms(right.end) && ms(right.start) < ms(left.end);
}

function liveSlots(state) {
  return state.slots.filter((slot) => slot.status !== 'cancelled');
}

function validateTimes(start, end, now) {
  const startMs = ms(start);
  const endMs = ms(end);
  if (!startMs || !endMs) throw clientError(400, 'Pick a valid date, start and end time');
  const minutes = (endMs - startMs) / MINUTE;
  if (minutes < MIN_SLOT_MINUTES) throw clientError(400, `A slot must be at least ${MIN_SLOT_MINUTES} minutes`);
  if (minutes > MAX_SLOT_MINUTES) throw clientError(400, `A slot can be at most ${MAX_SLOT_MINUTES / 60} hours`);
  if (endMs <= now) throw clientError(400, 'The slot must end in the future');
  return { start: iso(startMs), end: iso(endMs) };
}

function assertNoClash(state, candidate, ignoreId = '', kind = 'test') {
  // Recording sessions are in person and may run in parallel; GPU test slots may not.
  if (kind !== 'test') return;
  // Fixture slots never hold the GPU, so they never block a real one.
  const clash = liveSlots(state).find((slot) => slot.id !== ignoreId && real(slot) && slotKind(slot) === 'test' && slotsOverlap(slot, candidate));
  if (clash) {
    const error = clientError(409, `That time overlaps ${clash.assigneeName || clash.assigneeEmail || 'another slot'} `
      + `(${clash.start} – ${clash.end}). The GPU serves one person at a time.`);
    error.code = 'SLOT_CLASH';
    error.clash = { id: clash.id, start: clash.start, end: clash.end };
    throw error;
  }
}

export function findSlot(state, id) {
  return state.slots.find((slot) => slot.id === id && slot.status !== 'cancelled') || null;
}

export function addSlot(state, {
  id, kind = 'test', start, end, assigneeEmail = '', assigneeName = '', hostName = '', actor, now,
}) {
  const slotType = kind === 'recording' ? 'recording' : 'test';
  const times = validateTimes(start, end, now);
  if (slotType === 'test' && !normalizeEmail(assigneeEmail)) throw clientError(400, 'Choose who this test slot is for');
  assertNoClash(state, times, '', slotType);
  const slot = {
    id,
    kind: slotType,
    ...times,
    status: 'draft',
    assigneeEmail: normalizeEmail(assigneeEmail),
    assigneeName: cleanText(assigneeName, 80),
    // Who runs it (the super user account is shared, so the login does not say).
    hostName: cleanText(hostName, 80),
    createdBy: normalizeEmail(actor),
    updatedAt: iso(now),
    // What the assignee was last told (person + time), so Publish emails only real changes.
    notified: null,
    preloadedAt: null,
    reminderSentAt: null,
  };
  state.slots.push(slot);
  return slot;
}

export function editSlot(state, id, { start, end, assigneeEmail, assigneeName, hostName }, now) {
  const slot = findSlot(state, id);
  if (!slot) throw clientError(404, 'Slot not found');
  const times = validateTimes(start ?? slot.start, end ?? slot.end, now);
  if (slotKind(slot) === 'test' && assigneeEmail !== undefined && !normalizeEmail(assigneeEmail)) {
    throw clientError(400, 'A test slot needs a person');
  }
  assertNoClash(state, times, id, slotKind(slot));
  Object.assign(slot, times, {
    ...(assigneeEmail !== undefined ? { assigneeEmail: normalizeEmail(assigneeEmail) } : {}),
    ...(assigneeName !== undefined ? { assigneeName: cleanText(assigneeName, 80) } : {}),
    ...(hostName !== undefined ? { hostName: cleanText(hostName, 80) } : {}),
    updatedAt: iso(now),
    preloadedAt: null,
    reminderSentAt: null,
  });
  // An edited published slot goes back to draft until it is published again,
  // so lecturers never see a half-edited schedule.
  if (slot.status === 'published') slot.status = 'draft';
  return slot;
}

export function removeSlot(state, id) {
  const slot = findSlot(state, id);
  if (!slot) throw clientError(404, 'Slot not found');
  const told = slot.notified;
  slot.status = 'cancelled';
  return { slot, notify: told?.assigneeEmail ? told : null };
}

/**
 * Publishes every draft. Returns who must be emailed: people newly given a
 * slot or whose time changed, and people who lost a slot they had been told about.
 */
export function publishSlots(state, now) {
  const toNotify = [];
  for (const slot of state.slots.filter((item) => item.status === 'draft')) {
    slot.status = 'published';
    slot.publishedAt = iso(now);
    const before = slot.notified;
    const after = slot.assigneeEmail ? { assigneeEmail: slot.assigneeEmail, start: slot.start, end: slot.end } : null;
    const samePerson = before && after && sameNtuPerson(before.assigneeEmail, after.assigneeEmail);
    const recording = slotKind(slot) === 'recording';
    if (before && !samePerson) {
      toNotify.push({ kind: recording ? 'recordingCancelled' : 'slotCancelled', email: before.assigneeEmail, slot: { ...slot, ...before } });
    }
    if (after && (!samePerson || before.start !== after.start || before.end !== after.end)) {
      toNotify.push({ kind: recording ? 'recordingBooked' : 'slotBooked', email: after.assigneeEmail, slot: { ...slot }, moved: Boolean(samePerson) });
    }
    slot.notified = after;
  }
  return toNotify;
}

/** A lecturer picks an open published recording session (one upcoming each). */
export function claimSlot(state, id, { email, name = '', now, env = process.env }) {
  const slot = findSlot(state, id);
  if (!slot || slot.status !== 'published' || slotKind(slot) !== 'recording' || (!real(slot) && !isFixtureViewer(email, env))) {
    throw clientError(404, 'That session is not available');
  }
  if (slot.assigneeEmail) throw clientError(409, 'Someone has just taken that session — pick another');
  if (ms(slot.end) <= now) throw clientError(409, 'That session has already ended');
  if (!cleanText(name, 80)) throw clientError(400, 'Enter your name');
  const mine = liveSlots(state).find((item) => slotKind(item) === 'recording' && sameNtuPerson(item.assigneeEmail, email) && ms(item.end) > now);
  if (mine) throw clientError(409, 'You already have a recording session booked. Use Change to move it to another time.');
  if (hasSubmittedVoice(state, email)) {
    throw clientError(409, 'Your recordings are already in. One recording session per person — we email you as your voice moves along.');
  }
  slot.assigneeEmail = normalizeEmail(email);
  slot.assigneeName = cleanText(name, 80);
  slot.claimedAt = iso(now);
  slot.notified = { assigneeEmail: slot.assigneeEmail, start: slot.start, end: slot.end };
  return slot;
}

/**
 * A lecturer changes their booked recording session to another open one, in
 * one step, so they never hold two and never end up with none. Only before
 * their current session starts.
 */
export function moveSlot(state, toId, { email, now, env = process.env }) {
  const current = liveSlots(state).find((item) => slotKind(item) === 'recording' && item.status === 'published'
    && sameNtuPerson(item.assigneeEmail, email) && ms(item.end) > now);
  if (!current) throw clientError(404, 'You have no booked session to change');
  if (current.id === toId) throw clientError(409, 'That is already your session');
  if (ms(current.start) <= now) throw clientError(409, 'Your session has already started and cannot be changed');
  const target = findSlot(state, toId);
  if (!target || target.status !== 'published' || slotKind(target) !== 'recording' || (!real(target) && !isFixtureViewer(email, env))) {
    throw clientError(404, 'That session is not available');
  }
  if (target.assigneeEmail) throw clientError(409, 'Someone has just taken that session — pick another');
  if (ms(target.end) <= now) throw clientError(409, 'That session has already ended');
  const name = current.assigneeName;
  Object.assign(target, {
    assigneeEmail: current.assigneeEmail, assigneeName: name, claimedAt: iso(now),
    notified: { assigneeEmail: current.assigneeEmail, start: target.start, end: target.end },
  });
  Object.assign(current, { assigneeEmail: '', assigneeName: '', notified: null, claimedAt: null });
  return { from: { ...current }, to: target };
}

export function releaseSlot(state, id, { email, now }) {
  const slot = findSlot(state, id);
  if (!slot || slotKind(slot) !== 'recording' || !sameNtuPerson(slot.assigneeEmail, email)) throw clientError(404, 'That is not your session');
  if (ms(slot.start) <= now) throw clientError(409, 'Your slot has already started');
  slot.assigneeEmail = '';
  slot.assigneeName = '';
  slot.notified = null;
  slot.claimedAt = null;
  return slot;
}

export function currentSlot(state, now) {
  return activeSlotAt(state.slots, now);
}

export function upcomingSlotFor(state, email, now, kind = 'test') {
  return liveSlots(state)
    .filter((slot) => slotKind(slot) === kind && slot.status === 'published' && sameNtuPerson(slot.assigneeEmail, email) && slotEnd(slot) > now)
    .sort((a, b) => ms(a.start) - ms(b.start))[0] || null;
}

/** This person's most recent test slot that is over (ended or finished early), or null. */
export function lastTestedSlotFor(state, email, now) {
  return liveSlots(state)
    .filter((slot) => slotHoldsGpu(slot) && sameNtuPerson(slot.assigneeEmail, email) && slotEnd(slot) <= now)
    .sort((a, b) => slotEnd(b) - slotEnd(a))[0] || null;
}

// After a recording session ends, uploads that were started in it may still finish.
export const RECORDING_GRACE_MINUTES = 120;

/**
 * Whether this person may record/upload right now: only during their own
 * published recording session (super users always may). Returns their next
 * session either way so the page can say when it unlocks.
 */
export function recordingAccess(state, { email, now, superuser }) {
  const mine = liveSlots(state)
    .filter((slot) => slotKind(slot) === 'recording' && slot.status === 'published' && sameNtuPerson(slot.assigneeEmail, email))
    .sort((a, b) => ms(a.start) - ms(b.start));
  const active = mine.find((slot) => ms(slot.start) <= now && now < ms(slot.end)) || null;
  const next = mine.find((slot) => ms(slot.end) > now) || null;
  if (superuser) return { allowed: true, reason: 'superuser', slot: active || next };
  if (active) return { allowed: true, reason: 'in-session', slot: active };
  return { allowed: false, reason: next ? 'too-early' : 'no-session', slot: next };
}

/** Uploads to a set created in a session may finish shortly after it. */
export function uploadWindowOpen(state, job, { now, superuser }) {
  if (superuser) return true;
  const slot = state.slots.find((item) => item.id === job.recordingSlotId);
  if (!slot) return false;
  return now < ms(slot.end) + RECORDING_GRACE_MINUTES * MINUTE;
}

/**
 * One recording session per person: once their recordings are submitted
 * (anything but an unsent or withdrawn set), they cannot book another. A set
 * sent back for new recordings is withdrawn, so that person may book again.
 */
export function hasSubmittedVoice(state, email) {
  return state.jobs.some((job) => sameNtuPerson(job.ownerEmail, email) && !['uploading', 'cancelled'].includes(job.status));
}

// Emails before a booked session. Recording: the day before, then shortly
// before it starts. Test slot: on the morning of the day (the GPU "starts soon"
// email at warm-up is separate, see slotsToRemind).
const SGT_OFFSET_MS = 8 * 60 * MINUTE;
function sgtMorningOf(startMs, hour = 7) {
  const dayStart = Math.floor((startMs + SGT_OFFSET_MS) / (24 * 60 * MINUTE)) * 24 * 60 * MINUTE - SGT_OFFSET_MS;
  return dayStart + hour * 60 * MINUTE;
}
export const SESSION_REMINDERS = Object.freeze({
  recording: [
    { kind: 'day', from: (start) => start - 24 * 60 * MINUTE, until: (start) => start - 2 * 60 * MINUTE },
    { kind: 'soon', from: (start) => start - 60 * MINUTE, until: (start) => start },
  ],
  test: [
    { kind: 'today', from: (start) => sgtMorningOf(start), until: (start) => start - SLOT_WARMUP_MINUTES * MINUTE },
  ],
});

/**
 * Booked sessions whose reminder is due. Each reminder is recorded against the
 * person and start time it was sent for, so a moved or re-assigned session is
 * reminded again and an unchanged one never twice. A booking made after a
 * reminder's window has passed simply skips that reminder.
 */
export function sessionRemindersDue(state, now) {
  const due = [];
  for (const slot of liveSlots(state)) {
    // Fixtures (@voice-studio.test) are never emailed.
    if (slot.status !== 'published' || !slot.assigneeEmail || !real(slot)) continue;
    const start = ms(slot.start);
    const key = reminderKey(slot);
    for (const reminder of SESSION_REMINDERS[slotKind(slot)]) {
      if (slot.reminders?.[reminder.kind] === key) continue;
      if (reminder.from(start) <= now && now < reminder.until(start)) due.push({ slot, kind: reminder.kind, key });
    }
  }
  return due;
}

export function reminderKey(slot) {
  return `${normalizeEmail(slot.assigneeEmail)}|${slot.start}`;
}

/** Test slots inside the warm-up window whose "starts soon" email has not gone out. */
export function slotsToRemind(state, now) {
  return state.slots.filter((slot) => slotHoldsGpu(slot)
    && !slot.reminderSentAt
    && ms(slot.start) - SLOT_WARMUP_MINUTES * MINUTE <= now
    && now < ms(slot.start));
}

function approvedVoicesOf(state, email) {
  return state.jobs
    .filter((job) => sameNtuPerson(job.ownerEmail, email) && ['approved', 'scheduled'].includes(job.status) && job.approvedExpName)
    .map((job) => job.approvedExpName);
}

/**
 * Whether this person may load and speak with this voice right now.
 * Super users review any voice at any time, on their own QC GPU; a lecturer's
 * slot has a GPU of its own. A lecturer uses only their own approved voices,
 * only inside their own slot.
 */
export function voiceAccess(state, { email, voiceName, now, superuser }) {
  const active = activeSlotAt(state.slots, now);
  const ownApproved = approvedVoicesOf(state, email).includes(voiceName);
  if (active && sameNtuPerson(active.assigneeEmail, email) && ownApproved) {
    return { allowed: true, reason: 'in-slot', slot: active };
  }
  if (superuser) return { allowed: true, reason: 'superuser', slot: null };
  if (!ownApproved) return { allowed: false, reason: 'not-approved' };
  const slot = upcomingSlotFor(state, email, now, 'test');
  if (!slot) return { allowed: false, reason: 'no-slot' };
  return { allowed: false, reason: 'too-early', slot };
}

/** Voices this person may see in the testing portal at all. */
export function visibleVoices(state, { email, superuser }) {
  const own = approvedVoicesOf(state, email);
  if (!superuser) return own;
  const trained = state.jobs.flatMap((job) => job.attempts.filter((attempt) => attempt.result === 'trained').map((attempt) => attempt.expName));
  return [...new Set([...trained, ...own])];
}

/** The voice to load before a slot starts: the person's most recently approved one. */
export function preloadVoiceFor(state, slot) {
  const approved = state.jobs
    .filter((job) => sameNtuPerson(job.ownerEmail, slot.assigneeEmail) && ['approved', 'scheduled'].includes(job.status) && job.approvedExpName)
    .sort((a, b) => String(b.reviews.at(-1)?.at || '').localeCompare(String(a.reviews.at(-1)?.at || '')));
  return approved[0]?.approvedExpName || '';
}

/**
 * Whether a test slot holds the inference GPU now, and for whom: from
 * SLOT_WARMUP_MINUTES before it starts to its end, and across a gap shorter
 * than SLOT_BRIDGE_MINUTES to the next slot (the GPU then loads the next
 * person's voice instead of stopping and starting again). phase: 'warmup' |
 * 'slot' | 'bridge'.
 */
export function gpuHold(state, now) {
  const slots = state.slots.filter(slotHoldsGpu).sort((a, b) => ms(a.start) - ms(b.start));
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    const from = ms(slot.start) - SLOT_WARMUP_MINUTES * MINUTE;
    const end = slotEnd(slot);
    if (from <= now && now < end) return { slot, phase: now < ms(slot.start) ? 'warmup' : 'slot' };
    const next = slots[index + 1];
    if (next && end <= now && now < ms(next.start) - SLOT_WARMUP_MINUTES * MINUTE
      && ms(next.start) - end < SLOT_BRIDGE_MINUTES * MINUTE) {
      return { slot: next, phase: 'bridge' };
    }
  }
  return null;
}

/**
 * What a slot's GPU warm-up looks like, from the coordinator's answer: when it
 * started, whether the voice can speak, and when it should be ready. Kept on
 * the slot so the lecturer and super users see the same, real estimate.
 */
export const GPU_BOOT_ESTIMATE_MINUTES = 15;
export const GPU_SWITCH_ESTIMATE_MINUTES = 2;
export function nextWarmState(previous, capacity, now) {
  const ready = Boolean(capacity?.canStartConversation);
  const state = String(capacity?.state || (ready ? 'READY' : 'CHECKING'));
  if (ready) return { state: 'READY', readyAt: previous?.readyAt || iso(now), startedAt: previous?.startedAt || iso(now), checkedAt: iso(now) };
  // A new phase (e.g. switching after a boot) restarts the clock it is measured by.
  const samePhase = previous && previous.state === state && previous.state !== 'READY';
  // The coordinator reports when this boot/switch really began as waitStartedAt.
  const startedAt = samePhase ? previous.startedAt : iso(Number(capacity?.waitStartedAt) || now);
  const minutes = state === 'STARTING' ? GPU_BOOT_ESTIMATE_MINUTES : GPU_SWITCH_ESTIMATE_MINUTES;
  return {
    state,
    startedAt,
    estimatedReadyAt: iso(ms(startedAt) + minutes * MINUTE),
    message: cleanText(capacity?.message, 300),
    checkedAt: iso(now),
  };
}

/** Ended test slots whose GPU warm-up ran and has not been released yet. */
export function slotsToRelease(state, now) {
  return state.slots.filter((slot) => slotHoldsGpu(slot) && slot.warm && !slot.gpuReleasedAt && slotEnd(slot) <= now);
}

// Super users testing keeps the fixed GPU (the live chat service) on until this
// long after their last use; a test slot keeps it on regardless (gpuHold).
export const SUPERUSER_TEST_IDLE_MINUTES = 30;

/** The fixed GPU must stay on (and be started) while any of this is true. */
export function gpuDemand(state, now) {
  if (state.jobs.some((job) => real(job) && (job.status === 'training' || job.status === 'queued'))) return 'training';
  if (gpuHold(state, now)) return 'slot';
  if (now - ms(state.lastSuperuserTestAt) < SUPERUSER_TEST_IDLE_MINUTES * MINUTE) return 'testing';
  return '';
}

/** What a lecturer sees in the session table: published upcoming recording sessions. */
export function publicSlots(state, email, now, env = process.env) {
  const fixtureViewer = isFixtureViewer(email, env);
  return liveSlots(state)
    .filter((slot) => slotKind(slot) === 'recording' && slot.status === 'published' && ms(slot.end) > now)
    .filter((slot) => real(slot) || fixtureViewer)
    .sort((a, b) => ms(a.start) - ms(b.start))
    .map((slot) => ({
      id: slot.id,
      start: slot.start,
      end: slot.end,
      open: !slot.assigneeEmail,
      mine: sameNtuPerson(slot.assigneeEmail, email),
      name: slot.assigneeEmail ? (slot.assigneeName || 'Booked') : '',
    }));
}

// ── Views ────────────────────────────────────────────────────────────────

export function publicJob(job, estimate = null) {
  const { notifications: _notifications, sessionId: _sessionId, ...rest } = job;
  return { ...rest, ...(estimate ? { estimate } : {}) };
}

export function lecturerJob(job, estimate) {
  // Lecturers see their status, not reviewers' internal notes.
  return {
    id: job.id,
    label: job.label,
    status: lecturerStatus(job.status),
    attempt: job.attempt,
    files: job.files,
    totalBytes: job.totalBytes,
    createdAt: job.createdAt,
    queuedAt: job.queuedAt,
    voiceName: ['approved', 'scheduled'].includes(job.status) ? job.approvedExpName : '',
    estimate: estimate || null,
    feedback: job.feedback.filter((entry) => sameNtuPerson(entry.email, job.ownerEmail)),
  };
}

// A retrain after review is "queued"/"training" again with attempt > 1; the
// lecturer page labels that stage "Retraining". The review itself is internal.
function lecturerStatus(status) {
  if (status === 'approved' || status === 'scheduled') return 'ready';
  if (status === 'review') return 'quality-check';
  if (status === 'failed') return 'quality-check';
  return status;
}

// ── helpers ──────────────────────────────────────────────────────────────

export function clientError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function cleanText(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, max);
}

function ms(value) {
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function iso(value) {
  return new Date(ms(value)).toISOString();
}

function byQueuedAt(left, right) {
  return ms(left.queuedAt) - ms(right.queuedAt);
}
