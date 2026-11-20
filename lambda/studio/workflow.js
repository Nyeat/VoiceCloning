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

// A slot holds the GPU only once it is published AND someone is assigned to it.
// Drafts and open (unclaimed) slots never block training or super users.
export function slotHoldsGpu(slot) {
  return slot.status === 'published' && Boolean(slot.assigneeEmail);
}

function activeSlotAt(slots, time) {
  return slots.find((slot) => slotHoldsGpu(slot) && ms(slot.start) <= time && time < ms(slot.end)) || null;
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

function assertNoClash(state, candidate, ignoreId = '') {
  const clash = liveSlots(state).find((slot) => slot.id !== ignoreId && slotsOverlap(slot, candidate));
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

export function addSlot(state, { id, start, end, assigneeEmail = '', assigneeName = '', actor, now }) {
  const times = validateTimes(start, end, now);
  assertNoClash(state, times);
  const slot = {
    id,
    ...times,
    status: 'draft',
    assigneeEmail: normalizeEmail(assigneeEmail),
    assigneeName: cleanText(assigneeName, 80),
    createdBy: normalizeEmail(actor),
    updatedAt: iso(now),
    // What the assignee was last told (person + time), so Publish emails only real changes.
    notified: null,
    preloadedAt: null,
  };
  state.slots.push(slot);
  return slot;
}

export function editSlot(state, id, { start, end, assigneeEmail, assigneeName }, now) {
  const slot = findSlot(state, id);
  if (!slot) throw clientError(404, 'Slot not found');
  const times = validateTimes(start ?? slot.start, end ?? slot.end, now);
  assertNoClash(state, times, id);
  Object.assign(slot, times, {
    ...(assigneeEmail !== undefined ? { assigneeEmail: normalizeEmail(assigneeEmail) } : {}),
    ...(assigneeName !== undefined ? { assigneeName: cleanText(assigneeName, 80) } : {}),
    updatedAt: iso(now),
    preloadedAt: null,
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
    if (before && !samePerson) {
      toNotify.push({ kind: 'slotCancelled', email: before.assigneeEmail, slot: { ...slot, ...before } });
    }
    if (after && (!samePerson || before.start !== after.start || before.end !== after.end)) {
      toNotify.push({ kind: 'slotBooked', email: after.assigneeEmail, slot: { ...slot }, moved: Boolean(samePerson) });
    }
    slot.notified = after;
  }
  return toNotify;
}

/** A lecturer picks an open published slot (one upcoming slot each). */
export function claimSlot(state, id, { email, name = '', now }) {
  const slot = findSlot(state, id);
  if (!slot || slot.status !== 'published') throw clientError(404, 'That slot is not available');
  if (slot.assigneeEmail) throw clientError(409, 'Someone has just taken that slot — pick another');
  if (ms(slot.end) <= now) throw clientError(409, 'That slot has already ended');
  if (!state.jobs.some((job) => sameNtuPerson(job.ownerEmail, email) && !['uploading', 'cancelled'].includes(job.status))) {
    throw clientError(409, 'Submit your recordings first, then pick a time');
  }
  const mine = liveSlots(state).find((item) => sameNtuPerson(item.assigneeEmail, email) && ms(item.end) > now);
  if (mine) throw clientError(409, 'You already have an upcoming slot. Release it first to pick another.');
  slot.assigneeEmail = normalizeEmail(email);
  slot.assigneeName = cleanText(name, 80);
  slot.claimedAt = iso(now);
  slot.notified = { assigneeEmail: slot.assigneeEmail, start: slot.start, end: slot.end };
  return slot;
}

export function releaseSlot(state, id, { email, now }) {
  const slot = findSlot(state, id);
  if (!slot || !sameNtuPerson(slot.assigneeEmail, email)) throw clientError(404, 'That is not your slot');
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

export function upcomingSlotFor(state, email, now) {
  return liveSlots(state)
    .filter((slot) => slot.status === 'published' && sameNtuPerson(slot.assigneeEmail, email) && ms(slot.end) > now)
    .sort((a, b) => ms(a.start) - ms(b.start))[0] || null;
}

function approvedVoicesOf(state, email) {
  return state.jobs
    .filter((job) => sameNtuPerson(job.ownerEmail, email) && ['approved', 'scheduled'].includes(job.status) && job.approvedExpName)
    .map((job) => job.approvedExpName);
}

/**
 * Whether this person may load and speak with this voice right now.
 * Super users review any voice, but never inside a lecturer's slot (the GPU is theirs).
 * A lecturer uses only their own approved voices, only inside their own slot.
 */
export function voiceAccess(state, { email, voiceName, now, superuser }) {
  const active = activeSlotAt(state.slots, now);
  const ownApproved = approvedVoicesOf(state, email).includes(voiceName);
  if (active && sameNtuPerson(active.assigneeEmail, email) && ownApproved) {
    return { allowed: true, reason: 'in-slot', slot: active };
  }
  if (superuser) {
    if (active) return { allowed: false, reason: 'slot-in-use', slot: active };
    return { allowed: true, reason: 'superuser', slot: null };
  }
  if (!ownApproved) return { allowed: false, reason: 'not-approved' };
  const slot = upcomingSlotFor(state, email, now);
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

/** Published, assigned slots inside the warm-up window (or running) whose voice is not loaded yet. */
export function slotsToPreload(state, now) {
  return state.slots.filter((slot) => slotHoldsGpu(slot)
    && !slot.preloadedAt
    && ms(slot.start) - SLOT_WARMUP_MINUTES * MINUTE <= now
    && now < ms(slot.end));
}

/** The GPU must stay on (and be started) while any of this is true. */
export function gpuDemand(state, now) {
  if (state.jobs.some((job) => job.status === 'training' || job.status === 'queued')) return 'training';
  const soon = state.slots.find((slot) => slotHoldsGpu(slot)
    && ms(slot.start) - SLOT_WARMUP_MINUTES * MINUTE <= now
    && now < ms(slot.end));
  return soon ? 'slot' : '';
}

/** What a lecturer sees in the slot table: published upcoming slots. */
export function publicSlots(state, email, now) {
  return liveSlots(state)
    .filter((slot) => slot.status === 'published' && ms(slot.end) > now)
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

// "Retraining after review" is shown to the lecturer as plain "queued": the
// quality check is internal, and the email promise covers both.
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
