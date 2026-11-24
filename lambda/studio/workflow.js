// Voice Studio workflow: the pure rules behind the recording portal and the
// review/testing portal. No I/O lives here, so every rule (queue order, ETA,
// retrain strategy, slot clashes, who may do what) is unit-tested directly.
//
// Training runs one job at a time in a fair queue. Testing is one person, one
// GPU: each lecturer tests on a GPU of their own (in their booked slot, or any
// time before they send feedback, with a cold start), and super users share one.

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
    cleanupLog: Array.isArray(raw.cleanupLog) ? raw.cleanupLog : [],
    keptVoices: Array.isArray(raw.keptVoices) ? raw.keptVoices : [],
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
//   'recording' — an in-person recording session (no GPU). A super user books it
//                 for one person (time agreed in person); the record page
//                 unlocks for that person only during it.
//   'test'      — GPU time to test an approved voice, for one person. Several
//                 people may share a time: each gets a GPU of their own.
export function slotKind(slot) {
  return slot?.kind === 'recording' ? 'recording' : 'test';
}

export function slotHoldsGpu(slot) {
  if (!real(slot) || slotKind(slot) !== 'test' || !slot.assigneeEmail) return false;
  if (slot.status === 'published') return true;
  // Owner 2026-11-23: an edited published slot (a draft again until republished)
  // keeps its person's GPU on the NEW times at once (warms 20 min before the new
  // start, runs to the new end). A different person waits until it is published.
  return slot.status === 'draft' && Boolean(slot.notified?.assigneeEmail)
    && sameNtuPerson(slot.notified.assigneeEmail, slot.assigneeEmail);
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

function slotsHoldingGpu(slots, time) {
  return slots.filter((slot) => slotHoldsGpu(slot) && ms(slot.start) <= time && time < slotEnd(slot));
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

// ── Clean up (owner 2026-11-24) ──────────────────────────────────────────
// Stale entries (a test set, an approved voice nobody will test, an upload
// that never finished) can be deleted for good from Tools > Clean up. Only the
// record goes: recordings and trained voices stay in storage. Each withdraw,
// restore and delete is logged with who did it.

/** Delete a set's record. Their upcoming test slots go too unless another set of theirs is still live. */
export function deleteJob(state, id, now = Date.now()) {
  const job = findJob(state, id);
  if (!job) throw clientError(404, 'Job not found');
  if (job.status === 'training') throw clientError(409, 'Training is running on the GPU; wait for it to finish');
  state.jobs = state.jobs.filter((item) => item.id !== id);
  // The voices it trained are not deleted: they stay testable in Quality check
  // > Test any voice under the same name (owner 2026-11-24).
  if (!job.fixture) {
    const kept = studioTrainedVoices({ jobs: [job], keptVoices: [] });
    const names = new Set(kept.map((voice) => voice.expName));
    state.keptVoices = [...(state.keptVoices || []).filter((voice) => !names.has(voice.expName)), ...kept];
  }
  const stillLive = state.jobs.some((other) => sameNtuPerson(other.ownerEmail, job.ownerEmail) && other.status !== 'cancelled');
  let slotsRemoved = 0;
  if (!stillLive) {
    for (const slot of state.slots) {
      if (slot.status !== 'cancelled' && slotKind(slot) === 'test' && sameNtuPerson(slot.assigneeEmail, job.ownerEmail) && slotEnd(slot) > now) {
        slot.status = 'cancelled';
        slotsRemoved += 1;
      }
    }
  }
  return { job, slotsRemoved };
}

export function logCleanup(state, { actor, action, job, from = '', note = '', now = Date.now() }) {
  state.cleanupLog = [...(state.cleanupLog || []), {
    at: iso(now), actor: normalizeEmail(actor), action, jobId: job.id,
    who: job.ownerName || job.ownerEmail, email: job.ownerEmail, label: job.label || '', status: from || job.status, note,
  }].slice(-100);
}

/**
 * Every voice trained on this site: from each set's trained attempts, plus those
 * kept from sets deleted in Clean up. [{ expName, label, ownerEmail }], label
 * "<voice label> · <person> (try n)".
 */
export function studioTrainedVoices(state) {
  const voices = new Map((state.keptVoices || []).map((voice) => [voice.expName, voice]));
  for (const job of state.jobs.filter(real)) {
    for (const attempt of job.attempts) {
      if (attempt.result !== 'trained') continue;
      voices.set(attempt.expName, {
        expName: attempt.expName,
        label: `${job.label} · ${job.ownerName || job.ownerEmail}${attempt.attempt > 1 ? ` (try ${attempt.attempt})` : ''}`,
        ownerEmail: job.ownerEmail,
      });
    }
  }
  return [...voices.values()];
}

/** Every set, old unfinished uploads included, with what makes it look stale. */
export function cleanupRecords(state, now = Date.now()) {
  const upcomingTest = (email) => state.slots.some((slot) => slot.status !== 'cancelled' && slotKind(slot) === 'test'
    && sameNtuPerson(slot.assigneeEmail, email) && slotEnd(slot) > now);
  return state.jobs.map((job) => {
    const times = [job.createdAt, job.queuedAt, job.startedAt, job.finishedAt,
      ...(job.reviews || []).map((entry) => entry.at), ...(job.feedback || []).map((entry) => entry.at)]
      .map((value) => Date.parse(value || '')).filter(Number.isFinite);
    const lastAt = times.length ? Math.max(...times) : 0;
    const idleDays = lastAt ? Math.floor((now - lastAt) / 86_400_000) : null;
    let stale = '';
    if (job.status === 'uploading' && idleDays >= 1) stale = 'Upload never finished';
    else if (job.status === 'cancelled') stale = 'Withdrawn';
    else if (job.status === 'failed') stale = 'Training failed';
    else if (['approved', 'scheduled'].includes(job.status) && !upcomingTest(job.ownerEmail)) stale = 'Approved, no test slot';
    else if (idleDays >= 14 && job.status !== 'training') stale = `No activity for ${idleDays} days`;
    return {
      id: job.id, ownerEmail: job.ownerEmail, ownerName: job.ownerName, label: job.label, status: job.status,
      createdAt: job.createdAt, lastAt: lastAt ? iso(lastAt) : null, idleDays, stale, files: (job.files || []).length,
    };
  }).sort((a, b) => Number(Boolean(b.stale)) - Number(Boolean(a.stale)) || String(b.createdAt).localeCompare(String(a.createdAt)));
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
  // The lecturer's own feedback ends their testing of this voice.
  if (sameNtuPerson(entry.email, job.ownerEmail) && !job.testingClosedAt) job.testingClosedAt = iso(now);
  return job;
}

// ── Slots ────────────────────────────────────────────────────────────────
//
// A slot is time for one PERSON (not one voice). Super users add slots as
// drafts (date, time, person), edit them, and Publish. Lecturers never book:
// times are agreed in person. One person's own slots of a kind may not
// overlap; different people may share a time (one GPU each for testing).

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

function assertNoClash(state, candidate, ignoreId = '', kind = 'test', email = '') {
  // One person cannot be in two sessions of a kind at once; different people can.
  if (!normalizeEmail(email)) return;
  const clash = liveSlots(state).find((slot) => slot.id !== ignoreId && real(slot) && slotKind(slot) === kind
    && sameNtuPerson(slot.assigneeEmail, email) && slotsOverlap(slot, candidate));
  if (clash) {
    const error = clientError(409, `${clash.assigneeName || clash.assigneeEmail} already has a ${kind === 'test' ? 'test slot' : 'recording session'} `
      + `then (${clash.start} – ${clash.end}).`);
    error.code = 'SLOT_CLASH';
    error.clash = { id: clash.id, start: clash.start, end: clash.end };
    throw error;
  }
}

export function findSlot(state, id) {
  return state.slots.find((slot) => slot.id === id && slot.status !== 'cancelled') || null;
}

const MAX_SESSION_HOSTS = 8;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

// Staff running a recording session: a list (several may run one), trimmed,
// deduplicated case-insensitively. An old single `hostName` reads as a list of one.
function cleanHosts(hostNames, hostName) {
  const raw = Array.isArray(hostNames) ? hostNames : (hostName ? String(hostName).split(',') : []);
  const seen = new Set();
  const hosts = [];
  for (const value of raw) {
    const name = cleanText(value, 80);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    hosts.push(name);
    if (hosts.length >= MAX_SESSION_HOSTS) break;
  }
  return hosts;
}

function hostFields(hostNames, hostName) {
  const hosts = cleanHosts(hostNames, hostName);
  // hostName stays as the joined list for anything that still reads the single field.
  return { hostNames: hosts, hostName: hosts.join(', ') };
}

// ── Staff availability: first come gets the booking ─────────────────────
//
// A free recording session (no lecturer) is one staff member's availability;
// staff are super users (shown by their name, else their email). A booking is
// its own recording session with a lecturer. It goes to the staff member free
// then who marked the time first (covering the whole booking beats partly);
// everyone else free then is "overridden" and emailed on Publish to pick
// another time. The host confirms (or hands it to another free staff member)
// before the booking can be published. Undoing, moving or deleting the
// booking gives the overridden time back.

function isFreeRecording(slot) {
  return slotKind(slot) === 'recording' && !slot.assigneeEmail;
}

function isBookedRecording(slot) {
  return slotKind(slot) === 'recording' && Boolean(slot.assigneeEmail) && slot.status !== 'cancelled';
}

function sameHost(names, name) {
  return names.some((other) => other.toLowerCase() === String(name).toLowerCase());
}

// Names typed for a session must be super users (by name or email); stored as their display name
// (name, else email). Names already on the slot stay (older sessions named staff freely).
function superuserHosts(hosts, staff, keep = []) {
  if (!staff) return hosts;
  return hosts.map((name) => {
    const entry = staff.find((item) => (item.name && item.name.trim().toLowerCase() === name.toLowerCase())
      || sameNtuPerson(item.email, name));
    if (entry) return entry.name?.trim() || entry.email;
    if (sameHost(keep, name)) return name;
    throw clientError(400, `${name} is not a super user. Add them under Super users (with their email) first.`);
  });
}

/**
 * Staff free over `range`, priority first: availability covering the whole
 * range before partial, then whoever marked their time first. Staff already
 * running another booking then are left out.
 */
export function staffFreeFor(state, range, ignoreId = '') {
  const live = liveSlots(state).filter((slot) => slot.id !== ignoreId && slotKind(slot) === 'recording' && slotsOverlap(slot, range));
  const busy = live.filter(isBookedRecording).flatMap((slot) => slot.hostNames || []);
  const ranked = live
    .map((slot, order) => ({ slot, order, covers: ms(slot.start) <= ms(range.start) && ms(slot.end) >= ms(range.end) }))
    .filter(({ slot }) => isFreeRecording(slot))
    .sort((a, b) => Number(b.covers) - Number(a.covers) || a.order - b.order);
  const names = [];
  for (const { slot } of ranked) {
    for (const name of slot.hostNames || []) if (!sameHost(names, name) && !sameHost(busy, name)) names.push(name);
  }
  return names;
}

/**
 * A booking placed on its host's own free time, not confirmed yet: it stays a
 * draft until the host confirms (or hands it on). A booking with no free time
 * under it (the host was just named) needs no confirming (owner 2026-11-24).
 */
export function awaitsHost(state, slot) {
  if (slot.status !== 'draft' || !isBookedRecording(slot) || slot.hostConfirmedAt) return false;
  const hosts = slot.hostNames || [];
  if (!hosts.length) return false;
  return liveSlots(state).some((free) => free.id !== slot.id && isFreeRecording(free) && slotsOverlap(free, slot)
    && (free.hostNames || []).some((name) => sameHost(hosts, name)));
}

// Does `booking` take this free time? Only someone else's: the host's own free time is what they run it in.
function takes(booking, slot) {
  if (!isBookedRecording(booking) || slot.id === booking.id || !isFreeRecording(slot) || !slotsOverlap(slot, booking)) return false;
  const hosts = slot.hostNames || [];
  return !(hosts.length && hosts.every((name) => sameHost(booking.hostNames || [], name)));
}

function overrideBy(slot, booking, now, seen) {
  slot.freeAgain = null; // taken again before the "free again" email went: no need to send it
  slot.overriddenBy = {
    slotId: booking.id,
    start: booking.start,
    end: booking.end,
    assigneeName: booking.assigneeName || booking.assigneeEmail,
    hostNames: [...(booking.hostNames || [])],
    at: iso(now),
    // Free time added over a booking already shows it taken: nobody needs an email about it.
    notifiedAt: seen ? iso(now) : null,
  };
}

// Free time not overridden yet: the first booking (in the order they were made) that takes it.
// Free time added over a published booking is shown taken at once (no email); over a
// draft one, its staff are emailed when the booking goes out like everyone else.
function overrideFreeSlot(state, slot, now, seen = false) {
  if (slot.overriddenBy || !isFreeRecording(slot)) return;
  const booking = liveSlots(state).find((other) => takes(other, slot));
  if (booking) overrideBy(slot, booking, now, seen && booking.status === 'published');
}

/**
 * A lecturer booked before anyone was free has no host. Free time marked over
 * it later hands it to whoever free then marked first (owner 2026-11-24); they
 * confirm it as usual, and later free time there is taken.
 */
function adoptHostlessBookings(state, slot, now, staff) {
  if (!isFreeRecording(slot)) return;
  for (const booking of liveSlots(state)) {
    if (!isBookedRecording(booking) || (booking.hostNames || []).length || !slotsOverlap(booking, slot)) continue;
    const host = staffFreeFor(state, booking).filter((name) => {
      try { superuserHosts([name], staff); return true; } catch { return false; }
    })[0];
    if (!host) continue;
    Object.assign(booking, { hostNames: [host], hostName: host, hostConfirmedAt: null });
    if (booking.status === 'published') booking.status = 'draft'; // goes out again once the host confirms
    applyOverrides(state, booking, now);
  }
}

/** Re-applies the rule for one booking after it was added, edited or removed. */
function applyOverrides(state, booking, now) {
  const live = booking.status !== 'cancelled';
  const freed = [];
  for (const slot of liveSlots(state)) {
    if (slot.overriddenBy?.slotId === booking.id && !(live && takes(booking, slot))) {
      // Staff already told their time was taken are told it is free again (freeAgainNotices).
      if (slot.overriddenBy.notifiedAt) slot.freeAgain = { ...slot.overriddenBy, at: iso(now) };
      slot.overriddenBy = null;
      freed.push(slot);
    }
  }
  if (live) {
    for (const slot of liveSlots(state)) {
      if (!takes(booking, slot)) continue;
      if (slot.overriddenBy?.slotId === booking.id) {
        // Same booking, new details (time, lecturer, staff): refresh what the banner says.
        Object.assign(slot.overriddenBy, {
          start: booking.start, end: booking.end, assigneeName: booking.assigneeName || booking.assigneeEmail, hostNames: [...(booking.hostNames || [])],
        });
      } else if (!slot.overriddenBy) overrideBy(slot, booking, now, false); // else an earlier booking keeps it
    }
  }
  // Time given back may still sit under another booking.
  for (const slot of freed) {
    overrideFreeSlot(state, slot, now);
    if (slot.overriddenBy) slot.freeAgain = null;
  }
}

// ── Account-based (owner 2026-11-24): each super user acts only for themself ──

/** The signed-in super user's calendar name (name, else email), or ''. */
export function staffLabelOf(staff, email) {
  const entry = (staff || []).find((item) => sameNtuPerson(item.email, email));
  return entry ? (entry.name?.trim() || entry.email) : '';
}

// Hosts on a slot that are real super users (older slots may name anyone).
function superuserNames(names, staff) {
  return (names || []).filter((name) => (staff || []).some((item) => (item.name && item.name.trim().toLowerCase() === String(name).toLowerCase())
    || sameNtuPerson(item.email, name)));
}

function forbidden(message) {
  const error = clientError(403, message);
  error.code = 'NOT_YOURS';
  return error;
}

/**
 * Refuses a calendar change the signed-in account may not make: marking,
 * moving or deleting someone else's free time, and confirming or handing on a
 * booking that waits for another account. Bookings themselves (lecturer,
 * time) may be made and edited by any super user.
 * change: { add?: { assigneeEmail, hostNames }, slotId?, hostNames?, confirm?, remove? }
 */
export function assertMayChange(state, { actorEmail, staff, add, slotId, hostNames, confirm = false, remove = false }) {
  const me = staffLabelOf(staff, actorEmail);
  const mine = (names) => superuserNames(names, staff).every((name) => sameHost([me], name) || sameNtuPerson(actorEmail, name));
  if (add) {
    if (add.kind !== 'recording' || normalizeEmail(add.assigneeEmail)) return;
    if (!mine(add.hostNames || [])) throw forbidden('You can only mark your own free time. Sign in as them to mark theirs.');
    return;
  }
  const slot = findSlot(state, slotId);
  if (!slot || slotKind(slot) !== 'recording') return;
  if (isFreeRecording(slot)) {
    if (!mine(slot.hostNames || [])) throw forbidden(`This is ${(slot.hostNames || []).join(', ')}'s free time. Only they can change it.`);
    if (hostNames !== undefined && !mine(hostNames)) throw forbidden('You can only mark your own free time.');
    return;
  }
  // A booking on its host's free time: only that host confirms it or hands it on.
  const waiting = awaitsHost(state, slot);
  const host = (slot.hostNames || [])[0] || '';
  const handing = hostNames !== undefined && (hostNames || []).join(',').toLowerCase() !== (slot.hostNames || []).join(',').toLowerCase();
  if ((confirm || (waiting && handing)) && superuserNames([host], staff).length && !mine([host])) {
    throw forbidden(`Only ${host} can ${confirm ? 'confirm this booking' : 'hand this booking on'}. They see it when they sign in.`);
  }
}

/** The host takes the booking (the route checks it is them: assertMayChange). */
export function confirmHost(state, id, now) {
  const slot = findSlot(state, id);
  if (!slot) throw clientError(404, 'Slot not found');
  if (!isBookedRecording(slot) || !(slot.hostNames || []).length) throw clientError(400, 'Only a booked session with a host can be confirmed');
  slot.hostConfirmedAt = iso(now);
  return slot;
}

/**
 * Overridden availability whose staff have not been told yet and whose booking
 * is published: marks them told and returns who to email. Staff who run the
 * booking themselves (they handed it over or took it) are not emailed.
 */
// Staff are named on sessions; their email is their super-user entry (by name) or the name itself if it is an email.
function staffEmailResolver(state, env) {
  const staff = listSuperusers(state, env);
  return (name) => {
    const typed = normalizeEmail(name);
    if (EMAIL_SHAPE.test(typed)) return typed;
    return staff.find((entry) => entry.name && entry.name.trim().toLowerCase() === String(name).trim().toLowerCase())?.email || '';
  };
}

/** Availability given back after its staff were told it was taken: who to email now ("free again"). Clears them. */
export function freeAgainNotices(state, env = process.env, now = Date.now()) {
  const emailOf = staffEmailResolver(state, env);
  const notices = [];
  for (const slot of liveSlots(state)) {
    const by = slot.freeAgain;
    if (!by) continue;
    slot.freeAgain = null;
    if (ms(slot.end) <= now || slot.overriddenBy) continue;
    for (const name of slot.hostNames || []) {
      if (sameHost(by.hostNames || [], name)) continue;
      const email = emailOf(name);
      if (email) notices.push({ email, name, slot: { ...slot }, by: { ...by } });
    }
  }
  return notices;
}

export function overrideNotices(state, env = process.env, now = Date.now()) {
  const emailOf = staffEmailResolver(state, env);
  const notices = [];
  for (const slot of liveSlots(state)) {
    const by = slot.overriddenBy;
    if (!by || by.notifiedAt || ms(slot.end) <= now) continue;
    const booking = findSlot(state, by.slotId);
    if (!booking || booking.status !== 'published') continue;
    by.notifiedAt = iso(now);
    for (const name of slot.hostNames || []) {
      if (sameHost(booking.hostNames || [], name)) continue;
      const email = emailOf(name);
      if (email) notices.push({ email, name, slot: { ...slot }, by: { ...by } });
    }
  }
  return notices;
}

// Test slots always need a person. A recording session may be left free (no
// person yet); an email that is given must look like an email.
function checkAssignee(slotType, assigneeEmail) {
  const typed = String(assigneeEmail ?? '').trim();
  if (slotType === 'test') {
    if (!normalizeEmail(typed)) throw clientError(400, 'Choose who this test slot is for');
    return;
  }
  if (typed && !EMAIL_SHAPE.test(typed)) throw clientError(400, 'That email does not look right');
}

export function addSlot(state, {
  id, kind = 'test', start, end, assigneeEmail = '', assigneeName = '', hostName = '', hostNames, actor, now, staff,
}) {
  const slotType = kind === 'recording' ? 'recording' : 'test';
  const times = validateTimes(start, end, now);
  checkAssignee(slotType, assigneeEmail);
  assertNoClash(state, times, '', slotType, assigneeEmail);
  const hosts = hostFields(hostNames, hostName);
  if (slotType === 'recording') {
    hosts.hostNames = superuserHosts(hosts.hostNames, staff);
    // A booking with nobody named goes to whoever free then marked the time first.
    if (normalizeEmail(assigneeEmail) && !hosts.hostNames.length) {
      hosts.hostNames = staffFreeFor(state, times).filter((name) => {
        try { superuserHosts([name], staff); return true; } catch { return false; }
      }).slice(0, 1);
    }
    hosts.hostName = hosts.hostNames.join(', ');
  }
  const slot = {
    id,
    kind: slotType,
    ...times,
    status: 'draft',
    assigneeEmail: normalizeEmail(assigneeEmail),
    assigneeName: cleanText(assigneeName, 80),
    // Who runs it (the super user account is shared, so the login does not say).
    ...hosts,
    createdBy: normalizeEmail(actor),
    createdAt: iso(now),
    updatedAt: iso(now),
    // What the assignee was last told (person + time), so Publish emails only real changes.
    notified: null,
    preloadedAt: null,
    reminderSentAt: null,
    overriddenBy: null,
    hostConfirmedAt: null,
  };
  state.slots.push(slot);
  if (slotType === 'recording') {
    applyOverrides(state, slot, now);
    adoptHostlessBookings(state, slot, now, staff);
    overrideFreeSlot(state, slot, now, true); // free time added over a booking shows taken at once
  }
  return slot;
}

export function editSlot(state, id, { start, end, assigneeEmail, assigneeName, hostName, hostNames }, now, staff) {
  const slot = findSlot(state, id);
  if (!slot) throw clientError(404, 'Slot not found');
  const times = validateTimes(start ?? slot.start, end ?? slot.end, now);
  if (assigneeEmail !== undefined) {
    if (slotKind(slot) === 'test' && !normalizeEmail(assigneeEmail)) throw clientError(400, 'A slot needs a person');
    checkAssignee(slotKind(slot), assigneeEmail);
  }
  // Overridden availability belongs to an earlier booking: it cannot be booked.
  if (slot.overriddenBy && normalizeEmail(assigneeEmail ?? '')) {
    const by = slot.overriddenBy;
    const error = clientError(409, `This time was taken: ${by.assigneeName || 'a lecturer'} is booked then`
      + `${by.hostNames?.length ? ` with ${by.hostNames.join(', ')}` : ''}. Pick another time.`);
    error.code = 'SLOT_TAKEN';
    throw error;
  }
  assertNoClash(state, times, id, slotKind(slot), assigneeEmail ?? slot.assigneeEmail);
  const hosts = hostNames !== undefined || hostName !== undefined ? hostFields(hostNames, hostName) : null;
  if (hosts && slotKind(slot) === 'recording') {
    hosts.hostNames = superuserHosts(hosts.hostNames, staff, slot.hostNames || []);
    hosts.hostName = hosts.hostNames.join(', ');
  }
  // The host confirmed this booking as it was: a new host, lecturer or time needs confirming again.
  const changed = (hosts && hosts.hostName.toLowerCase() !== (slot.hostNames || []).join(', ').toLowerCase())
    || (assigneeEmail !== undefined && normalizeEmail(assigneeEmail) !== slot.assigneeEmail)
    || times.start !== slot.start || times.end !== slot.end;
  Object.assign(slot, times, {
    ...(assigneeEmail !== undefined ? { assigneeEmail: normalizeEmail(assigneeEmail) } : {}),
    ...(assigneeName !== undefined ? { assigneeName: cleanText(assigneeName, 80) } : {}),
    ...(hosts || {}),
    ...(changed ? { hostConfirmedAt: null } : {}),
    updatedAt: iso(now),
    preloadedAt: null,
    reminderSentAt: null,
    // A new time or person warms a fresh GPU; any GPU already warming for the
    // old booking is released by the caller (gpuToRelease).
    warm: null,
    gpuReleasedAt: null,
  });
  // A booking still nobody runs: whoever free then marked the time first takes it.
  if (slotKind(slot) === 'recording' && slot.assigneeEmail && !(slot.hostNames || []).length) {
    const host = staffFreeFor(state, slot, slot.id).filter((name) => {
      try { superuserHosts([name], staff); return true; } catch { return false; }
    })[0];
    if (host) Object.assign(slot, { hostNames: [host], hostName: host, hostConfirmedAt: null });
  }
  // An edited published slot goes back to draft until it is published again,
  // so lecturers never see a half-edited schedule.
  if (slot.status === 'published') slot.status = 'draft';
  if (slotKind(slot) === 'recording') {
    // Moved free time: still overridden only while the booking that took it overlaps it.
    const by = slot.overriddenBy ? findSlot(state, slot.overriddenBy.slotId) : null;
    if (slot.overriddenBy && !(by && takes(by, slot))) slot.overriddenBy = null;
    applyOverrides(state, slot, now);
    adoptHostlessBookings(state, slot, now, staff);
    overrideFreeSlot(state, slot, now, true);
  }
  return slot;
}

/**
 * After a test slot is edited or deleted: the email whose GPU was already
 * started for it and must be given back now, or '' (never warmed, already
 * released, or that person still has another slot holding their GPU).
 */
export function gpuToRelease(state, before, now) {
  if (!before || slotKind(before) !== 'test' || !before.warm || before.gpuReleasedAt || !before.assigneeEmail) return '';
  const stillHeld = gpuHolds(state, now).some((hold) => sameNtuPerson(hold.slot.assigneeEmail, before.assigneeEmail));
  return stillHeld ? '' : normalizeEmail(before.assigneeEmail);
}

export function removeSlot(state, id) {
  const slot = findSlot(state, id);
  if (!slot) throw clientError(404, 'Slot not found');
  const told = slot.notified;
  slot.status = 'cancelled';
  // A deleted booking gives back the availability it overrode.
  if (slotKind(slot) === 'recording') applyOverrides(state, slot, Date.now());
  return { slot, notify: told?.assigneeEmail ? told : null };
}

/**
 * Publishes every draft. Returns who must be emailed: people newly given a
 * slot or whose time changed, and people who lost a slot they had been told about.
 */
export function publishSlots(state, now, onlyId = '') {
  const toNotify = [];
  // A booking waits for its host to confirm (or hand it on) before it goes out.
  for (const slot of state.slots.filter((item) => item.status === 'draft' && !awaitsHost(state, item) && (!onlyId || item.id === onlyId))) {
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
  // Owner 2026-11-23: anyone who has not sent their recordings yet may record
  // on their own, session or not (a booked session is still shown to them).
  // Owner 2026-11-24: the recording page is a one-time thing. Once a set was
  // ever sent (even one later withdrawn), only a new session the team books
  // opens it again.
  if (!everSubmittedVoice(state, email)) return { allowed: true, reason: 'open', slot: next };
  return { allowed: false, reason: next ? 'too-early' : 'submitted', slot: next };
}

/** Uploads to a set created in a session may finish shortly after it; sets made outside one stay open. */
export function uploadWindowOpen(state, job, { now, superuser }) {
  if (superuser || !job.recordingSlotId) return true;
  const slot = state.slots.find((item) => item.id === job.recordingSlotId);
  if (!slot) return true;
  return now < ms(slot.end) + RECORDING_GRACE_MINUTES * MINUTE;
}

/**
 * One recording session per person: once their recordings are submitted
 * (anything but an unsent or withdrawn set), they cannot book another. A set
 * sent back for new recordings is withdrawn, so that person may book again.
 */
/** Sent a set at least once (withdrawn ones count): the recording page has been used. */
export function everSubmittedVoice(state, email) {
  return state.jobs.some((job) => sameNtuPerson(job.ownerEmail, email) && job.queuedAt);
}

export function hasSubmittedVoice(state, email) {
  return state.jobs.some((job) => sameNtuPerson(job.ownerEmail, email) && !['uploading', 'cancelled'].includes(job.status));
}

// Emails before a booked session. Recording: the day before, then on the
// morning of the day. Test slot: on the morning of the day (the GPU "starts soon"
// email at warm-up is separate, see slotsToRemind).
const SGT_OFFSET_MS = 8 * 60 * MINUTE;
function sgtMorningOf(startMs, hour = 7) {
  const dayStart = Math.floor((startMs + SGT_OFFSET_MS) / (24 * 60 * MINUTE)) * 24 * 60 * MINUTE - SGT_OFFSET_MS;
  return dayStart + hour * 60 * MINUTE;
}
export const SESSION_REMINDERS = Object.freeze({
  // The day before, then on the morning of the day itself.
  recording: [
    { kind: 'day', from: (start) => start - 24 * 60 * MINUTE, until: (start) => Math.min(start, sgtMorningOf(start)) },
    { kind: 'today', from: (start) => sgtMorningOf(start), until: (start) => start },
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

/** Whether this person has finished testing (sent their feedback) for a voice. */
export function testingClosed(state, email, voiceName) {
  return state.jobs.some((job) => sameNtuPerson(job.ownerEmail, email) && job.approvedExpName === voiceName && job.testingClosedAt);
}

/**
 * Whether this person may load and speak with this voice right now.
 * Super users review any voice at any time, on their own GPU. A lecturer uses
 * only their own approved voices, on a GPU of their own: warmed for their test
 * slot, or started on demand (cold start) outside it — until they send their
 * feedback, which closes testing.
 */
export function voiceAccess(state, { email, voiceName, now, superuser }) {
  const ownApproved = approvedVoicesOf(state, email).includes(voiceName);
  const active = slotsHoldingGpu(state.slots, now).find((slot) => sameNtuPerson(slot.assigneeEmail, email)) || null;
  if (superuser) return { allowed: true, reason: 'superuser', slot: active };
  if (!ownApproved) return { allowed: false, reason: 'not-approved' };
  if (testingClosed(state, email, voiceName)) return { allowed: false, reason: 'tested' };
  if (active) return { allowed: true, reason: 'in-slot', slot: active };
  return { allowed: true, reason: 'on-demand', slot: upcomingSlotFor(state, email, now, 'test') };
}

/** Voices this person may see in the testing portal at all. */
export function visibleVoices(state, { email, superuser }) {
  const own = approvedVoicesOf(state, email);
  if (!superuser) return own;
  const trained = studioTrainedVoices(state).map((voice) => voice.expName);
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
 * A test slot can only be booked for someone whose voice has passed QC:
 * without an approved voice there is nothing to warm on their GPU.
 */
export function assertVoiceApproved(state, email) {
  if (!normalizeEmail(email) || preloadVoiceFor(state, { assigneeEmail: email })) return;
  const error = clientError(400, `${normalizeEmail(email)} has no approved voice yet. Approve their voice first, then assign a test slot.`);
  error.code = 'VOICE_NOT_APPROVED';
  throw error;
}

/**
 * Test slots holding a GPU now, one entry per person (each has a GPU of their
 * own): from SLOT_WARMUP_MINUTES before a slot to its end, nothing between
 * slots (owner 2026-11-23: every slot warms its own GPU, so a GPU is never kept
 * on for a later one). phase: 'warmup' | 'slot'.
 */
export function gpuHolds(state, now) {
  const byPerson = new Map();
  for (const slot of state.slots.filter(slotHoldsGpu)) {
    const key = normalizeEmail(slot.assigneeEmail);
    byPerson.set(key, [...(byPerson.get(key) || []), slot]);
  }
  const holds = [];
  for (const slots of byPerson.values()) {
    slots.sort((a, b) => ms(a.start) - ms(b.start));
    for (let index = 0; index < slots.length; index += 1) {
      const slot = slots[index];
      const from = ms(slot.start) - SLOT_WARMUP_MINUTES * MINUTE;
      const end = slotEnd(slot);
      if (from <= now && now < end) {
        holds.push({ slot, phase: now < ms(slot.start) ? 'warmup' : 'slot' });
        break;
      }
    }
  }
  return holds;
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

/**
 * Ended test slots whose GPU warm-up ran and has not been released yet: released
 * at once, unless that person's next slot is already warming (a gap under 20 min).
 */
export function slotsToRelease(state, now) {
  const held = gpuHolds(state, now).map((hold) => normalizeEmail(hold.slot.assigneeEmail));
  return state.slots.filter((slot) => slotHoldsGpu(slot) && slot.warm && !slot.gpuReleasedAt && slotEnd(slot) <= now
    && !held.includes(normalizeEmail(slot.assigneeEmail)));
}

// Super users testing keeps the fixed GPU (the live chat service) on until this
// long after their last use; a test slot keeps it on regardless (gpuHold).
export const SUPERUSER_TEST_IDLE_MINUTES = 30;

/** The fixed GPU must stay on (and be started) while any of this is true. */
export function gpuDemand(state, now) {
  if (state.jobs.some((job) => real(job) && (job.status === 'training' || job.status === 'queued'))) return 'training';
  if (gpuHolds(state, now).length > 0) return 'slot';
  // Anyone testing a voice on this site (super user or lecturer: chat, reading)
  // keeps the fixed GPU, which also serves live chat, on for 30 min after.
  const lastTest = Math.max(ms(state.lastSuperuserTestAt) || 0, ms(state.lastLecturerTestAt) || 0);
  if (now - lastTest < SUPERUSER_TEST_IDLE_MINUTES * MINUTE) return 'testing';
  return '';
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
    // Set when a super user uploaded it for someone: who it is for.
    ...(job.submittedBy ? { forEmail: job.ownerEmail, forName: job.ownerName || '' } : {}),
    status: lecturerStatus(job.status),
    attempt: job.attempt,
    files: job.files,
    totalBytes: job.totalBytes,
    createdAt: job.createdAt,
    queuedAt: job.queuedAt,
    // The recording session it was made in (a new session the team books opens recording again).
    recordingSlotId: job.recordingSlotId || null,
    voiceName: ['approved', 'scheduled'].includes(job.status) ? job.approvedExpName : '',
    testingClosedAt: job.testingClosedAt || null,
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
