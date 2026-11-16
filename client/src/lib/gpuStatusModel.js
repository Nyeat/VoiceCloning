// Pure rules behind the GPU badge and the "starting" overlay, kept out of React
// so they can be tested. Two problems they fix:
//   1. One slow or failed status poll used to flip a ready GPU back to
//      "warming up" (and re-open the full-screen overlay) for a few seconds.
//   2. A stopped GPU read "Starting" on pages that never start it themselves.

// Consecutive not-ready polls needed before a GPU that was ready is shown as
// not ready again. EC2 saying stopping/stopped is believed immediately.
export const READY_MISS_TOLERANCE = 2;

const DOWN_STATES = new Set(['stopping', 'shutting-down', 'stopped', 'terminated']);

export function smoothGpuStatus(previous, next, misses = 0) {
  if (!next) return { status: previous || null, misses };
  if (next.workerReady || !previous?.workerReady) return { status: next, misses: 0 };
  if (DOWN_STATES.has(next.state)) return { status: next, misses: 0 };
  const nextMisses = misses + 1;
  if (nextMisses < READY_MISS_TOLERANCE) return { status: previous, misses: nextMisses };
  return { status: next, misses: 0 };
}

// phase: checking | unconfigured | ready | stopped | starting | warming | stopping | unavailable
export function describeGpuStatus({ status, checking = false, starting = false, autoStart = false } = {}) {
  if (checking && !status) {
    return { phase: 'checking', label: 'Checking GPU', detail: 'Checking the GPU status.' };
  }
  if (!status?.configured) {
    return {
      phase: 'unconfigured',
      label: 'GPU not configured',
      detail: status?.message || 'GPU control is not configured.',
    };
  }
  const state = status.state;
  if (status.workerReady) {
    return { phase: 'ready', label: 'GPU ready', detail: 'The GPU is on and ready.' };
  }
  if (state === 'stopping' || state === 'shutting-down') {
    return { phase: 'stopping', label: 'GPU stopping', detail: 'The GPU is shutting down.' };
  }
  if (starting || state === 'pending') {
    return {
      phase: 'starting',
      label: 'Starting GPU',
      detail: 'Powering on the GPU. A cold start takes about a minute.',
    };
  }
  if (state === 'stopped') {
    return autoStart
      ? { phase: 'starting', label: 'Starting GPU', detail: 'The GPU is off and is being started for you.' }
      : {
        phase: 'stopped',
        label: 'GPU stopped',
        detail: status.startable ? 'The GPU is off. Press to start it.' : 'The GPU is off.',
      };
  }
  if (state === 'running') {
    return {
      phase: 'warming',
      label: 'GPU warming up',
      detail: 'The GPU is on and its voice engine is loading.',
    };
  }
  return {
    phase: 'unavailable',
    label: 'GPU status unavailable',
    detail: status.message || 'Could not reach the GPU. Retrying.',
  };
}
