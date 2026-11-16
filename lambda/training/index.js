import { gpuPost, gpuGet } from '../shared/gpuWorker.js';
import { isSafePathSegment } from '../shared/paths.js';
import { describeVoiceIdentity, nextVoiceName, ownsVoiceName } from '../shared/voiceIdentity.js';
import { ok, err, preflight, parseJsonBody } from '../shared/cors.js';
import { getObject, headObject } from '../shared/s3.js';
import { listTrainedVoiceNames as listTrainedVoices } from '../shared/trainedVoices.js';
import { createLiveAuthGuard } from '../shared/liveAuth.js';

const BUSY_TRAINING_STATUSES = new Set(['waiting', 'running', 'queued', 'waiting-for-client']);

// When on, the voice owner is the signed-in Microsoft account, never an email
// typed into the page — that is what keeps one lecturer from training into,
// stopping, or watching another lecturer's voice.
export function trainingAuthRequired(env = process.env) {
  return /^(1|true|yes|on)$/iu.test(String(env.TRAINING_AUTH_REQUIRED || ''));
}

export function isTrainingBusy(state) {
  if (!state || typeof state !== 'object') return false;
  if (Number(state.queueDepth) > 0) return true;
  return BUSY_TRAINING_STATUSES.has(String(state.status || '').toLowerCase());
}

// What a lecturer who does NOT own the running job may see: that the GPU is
// busy and roughly how far along it is. Never the voice name (it is derived
// from the owner's email), logs, or the session id that opens the live stream.
export function publicTrainingSummary(state) {
  const steps = Array.isArray(state?.steps) ? state.steps : [];
  const done = steps.filter((step) => ['done', 'complete', 'skipped'].includes(step?.status)).length;
  const running = steps.find((step) => step?.status === 'running');
  return {
    sessionId: null,
    status: 'busy',
    busy: true,
    mine: false,
    startedAt: Number(state?.startedAt) || null,
    stepsTotal: steps.length,
    stepsDone: done,
    currentStep: running?.name || '',
    steps: [],
    logs: [],
  };
}

// The page that opens a trained voice in the "Test your voice" tab. Only an
// https base is used, so a misconfigured value never reaches an email.
export function testVoiceUrl(expName, env = process.env) {
  const base = String(env.TRAINING_PUBLIC_URL || '').trim().replace(/\/+$/u, '');
  if (!/^https:\/\//iu.test(base) || !expName) return '';
  return `${base}/test-voice?voice=${encodeURIComponent(expName)}`;
}

function isWorkerUnavailableError(error) {
  const message = error?.message || '';
  return error instanceof TypeError
    || /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|GPU_WORKER_URL env var/u.test(message);
}

async function defaultReadObject(key) {
  const existing = await headObject(key);
  if (!existing) return null;
  return getObject(key);
}

function decodeSegment(value) {
  try {
    return decodeURIComponent(value || '');
  } catch {
    return '';
  }
}

export function createHandler({
  readObject = defaultReadObject,
  listTrainedVoiceNames = listTrainedVoices,
  readTrainingState = () => gpuGet('/train/current'),
  authGuard = createLiveAuthGuard(),
  authRequired = trainingAuthRequired,
  env = process.env,
} = {}) {
  // Resolves whose voice this request is about. Signed mode ignores any email
  // in the body; legacy mode (auth off) keeps the typed email.
  async function resolveOwner(event, body) {
    if (!authRequired(env)) return { email: body?.email, signed: false };
    if (!authGuard) {
      const error = new Error('Training sign-in is not configured');
      error.statusCode = 503;
      throw error;
    }
    let identity;
    try {
      identity = await authGuard.authorize(event);
    } catch {
      const error = new Error('Sign in with your NTU account to train a voice');
      error.statusCode = 401;
      throw error;
    }
    if (identity?.synthetic || !identity?.email) {
      const error = new Error('A signed-in NTU account is required to train a voice');
      error.statusCode = 403;
      throw error;
    }
    return { email: identity.email, signed: true };
  }

  return async function trainingHandler(event) {
  if (event.requestContext?.http?.method === 'OPTIONS') {
    return preflight();
  }

  const method = event.requestContext?.http?.method;
  const routePath = event.rawPath || '';
  let body = {};
  if (method === 'POST') {
    try {
      body = parseJsonBody(event);
    } catch {
      return err(400, 'Invalid JSON body');
    }
  }

  try {
    if (method === 'POST' && routePath.endsWith('/train/stop')) {
      const { sessionId } = body;
      if (!sessionId) return err(400, 'sessionId is required');
      const owner = await resolveOwner(event, body);
      if (owner.signed) {
        const current = await readTrainingState();
        if (current?.sessionId !== sessionId || !ownsVoiceName(owner.email, current?.expName)) {
          return err(403, 'You can only stop your own training run');
        }
      }
      return ok(await gpuPost('/train/stop', { sessionId }));
    }

    // The client must know the run's name before it uploads, because the audio
    // goes to training/datasets/<expName>/raw/. Allocating it here rather than
    // letting the browser guess is what stops a stale client from uploading
    // into a voice that already exists.
    if (method === 'POST' && routePath.endsWith('/train/next-name')) {
      const owner = await resolveOwner(event, body);
      const identity = describeVoiceIdentity(owner.email);
      if (!identity.valid) return err(400, identity.error);

      const takenNames = await listTrainedVoiceNames();
      const expName = nextVoiceName(identity.email, takenNames);
      if (!expName) {
        return err(409, `${identity.email} has too many voices; delete one before training again`);
      }
      return ok({
        expName,
        baseVoiceName: identity.baseVoiceName,
        email: identity.email,
        existingVoiceNames: takenNames.filter((name) => ownsVoiceName(identity.email, name)).sort(),
      });
    }

    if (method === 'POST' && routePath.endsWith('/train')) {
      const {
        expName: requestedExpName,
        email,
        batchSize,
        sovitsEpochs,
        gptEpochs,
        sovitsSaveEvery,
        gptSaveEvery,
        asrLanguage,
        asrModel,
        skipDenoise,
        selectedReferences,
        sourceDatasetStats,
      } = body;
      const owner = await resolveOwner(event, { email });
      const identity = describeVoiceIdentity(owner.email);
      if (!identity.valid) return err(400, identity.error);

      const takenNames = await listTrainedVoiceNames();
      // Falling back to a freshly allocated name keeps a client that never
      // called /train/next-name working, rather than failing it.
      const expName = String(requestedExpName || '').trim() || nextVoiceName(identity.email, takenNames);
      if (!expName) {
        return err(409, `${identity.email} has too many voices; delete one before training again`);
      }
      if (!isSafePathSegment(expName)) {
        return err(400, 'expName may only contain letters, numbers, dots, dashes, and underscores');
      }
      // Two separate guarantees: the name belongs to this lecturer, and it is
      // not a voice that already exists. Training never replaces a voice, so a
      // client that proposed a stale name must be told, not obeyed.
      if (!ownsVoiceName(identity.email, expName)) {
        return err(403, `${identity.email} does not own a voice called ${expName}`);
      }
      if (takenNames.includes(expName)) {
        return err(409, `${expName} already exists; training would replace it`);
      }

      // One GPU trains one voice at a time. Refuse up front with a readable
      // answer; the worker enforces the same rule against races.
      let currentState = null;
      try {
        currentState = await readTrainingState();
      } catch {
        currentState = null;
      }
      if (isTrainingBusy(currentState)) {
        return {
          ...err(409, 'Another voice is being trained right now. Training opens again when it finishes.'),
          body: JSON.stringify({
            error: 'Another voice is being trained right now. Training opens again when it finishes.',
            code: 'TRAINING_BUSY',
          }),
        };
      }
      const notifyUrl = testVoiceUrl(expName, env);

      return ok(await gpuPost('/train', {
        expName,
        email: identity.email,
        config: {
          ...(batchSize !== undefined ? { batchSize } : {}),
          ...(sovitsEpochs !== undefined ? { sovitsEpochs } : {}),
          ...(gptEpochs !== undefined ? { gptEpochs } : {}),
          ...(sovitsSaveEvery !== undefined ? { sovitsSaveEvery } : {}),
          ...(gptSaveEvery !== undefined ? { gptSaveEvery } : {}),
          ...(asrLanguage !== undefined ? { asrLanguage } : {}),
          ...(asrModel !== undefined ? { asrModel } : {}),
          ...(skipDenoise !== undefined ? { skipDenoise } : {}),
          ...(selectedReferences && typeof selectedReferences === 'object' && !Array.isArray(selectedReferences)
            ? { selectedReferences }
            : {}),
          ...(sourceDatasetStats && typeof sourceDatasetStats === 'object' && !Array.isArray(sourceDatasetStats)
            ? { sourceDatasetStats }
            : {}),
          ...(notifyUrl ? { testVoiceUrl: notifyUrl } : {}),
        },
      }));
    }

    if (method === 'GET' && routePath.endsWith('/train/current')) {
      let owner = null;
      if (authRequired(env)) {
        owner = await resolveOwner(event, {});
      }
      try {
        const state = await readTrainingState();
        if (!owner) return ok(state);
        if (state?.expName && ownsVoiceName(owner.email, state.expName)) {
          return ok({ ...state, mine: true, busy: isTrainingBusy(state) });
        }
        if (isTrainingBusy(state)) return ok(publicTrainingSummary(state));
        return ok({ sessionId: null, status: 'idle', busy: false, mine: false, steps: [], logs: [] });
      } catch (error) {
        return ok({
          sessionId: null,
          status: 'idle',
          steps: [],
          logs: [],
          workerAvailable: false,
          message: error.message,
        });
      }
    }

    if (method === 'GET' && routePath.includes('/train/metadata/')) {
      const expName = decodeSegment(routePath.split('/train/metadata/')[1]?.replace(/\/$/u, ''));
      if (!expName || !isSafePathSegment(expName)) {
        return err(400, 'Invalid experiment name');
      }
      const raw = await readObject(`training/runs/${expName}/metadata.json`);
      if (!raw) {
        return err(404, `Training metadata not found for ${expName}`);
      }
      return ok({ expName, metadata: JSON.parse(raw.toString('utf-8')) });
    }

    return err(404, 'Not found');
  } catch (error) {
    if (error?.statusCode) return err(error.statusCode, error.message);
    return err(500, error.message);
  }
};
}

export const handler = createHandler();
