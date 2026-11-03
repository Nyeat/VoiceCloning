import { useState, useEffect, useRef, useCallback } from 'react';
import { connectSSE } from '../services/sse.js';

const STEP_NAMES = [
  'Slice Audio',
  'Denoise',
  'ASR (Speech Recognition)',
  'Extract Text Features',
  'Extract HuBERT Features',
  'Extract Speaker Verification',
  'Extract Semantic Features',
  'Train SoVITS',
  'Train GPT',
];

function createDefaultSteps() {
  return STEP_NAMES.map((name, i) => ({ index: i, name, status: 'pending', detail: '' }));
}

export function useSSE() {
  const [logs, setLogs] = useState([]);
  const [steps, setSteps] = useState(createDefaultSteps);
  const [pipelineStatus, setPipelineStatus] = useState('idle'); // idle | waiting | running | complete | error | stopped
  const [error, setError] = useState(null);
  // True while the progress stream is down (GPU stopped, booting, or network).
  const [connectionLost, setConnectionLost] = useState(false);
  const esRef = useRef(null);

  const hydrate = useCallback((initialState = {}) => {
    const {
      initialLogs = [],
      initialSteps = createDefaultSteps(),
      initialStatus = 'idle',
      initialError = null,
    } = initialState;

    setLogs(Array.isArray(initialLogs) ? initialLogs : []);
    setSteps(Array.isArray(initialSteps) && initialSteps.length > 0 ? initialSteps : createDefaultSteps());
    setPipelineStatus(initialStatus);
    setError(initialError);
    setConnectionLost(false);
  }, []);

  const connect = useCallback((sessionId, initialState = {}) => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    hydrate({ ...initialState, initialStatus: initialState.initialStatus || 'running' });

    esRef.current = connectSSE(sessionId, {
      onConnectionChange({ state }) {
        setConnectionLost(state === 'lost');
      },
      onLog(data) {
        setLogs(prev => [...prev, data]);
      },
      onStepStart(data) {
        setSteps(prev => prev.map(s =>
          s.index === data.step ? { ...s, status: data.status || 'running', detail: data.detail || '' } : s
        ));
      },
      onStepComplete(data) {
        setSteps(prev => prev.map(s =>
          s.index === data.step ? { ...s, status: data.code === 0 ? 'done' : 'error' } : s
        ));
      },
      onComplete() {
        setPipelineStatus('complete');
      },
      onError(data) {
        const nextStatus = data?.message === 'Training stopped by user' ? 'stopped' : 'error';
        setError(data?.message || null);
        setPipelineStatus(nextStatus);
        setSteps(prev => prev.map(s =>
          s.status === 'running' ? { ...s, status: nextStatus === 'stopped' ? 'pending' : 'error' } : s
        ));
      },
    });
  }, [hydrate]);

  const disconnect = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    disconnect();
    hydrate();
  }, [disconnect, hydrate]);

  useEffect(() => {
    return () => disconnect();
  }, [disconnect]);

  return { logs, steps, pipelineStatus, error, connectionLost, connect, disconnect, hydrate, reset };
}

export { STEP_NAMES };
