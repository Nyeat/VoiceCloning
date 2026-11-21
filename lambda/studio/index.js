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
import { describeVoiceIdentity, nextVoiceName } from '../shared/voiceIdentity.js';
import { gpuGet, gpuPost, inferencePost } from '../shared/gpuWorker.js';
import { listTrainedVoiceNames, bestModelsForVoice } from '../shared/trainedVoices.js';
import * as wf from './workflow.js';
import { createS3StateStore, updateState } from './store.js';
import {
  ACCOUNTS_KEY, findAccount, hashPassword, normalizeAccounts, passwordMatches, requiresMicrosoft, validateRegistration,
} from './accounts.js';
import { createGoogleVerifier } from './googleToken.js';
import { signStudioSession, STUDIO_SESSION_DAYS } from '../shared/studioSession.js';
import { createMailer, templates } from './mailer.js';
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

// Loads a voice onto the GPU the way selecting it in the studio does: the
// coordinator switches the GPU to it at once (singleGpu, no 10 min protection).
async function defaultPreloadVoice(voiceName) {
  const [{ createVoiceProfileResolver }, { prepareCoordinatedModel }, { buildVoiceProfileId }] = await Promise.all([
    import('../shared/voiceProfileRuntime.js'),
    import('../shared/modelCoordinator.js'),
    import('../shared/voiceIdentity.js'),
  ]);
  const body = await createVoiceProfileResolver()({ voiceProfileId: buildVoiceProfileId(voiceName), text: 'Voice Studio slot warm-up.' });
  return prepareCoordinatedModel(body, { allowScale: true, source: 'models-select', singleGpu: true });
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

    // Load the person's voice before their slot starts, once the GPU is up.
    const preloaded = [];
    for (const slot of wf.slotsToPreload(state, now)) {
      const voiceName = wf.preloadVoiceFor(state, slot);
      if (!voiceName) continue;
      try {
        await preloadVoice(voiceName);
        preloaded.push(voiceName);
        await updateState(store, (draft) => {
          const current = wf.findSlot(draft, slot.id);
          if (current) current.preloadedAt = new Date(now).toISOString();
          return null;
        });
      } catch (error) {
        console.warn(`[studio] slot preload of ${voiceName} failed (retried next tick): ${error.message}`);
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

  return { store, accountStore, tick, takenVoiceNames, notify, superuserEmails, env, clock, newId, presign, head, readJson, writeJson, applyPronunciation, readWorker, mailer };
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
      throw wf.clientError(401, 'Please sign in with your Microsoft account');
    }
    if (identity?.synthetic || !identity?.email) throw wf.clientError(403, 'A signed-in account is required');
    return { email: String(identity.email).trim().toLowerCase(), passwordAccount: identity.passwordAccount === true };
  }

  // Email + password addresses are not verified, so they are never super users.
  function superuserOf(state, email, passwordAccount) {
    return !passwordAccount && wf.isSuperuser(state, email, env);
  }

  function requireSuperuser(state, email, passwordAccount) {
    if (!superuserOf(state, email, passwordAccount)) throw wf.clientError(403, 'Super users only');
  }

  async function register(body) {
    const { email, name } = validateRegistration(body, env);
    const { state } = await store.read();
    // A Microsoft user's studio work stays theirs: nobody can take over that address with a password.
    if (wf.isSuperuser(state, email, env)
      || state.jobs.some((job) => wf.sameNtuPerson(job.ownerEmail, email))
      || state.slots.some((slot) => slot.status !== 'cancelled' && wf.sameNtuPerson(slot.assigneeEmail, email))) {
      throw wf.clientError(409, 'This address already uses Voice Studio with Microsoft sign-in. Please sign in with Microsoft.');
    }
    const passwordHash = await hashPassword(body.password);
    await updateState(service.accountStore, (accounts) => {
      if (findAccount(accounts, email)) throw wf.clientError(409, 'An account with this email already exists — sign in instead');
      accounts.accounts.push({ email, name, passwordHash, createdAt: new Date(clock()).toISOString() });
      return null;
    });
    return { ...session({ email, name }), created: true };
  }

  // One form: an address with no account yet is signed up on the spot, its
  // name taken from the address unless one is given.
  async function login(body) {
    const { state: accounts } = await service.accountStore.read();
    const account = findAccount(accounts, body.email);
    if (!account) {
      const local = String(body.email || '').split('@')[0].replace(/[._+-]+/gu, ' ').trim();
      return register({ ...body, name: String(body.name || '').trim() || local });
    }
    if (!(await passwordMatches(String(body.password || ''), account.passwordHash))) {
      throw wf.clientError(401, 'Wrong password for this email');
    }
    return session(account);
  }

  // "Sign in with Google": the address is verified by Google, so no password.
  async function googleLogin(body) {
    let verified;
    try {
      verified = await google.verify(body.credential);
    } catch (error) {
      throw wf.clientError(error.code === 'misconfigured' ? 503 : 401, error.message || 'Google sign-in failed');
    }
    if (requiresMicrosoft(verified.email, env)) throw wf.clientError(400, 'NTU addresses sign in with Microsoft');
    const { state: accounts } = await service.accountStore.read();
    const name = verified.name || findAccount(accounts, verified.email)?.name || verified.email.split('@')[0];
    return session({ email: verified.email, name });
  }

  function session({ email, name }) {
    const now = clock();
    try {
      return { token: signStudioSession({ email, name }, { env, now }), email, name, expiresAt: new Date(now + STUDIO_SESSION_DAYS * 86400_000).toISOString() };
    } catch (error) {
      throw wf.clientError(503, error.message);
    }
  }

  function ownJob(state, id, email) {
    const job = wf.findJob(state, id);
    if (!job || !wf.sameNtuPerson(job.ownerEmail, email)) throw wf.clientError(404, 'Recording set not found');
    return job;
  }

  async function maybeTick() {
    try {
      return await service.tick();
    } catch (error) {
      console.warn('[studio] tick failed', error.message);
      return null;
    }
  }

  async function lecturerView(state, email, passwordAccount = false) {
    const now = clock();
    const superuser = superuserOf(state, email, passwordAccount);
    const estimates = new Map(wf.estimateQueue(state, { now, env }).map((entry) => [entry.jobId, entry]));
    const jobs = state.jobs
      .filter((job) => wf.sameNtuPerson(job.ownerEmail, email) && job.status !== 'cancelled')
      .map((job) => wf.lecturerJob(job, estimates.get(job.id)))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return {
      email,
      role: superuser ? 'superuser' : 'lecturer',
      account: passwordAccount ? 'password' : 'microsoft',
      jobs,
      queueLength: wf.orderQueue(state.jobs).length + (state.jobs.some((job) => job.status === 'training') ? 1 : 0),
      trainingMinutes: wf.trainingMinutes(state, env),
      voices: wf.visibleVoices(state, { email, superuser: false }).map((voiceName) => ({
        voiceName,
        access: wf.voiceAccess(state, { email, voiceName, now, superuser: false }),
      })),
      // Recording sessions: the table they pick from, and whether recording is open now.
      sessions: wf.publicSlots(state, email, now),
      recording: wf.recordingAccess(state, { email, now, superuser }),
      // GPU test slot (allocated by a super user after QC).
      mySlot: wf.upcomingSlotFor(state, email, now, 'test'),
      activeSlot: (() => {
        const active = wf.currentSlot(state, now);
        return active && wf.sameNtuPerson(active.assigneeEmail, email) ? active : null;
      })(),
      now: new Date(now).toISOString(),
    };
  }

  async function adminView(state) {
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
        .map((job) => wf.publicJob(job, estimates.get(job.id)))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
      queue: wf.orderQueue(state.jobs).map((job) => job.id),
      slots: state.slots
        .filter((slot) => slot.status !== 'cancelled' && Date.parse(slot.end) > now - 7 * 24 * 3600_000)
        .sort((a, b) => a.start.localeCompare(b.start)),
      draftCount: state.slots.filter((slot) => slot.status === 'draft').length,
      people: [...new Map(state.jobs.filter((job) => job.status !== 'uploading').map((job) => [job.ownerEmail, {
        email: job.ownerEmail,
        name: job.ownerName,
        approvedVoices: state.jobs.filter((other) => other.ownerEmail === job.ownerEmail && ['approved', 'scheduled'].includes(other.status)).map((other) => other.approvedExpName),
      }])).values()],
      currentSlot: wf.currentSlot(state, now),
      superusers: wf.listSuperusers(state, env),
      trainingMinutes: wf.trainingMinutes(state, env),
      maxAttempts: wf.MAX_TRAINING_ATTEMPTS,
      rejectReasons: wf.REJECT_REASONS,
      feedbackIssues: wf.FEEDBACK_ISSUES,
      feedbackLikeness: wf.FEEDBACK_LIKENESS,
      emailConfigured: Boolean(env.EMAIL_USER && env.EMAIL_PASS),
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
    if (!visible.includes(voiceName)) throw wf.clientError(404, 'Voice not found');
    return { state, superuser, access: wf.voiceAccess(state, { email, voiceName, now: clock(), superuser }) };
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
      // Email + password sign-in (no Microsoft account): the only routes without a token.
      if (method === 'POST' && parts.length === 2 && parts[0] === 'auth' && ['register', 'login', 'google'].includes(parts[1])) {
        const handlers = { register, login, google: googleLogin };
        return ok(await handlers[parts[1]](body), {}, event);
      }
      const { email, passwordAccount } = await identify(event);
      const now = clock();
      const route = `${method} ${parts.map((part, index) => (index > 0 && part !== 'publish' && ['submissions', 'jobs', 'voices', 'superusers', 'slots'].includes(parts[index - 1]) ? ':id' : part)).join('/')}`;

      // ── Lecturer (and everyone) ──
      if (route === 'GET me') {
        await maybeTick();
        const { state } = await store.read();
        return ok(await lecturerView(state, email, passwordAccount), {}, event);
      }

      if (route === 'POST submissions') {
        const identity = describeVoiceIdentity(email, STUDIO_IDENTITY);
        if (!identity.valid) throw wf.clientError(400, identity.error);
        const { result } = await updateState(store, async (state) => {
          const superuser = superuserOf(state, email, passwordAccount);
          // Super users record their own reference voices and do not sign the lecturer consent.
          if (!superuser && (body.consent?.accepted !== true || !String(body.consent?.version || '').trim())) {
            throw wf.clientError(400, 'Please read and accept the consent form first');
          }
          const access = wf.recordingAccess(state, { email, now, superuser });
          if (!access.allowed) throw wf.clientError(403, 'Recording opens during your booked recording session');
          const open = state.jobs.filter((job) => wf.sameNtuPerson(job.ownerEmail, email) && ['uploading', 'queued'].includes(job.status));
          if (open.length >= 5) throw wf.clientError(429, 'You already have 5 recording sets waiting. Please wait for them to train.');
          const expName = nextVoiceName(email, await service.takenVoiceNames(state), STUDIO_IDENTITY);
          if (!expName) throw wf.clientError(409, 'You have too many voices; ask a super user to remove one');
          const job = wf.createJob(state, { id: newId(), ownerEmail: email, ownerName: body.name, expName, label: body.label, consent: superuser ? null : body.consent, now });
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
        return ok(await lecturerView((await store.read()).state, email, passwordAccount), {}, event);
      }

      if (route === 'POST submissions/:id/cancel') {
        await updateState(store, (state) => {
          const job = ownJob(state, parts[1], email);
          if (!['uploading', 'queued'].includes(job.status)) throw wf.clientError(409, 'Only a recording set that has not started training can be withdrawn');
          wf.cancelJob(job);
          return null;
        });
        const { state } = await store.read();
        return ok(await lecturerView(state, email, passwordAccount), {}, event);
      }

      if (route === 'POST submissions/:id/feedback') {
        await updateState(store, (state) => {
          const job = ownJob(state, parts[1], email);
          if (!['scheduled', 'approved'].includes(job.status)) throw wf.clientError(409, 'Feedback opens once your voice is ready to test');
          wf.addFeedback(job, {
            email, rating: body.rating, comment: body.comment, likeness: body.likeness, issues: body.issues, words: body.words, now,
          });
          return null;
        });
        return ok({ saved: true }, {}, event);
      }

      if (route === 'GET voices/:id/access') {
        const { access, superuser } = await voiceAccessFor(email, parts[1], passwordAccount);
        return ok({ voiceName: parts[1], superuser, ...access }, {}, event);
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
        const word = String(body.word || '').trim().toLowerCase();
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

      if (route === 'POST slots/:id/move') {
        const { result } = await updateState(store, (state) => ({ moved: wf.moveSlot(state, parts[1], { email, now }) }));
        const { state } = await store.read();
        await service.mailer.send(email, templates.recordingBooked({ slot: result.moved.to, moved: true, env }));
        await service.mailer.send(wf.listSuperusers(state, env).map((entry) => entry.email), templates.slotPicked({ slot: result.moved.to, email, claiming: true, env }));
        return ok(await lecturerView(state, email, passwordAccount), {}, event);
      }

      if (route === 'POST slots/:id/claim' || route === 'POST slots/:id/release') {
        const claiming = route.endsWith('claim');
        const { result } = await updateState(store, (state) => {
          const slot = claiming
            ? wf.claimSlot(state, parts[1], { email, name: body.name, now })
            : wf.releaseSlot(state, parts[1], { email, now });
          return { slot: { ...slot } };
        });
        const { state } = await store.read();
        if (claiming) {
          await service.mailer.send(email, templates.recordingBooked({ slot: result.slot, moved: false, env }));
        }
        const people = wf.listSuperusers(state, env).map((entry) => entry.email);
        await service.mailer.send(people, templates.slotPicked({ slot: result.slot, email, claiming, env }));
        return ok(await lecturerView(state, email, passwordAccount), {}, event);
      }

      // ── Super users ──
      if (parts[0] === 'admin') {
        const { state: snapshot } = await store.read();
        requireSuperuser(snapshot, email, passwordAccount);

        if (route === 'GET admin/overview') {
          await maybeTick();
          const { state } = await store.read();
          return ok(await adminView(state), {}, event);
        }

        if (route === 'POST admin/tick') {
          const result = await service.tick({ force: true });
          const { state } = await store.read();
          return ok({ tick: result, ...(await adminView(state)) }, {}, event);
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
          return ok(await adminView((await store.read()).state), {}, event);
        }

        if (route === 'POST admin/slots') {
          await updateState(store, (state) => {
            wf.addSlot(state, {
              id: newId(), kind: body.kind, start: body.start, end: body.end, assigneeEmail: body.assigneeEmail, assigneeName: body.assigneeName, actor: email, now,
            });
            return null;
          });
          return ok(await adminView((await store.read()).state), {}, event);
        }

        if (route === 'PUT admin/slots/:id') {
          await updateState(store, (state) => {
            wf.editSlot(state, parts[2], {
              start: body.start, end: body.end, assigneeEmail: body.assigneeEmail, assigneeName: body.assigneeName,
            }, now);
            return null;
          });
          return ok(await adminView((await store.read()).state), {}, event);
        }

        if (route === 'DELETE admin/slots/:id') {
          const { result } = await updateState(store, (state) => ({ removed: wf.removeSlot(state, parts[2]) }));
          const told = result.removed.notify;
          if (told) {
            const template = wf.slotKind(result.removed.slot) === 'recording' ? templates.recordingCancelled : templates.slotCancelled;
            await service.mailer.send(told.assigneeEmail, template({ slot: told, env }));
          }
          return ok(await adminView((await store.read()).state), {}, event);
        }

        if (route === 'POST admin/slots/publish') {
          const { result } = await updateState(store, (state) => ({ toNotify: wf.publishSlots(state, now) }));
          const sent = [];
          for (const item of result.toNotify) {
            const message = templates[item.kind]({ slot: item.slot, moved: item.moved, env });
            sent.push({ email: item.email, kind: item.kind, ...(await service.mailer.send(item.email, message)) });
          }
          return ok({ ...(await adminView((await store.read()).state)), published: sent }, {}, event);
        }

        if (route === 'POST admin/jobs/:id/retry') {
          await updateState(store, async (state) => {
            const job = wf.findJob(state, parts[2]);
            if (!job) throw wf.clientError(404, 'Job not found');
            wf.requeueFailedJob(job, { nextExpName: nextVoiceName(job.ownerEmail, await service.takenVoiceNames(state), STUDIO_IDENTITY), now });
            return null;
          });
          await maybeTick();
          return ok(await adminView((await store.read()).state), {}, event);
        }

        if (route === 'POST admin/jobs/:id/cancel') {
          await updateState(store, (state) => {
            const job = wf.findJob(state, parts[2]);
            if (!job) throw wf.clientError(404, 'Job not found');
            wf.cancelJob(job);
            return null;
          });
          return ok(await adminView((await store.read()).state), {}, event);
        }

        if (route === 'POST admin/jobs/:id/request-recordings') {
          const { result } = await updateState(store, (state) => {
            const job = wf.findJob(state, parts[2]);
            if (!job) throw wf.clientError(404, 'Job not found');
            if (!['review', 'failed'].includes(job.status)) throw wf.clientError(409, 'Only a voice in review or a failed run can be sent back');
            job.reviews.push({ attempt: job.attempt, expName: job.expName, decision: 'new-recordings', reasons: [], notes: String(body.notes || '').slice(0, 1000), reviewer: email, at: new Date(now).toISOString() });
            wf.cancelJob(job);
            return { jobId: job.id };
          });
          const { state } = await store.read();
          const job = wf.findJob(state, result.jobId);
          await service.notify(job.id, 'newRecordingsNeeded', job.ownerEmail, templates.newRecordingsNeeded({ job, notes: body.notes, env }));
          return ok(await adminView((await store.read()).state), {}, event);
        }

        if (route === 'POST admin/superusers') {
          await updateState(store, (state) => {
            wf.addSuperuser(state, { email: body.email, name: body.name }, email, now);
            return null;
          });
          const added = String(body.email || '').trim().toLowerCase();
          await service.mailer.send(added, templates.superuserAdded({ email: added, actor: email, env }));
          return ok(await adminView((await store.read()).state), {}, event);
        }

        if (route === 'PUT admin/superusers/:id') {
          await updateState(store, (state) => {
            wf.updateSuperuser(state, parts[2], { name: body.name }, env);
            return null;
          });
          return ok(await adminView((await store.read()).state), {}, event);
        }

        if (route === 'DELETE admin/superusers/:id') {
          await updateState(store, (state) => {
            wf.removeSuperuser(state, parts[2], email, env);
            return null;
          });
          return ok(await adminView((await store.read()).state), {}, event);
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
  const superuser = !passwordAccount && wf.isSuperuser(state, email, env);
  const names = wf.visibleVoices(state, { email, superuser })
    .filter((voiceName) => wf.voiceAccess(state, { email, voiceName, now, superuser }).allowed);
  // Who each studio voice really belongs to, so a profile created while a super
  // user reviews it is still recorded under the lecturer.
  const owners = {};
  for (const job of state.jobs) {
    for (const name of [job.expName, job.approvedExpName, ...job.attempts.map((attempt) => attempt.expName)]) {
      if (name) owners[name] = job.ownerEmail;
    }
  }
  const voiceNames = [...new Set(names)];
  return { superuser, voiceNames, owners: Object.fromEntries(voiceNames.map((name) => [name, owners[name] || ''])) };
}
