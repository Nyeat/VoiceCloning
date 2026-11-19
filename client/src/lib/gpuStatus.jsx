import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { getInstanceStatus, startInstance } from '../services/api.js';
import { cacheGpuReadyStatus, readCachedGpuReadyStatus } from './gpuReadyCache.js';
import { smoothGpuStatus } from './gpuStatusModel.js';

const GpuStatusContext = createContext(null);

// Only the fields the UI actually reacts to. Background polls that come back
// identical must NOT replace state (which would re-render every consumer, incl.
// the big LivePage, mid-conversation and cause audible hitches).
function sameStatus(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.configured === b.configured
    && a.state === b.state
    && a.workerReady === b.workerReady
    && a.startable === b.startable
    && (a.closed || '') === (b.closed || '')
    && (a.message || '') === (b.message || '');
}

// Single source of truth for the shared GPU instance lifecycle. Both the header
// button and the full-screen "starting" overlay read from here, and pages gate
// their backend calls on `workerReady` so we never fire model/status requests at
// a cold GPU (which is what surfaced the raw 503 / 404 error banners).
export function GpuStatusProvider({ children, autoStart = false, target = '' }) {
  const cachedStatus = useMemo(() => readCachedGpuReadyStatus(), []);
  const [status, setStatus] = useState(cachedStatus);
  const [checking, setChecking] = useState(!cachedStatus);
  const [starting, setStarting] = useState(false);
  const autoStartedRef = useRef(false);
  const readyMissesRef = useRef(0);

  // Applies the not-ready hysteresis so one slow poll cannot flip a ready GPU
  // back to "warming up" and re-open the overlay.
  const applyStatus = useCallback((next) => {
    setStatus((prev) => {
      const smoothed = smoothGpuStatus(prev, next, readyMissesRef.current);
      readyMissesRef.current = smoothed.misses;
      cacheGpuReadyStatus(smoothed.status);
      return sameStatus(prev, smoothed.status) ? prev : smoothed.status;
    });
  }, []);
  const prevWorkerReadyRef = useRef(false);

  // `background: true` for interval polls — they don't touch `checking` and only
  // update state when something actually changed, so a steady "running/ready" GPU
  // produces zero re-renders while a conversation is live.
  const refreshStatus = useCallback(async ({ background = false } = {}) => {
    if (!background) setChecking(true);
    try {
      const res = await getInstanceStatus(target);
      applyStatus(res.data);
    } catch (err) {
      const next = {
        configured: true,
        state: 'unavailable',
        workerReady: false,
        startable: false,
        message: err.response?.data?.error || err.message || 'Could not check GPU instance status.',
      };
      applyStatus(next);
    } finally {
      if (!background) setChecking(false);
    }
  }, [applyStatus, target]);

  const start = useCallback(async () => {
    setStarting(true);
    try {
      const res = await startInstance();
      cacheGpuReadyStatus(res.data);
      setStatus(res.data);
      window.setTimeout(refreshStatus, 5000);
    } catch (err) {
      setStatus((current) => {
        const next = {
          ...(current || {}),
          configured: true,
          state: current?.state || 'unknown',
          workerReady: false,
          startable: false,
          message: err.response?.data?.error || err.message || 'Could not start GPU instance.',
        };
        cacheGpuReadyStatus(next);
        return next;
      });
    } finally {
      setStarting(false);
    }
  }, [refreshStatus]);

  useEffect(() => {
    refreshStatus({ background: Boolean(cachedStatus?.workerReady) });
  }, [refreshStatus, cachedStatus]);

  // Poll the instance state continuously. Fast while we're waiting for it to come
  // up; slower once ready — but we keep polling so an idle auto-stop is detected
  // (which then re-shows the overlay and re-triggers auto-start).
  useEffect(() => {
    if (!status?.configured) return undefined;
    const cadence = status.workerReady ? 20000 : 3000;
    const id = window.setInterval(() => refreshStatus({ background: true }), cadence);
    return () => window.clearInterval(id);
  }, [status?.configured, status?.workerReady, status?.state, refreshStatus]);

  // Auto-start the GPU whenever we see it stopped — both the first entry and, if
  // the user is still on the page after an idle auto-stop, a restart. The guard is
  // reset once the worker becomes ready (below), so each fresh "stopped" episode
  // triggers exactly one start() instead of hammering it.
  useEffect(() => {
    if (!autoStart) return;
    if (autoStartedRef.current) return;
    if (!status?.configured) return;
    if (status.workerReady || starting) return;
    if (status.startable && status.state === 'stopped') {
      autoStartedRef.current = true;
      start();
    }
  }, [autoStart, status?.configured, status?.workerReady, status?.startable, status?.state, starting, start]);

  // Notify pages the moment the worker flips ready so they can (re)load models, and
  // re-arm auto-start so a subsequent idle stop is picked up.
  useEffect(() => {
    const ready = Boolean(status?.workerReady);
    if (ready && !prevWorkerReadyRef.current) {
      autoStartedRef.current = false;
      window.dispatchEvent(new Event('voice-cloning-gpu-ready'));
    }
    prevWorkerReadyRef.current = ready;
  }, [status?.workerReady]);

  // Memoized so the provider only pushes a new context value when something the UI
  // cares about changed — a no-op background poll won't re-render consumers.
  const value = useMemo(() => ({
    status,
    checking,
    starting,
    workerReady: Boolean(status?.workerReady),
    configured: Boolean(status?.configured),
    autoStart,
    refreshStatus,
    start,
  }), [status, checking, starting, autoStart, refreshStatus, start]);

  return <GpuStatusContext.Provider value={value}>{children}</GpuStatusContext.Provider>;
}

export function useGpuStatus() {
  return useContext(GpuStatusContext) || {
    status: null,
    checking: false,
    starting: false,
    workerReady: false,
    configured: false,
    autoStart: false,
    refreshStatus: () => {},
    start: () => {},
  };
}
