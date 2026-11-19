// The single decoder for a non-200 synthesis response, shared by every synthesis
// route in services/api.js (`/inference`, `/live/tts-sentence`).
//
// It lives here rather than inline in api.js for two reasons. It stays free of the
// `@/` aliases, so the ordering below is directly testable — and that ordering is
// the whole point of the module. And there is now one copy: api.js used to decode
// each route separately, the two copies drifted, and the Live Fast copy never
// learned about MODEL_CAPACITY_*. A voice model that was merely still loading onto
// a healthy GPU was therefore reported to the student as
// "GPU not started — press Start GPU to begin".

// How the model coordinator says "this voice is still loading onto a GPU" / "the
// fleet is at its limit": a 503 carrying its own message and a retry hint.
// `isRetryableSynthesisError` (lib/backendErrors.js) deliberately refuses to retry
// these, so dropping the code costs more than a wrong message — it turns a wait
// into a dead end.
export const CAPACITY_CODES = new Set([
  'MODEL_CAPACITY_STARTING',
  'MODEL_CAPACITY_LIMIT',
  'DEV_CAPACITY_SIMULATED',
  'MODEL_QUEUE_FULL',
  'MODEL_QUEUE_TIMEOUT',
  'MODEL_ADMISSION_BUSY',
]);

// A GPU-down request typically comes back as a 502/503/504 from the reverse proxy
// (often with an HTML body), so detect both the status and the tell-tale HTML text.
export function isGpuOfflineResponse(status, body = '') {
  if ([502, 503, 504].includes(Number(status))) return true;
  return /50[234]|Service (Temporarily )?Unavailable|Bad Gateway|Gateway Time-?out/i.test(String(body));
}

function withStatus(error, status) {
  error.status = Number(status) || 0;
  return error;
}

function capacityError(payload, status) {
  if (!CAPACITY_CODES.has(payload?.code)) return null;
  const error = withStatus(new Error(payload.error || 'This lecture voice is preparing.'), status);
  error.code = payload.code;
  error.retryAfterSeconds = Number(payload.retryAfterSeconds) || 0;
  error.scaleStarted = payload.scaleStarted === true;
  error.voiceProfileId = payload.voiceProfileId || '';
  return error;
}

// `gpuOfflineMessage` is injected, not imported: the gi kiosk and the studio word
// it differently (see GPU_OFFLINE_MESSAGE in services/api.js), and this module
// must not have to know about the app-mode config to say it.
export function synthesisResponseError(text, status, { gpuOfflineMessage = '' } = {}) {
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* non-JSON proxy/CloudFront response */ }

  // Capacity FIRST. isGpuOfflineResponse() matches every 502/503/504 whatever the
  // body says, so any branch placed after it is unreachable for those statuses.
  const capacity = capacityError(payload, status);
  if (capacity) return capacity;

  // Turned off by an administrator: a final answer, not a GPU to wait for.
  if (payload?.code === 'GPU_PAUSED') {
    const error = withStatus(new Error(payload.error || 'Voice features are turned off for now.'), status);
    error.code = 'GPU_PAUSED';
    return error;
  }

  if (isGpuOfflineResponse(status, text)) {
    const error = withStatus(new Error(gpuOfflineMessage), Number(status) || 503);
    error.code = 'GPU_OFFLINE';
    return error;
  }

  const message = payload ? payload.error : text;
  return withStatus(new Error(message || `Request failed with status ${status}`), status);
}
