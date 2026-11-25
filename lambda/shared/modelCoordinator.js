import crypto from 'node:crypto';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { inferencePost, inferencePostBinary, workerDeadlineMs } from './gpuWorker.js';

const client = new LambdaClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });

function functionName() {
  return String(process.env.MODEL_COORDINATOR_FUNCTION_NAME || '').trim();
}

// The browser's CloudFront request gives up at 60 s, so the coordinator call
// must end (with a retryable answer) before that rather than outlive it.
export async function invokeCoordinator(payload, { lambdaClient = client, timeoutMs = workerDeadlineMs() } = {}) {
  const name = functionName();
  if (!name) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await lambdaClient.send(new InvokeCommand({
      FunctionName: name,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(payload)),
    }), { abortSignal: controller.signal });
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    const timeout = new Error('The voice GPU is busy and did not answer in time. Your request will retry shortly.');
    timeout.statusCode = 503;
    timeout.code = 'MODEL_QUEUE_TIMEOUT';
    timeout.retryAfterSeconds = 2;
    throw timeout;
  } finally {
    clearTimeout(timer);
  }
  const raw = Buffer.from(response.Payload || []).toString('utf8');
  let result;
  try { result = raw ? JSON.parse(raw) : {}; } catch { result = { statusCode: 500, error: raw || 'Invalid coordinator response' }; }
  if (response.FunctionError) {
    const error = new Error(result.errorMessage || result.error || 'Model coordinator failed');
    error.statusCode = 503;
    throw error;
  }
  return result;
}

// GPU_PAUSED=true (admin) takes voice synthesis out of use on every site and
// stops selections from waking or scaling the GPU fleet. Same switch and
// wording as the instance status, so pages show one consistent "GPU is off".
export function gpuPausedMessage(env = process.env) {
  if (!/^(1|true|yes|on)$/iu.test(String(env.GPU_PAUSED || '').trim())) return '';
  return String(env.GPU_PAUSED_MESSAGE || '').trim()
    || 'The GPU has been turned off by an administrator, so voice features are unavailable for now. Please try again later.';
}

function throwIfGpuPaused() {
  const message = gpuPausedMessage();
  if (!message) return;
  const error = new Error(message);
  error.statusCode = 503;
  error.code = 'GPU_PAUSED';
  throw error;
}

// Every coordinator answer the browser must recognise to wait/retry instead of
// failing. Must match client/src/lib/synthesisResponse.js CAPACITY_CODES (+
// GPU_PAUSED). A route that forwards only some of them turns a queued-while-a-
// GPU-is-added request into "The voice engine is not ready yet" (2026-11-19
// staging: MODEL_QUEUE_FULL/TIMEOUT reached Test your voice as a bare 503).
export const FORWARDED_CAPACITY_CODES = new Set([
  'MODEL_CAPACITY_STARTING',
  // A voice that cannot speak: the page shows why instead of retrying.
  'VOICE_FAILED',
  'MODEL_CAPACITY_LIMIT',
  'DEV_CAPACITY_SIMULATED',
  'MODEL_QUEUE_FULL',
  'MODEL_QUEUE_TIMEOUT',
  'MODEL_ADMISSION_BUSY',
  'GPU_PAUSED',
]);

// The HTTP response for a coded coordinator error, or null for anything else.
export function capacityErrorResponse(error, corsHeaders = {}) {
  if (!FORWARDED_CAPACITY_CODES.has(error?.code)) return null;
  const status = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
    ? error.statusCode
    : 503;
  const retryAfter = Math.max(1, Number(error.retryAfterSeconds) || 0);
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json',
      ...(error.code === 'GPU_PAUSED' ? {} : { 'Retry-After': String(retryAfter) }),
      ...corsHeaders,
    },
    body: JSON.stringify({
      error: error.message,
      code: error.code,
      ...(error.code === 'GPU_PAUSED' ? {} : {
        retryAfterSeconds: Number(error.retryAfterSeconds) || 0,
        scaleStarted: error.scaleStarted === true,
        voiceProfileId: error.voiceProfileId || '',
      }),
      ...(error.voiceFailure ? { voiceFailure: error.voiceFailure } : {}),
    }),
  };
}

// A voice that cannot speak (coordinator VOICE_FAILED): add the root cause from
// what training left behind, so every site says WHY (owner 2026-11-25).
export async function explainVoiceFailure(failure = {}, { readJson } = {}) {
  const { diagnoseVoiceFailure } = await import('./voiceFailureDiagnosis.js');
  const reader = readJson || (async (key) => {
    const { getObject, headObject } = await import('./s3.js');
    if (!(await headObject(key))) return null;
    return JSON.parse((await getObject(key)).toString('utf-8'));
  });
  try {
    return await diagnoseVoiceFailure(failure.voiceProfileId, { readJson: reader, error: failure.error });
  } catch {
    return diagnoseVoiceFailure('', { error: failure.error });
  }
}
async function withVoiceFailureReason(result) {
  if (!result?.voiceFailure) return result;
  const diagnosis = await explainVoiceFailure(result.voiceFailure);
  return {
    ...result,
    voiceFailure: { ...result.voiceFailure, ...diagnosis },
    message: `${result.message || result.error || 'This voice could not be loaded.'} Reason: ${diagnosis.reason}`,
  };
}

function throwCoordinatorError(result) {
  const error = new Error((result.voiceFailure && result.message) || result.error || `Model coordinator request failed (${result.statusCode || 500})`);
  error.statusCode = Number(result.statusCode) || 500;
  error.code = result.code;
  if (result.voiceFailure) error.voiceFailure = result.voiceFailure;
  error.retryAfterSeconds = result.retryAfterSeconds;
  error.scaleStarted = result.scaleStarted;
  error.voiceProfileId = result.voiceProfileId;
  throw error;
}

export async function coordinatedInferencePostBinary(routePath, body = {}, headers = {}) {
  throwIfGpuPaused();
  if (!functionName()) return inferencePostBinary(routePath, body, headers);
  const result = await invokeCoordinator({ action: 'synthesize', routePath, body, headers });
  if (!result || Number(result.statusCode) >= 400) throwCoordinatorError(await withVoiceFailureReason(result || {}));
  return {
    buffer: Buffer.from(result.bodyBase64 || '', 'base64'),
    contentType: result.contentType || 'application/octet-stream',
    queueWaitMs: result.queueWaitMs,
    capacityRetryCount: 0,
    capacityRetrySleepMs: 0,
    workerId: result.workerId,
  };
}

export async function coordinatedInferencePost(routePath, body = {}, headers = {}) {
  if (routePath !== '/live/cancel') throwIfGpuPaused();
  if (!functionName()) return inferencePost(routePath, body, headers);
  if (routePath === '/live/cancel') {
    const result = await invokeCoordinator({ action: 'cancel', replyToken: body.replyToken });
    if (!result || Number(result.statusCode) >= 400) throwCoordinatorError(result || {});
    return result;
  }
  throwIfGpuPaused();
  const result = await invokeCoordinator({ action: 'synthesize', routePath, body, headers });
  if (!result || Number(result.statusCode) >= 400) throwCoordinatorError(await withVoiceFailureReason(result || {}));
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(result.bodyBase64 || '', 'base64').toString('utf8'));
  } catch {
    const error = new Error('Coordinator returned an invalid JSON worker response');
    error.statusCode = 502;
    throw error;
  }
  return {
    ...parsed,
    coordinatorAdmission: {
      workerId: result.workerId || '',
      queueWaitMs: Number(result.queueWaitMs) || 0,
      capacityAction: result.capacityAction?.type || result.capacityAction || 'none',
      simulated: result.capacityAction?.simulated === true,
    },
  };
}

export async function getCoordinatedModelStatus(body = {}) {
  if (!functionName()) return null;
  return invokeCoordinator({ action: 'status', body });
}

// Read-only load check (coordinator action 'peek'): never records a
// selection, switches or scales, so open pages can poll it.
export async function peekCoordinatedModel(body = {}) {
  if (gpuPausedMessage() || !functionName()) {
    return { statusCode: 200, state: 'UNKNOWN', busy: false };
  }
  const result = await invokeCoordinator({ action: 'peek', body });
  if (!result || Number(result.statusCode) >= 400) throwCoordinatorError(result || {});
  return withVoiceFailureReason(result);
}

// The voice-cloning (training) site, where each person tests only their own
// voices: TRAINING_SITE_ORIGINS, else the origin of TRAINING_PUBLIC_URL. Lecture
// and other sites share voices across many users and never match.
function requestOrigin(event) {
  const headers = event?.headers || {};
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'origin');
  return key ? String(headers[key] || '').trim().replace(/\/+$/u, '') : '';
}

// The admin Text-to-Speech site (TTS_SITE_ORIGINS): one person auditioning
// voices on what is essentially one GPU. Selecting a voice switches an idle GPU
// at once (no 10 min protection) and never adds a GPU while one exists.
export function ttsSiteOption(event, env = process.env) {
  const allowed = String(env.TTS_SITE_ORIGINS || '').split(',')
    .map((origin) => origin.trim().replace(/\/+$/u, '')).filter(Boolean);
  const origin = requestOrigin(event);
  // Voice Studio has its own reserved GPU instead (studioOwnerOption).
  if (isStudioOrigin(origin, env)) return {};
  return origin && allowed.includes(origin) ? { singleGpu: true } : {};
}

// Voice Studio: one person, one GPU (owner decision 2026-11-23). Every key is a
// hard reservation ("reserved:"), so no other site and no other person ever
// switches it while it is in use (35 min since last use; the studio's slot
// keep-alive and the tester's polling refresh it). Inside a key, the owner's
// own voice picks switch at once (no 10 min idle wait).
//  - super users (one shared account): STUDIO_GPU_OWNER;
//  - each lecturer: studioPersonOwner(email) — warmed for their test slot,
//    or cold-started when they test outside it; released after the slot or
//    when they send their feedback.
// Which one a request uses follows who is signed in (studioGpuGuard).
export const STUDIO_GPU_OWNER = 'reserved:studio-qc';
export function studioPersonOwner(email) {
  const key = String(email || '').trim().toLowerCase();
  if (!key) return '';
  return `reserved:studio-p-${crypto.createHash('sha256').update(`vcs-studio:${key}`).digest('hex').slice(0, 20)}`;
}

/** Voices the coordinator marked as unable to speak (any site), with their root cause. */
export async function listVoiceFailures() {
  if (!functionName()) return [];
  const result = await invokeCoordinator({ action: 'voice-failures' });
  if (!result || Number(result.statusCode) >= 400) throwCoordinatorError(result || {});
  return Promise.all((result.failures || []).map(async (failure) => ({ ...failure, ...(await explainVoiceFailure(failure)) })));
}

/** An admin retries a voice marked failed (e.g. after fixing its files). */
export async function clearVoiceFailure(modelKey) {
  const result = await invokeCoordinator({ action: 'clear-voice-failure', modelKey });
  if (result && Number(result.statusCode) >= 400) throwCoordinatorError(result);
  return result;
}

/** Gives an owner's GPUs back; each is removed as soon as nothing runs on it. */
export async function releaseCoordinatedOwner(ownerKey) {
  const result = await invokeCoordinator({ action: 'release', ownerKey });
  if (result && Number(result.statusCode) >= 400) throwCoordinatorError(result);
  return result;
}
function isStudioOrigin(origin, env = process.env) {
  const studio = String(env.STUDIO_SITE_ORIGINS || '').split(',')
    .map((value) => value.trim().replace(/\/+$/u, '')).filter(Boolean);
  return Boolean(origin) && studio.includes(origin);
}
// The prepare option for a Voice Studio caller, from studioGpuAccess's answer.
export function studioOwnerOption(ownerKey = '') {
  return ownerKey ? { ownerKey } : {};
}

export function isTrainingSiteRequest(event, env = process.env) {
  const configured = String(env.TRAINING_SITE_ORIGINS || '').split(',');
  try {
    if (env.TRAINING_PUBLIC_URL) configured.push(new URL(env.TRAINING_PUBLIC_URL).origin);
  } catch { /* ignore a malformed URL */ }
  const allowed = configured.map((origin) => origin.trim().replace(/\/+$/u, '')).filter(Boolean);
  const headers = event?.headers || {};
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'origin');
  const origin = key ? String(headers[key] || '').trim().replace(/\/+$/u, '') : '';
  return Boolean(origin) && allowed.includes(origin);
}

// One person, one GPU on the training site: an opaque key for the signed-in
// account (hash of its Entra object id; no email or name reaches the
// coordinator). '' anywhere else, or when the caller is not signed in.
export async function trainingOwnerKey(event, authGuard, env = process.env) {
  if (!authGuard || !isTrainingSiteRequest(event, env)) return '';
  try {
    const identity = await authGuard.authorize(event);
    if (!identity?.oid || identity.synthetic) return '';
    return crypto.createHash('sha256').update(`vcs-owner:${identity.oid}`).digest('hex').slice(0, 24);
  } catch {
    return '';
  }
}

// `{ ownerKey }` for the prepare options, or {} (keeps other callers unchanged).
export async function trainingOwnerOption(event, authGuard, env = process.env) {
  const ownerKey = await trainingOwnerKey(event, authGuard, env);
  return ownerKey ? { ownerKey } : {};
}

// Every site's GPU has an owner, and only that owner switches it (owner
// 2026-11-23): no other site, person or voice can take a GPU in use, and the
// owner's own voice picks switch it at once. Reserved until 35 min after last
// use (replies keep it fresh), then ordinary capacity again.
//  - Voice Studio: per person (studioGpuAccess) — passed in as studioOwner;
//  - admin Text to Speech: one owner, one GPU;
//  - training site: per signed-in account;
//  - Faculty: per signed-in lecturer;
//  - lectures, GI, Live MC and anything else: per voice (many students share
//    a lecture's GPU; a busy one still overflows to another GPU).
export const TTS_GPU_OWNER = 'reserved:tts';
function ownerHash(prefix, value) {
  return `${prefix}${crypto.createHash('sha256').update(`vcs-owner:${value}`).digest('hex').slice(0, 24)}`;
}
export async function siteOwnerOption(event, {
  authGuard = null, studioOwner = '', voiceProfileId = '', env = process.env,
} = {}) {
  if (studioOwner) return { ownerKey: studioOwner };
  const origin = requestOrigin(event);
  if (isStudioOrigin(origin, env)) return {};
  const tts = ttsSiteOption(event, env);
  if (tts.singleGpu) return { ...tts, ownerKey: TTS_GPU_OWNER };
  if (isTrainingSiteRequest(event, env)) {
    const key = await trainingOwnerKey(event, authGuard, env);
    return key ? { ownerKey: `reserved:train-${key}` } : {};
  }
  const { isFacultyRequest } = await import('./liveAuth.js');
  if (isFacultyRequest(event) && authGuard) {
    try {
      const identity = await authGuard.authorize(event);
      if (identity?.oid && !identity.synthetic) return { ownerKey: ownerHash('reserved:faculty-', identity.oid) };
    } catch { /* not signed in: falls through to the voice */ }
  }
  const id = String(voiceProfileId || '').trim();
  return id ? { ownerKey: ownerHash('reserved:voice-', id) } : {};
}

export async function prepareCoordinatedModel(body = {}, {
  allowScale = false,
  source = 'preflight',
  ownerKey = '',
  singleGpu = false,
} = {}) {
  const pausedMessage = gpuPausedMessage();
  if (pausedMessage) {
    return {
      statusCode: 200,
      state: 'PAUSED',
      canStartConversation: false,
      capacityAction: 'none',
      message: pausedMessage,
      coordinatorConfigured: Boolean(functionName()),
    };
  }
  if (!functionName()) {
    return {
      statusCode: 200,
      state: 'READY',
      canStartConversation: true,
      capacityAction: 'none',
      coordinatorConfigured: false,
    };
  }
  const result = await invokeCoordinator({
    action: 'prepare', body, allowScale, source, ...(ownerKey ? { ownerKey } : {}),
    ...(singleGpu ? { singleGpu: true } : {}),
  });
  if (!result || Number(result.statusCode) >= 400) throwCoordinatorError(result || {});
  return { ...(await withVoiceFailureReason(result)), coordinatorConfigured: true };
}
