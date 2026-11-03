function baseUrl() {
  const GPU_WORKER_URL = process.env.GPU_WORKER_URL || '';
  if (!GPU_WORKER_URL) {
    throw new Error('GPU_WORKER_URL env var is not set');
  }
  return GPU_WORKER_URL.replace(/\/+$/u, '');
}

function publicBaseUrl() {
  const url = process.env.GPU_WORKER_PUBLIC_URL || process.env.GPU_WORKER_URL || '';
  if (!url) {
    throw new Error('GPU_WORKER_PUBLIC_URL or GPU_WORKER_URL env var is not set');
  }
  return url.replace(/\/+$/u, '');
}

function inferenceBaseUrl() {
  const url = process.env.INFERENCE_WORKER_URL || process.env.GPU_WORKER_URL || '';
  if (!url) {
    throw new Error('INFERENCE_WORKER_URL env var is not set');
  }
  return url.replace(/\/+$/u, '');
}

function inferencePublicBaseUrl() {
  const url = process.env.INFERENCE_WORKER_PUBLIC_URL
    || process.env.INFERENCE_WORKER_URL
    || process.env.GPU_WORKER_PUBLIC_URL
    || process.env.GPU_WORKER_URL
    || '';
  if (!url) {
    throw new Error('No inference worker public URL configured');
  }
  return url.replace(/\/+$/u, '');
}

// Every ALB listener rule requires this header, so the GPU workers cannot be
// reached by calling the public ALB directly. CloudFront adds the same value as
// an origin custom header; Lambda adds it here.
export function originVerifyHeaders(env = process.env) {
  const value = String(env.ALB_ORIGIN_VERIFY_VALUE || '').trim();
  return value ? { 'X-VCS-Origin-Verify': value } : {};
}

// CloudFront gives up on the Lambda origin after 60 s. Every worker call must
// finish (or fail with a clear error) before that, otherwise the browser sees a
// bare 504 while the GPU keeps working and the user retries into duplicate work.
export function workerDeadlineMs(env = process.env) {
  const parsed = Number.parseInt(env.WORKER_REQUEST_DEADLINE_MS || '55000', 10);
  return Number.isFinite(parsed) ? Math.min(58_000, Math.max(1_000, parsed)) : 55_000;
}

function timeoutError(routePath, ms) {
  const error = new Error(`GPU worker did not answer ${routePath} within ${Math.round(ms / 1000)} s. It may still be starting or busy; please try again.`);
  error.statusCode = 504;
  error.code = 'WORKER_TIMEOUT';
  return error;
}

function safePath(url) {
  try { return new URL(url).pathname; } catch { return 'the GPU worker'; }
}

export async function workerFetch(url, options = {}, { fetchImpl = fetch, timeoutMs = workerDeadlineMs(), routePath = safePath(url) } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      ...options,
      headers: { ...(options.headers || {}), ...originVerifyHeaders() },
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw timeoutError(routePath, timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function upstreamError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function capacityRetryBudgetMs() {
  // Capacity retries plus one synthesis must fit inside the CloudFront origin
  // timeout, so the retry window is capped well below it.
  const parsed = Number.parseInt(process.env.INFERENCE_CAPACITY_RETRY_MS || '20000', 10);
  return Number.isFinite(parsed) ? Math.min(30_000, Math.max(0, parsed)) : 20_000;
}

function isCapacityStatus(status) {
  return status === 429 || status === 503;
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const capacityRetryMetadata = new WeakMap();

export function getCapacityRetryMetadata(response) {
  return capacityRetryMetadata.get(response) || { retryCount: 0, retrySleepMs: 0 };
}

export async function fetchInferenceWithCapacityRetry(routePath, options, {
  fetchImpl = fetch,
  waitImpl = wait,
  now = Date.now,
} = {}) {
  const startedAt = now();
  const budgetMs = capacityRetryBudgetMs();
  let attempt = 0;
  let retrySleepMs = 0;
  const deadlineMs = workerDeadlineMs();
  while (true) {
    const remainingMs = Math.max(1_000, deadlineMs - (now() - startedAt));
    const response = await workerFetch(`${inferenceBaseUrl()}${routePath}`, {
      ...options,
      headers: {
        ...(options.headers || {}),
        ...(attempt > 0 ? { 'X-VCS-Capacity-Retry': String(attempt) } : {}),
      },
    }, { fetchImpl, timeoutMs: remainingMs, routePath });
    if (!isCapacityStatus(response.status)) {
      capacityRetryMetadata.set(response, { retryCount: attempt, retrySleepMs });
      return response;
    }

    const elapsed = now() - startedAt;
    const retryAfterSeconds = Number(response.headers.get('retry-after'));
    const exponentialMs = Math.min(2_000, 250 * (2 ** attempt));
    const delayMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? Math.min(5_000, retryAfterSeconds * 1_000)
      : exponentialMs;
    if (elapsed + delayMs > budgetMs) {
      capacityRetryMetadata.set(response, { retryCount: attempt, retrySleepMs });
      return response;
    }

    // Consume the response before retrying so Node can reuse the ALB connection.
    await response.arrayBuffer();
    await waitImpl(delayMs);
    retrySleepMs += delayMs;
    attempt += 1;
  }
}

export async function gpuPost(routePath, body = {}) {
  const response = await workerFetch(`${baseUrl()}${routePath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await parseResponse(response);
  if (!response.ok) {
    throw new Error(data.error || data.message || `GPU Worker POST ${routePath} failed (${response.status})`);
  }
  return data;
}

export async function gpuGet(routePath) {
  const response = await workerFetch(`${baseUrl()}${routePath}`, {}, { routePath });
  const data = await parseResponse(response);
  if (!response.ok) {
    throw new Error(data.error || data.message || `GPU Worker GET ${routePath} failed (${response.status})`);
  }
  return data;
}

export function gpuPublicUrl(routePath) {
  const normalizedPath = routePath.startsWith('/') ? routePath : `/${routePath}`;
  return `${publicBaseUrl()}${normalizedPath}`;
}

export async function gpuPostBinary(routePath, body = {}) {
  const response = await workerFetch(`${baseUrl()}${routePath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await parseResponse(response);
    throw new Error(data.error || data.message || `GPU Worker POST ${routePath} failed (${response.status})`);
  }
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || 'application/octet-stream',
    queueWaitMs: response.headers.get('x-synthesis-queue-wait-ms'),
  };
}

export async function inferencePost(routePath, body = {}, extraHeaders = {}) {
  const response = await workerFetch(`${inferenceBaseUrl()}${routePath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
  const data = await parseResponse(response);
  if (!response.ok) {
    throw upstreamError(data.error || data.message || `Inference Worker POST ${routePath} failed (${response.status})`, response.status);
  }
  return data;
}

// The staging ALB Target Optimizer caps concurrent requests per GPU, and a
// status/model poll counts against that cap like a synthesis does. A poll that
// lands while both slots are busy gets a bare 503, which the UI used to show as
// "voice engine unavailable" for a few seconds. GETs are idempotent, so retry
// them briefly before reporting the worker down.
export async function fetchIdempotentWithRetry(url, { routePath, fetchImpl = fetch, waitImpl = wait, delaysMs = [250, 600] } = {}) {
  let response = await workerFetch(url, {}, { routePath, fetchImpl });
  for (const delayMs of delaysMs) {
    if (response.status !== 503) return response;
    await response.arrayBuffer().catch(() => {});
    await waitImpl(delayMs);
    response = await workerFetch(url, {}, { routePath, fetchImpl });
  }
  return response;
}

export async function inferenceGet(routePath) {
  const response = await fetchIdempotentWithRetry(`${inferenceBaseUrl()}${routePath}`, { routePath });
  const data = await parseResponse(response);
  if (!response.ok) {
    throw upstreamError(data.error || data.message || `Inference Worker GET ${routePath} failed (${response.status})`, response.status);
  }
  return data;
}

export function inferencePublicUrl(routePath) {
  const normalizedPath = routePath.startsWith('/') ? routePath : `/${routePath}`;
  return `${inferencePublicBaseUrl()}${normalizedPath}`;
}

export async function inferencePostBinary(routePath, body = {}, extraHeaders = {}) {
  const response = await fetchInferenceWithCapacityRetry(routePath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await parseResponse(response);
    throw upstreamError(data.error || data.message || `Inference Worker POST ${routePath} failed (${response.status})`, response.status);
  }
  const { retryCount, retrySleepMs } = getCapacityRetryMetadata(response);
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || 'application/octet-stream',
    queueWaitMs: response.headers.get('x-synthesis-queue-wait-ms'),
    capacityRetryCount: retryCount,
    capacityRetrySleepMs: retrySleepMs,
  };
}

export async function inferenceGetBinary(routePath) {
  const response = await workerFetch(`${inferenceBaseUrl()}${routePath}`, {}, { routePath });
  if (!response.ok) {
    const data = await parseResponse(response);
    throw upstreamError(data.error || data.message || `Inference Worker GET ${routePath} failed (${response.status})`, response.status);
  }
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || 'application/octet-stream',
  };
}
