// Voice Studio API (/api/studio/*): the recording portal (lecturers upload or
// record audio, which queues training) and the studio portal (super users
// review, book GPU slots and manage super users; lecturers test their approved
// voice inside their slot, tune its pronunciation and leave feedback).
//
// Who you are comes only from the verified Microsoft token; a super user is
// someone on the stored list or in STUDIO_SUPERUSERS. Everything else is a
// lecturer, who only ever sees their own jobs and voices.
import { randomUUID } from 'crypto';
import path from 'path';
import { ok, err, preflight, parseJsonBody } from '../shared/cors.js';
import { createLiveAuthGuard } from '../shared/liveAuth.js';
import { generatePresignedPutUrl, headObject, getObject, uploadBuffer } from '../shared/s3.js';
import { sanitizeFilename } from '../shared/paths.js';
import { describeVoiceIdentity, nextVoiceName, normalizeEmail } from '../shared/voiceIdentity.js';
import { gpuGet, gpuPost, inferencePost } from '../shared/gpuWorker.js';
import { listTrainedVoiceNames, bestModelsForVoice } from '../shared/trainedVoices.js';
import * as wf from './workflow.js';
import { createS3StateStore, updateState } from './store.js';
import {
  ACCOUNTS_KEY, findAccount, normalizeAccounts, requiresMicrosoft,
} from './accounts.js';
import { createGoogleVerifier } from './googleToken.js';
import { signStudioSession, STUDIO_SESSION_DAYS } from '../shared/studioSession.js';
import { createMailer, emailConfigured, templates } from './mailer.js';
import { validatePronunciation, voiceDictionaryKey } from './pronunciation.js';

// Voice Studio accepts any Microsoft account, so outside addresses get x- voice names.
const STUDIO_IDENTITY = Object.freeze({ allowExternal: true });
const AUDIO_EXTS = new Set(['.wav', '.mp3', '.ogg', '.flac', '.m4a']);
const MAX_FILES = 100;
const TICK_INTERVAL_MS = 45_000;
// A run the worker no longer reports is declared lost only after this long, so
// a worker restart mid-dispatch is not mistaken for a failure.
const LOST_RUN_GRACE_MS = 5 * 60_000;

const BUSY_WORKER_STATUSES = new Set(['waiting', 'running', 'queued', 'waiting-for-client']);

function workerBusy(state) {
  if (!state || typeof state !== 'object') return false;
  if (Number(state.queueDepth) > 0) return true;
  return BUSY_WORKER_STATUSES.has(String(state.status || '').toLowerCase());
}

async function defaultStartGpu() {
  const { startGpuInstance } = await import('../instance/index.js');
  return startGpuInstance();
}

// Gets a lecturer's voice ready for their test slot on a GPU of their own
// (ownerKey: studioPersonOwner), and keeps asking for it through the slot (each
// ask counts as use, so the GPU is never idled out or switched under them).
// Returns the coordinator's answer (state, canStartConversation, …).
async function defaultPreloadVoice(voiceName, ownerKey, ownerEmail = '') {
  const [{ createVoiceProfileResolver }, { prepareCoordinatedModel }, { buildVoiceProfileId }, { ensureVoiceProfileRecord }] = await Promise.all([
    import('../shared/voiceProfileRuntime.js'),
    import('../shared/modelCoordinator.js'),
    import('../shared/voiceIdentity.js'),
    import('../voice-profile/index.js'),
  ]);
  // A voice nobody has opened yet has no saved record; the warm-up would fail
  // with "Voice profile … not found" every tick (2026-11-23). Create it first.
  const ensured = await ensureVoiceProfileRecord(voiceName, { ownerEmail });
  if (ensured.error) throw new Error(ensured.error);
  const body = await createVoiceProfileResolver()({ voiceProfileId: buildVoiceProfileId(voiceName), text: 'Voice Studio slot warm-up.' });
  return prepareCoordinatedModel(body, { allowScale: true, source: 'models-select', ownerKey });
}

// A person's GPU once they are done (slot over with none within the hour, or
// feedback sent): released so it shuts down now rather than after the idle timer.
async function defaultReleaseSlotGpu(ownerKey) {
  const { releaseCoordinatedOwner } = await import('../shared/modelCoordinator.js');
  return releaseCoordinatedOwner(ownerKey);
}

async function personOwner(email) {
  const { studioPersonOwner } = await import('../shared/modelCoordinator.js');
  return studioPersonOwner(email);
}

async function readJsonObject(key) {
  if (!(await headObject(key))) return null;
  return JSON.parse((await getObject(key)).toString('utf-8'));
}

export function createStudioService({
  store = createS3StateStore(),
  accountStore = createS3StateStore({ key: ACCOUNTS_KEY, normalize: normalizeAccounts }),
  mailer = createMailer(),
  env = process.env,
  clock = () => Date.now(),
  newId = () => randomUUID(),
  listVoices = () => listTrainedVoiceNames(),
  modelsFor = (name) => bestModelsForVoice(name),
  readWorker = () => gpuGet('/train/current'),
  startTraining = (body) => gpuPost('/train', body),
  startGpu = defaultStartGpu,
  presign = (key, type) => generatePresignedPutUrl(key, type),
  head = (key) => headObject(key),
  readJson = readJsonObject,
  writeJson = (key, value) => uploadBuffer(key, Buffer.from(JSON.stringify(value, null, 2)), 'application/json'),
  applyPronunciation = (voiceName) => inferencePost('/inference/start', { pronunciationVoice: voiceName }),
  preloadVoice = defaultPreloadVoice,
  releaseSlotGpu = defaultReleaseSlotGpu,
} = {}) {
  async function takenVoiceNames(state) {
    const trained = await listVoices();
    const studio = state.jobs.flatMap((job) => [job.expName, job.sourceExpName, ...job.attempts.map((a) => a.expName)]);
    return [...new Set([...trained, ...studio].filter(Boolean))];
  }

  async function notify(jobId, kind, to, message) {
    const result = await mailer.send(to, message);
    try {
      await updateState(store, (state) => {
        const job = jobId ? wf.findJob(state, jobId) : null;
        if (!job) return { skipWrite: true };
        job.notifications.push({ kind, to: [].concat(to), status: result.status, error: result.error || '', at: new Date(clock()).toISOString() });
        job.notifications = job.notifications.slice(-30);
        return null;
      });
    } catch (error) {
      console.warn('[studio] could not record notification', error.message);
    }
    return result;
  }

  function superuserEmails(state) {
    return wf.listSuperusers(state, env).map((entry) => entry.email);
  }

  /**
   * Moves the training queue forward. Safe to call from any request and from
   * the scheduled idle check: every transition is claimed with a conditional
   * write, and the worker call happens only after the claim is saved.
   */
  async function tick({ force = false } = {}) {
    const now = clock();
    const { state: snapshot } = await store.read();
    if (!force && now - (snapshot.lastTickAt || 0) < TICK_INTERVAL_MS) {
      return { skipped: true, demand: wf.gpuDemand(snapshot, now) };
    }

    let worker = null;
    try {
      worker = await readWorker();
    } catch {
      worker = null;
    }

    const running = snapshot.jobs.find((job) => job.status === 'training');
    let finishedOk = null;
    if (running) {
      const mine = worker && worker.expName === running.expName;
      const status = String(worker?.status || '').toLowerCase();
      if (mine && status === 'complete') finishedOk = Boolean(await modelsFor(running.expName));
      else if (mine && ['error', 'stopped'].includes(status)) finishedOk = false;
      else if (worker && !mine && now - Date.parse(running.startedAt || 0) > LOST_RUN_GRACE_MS) {
        finishedOk = Boolean(await modelsFor(running.expName));
      }
    }

    const events = [];
    const { state } = await updateState(store, (draft) => {
      draft.lastTickAt = now;
      events.length = 0;
      const job = running ? wf.findJob(draft, running.id) : null;
      if (job && job.status === 'training' && finishedOk !== null) {
        const error = finishedOk ? '' : (worker?.expName === job.expName && worker?.error) || 'The training run was lost or produced no model';
        wf.markTrainingFinished(draft, job, { ok: finishedOk, error, now });
        events.push({ kind: finishedOk ? 'readyForReview' : 'trainingFailed', jobId: job.id });
      }
      return null;
    });

    for (const event of events) {
      const job = wf.findJob(state, event.jobId);
      await notify(job.id, event.kind, superuserEmails(state), templates[event.kind]({ job, env }));
      // The lecturer hears once that their voice moved into quality control
      // (not again for a retrain, and never for fixtures).
      if (event.kind === 'readyForReview' && !job.fixture && !job.notifications.some((entry) => entry.kind === 'inQualityCheck')) {
        await notify(job.id, 'inQualityCheck', job.ownerEmail, templates.inQualityCheck({ job, env }));
      }
    }

    // Dispatch the next job when the GPU is up and its trainer is free.
    const next = wf.nextJobToTrain(state, now);
    let dispatched = null;
    if (next && worker && !workerBusy(worker)) {
      const claim = await updateState(store, (draft) => {
        const job = wf.findJob(draft, next.id);
        if (!job || job.status !== 'queued' || wf.nextJobToTrain(draft, now)?.id !== job.id) return { skipWrite: true };
        wf.markTrainingStarted(job, { sessionId: '', now });
        return { claimed: true };
      });
      if (claim.result?.claimed) {
        const job = wf.findJob(claim.state, next.id);
        try {
          const response = await startTraining({
            expName: job.expName,
            email: job.ownerEmail,
            config: {
              ...job.trainingConfig,
              headless: true,
              notifyOwner: false,
              sourceExpName: job.sourceExpName,
            },
          });
          await updateState(store, (draft) => {
            const current = wf.findJob(draft, job.id);
            if (current) current.sessionId = response?.sessionId || '';
            return null;
          });
          dispatched = job.id;
        } catch (error) {
          // The worker refused (busy with a run from the training site, or
          // restarting): give the slot back and try again on the next tick.
          await updateState(store, (draft) => {
            const current = wf.findJob(draft, job.id);
            if (current?.status === 'training') {
              current.status = 'queued';
              current.startedAt = null;
              current.error = `Waiting for the GPU: ${error.message}`.slice(0, 300);
            }
            return null;
          });
        }
      }
    }

    // "Your test time starts soon" — sent once, as the GPU starts warming for it.
    for (const slot of wf.slotsToRemind(state, now)) {
      const claim = await updateState(store, (draft) => {
        const current = wf.findSlot(draft, slot.id);
        if (!current || current.reminderSentAt) return { skipWrite: true };
        current.reminderSentAt = new Date(now).toISOString();
        return { claimed: true };
      });
      if (claim.result?.claimed) await mailer.send(slot.assigneeEmail, templates.slotReminder({ slot, env }));
    }

    // Session reminders: recording (day before, then shortly before) and the
    // test slot's same-day email. Claimed first so it is sent once.
    for (const { slot, kind, key } of wf.sessionRemindersDue(state, now)) {
      const claim = await updateState(store, (draft) => {
        const current = wf.findSlot(draft, slot.id);
        if (!current || current.reminders?.[kind] === key || wf.reminderKey(current) !== key) return { skipWrite: true };
        current.reminders = { ...(current.reminders || {}), [kind]: key };
        return { claimed: true };
      });
      if (!claim.result?.claimed) continue;
      const message = wf.slotKind(slot) === 'recording'
        ? templates.recordingReminder({ slot, kind, env })
        : templates.testDayReminder({ slot, env });
      await mailer.send(slot.assigneeEmail, message);
    }

    // Each test slot holds a GPU of its person's own from 30 min before it to
    // its end (and across a short gap to their next): ask for their voice on
    // every tick, and keep the warm-up state on the slot for everyone to see.
    // Several people in one slot each get their own GPU, warmed in parallel.
    const preloaded = [];
    const holds = wf.gpuHolds(state, now).filter((hold) => !testingDone(state, hold.slot.assigneeEmail));
    await Promise.all(holds.map(async (hold) => {
      const voiceName = wf.preloadVoiceFor(state, hold.slot);
      if (!voiceName) return;
      let capacity = null;
      try {
        capacity = await preloadVoice(voiceName, await personOwner(hold.slot.assigneeEmail), hold.slot.assigneeEmail);
        preloaded.push(voiceName);
      } catch (error) {
        capacity = { state: 'ERROR', message: error.message };
        console.warn(`[studio] slot warm-up of ${voiceName} failed (retried next tick): ${error.message}`);
      }
      await updateState(store, (draft) => {
        const current = wf.findSlot(draft, hold.slot.id);
        if (!current) return { skipWrite: true };
        current.warm = wf.nextWarmState(current.warm, capacity, now);
        if (current.warm.state === 'READY' && !current.preloadedAt) current.preloadedAt = new Date(now).toISOString();
        return null;
      });
    }));

    // A person's slot is over and none follows soon: give their GPU back (shuts down now).
    const finished = wf.slotsToRelease(state, now);
    for (const email of [...new Set(finished.map((slot) => slot.assigneeEmail))]) {
      try {
        await releaseSlotGpu(await personOwner(email));
        await updateState(store, (draft) => {
          for (const slot of finished.filter((item) => wf.sameNtuPerson(item.assigneeEmail, email))) {
            const current = wf.findSlot(draft, slot.id);
            if (current) current.gpuReleasedAt = new Date(now).toISOString();
          }
          return null;
        });
      } catch (error) {
        console.warn(`[studio] slot GPU release failed (retried next tick): ${error.message}`);
      }
    }

    const demand = wf.gpuDemand(state, now);
    let gpuStart = null;
    if (demand && !worker) {
      try {
        gpuStart = await startGpu();
      } catch (error) {
        gpuStart = { error: error.message };
      }
    }
    return { skipped: false, demand, dispatched, preloaded, workerReachable: Boolean(worker), gpuStart };
  }

  // Sent feedback on every approved voice: no GPU is warmed for them any more.
  function testingDone(state, email) {
    const approved = state.jobs.filter((job) => wf.sameNtuPerson(job.ownerEmail, email) && ['approved', 'scheduled'].includes(job.status));
    return approved.length > 0 && approved.every((job) => job.testingClosedAt);
  }

  // A lecturer finished testing: end their running slot and give their GPU back now.
  async function finishTesting(email) {
    const now = clock();
    await updateState(store, (draft) => {
      const slots = draft.slots.filter((slot) => wf.slotHoldsGpu(slot) && wf.sameNtuPerson(slot.assigneeEmail, email)
        && Date.parse(slot.start) - wf.SLOT_WARMUP_MINUTES * 60_000 <= now && now < wf.slotEnd(slot));
      if (slots.length === 0) return { skipWrite: true };
      for (const slot of slots) slot.completedAt = new Date(now).toISOString();
      return null;
    });
    try {
      await releaseSlotGpu(await personOwner(email));
    } catch (error) {
      console.warn(`[studio] GPU release after feedback failed (it idles off instead): ${error.message}`);
    }
  }

  // Gives one person's test GPU back now.
  async function releasePersonGpu(email) {
    await releaseSlotGpu(await personOwner(email));
  }

  return { store, accountStore, tick, takenVoiceNames, notify, superuserEmails, env, clock, newId, presign, head, readJson, writeJson, applyPronunciation, readWorker, mailer, listVoices, finishTesting, testingDone, releaseSlotGpu: releasePersonGpu };
}

// ── HTTP ─────────────────────────────────────────────────────────────────

const ROUTE = /^\/api\/studio\/(.+?)\/?$/u;

function segmentsOf(routePath) {
  const match = String(routePath || '').match(ROUTE);
  if (!match) return [];
  return match[1].split('/').map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return '';
    }
  });
}

function respondError(error, event) {
  if (error?.statusCode) {
    const response = err(error.statusCode, error.message, event);
    if (error.code) {
      response.body = JSON.stringify({ error: error.message, code: error.code, ...(error.clash ? { clash: error.clash } : {}) });
    }
    return response;
  }
  console.error('[studio]', error);
  return err(500, error?.message || 'Voice Studio error', event);
}

export function createHandler({
  service = createStudioService(),
  authGuard = createLiveAuthGuard({ forceStudio: true }),
  googleVerifier = null,
} = {}) {
  const { store, env, clock, newId } = service;
  const google = googleVerifier || createGoogleVerifier({ clientId: env.STUDIO_GOOGLE_CLIENT_ID || '' });

  async function identify(event) {
    if (!authGuard) throw wf.clientError(503, 'Voice Studio sign-in is not configured');
    let identity;
    try {
      identity = await authGuard.authorize(event);
    } catch {
      throw wf.clientError(401, 'Please sign in with Google');
    }
    if (identity?.synthetic || !identity?.email) throw wf.clientError(403, 'A signed-in account is required');
    // Password sign-in was removed (owner decision 2026-11-23): old password sessions must sign in with Google.
    if (identity.passwordAccount === true) throw wf.clientError(401, 'Please sign in again with Google');
    return { email: String(identity.email).trim().toLowerCase(), passwordAccount: false, via: identity.via === 'google' ? 'google' : 'microsoft' };
  }

  // Email + password addresses are not verified, so they are never super users.
  function superuserOf(state, email, passwordAccount) {
    return (!passwordAccount || wf.passwordSuperuserAllowed(email, env)) && wf.isSuperuser(state, email, env);
  }

  function requireSuperuser(state, email, passwordAccount) {
    if (!superuserOf(state, email, passwordAccount)) throw wf.clientError(403, 'Super users only');
  }

  // "Sign in with Google": the address is verified by Google, so no password.
  async function googleLogin(body) {
    let verified;
    try {
      verified = await google.verify(body.credential);
    } catch (error) {
      throw wf.clientError(error.code === 'misconfigured' ? 503 : 401, error.message || 'Google sign-in failed');
    }
    if (requiresMicrosoft(verified.email, env)) throw wf.clientError(400, 'Please sign in with a Gmail account');
    const { state: accounts } = await service.accountStore.read();
    const name = verified.name || findAccount(accounts, verified.email)?.name || verified.email.split('@')[0];
    return session({ email: verified.email, name, via: 'google' });
  }

  function session({ email, name, via }) {
    const now = clock();
    try {
      return { token: signStudioSession({ email, name, via }, { env, now }), email, name, expiresAt: new Date(now + STUDIO_SESSION_DAYS * 86400_000).toISOString() };
    } catch (error) {
      throw wf.clientError(503, error.message);
    }
  }

  async function releaseGpuOf(personEmail) {
    if (!personEmail) return;
    try {
      await service.releaseSlotGpu(personEmail);
    } catch (error) {
      console.warn(`[studio] GPU release for a changed slot failed (it idles off instead): ${error.message}`);
    }
  }

  function ownJob(state, id, email) {
    const job = wf.findJob(state, id);
    // The person it is for, or the super user who uploaded it on their behalf.
    if (!job || !(wf.sameNtuPerson(job.ownerEmail, email) || (job.submittedBy && wf.sameNtuPerson(job.submittedBy, email)))) {
      throw wf.clientError(404, 'Recording set not found');
    }
    return job;
  }

  // A test slot added, moved or published inside its warm-up window starts
  // warming now, not at the next scheduled check (up to 5 min later). Only
  // then: no extra tick (and its emails) for anything else.
  async function warmNow() {
    try {
      const { state } = await store.read();
      if (!wf.gpuHolds(state, clock()).some((hold) => !hold.slot.warm)) return null;
      return await service.tick({ force: true });
    } catch (error) {
      console.warn('[studio] warm-up tick failed', error.message);
      return null;
    }
  }

  async function maybeTick() {
    try {
      return await service.tick();
    } catch (error) {
      console.warn('[studio] tick failed', error.message);
      return null;
    }
  }

  async function lecturerView(state, email, passwordAccount = false, via = 'google') {
    const now = clock();
    const superuser = superuserOf(state, email, passwordAccount);
    const estimates = new Map(wf.estimateQueue(state, { now, env }).map((entry) => [entry.jobId, entry]));
    const jobs = state.jobs
      .filter((job) => (wf.sameNtuPerson(job.ownerEmail, email) || (job.submittedBy && wf.sameNtuPerson(job.submittedBy, email))) && job.status !== 'cancelled')
      .map((job) => wf.lecturerJob(job, estimates.get(job.id)))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return {
      email,
      role: superuser ? 'superuser' : 'lecturer',
      account: via,
      jobs,
      queueLength: wf.orderQueue(state.jobs.filter((job) => !job.fixture)).length + (state.jobs.some((job) => job.status === 'training' && !job.fixture) ? 1 : 0),
      trainingMinutes: wf.trainingMinutes(state, env),
      voices: wf.visibleVoices(state, { email, superuser: false }).map((voiceName) => ({
        voiceName,
        access: wf.voiceAccess(state, { email, voiceName, now, superuser: false }),
      })),
      // Their recording session (booked for them by the team) and whether recording is open now.
      recording: wf.recordingAccess(state, { email, now, superuser }),
      // Sent a set before but every one was withdrawn: the page says to ask the team.
      withdrawnOnly: !jobs.some((job) => job.queuedAt) && wf.everSubmittedVoice(state, email),
      // GPU test slot (allocated by a super user after QC).
      mySlot: wf.upcomingSlotFor(state, email, now, 'test'),
      // Their last test slot that is over, so the page can say they have tested.
      testedSlot: (() => {
        const slot = wf.lastTestedSlotFor(state, email, now);
        return slot ? { id: slot.id, start: slot.start, end: slot.end, completedAt: slot.completedAt || null } : null;
      })(),
      activeSlot: (() => {
        const active = wf.currentSlot(state, now);
        return active && wf.sameNtuPerson(active.assigneeEmail, email) ? active : null;
      })(),
      now: new Date(now).toISOString(),
    };
  }

  async function adminView(fullState, viewer) {
    const state = wf.viewFor(fullState, viewer, env);
    const now = clock();
    let worker = null;
    try {
      worker = await service.readWorker();
    } catch {
      worker = null;
    }
    const estimates = new Map(wf.estimateQueue(state, { now, gpuRunning: Boolean(worker), env }).map((entry) => [entry.jobId, entry]));
    return {
      jobs: state.jobs
        .filter((job) => job.status !== 'uploading' || now - Date.parse(job.createdAt) < 24 * 3600_000)
        .map((job) => ({ ...wf.publicJob(job, estimates.get(job.id)), testSlot: wf.latestTestSlotFor(state, job.ownerEmail) }))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
      queue: wf.orderQueue(state.jobs).map((job) => job.id),
      slots: state.slots
        // Only what is still to come or running: a session or test slot that is
        // over (or a test the lecturer finished early) is not shown anywhere.
        .filter((slot) => slot.status !== 'cancelled' && wf.slotEnd(slot) > now)
        .sort((a, b) => a.start.localeCompare(b.start)),
      draftCount: state.slots.filter((slot) => slot.status === 'draft' && !wf.awaitsHost(state, slot)).length,
      // Bookings waiting for their host to confirm (Publish leaves them as drafts).
      awaitingHost: state.slots.filter((slot) => wf.awaitsHost(state, slot)).length,
      people: [...new Map(state.jobs.filter((job) => job.status !== 'uploading').map((job) => [job.ownerEmail, {
        email: job.ownerEmail,
        name: job.ownerName,
        approvedVoices: state.jobs.filter((other) => other.ownerEmail === job.ownerEmail && ['approved', 'scheduled'].includes(other.status)).map((other) => other.approvedExpName),
      }])).values()],
      // Test slots holding a GPU now (one per person).
      currentSlots: wf.gpuHolds(state, now).map((hold) => ({ ...hold.slot, phase: hold.phase })),
      superusers: wf.listSuperusers(state, env),
      // Tools > Clean up: every set (old unfinished uploads too) and the log.
      records: wf.cleanupRecords(state, now),
      cleanupLog: [...(state.cleanupLog || [])].reverse().slice(0, 50),
      trainingMinutes: wf.trainingMinutes(state, env),
      maxAttempts: wf.MAX_TRAINING_ATTEMPTS,
      rejectReasons: wf.REJECT_REASONS,
      feedbackIssues: wf.FEEDBACK_ISSUES,
      feedbackLikeness: wf.FEEDBACK_LIKENESS,
      emailConfigured: emailConfigured(env),
      worker: worker
        ? { reachable: true, status: worker.status || 'idle', expName: worker.expName || '', busy: workerBusy(worker) }
        : { reachable: false },
      now: new Date(now).toISOString(),
    };
  }

  async function voiceAccessFor(email, voiceName, passwordAccount = false) {
    const { state } = await store.read();
    const superuser = superuserOf(state, email, passwordAccount);
    const visible = wf.visibleVoices(state, { email, superuser });
    if (!visible.includes(voiceName)) {
      throw wf.clientError(404, 'Voice not found');
    }
    return { state, superuser, access: wf.voiceAccess(state, { email, voiceName, now: clock(), superuser }) };
  }

  // Records that a voice is being tried on this site (at most once a minute)
  // and ticks, so a stopped GPU starts now rather than on the 5-min schedule.
  async function recordTestActivity(field, now) {
    await updateState(store, (state) => {
      if (now - Date.parse(state[field] || 0) < 60_000) return { skipWrite: true };
      state[field] = new Date(now).toISOString();
      return null;
    });
    const result = await service.tick({ force: true }).catch((error) => ({ error: error.message }));
    return { recorded: true, demand: result?.demand || '', gpuStart: result?.gpuStart || null };
  }

  return async function studioHandler(event) {
    const method = event.requestContext?.http?.method || 'GET';
    if (method === 'OPTIONS') return preflight(event);
    const parts = segmentsOf(event.rawPath);
    let body = {};
    if (['POST', 'PUT', 'DELETE'].includes(method)) {
      try {
        body = parseJsonBody(event) || {};
      } catch {
        return err(400, 'Invalid JSON body', event);
      }
    }

    try {
      // "Sign in with Google": the only route without a token.
      if (method === 'POST' && parts.length === 2 && parts[0] === 'auth' && parts[1] === 'google') {
        return ok(await googleLogin(body), {}, event);
      }
      const { email, passwordAccount, via } = await identify(event);
      const now = clock();
      const route = `${method} ${parts.map((part, index) => (index > 0 && part !== 'publish' && ['submissions', 'jobs', 'voices', 'superusers', 'slots'].includes(parts[index - 1]) ? ':id' : part)).join('/')}`;

      // ── Lecturer (and everyone) ──
      if (route === 'GET me') {
        await maybeTick();
        const { state } = await store.read();
        return ok(await lecturerView(state, email, passwordAccount, via), {}, event);
      }

      if (route === 'POST submissions') {
        // A super user may upload on someone's behalf (forEmail): the voice is
        // theirs, so when they sign in they see its status and can test it.
        const forEmail = normalizeEmail(body.forEmail);
        const owner = forEmail || email;
        const identity = describeVoiceIdentity(owner, STUDIO_IDENTITY);
        if (!identity.valid) throw wf.clientError(400, identity.error);
        const { result } = await updateState(store, async (state) => {
          const superuser = superuserOf(state, email, passwordAccount);
          if (forEmail && !superuser) throw wf.clientError(403, 'Only super users can upload for someone else');
          // Super users record their own reference voices and do not sign the lecturer consent.
          if (!superuser && (body.consent?.accepted !== true || !String(body.consent?.version || '').trim())) {
            throw wf.clientError(400, 'Please read and accept the consent form first');
          }
          const access = wf.recordingAccess(state, { email, now, superuser });
          if (!access.allowed) throw wf.clientError(403, 'Recording opens during your booked recording session');
          // One submission per person (same rule as booking): once it is in, what comes next is training.
          if (!superuser && wf.hasSubmittedVoice(state, email)) {
            throw wf.clientError(409, 'Your recordings are already submitted. We email you as your voice moves along.');
          }
          const open = state.jobs.filter((job) => wf.sameNtuPerson(job.ownerEmail, owner) && ['uploading', 'queued'].includes(job.status));
          if (open.length >= 5) throw wf.clientError(429, `${forEmail || 'You'} already ${forEmail ? 'has' : 'have'} 5 recording sets waiting. Please wait for them to train.`);
          const expName = nextVoiceName(owner, await service.takenVoiceNames(state), STUDIO_IDENTITY);
          if (!expName) throw wf.clientError(409, 'Too many voices for this person; remove one first');
          const job = wf.createJob(state, {
            id: newId(), ownerEmail: owner, ownerName: forEmail ? body.forName : body.name, expName, label: body.label,
            consent: superuser ? null : body.consent, trainingConfig: superuser ? body.trainingConfig : null, now,
          });
          if (forEmail) job.submittedBy = normalizeEmail(email);
          job.recordingSlotId = access.slot?.id || '';
          return { job };
        });
        return ok({ job: wf.lecturerJob(result.job, null), jobId: result.job.id }, {}, event);
      }

      if (route === 'POST submissions/:id/presign') {
        const { state } = await store.read();
        const job = ownJob(state, parts[1], email);
        if (job.status !== 'uploading') throw wf.clientError(409, 'This recording set was already submitted');
        if (!wf.uploadWindowOpen(state, job, { now, superuser: superuserOf(state, email, passwordAccount) })) {
          throw wf.clientError(403, 'Your recording session has ended');
        }
        const files = Array.isArray(body.files) ? body.files : [];
        if (files.length === 0) throw wf.clientError(400, 'files array is required');
        if (files.length > MAX_FILES) throw wf.clientError(400, `At most ${MAX_FILES} files per recording set`);
        const uploads = [];
        for (const file of files) {
          const ext = path.extname(String(file?.name || '')).toLowerCase();
          if (!AUDIO_EXTS.has(ext)) throw wf.clientError(400, `"${file?.name}" is not a supported audio file (WAV, MP3, M4A, FLAC or OGG)`);
          const safeName = sanitizeFilename(file.name, 'recording');
          const key = `training/datasets/${job.sourceExpName}/raw/${safeName}`;
          const { url } = await service.presign(key, file.type || 'audio/wav');
          uploads.push({ name: file.name, filename: safeName, key, url });
        }
        return ok({ uploads }, {}, event);
      }

      if (route === 'POST submissions/:id/submit') {
        const { state: snapshot } = await store.read();
        const job = ownJob(snapshot, parts[1], email);
        if (!wf.uploadWindowOpen(snapshot, job, { now, superuser: superuserOf(snapshot, email, passwordAccount) })) {
          throw wf.clientError(403, 'Your recording session has ended');
        }
        const prefix = `training/datasets/${job.sourceExpName}/raw/`;
        const keys = Array.isArray(body.keys) ? body.keys.map(String) : [];
        if (keys.length === 0) throw wf.clientError(400, 'Upload at least one audio file');
        if (keys.some((key) => !key.startsWith(prefix) || key.slice(prefix.length).includes('/'))) {
          throw wf.clientError(400, 'Files must belong to this recording set');
        }
        const sources = body.sources && typeof body.sources === 'object' ? body.sources : {};
        const files = [];
        for (const key of keys) {
          const found = await service.head(key);
          if (found) files.push({ name: key.slice(prefix.length), bytes: Number(found.ContentLength || found.size || 0), source: sources[key] === 'recorded' ? 'recorded' : 'upload' });
        }
        if (files.length === 0) throw wf.clientError(400, 'None of the files reached storage; please upload again');
        await updateState(store, (state) => {
          wf.submitJob(ownJob(state, parts[1], email), { files, now });
          return null;
        });
        await service.tick({ force: true }).catch((error) => console.warn('[studio] tick after submit failed', error.message));
        const { state } = await store.read();
        // Receipt with the estimated finish, so the lecturer knows what to expect.
        const submitted = wf.findJob(state, parts[1]);
        const estimate = wf.estimateQueue(state, { now: clock(), env }).find((entry) => entry.jobId === submitted.id) || null;
        await service.notify(submitted.id, 'submissionReceived', submitted.ownerEmail, templates.submissionReceived({
          job: submitted, estimate, minutes: wf.trainingMinutes(state, env), env,
        }));
        return ok(await lecturerView((await store.read()).state, email, passwordAccount, via), {}, event);
      }

      if (route === 'POST submissions/:id/cancel') {
        await updateState(store, (state) => {
          const job = ownJob(state, parts[1], email);
          if (!['uploading', 'queued'].includes(job.status)) throw wf.clientError(409, 'Only a recording set that has not started training can be withdrawn');
          wf.cancelJob(job);
          return null;
        });
        const { state } = await store.read();
        return ok(await lecturerView(state, email, passwordAccount, via), {}, event);
      }

      // The lecturer's feedback is the end of their testing: testing that voice
      // closes, their slot ends and their GPU is given back.
      if (route === 'POST submissions/:id/feedback') {
        const { result } = await updateState(store, (state) => {
          const job = ownJob(state, parts[1], email);
          if (!['scheduled', 'approved'].includes(job.status)) throw wf.clientError(409, 'Feedback opens once your voice is ready to test');
          if (job.testingClosedAt) throw wf.clientError(409, 'You already sent your feedback for this voice — thank you');
          wf.addFeedback(job, {
            email, rating: body.rating, comment: body.comment, likeness: body.likeness, issues: body.issues, words: body.words, now,
          });
          return { done: service.testingDone(state, email), jobId: job.id };
        });
        if (result.done) await service.finishTesting(email);
        const { state } = await store.read();
        const job = wf.findJob(state, result.jobId);
        await service.notify(job.id, 'feedbackReceived', service.superuserEmails(state), templates.feedbackReceived({ job, env }));
        return ok({ saved: true, ...(await lecturerView(state, email, passwordAccount, via)) }, {}, event);
      }

      if (route === 'GET voices/:id/access') {
        const { access, superuser } = await voiceAccessFor(email, parts[1], passwordAccount);
        return ok({ voiceName: parts[1], superuser, ...access }, {}, event);
      }

      // A lecturer is using their voice (chat, a reading, the page opening):
      // keeps the GPU that serves live chat on for 30 min, and starts it if off.
      if (route === 'POST voices/:id/activity') {
        const { access } = await voiceAccessFor(email, parts[1], passwordAccount);
        if (!access.allowed) throw wf.clientError(403, 'This voice is not open for testing');
        return ok(await recordTestActivity('lastLecturerTestAt', now), {}, event);
      }

      if (route === 'GET voices/:id/pronunciations') {
        await voiceAccessFor(email, parts[1], passwordAccount);
        const stored = await service.readJson(voiceDictionaryKey(parts[1]));
        return ok({ voiceName: parts[1], entries: Array.isArray(stored?.entries) ? stored.entries : [] }, {}, event);
      }

      if (route === 'POST voices/:id/pronunciations' || route === 'DELETE voices/:id/pronunciations') {
        await voiceAccessFor(email, parts[1], passwordAccount);
        const stored = await service.readJson(voiceDictionaryKey(parts[1]));
        const entries = Array.isArray(stored?.entries) ? stored.entries : [];
        // DELETE sends the word in the query string (CloudFront rejects a DELETE with a body).
        const word = String(body.word || event.queryStringParameters?.word || '').trim().toLowerCase();
        let next = entries.filter((entry) => String(entry.word || '').toLowerCase() !== word);
        if (method === 'POST') {
          const entry = validatePronunciation(body);
          next = [...entries.filter((item) => String(item.word || '').toLowerCase() !== entry.word.toLowerCase()), {
            ...entry, updatedBy: email, updatedAt: new Date(now).toISOString(),
          }].sort((a, b) => a.word.localeCompare(b.word));
          if (next.length > 500) throw wf.clientError(400, 'A voice can hold at most 500 pronunciations');
        } else if (!word || next.length === entries.length) {
          throw wf.clientError(404, 'That word is not in this voice\'s library');
        }
        await service.writeJson(voiceDictionaryKey(parts[1]), { schemaVersion: 1, voiceName: parts[1], entries: next });
        return ok({ voiceName: parts[1], entries: next }, {}, event);
      }

      if (route === 'POST voices/:id/pronunciations/apply') {
        const { access } = await voiceAccessFor(email, parts[1], passwordAccount);
        if (!access.allowed) throw wf.clientError(409, 'The GPU is not yours right now; changes apply when your slot starts');
        const result = await service.applyPronunciation(parts[1]);
        return ok({ applied: true, restarted: Boolean(result?.restarted), ready: result?.ready !== false }, {}, event);
      }

      // ── Super users ──
      if (parts[0] === 'admin') {
        const { state: snapshot } = await store.read();
        requireSuperuser(snapshot, email, passwordAccount);

        if (route === 'GET admin/overview') {
          await maybeTick();
          const { state } = await store.read();
          return ok(await adminView(state, email), {}, event);
        }

        if (route === 'POST admin/tick') {
          const result = await service.tick({ force: true });
          const { state } = await store.read();
          return ok({ tick: result, ...(await adminView(state, email)) }, {}, event);
        }

        if (route === 'POST admin/jobs/:id/review') {
          const decision = body.decision === 'approve' ? 'approve' : body.decision === 'reject' ? 'reject' : '';
          if (!decision) throw wf.clientError(400, 'decision must be approve or reject');
          await updateState(store, async (state) => {
            const job = wf.findJob(state, parts[2]);
            if (!job) throw wf.clientError(404, 'Job not found');
            const nextExpName = decision === 'reject' ? nextVoiceName(job.ownerEmail, await service.takenVoiceNames(state), STUDIO_IDENTITY) : '';
            wf.reviewJob(job, {
              decision, reasons: body.reasons, notes: body.notes, overrides: body.overrides || {}, reviewer: email, nextExpName, now,
            });
            return null;
          });
          if (decision === 'reject') await maybeTick();
          const { state } = await store.read();
          if (decision === 'approve') {
            const job = wf.findJob(state, parts[2]);
            const slot = wf.upcomingSlotFor(state, job.ownerEmail, clock());
            await service.notify(job.id, 'voiceApproved', job.ownerEmail, templates.voiceApproved({ job, slot, env }));
          }
          return ok(await adminView((await store.read()).state, email), {}, event);
        }

        // Test slots may name several people at once (one slot, and one GPU, each).
        if (route === 'POST admin/slots') {
          const people = body.kind !== 'recording' && Array.isArray(body.assignees) && body.assignees.length > 0
            ? body.assignees.slice(0, 20)
            : [{ email: body.assigneeEmail, name: body.assigneeName }];
          await updateState(store, (state) => {
            if (body.kind !== 'recording') for (const person of people) wf.assertVoiceApproved(state, person?.email);
            wf.assertMayChange(state, { actorEmail: email, staff: wf.listSuperusers(state, env), add: { kind: body.kind, assigneeEmail: body.assigneeEmail, hostNames: body.hostNames || (body.hostName ? [body.hostName] : []) } });
            for (const person of people) {
              wf.addSlot(state, {
                id: newId(), kind: body.kind, start: body.start, end: body.end, assigneeEmail: person?.email, assigneeName: person?.name, hostName: body.hostName, hostNames: body.hostNames, actor: email, now, staff: wf.listSuperusers(state, env),
              });
            }
            return null;
          });
          await warmNow();
          return ok(await adminView((await store.read()).state, email), {}, event);
        }

        // Editing or deleting a test slot also cancels its GPU: one already
        // warming for it is released now instead of idling until it times out.
        // Staff whose overridden time was given back after they were told it was taken.
        const sendFreeAgain = async (notices) => {
          const sent = [];
          for (const item of notices || []) {
            const message = templates.availabilityRestored({ slot: item.slot, by: item.by, name: item.name, env });
            sent.push({ email: item.email, kind: 'availabilityRestored', ...(await service.mailer.send(item.email, message)) });
          }
          return sent;
        };

        // Published slots: the people booked or moved, and staff whose free time a booking took.
        const sendSlotNotices = async (toNotify = [], overridden = []) => {
          const sent = [];
          for (const item of toNotify) {
            const message = templates[item.kind]({ slot: item.slot, moved: item.moved, env });
            sent.push({ email: item.email, kind: item.kind, ...(await service.mailer.send(item.email, message)) });
          }
          for (const item of overridden) {
            const message = templates.availabilityOverridden({ slot: item.slot, by: item.by, name: item.name, env });
            sent.push({ email: item.email, kind: 'availabilityOverridden', ...(await service.mailer.send(item.email, message)) });
          }
          return sent;
        };

        if (route === 'PUT admin/slots/:id') {
          const { result } = await updateState(store, (state) => {
            const before = { ...wf.findSlot(state, parts[2]) };
            // Handing a test slot to someone else: they too need an approved voice.
            if (before.id && wf.slotKind(before) === 'test' && body.assigneeEmail !== undefined
              && !wf.sameNtuPerson(body.assigneeEmail, before.assigneeEmail)) wf.assertVoiceApproved(state, body.assigneeEmail);
            wf.assertMayChange(state, { actorEmail: email, staff: wf.listSuperusers(state, env), slotId: parts[2], hostNames: body.hostNames, confirm: body.confirmHost === true });
            // The host confirming a booking sends it out at once (owner 2026-11-24): the
            // lecturer is emailed, and so is everyone whose free time it takes.
            if (body.confirmHost === true) {
              wf.confirmHost(state, parts[2], now);
              const toNotify = wf.publishSlots(state, now, parts[2]);
              return { release: '', freeAgain: wf.freeAgainNotices(state, env, now), toNotify, overridden: wf.overrideNotices(state, env, now) };
            }
            wf.editSlot(state, parts[2], {
              start: body.start, end: body.end, assigneeEmail: body.assigneeEmail, assigneeName: body.assigneeName, hostName: body.hostName, hostNames: body.hostNames,
            }, now, wf.listSuperusers(state, env));
            return { release: wf.gpuToRelease(state, before, now), freeAgain: wf.freeAgainNotices(state, env, now) };
          });
          await releaseGpuOf(result.release);
          await sendFreeAgain(result.freeAgain);
          await sendSlotNotices(result.toNotify, result.overridden);
          await warmNow();
          return ok(await adminView((await store.read()).state, email), {}, event);
        }

        if (route === 'DELETE admin/slots/:id') {
          const { result } = await updateState(store, (state) => {
            wf.assertMayChange(state, { actorEmail: email, staff: wf.listSuperusers(state, env), slotId: parts[2], remove: true });
            const removed = wf.removeSlot(state, parts[2]);
            return { removed, release: wf.gpuToRelease(state, removed.slot, now), freeAgain: wf.freeAgainNotices(state, env, now) };
          });
          await releaseGpuOf(result.release);
          await sendFreeAgain(result.freeAgain);
          const told = result.removed.notify;
          if (told) {
            const template = wf.slotKind(result.removed.slot) === 'recording' ? templates.recordingCancelled : templates.slotCancelled;
            await service.mailer.send(told.assigneeEmail, template({ slot: told, env }));
          }
          return ok(await adminView((await store.read()).state, email), {}, event);
        }

        if (route === 'POST admin/slots/publish') {
          const { result } = await updateState(store, (state) => {
            const toNotify = wf.publishSlots(state, now);
            // Staff whose availability a now-published booking took: pick another time.
            return { toNotify, overridden: wf.overrideNotices(state, env, now), freeAgain: wf.freeAgainNotices(state, env, now) };
          });
          const sent = await sendSlotNotices(result.toNotify, result.overridden);
          sent.push(...(await sendFreeAgain(result.freeAgain)));
          await warmNow();
          return ok({ ...(await adminView((await store.read()).state, email)), published: sent }, {}, event);
        }

        if (route === 'POST admin/jobs/:id/retry') {
          await updateState(store, async (state) => {
            const job = wf.findJob(state, parts[2]);
            if (!job) throw wf.clientError(404, 'Job not found');
            wf.requeueFailedJob(job, { nextExpName: nextVoiceName(job.ownerEmail, await service.takenVoiceNames(state), STUDIO_IDENTITY), now });
            return null;
          });
          await maybeTick();
          return ok(await adminView((await store.read()).state, email), {}, event);
        }

        // Withdraw = the person's voice: sets + test slots go, recording page reopens (no undo).
        if (route === 'POST admin/jobs/:id/cancel') {
          const { result } = await updateState(store, (state) => {
            const job = wf.findJob(state, parts[2]);
            if (!job) throw wf.clientError(404, 'Job not found');
            const { withdrawn, slotsRemoved } = wf.withdrawPerson(state, job.ownerEmail, now);
            const note = slotsRemoved ? `${slotsRemoved} test slot${slotsRemoved === 1 ? '' : 's'} cancelled` : '';
            for (const entry of withdrawn) wf.logCleanup(state, { actor: email, action: 'withdrawn', job: entry.job, from: entry.from, note, now });
            return { jobId: job.id };
          });
          if (body.email === true) {
            const job = wf.findJob((await store.read()).state, result.jobId);
            await service.notify(job.id, 'newRecordingsNeeded', job.ownerEmail, templates.newRecordingsNeeded({ job, notes: body.notes, env, reset: true }));
          }
          return ok(await adminView((await store.read()).state, email), {}, event);
        }

        // The tester is in use (a chat message, a reading, the page opening):
        // keeps the chat service on for 30 min after, and starts it if it is off.
        if (route === 'POST admin/test-activity') {
          return ok(await recordTestActivity('lastSuperuserTestAt', now), {}, event);
        }

        if (route === 'POST admin/test-email') {
          const result = await service.mailer.send(email, {
            subject: 'Voice Studio test email',
            text: 'This is a test from Voice Studio. If you can read it, email is working.',
            html: '<p>This is a test from Voice Studio. If you can read it, email is working.</p>',
          });
          return ok({ to: email, ...result }, {}, event);
        }

        // Tools > Clean up: a stale set's record goes for good (files stay in storage).
        if (route === 'DELETE admin/jobs/:id') {
          await updateState(store, (state) => {
            const from = wf.findJob(state, parts[2])?.status || '';
            const { job, slotsRemoved } = wf.deleteJob(state, parts[2], now);
            wf.logCleanup(state, { actor: email, action: 'deleted', job, from, note: slotsRemoved ? `${slotsRemoved} test slot${slotsRemoved === 1 ? '' : 's'} removed` : '', now });
            return null;
          });
          return ok(await adminView((await store.read()).state, email), {}, event);
        }

        if (route === 'POST admin/jobs/:id/request-recordings') {
          const { result } = await updateState(store, (state) => {
            const job = wf.findJob(state, parts[2]);
            if (!job) throw wf.clientError(404, 'Job not found');
            if (!['review', 'failed'].includes(job.status)) throw wf.clientError(409, 'Only a voice in review or a failed run can be sent back');
            job.reviews.push({ attempt: job.attempt, expName: job.expName, decision: 'new-recordings', reasons: [], notes: String(body.notes || '').slice(0, 1000), reviewer: email, at: new Date(now).toISOString() });
            wf.cancelJob(job);
            // They were asked to record again, so the recording page opens again.
            job.recordingReopened = true;
            return { jobId: job.id };
          });
          const { state } = await store.read();
          const job = wf.findJob(state, result.jobId);
          await service.notify(job.id, 'newRecordingsNeeded', job.ownerEmail, templates.newRecordingsNeeded({ job, notes: body.notes, env }));
          return ok(await adminView((await store.read()).state, email), {}, event);
        }

        if (route === 'POST admin/superusers') {
          await updateState(store, (state) => {
            wf.addSuperuser(state, { email: body.email, name: body.name }, email, now);
            return null;
          });
          const added = String(body.email || '').trim().toLowerCase();
          await service.mailer.send(added, templates.superuserAdded({ email: added, actor: email, env }));
          return ok(await adminView((await store.read()).state, email), {}, event);
        }

        if (route === 'PUT admin/superusers/:id') {
          await updateState(store, (state) => {
            wf.updateSuperuser(state, parts[2], { name: body.name }, env);
            return null;
          });
          return ok(await adminView((await store.read()).state, email), {}, event);
        }

        if (route === 'DELETE admin/superusers/:id') {
          await updateState(store, (state) => {
            wf.removeSuperuser(state, parts[2], email, env);
            return null;
          });
          return ok(await adminView((await store.read()).state, email), {}, event);
        }
      }

      return err(404, 'Not found', event);
    } catch (error) {
      return respondError(error, event);
    }
  };
}

let defaultHandler = null;
export async function handler(event, context) {
  if (!defaultHandler) defaultHandler = createHandler();
  return defaultHandler(event, context);
}

// ── Hooks used by other routes ───────────────────────────────────────────

let defaultService = null;
function sharedService() {
  if (!defaultService) defaultService = createStudioService();
  return defaultService;
}

/** Scheduled idle check: advance the queue; report whether the GPU must stay on. */
export async function studioTick(options = {}) {
  if (!process.env.S3_BUCKET) return { demand: '', skipped: true };
  return sharedService().tick(options);
}

/** Voice-profile /mine?scope=studio: which voices this person may use right now. */
export async function studioVoiceScope(email, {
  store = sharedService().store, env = process.env, now = Date.now(), passwordAccount = false,
} = {}) {
  const { state } = await store.read();
  const superuser = (!passwordAccount || wf.passwordSuperuserAllowed(email, env)) && wf.isSuperuser(state, email, env);
  const names = wf.visibleVoices(state, { email, superuser })
    .filter((voiceName) => wf.voiceAccess(state, { email, voiceName, now, superuser }).allowed);
  // Who each studio voice really belongs to, so a profile created while a super
  // user reviews it is still recorded under the lecturer.
  const owners = {};
  // Readable names: "<voice label> · <lecturer> (try n)".
  const labels = {};
  for (const voice of wf.studioTrainedVoices(state)) {
    labels[voice.expName] = voice.label;
    owners[voice.expName] = voice.ownerEmail;
  }
  for (const job of state.jobs) {
    for (const name of [job.expName, job.approvedExpName, ...job.attempts.map((attempt) => attempt.expName)]) {
      if (name) owners[name] = job.ownerEmail;
    }
  }
  const voiceNames = [...new Set(names)];
  // Super users may test any trained voice of any user (studio or training
  // site) at any time, on their own QC GPU (a slot has its own).
  const allVoices = superuser;
  return {
    superuser, allVoices, voiceNames, labels, owners: Object.fromEntries(voiceNames.map((name) => [name, owners[name] || ''])), studioOwners: owners,
  };
}

/** Readable names for every trained Voice Studio voice: "<label> · <person> (try n)". */
export async function studioVoiceLabels({ store = sharedService().store } = {}) {
  if (!process.env.S3_BUCKET) return {};
  const { state } = await store.read();
  return Object.fromEntries(wf.studioTrainedVoices(state).map((voice) => [voice.expName, voice.label]));
}
