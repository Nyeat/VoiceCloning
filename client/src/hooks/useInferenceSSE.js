import { useState, useEffect, useRef, useCallback } from 'react';
import { connectInferenceSSE } from '../services/sse.js';

export function useInferenceSSE() {
  const [status, setStatus] = useState('idle'); // idle | waiting | generating | complete | error | cancelled
  const [totalChunks, setTotalChunks] = useState(0);
  const [completedChunks, setCompletedChunks] = useState(0);
  const [chunks, setChunks] = useState([]);
  const [currentChunkText, setCurrentChunkText] = useState('');
  const [error, setError] = useState(null);
  // True while the progress stream is down (GPU stopped, booting, or network).
  const [connectionLost, setConnectionLost] = useState(false);
  const esRef = useRef(null);

  const hydrate = useCallback((initialState = {}) => {
    const {
      initialStatus = 'idle',
      initialTotalChunks = 0,
      initialCompletedChunks = 0,
      initialChunks = [],
      initialCurrentChunkText = '',
      initialError = null,
    } = initialState;

    setStatus(initialStatus);
    setTotalChunks(initialTotalChunks);
    setCompletedChunks(initialCompletedChunks);
    setChunks(initialChunks);
    setCurrentChunkText(initialCurrentChunkText);
    setError(initialError);
    setConnectionLost(false);
  }, []);

  const connect = useCallback((sessionId, initialState = {}) => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    hydrate({
      initialStatus: initialState.initialStatus || 'waiting',
      initialTotalChunks: initialState.initialTotalChunks || 0,
      initialCompletedChunks: initialState.initialCompletedChunks || 0,
      initialChunks: Array.isArray(initialState.initialChunks) ? initialState.initialChunks : [],
      initialCurrentChunkText: initialState.initialCurrentChunkText || '',
      initialError: initialState.initialError || null,
    });

    esRef.current = connectInferenceSSE(sessionId, {
      onConnectionChange({ state }) {
        setConnectionLost(state === 'lost');
      },
      onStart(data) {
        setStatus('generating');
        setTotalChunks(data.totalChunks || 0);
        setChunks(Array.isArray(data.chunks) ? data.chunks : []);
      },
      onChunkStart(data) {
        setStatus('generating');
        setCurrentChunkText(data.text);
      },
      onChunkComplete(data) {
        setCompletedChunks(data.index + 1);
        setChunks((current) => current.map((chunk) => (
          chunk.index === data.index
            ? {
              ...chunk,
              attempts: data.attempts,
              fallback: data.fallback === true,
              fallbackReason: data.fallbackReason || '',
            }
            : chunk
        )));
      },
      onComplete() {
        setStatus('complete');
        setCurrentChunkText('');
      },
      onError(data) {
        const isCancelled = data?.message?.includes('cancelled');
        setStatus(isCancelled ? 'cancelled' : 'error');
        setError(data?.message || 'Unknown error');
        setCurrentChunkText('');
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

  return {
    status,
    totalChunks,
    completedChunks,
    chunks,
    currentChunkText,
    error,
    connectionLost,
    connect,
    disconnect,
    hydrate,
    reset,
  };
}
