import {
  isRetryableSynthesisError,
  synthesisRetryDelayMs,
} from './backendErrors.js';

export const CAPACITY_RETRY_INTERVAL_MS = 15_000;
export const CAPACITY_RETRY_MAX_MS = 20 * 60 * 1000;

export function isAutoRetryableCapacityError(err) {
  return [
    'MODEL_CAPACITY_STARTING',
    'MODEL_QUEUE_FULL',
    'MODEL_QUEUE_TIMEOUT',
    'MODEL_ADMISSION_BUSY',
  ].includes(err?.code);
}

export async function runSynthesisWithRetry(run, {
  isCancelled = () => false,
  onCapacityWait = () => {},
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  transientAttempts = 3,
  capacityRetryIntervalMs = CAPACITY_RETRY_INTERVAL_MS,
  capacityRetryMaxMs = CAPACITY_RETRY_MAX_MS,
  // The backend's retryAfterSeconds is a worst case (a cold boot). An
  // interactive caller can poll sooner, because a voice switch on a warm GPU
  // usually finishes in seconds.
  // Never sleep longer than one regular poll: staging's cold-boot hint is 600 s,
  // which left a chat reply silent for ten minutes behind a 10 s voice switch.
  maxCapacityWaitMs = CAPACITY_RETRY_INTERVAL_MS,
} = {}) {
  let transientAttempt = 0;
  let capacityWaitStartedAt = null;

  while (true) {
    try {
      return await run();
    } catch (err) {
      if (isCancelled()) throw err;

      if (isAutoRetryableCapacityError(err)) {
        capacityWaitStartedAt ??= now();
        if (now() - capacityWaitStartedAt < capacityRetryMaxMs) {
          onCapacityWait(err);
          const hintedRetryMs = Number(err?.retryAfterSeconds || 0) * 1_000;
          const capacityWaitMs = hintedRetryMs > 0 ? Math.max(1_000, hintedRetryMs) : capacityRetryIntervalMs;
          await wait(Math.min(capacityWaitMs, maxCapacityWaitMs));
          if (isCancelled()) throw err;
          continue;
        }
        throw err;
      }

      if (
        !isRetryableSynthesisError(err)
        || transientAttempt >= transientAttempts - 1
      ) {
        throw err;
      }
      await wait(synthesisRetryDelayMs(err, transientAttempt));
      if (isCancelled()) throw err;
      transientAttempt += 1;
    }
  }
}
