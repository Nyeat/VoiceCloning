import { resolveWorkerPath } from '@/lib/runtimeConfig';
import { openResilientStream } from '@/lib/resilientStream';

export { openResilientStream };

function parse(event) {
  try {
    return JSON.parse(event.data);
  } catch {
    return {};
  }
}

export function connectSSE(sessionId, { onLog, onStepStart, onStepComplete, onComplete, onError, onConnectionChange }) {
  return openResilientStream(resolveWorkerPath(`/train/progress/${sessionId}`), {
    log: (e) => onLog?.(parse(e)),
    'step-start': (e) => onStepStart?.(parse(e)),
    'step-complete': (e) => onStepComplete?.(parse(e)),
    'pipeline-complete': (e, stream) => {
      onComplete?.(parse(e));
      stream.close();
    },
    // Custom 'pipeline-error' event from our server (not a connection error).
    error: (e, stream) => {
      if (!e.data) return;
      onError?.(parse(e));
      stream.close();
    },
  }, { onConnectionChange });
}

export function connectInferenceSSE(sessionId, { onStart, onChunkStart, onChunkComplete, onComplete, onError, onConnectionChange }) {
  return openResilientStream(resolveWorkerPath(`/inference/progress/${sessionId}`), {
    'inference-start': (e) => onStart?.(parse(e)),
    'chunk-start': (e) => onChunkStart?.(parse(e)),
    'chunk-complete': (e) => onChunkComplete?.(parse(e)),
    'inference-complete': (e, stream) => {
      onComplete?.(parse(e));
      stream.close();
    },
    error: (e, stream) => {
      if (!e.data) return;
      onError?.(parse(e));
      stream.close();
    },
  }, { onConnectionChange });
}
