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
export const SLOT_WARMUP_MINUTES = 15;

const MINUTE = 60_000;

// Worker defaults (gpu-worker/src/services/pipeline.js). Retrains move away
// from these, never back to them, so a second attempt is not a coin re-toss.
export const BASE_TRAINING_CONFIG = Object.freeze({
  sovitsEpochs: 8,
  gptEpochs: 15,
  skipDenoise: false,
  asrModel: 'large-v3',
});

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

export function createJob(state, { id, ownerEmail, ownerName = '', expName, label = '', consent = null, now }) {
  const job = {
    id,
    ownerEmail: normalizeEmail(ownerEmail),
    ownerName: cleanText(ownerName, 80),
    label: cleanText(label, 80) || 'My voice',
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
    trainingConfig: { ...BASE_TRAINING_CONFIG },
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

function activeSlotAt(slots, time) {
  return slots.find((slot) => slot.status !== 'cancelled' && ms(slot.start) <= time && time < ms(slot.end)) || null;
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
  orderQueue(state.jobs).forEach((job, index) => {
    let start = cursor;
    for (let guard = 0; guard < 50; guard += 1) {
      const slot = activeSlotAt(state.slots, start);
      if (!slot) break;
      start = ms(slot.end);
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
  return orderQueue(state.jobs)[0] || null;
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
 * rhythm, and noise is a data problem (force denoising, and stop before the
 * model memorises the hiss). Explicit epoch overrides from the reviewer win.
 */
export function retrainConfig(previous, reasons = [], overrides = {}) {
  const config = { ...BASE_TRAINING_CONFIG, ...previous };
  const has = (reason) => reasons.includes(reason);
  if (has('not-their-voice')) config.sovitsEpochs = Math.min(16, Math.ceil(config.sovitsEpochs * 1.5));
  if (has('mispronounces') || has('robotic')) config.gptEpochs = Math.min(30, Math.ceil(config.gptEpochs * 1.5));
  if (has('noisy')) {
    config.skipDenoise = false;
    config.sovitsEpochs = Math.max(4, config.sovitsEpochs - 2);
  }
  // Nothing specific was named: still move off the previous run.
  if (!reasons.some((reason) => reason !== 'other')) {
    config.sovitsEpochs = Math.min(16, config.sovitsEpochs + 2);
    config.gptEpochs = Math.min(30, config.gptEpochs + 5);
  }
  const sovits = Number(overrides.sovitsEpochs);
  const gpt = Number(overrides.gptEpochs);
  if (Number.isInteger(sovits) && sovits >= 1 && sovits <= 30) config.sovitsEpochs = sovits;
  if (Number.isInteger(gpt) && gpt >= 1 && gpt <= 50) config.gptEpochs = gpt;
  config.skipDenoise = config.skipDenoise === true;
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
  job.status = 'cancelled';
  return job;
}

export function addFeedback(job, { email, rating, comment, now }) {
  const score = Number(rating);
  if (!Number.isInteger(score) || score < 1 || score > 5) throw clientError(400, 'rating must be 1 to 5');
  const text = cleanText(comment, 2000);
  job.feedback.push({ email: normalizeEmail(email), rating: score, comment: text, at: iso(now) });
  return job;
}

// ── Slots ────────────────────────────────────────────────────────────────

export function slotsOverlap(left, right) {
  return ms(left.start) < ms(right.end) && ms(right.start) < ms(left.end);
}

/**
 * Books (or moves) the job's GPU slot. One GPU means one voice at a time, so
 * any overlap with another booking is refused, never resolved silently.
 */
export function bookSlot(state, job, { start, end, bookedBy, slotId, now }) {
  if (!['approved', 'scheduled'].includes(job.status)) {
    throw clientError(409, 'Approve the voice before booking a test slot');
  }
  const startMs = ms(start);
  const endMs = ms(end);
  if (!startMs || !endMs) throw clientError(400, 'start and end must be valid times');
  const minutes = (endMs - startMs) / MINUTE;
  if (minutes < MIN_SLOT_MINUTES) throw clientError(400, `A slot must be at least ${MIN_SLOT_MINUTES} minutes`);
  if (minutes > MAX_SLOT_MINUTES) throw clientError(400, `A slot can be at most ${MAX_SLOT_MINUTES / 60} hours`);
  if (endMs <= now) throw clientError(400, 'The slot must end in the future');

  const candidate = { start: iso(startMs), end: iso(endMs) };
  const existing = state.slots.find((slot) => slot.jobId === job.id && slot.status !== 'cancelled');
  const clash = state.slots.find((slot) => slot.status !== 'cancelled'
    && slot !== existing
    && slotsOverlap(slot, candidate));
  if (clash) {
    const owner = findJob(state, clash.jobId);
    const error = clientError(409, `That time clashes with ${owner?.ownerName || owner?.ownerEmail || 'another booking'} `
      + `(${clash.start} – ${clash.end}). The GPU can serve one voice at a time.`);
    error.code = 'SLOT_CLASH';
    error.clash = { start: clash.start, end: clash.end, jobId: clash.jobId };
    throw error;
  }

  const slot = existing || { id: slotId, jobId: job.id, status: 'booked' };
  Object.assign(slot, candidate, {
    voiceName: job.approvedExpName || job.expName,
    ownerEmail: job.ownerEmail,
    bookedBy: normalizeEmail(bookedBy),
    bookedAt: iso(now),
    reminderSentAt: null,
  });
  if (!existing) state.slots.push(slot);
  job.status = 'scheduled';
  job.slotId = slot.id;
  return { slot, moved: Boolean(existing) };
}

export function cancelSlot(state, job) {
  const slot = state.slots.find((item) => item.jobId === job.id && item.status !== 'cancelled');
  if (!slot) throw clientError(404, 'This voice has no booked slot');
  slot.status = 'cancelled';
  job.status = 'approved';
  job.slotId = null;
  return slot;
}

export function currentSlot(state, now) {
  return activeSlotAt(state.slots, now);
}

/**
 * Whether this person may load and speak with this voice right now.
 * Super users review any voice, but not inside another lecturer's booked hour.
 * A lecturer uses only their own approved voice, only inside their slot.
 */
export function voiceAccess(state, { email, voiceName, now, superuser }) {
  const active = activeSlotAt(state.slots, now);
  if (superuser) {
    if (active && active.voiceName !== voiceName) {
      return { allowed: false, reason: 'slot-in-use', slot: active };
    }
    return { allowed: true, reason: 'superuser', slot: active };
  }
  const own = state.jobs.find((job) => sameNtuPerson(job.ownerEmail, email)
    && (job.approvedExpName || '') === voiceName
    && job.status === 'scheduled');
  if (!own) return { allowed: false, reason: 'not-approved' };
  const slot = state.slots.find((item) => item.jobId === own.id && item.status !== 'cancelled');
  if (!slot) return { allowed: false, reason: 'no-slot' };
  if (now < ms(slot.start)) return { allowed: false, reason: 'too-early', slot };
  if (now >= ms(slot.end)) return { allowed: false, reason: 'slot-ended', slot };
  return { allowed: true, reason: 'in-slot', slot };
}

/** Voices this person may see in the testing portal at all. */
export function visibleVoices(state, { email, superuser }) {
  if (superuser) {
    return state.jobs
      .filter((job) => ['review', 'approved', 'scheduled', 'failed'].includes(job.status) || job.attempts.length > 0)
      .flatMap((job) => job.attempts.filter((attempt) => attempt.result === 'trained').map((attempt) => attempt.expName));
  }
  return state.jobs
    .filter((job) => sameNtuPerson(job.ownerEmail, email) && job.status === 'scheduled' && job.approvedExpName)
    .map((job) => job.approvedExpName);
}

/** The GPU must stay on (and be started) while any of this is true. */
export function gpuDemand(state, now) {
  if (state.jobs.some((job) => job.status === 'training' || job.status === 'queued')) return 'training';
  const soon = state.slots.find((slot) => slot.status !== 'cancelled'
    && ms(slot.start) - SLOT_WARMUP_MINUTES * MINUTE <= now
    && now < ms(slot.end));
  return soon ? 'slot' : '';
}

// ── Views ────────────────────────────────────────────────────────────────

export function publicJob(job, estimate = null) {
  const { notifications: _notifications, sessionId: _sessionId, ...rest } = job;
  return { ...rest, ...(estimate ? { estimate } : {}) };
}

export function lecturerJob(job, estimate, state) {
  const slot = state.slots.find((item) => item.jobId === job.id && item.status !== 'cancelled') || null;
  // Lecturers see their status and slot, not reviewers' internal notes.
  return {
    id: job.id,
    label: job.label,
    status: lecturerStatus(job.status),
    attempt: job.attempt,
    files: job.files,
    totalBytes: job.totalBytes,
    createdAt: job.createdAt,
    queuedAt: job.queuedAt,
    voiceName: job.status === 'scheduled' ? job.approvedExpName : '',
    estimate: estimate || null,
    slot: slot ? { start: slot.start, end: slot.end } : null,
    feedback: job.feedback.filter((entry) => sameNtuPerson(entry.email, job.ownerEmail)),
  };
}

// "Retraining after review" is shown to the lecturer as plain "queued": the
// quality check is internal, and the email promise covers both.
function lecturerStatus(status) {
  if (status === 'review' || status === 'approved') return 'quality-check';
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
