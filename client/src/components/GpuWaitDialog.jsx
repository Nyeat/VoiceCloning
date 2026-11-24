import React, { useEffect, useRef, useState } from 'react';
import { Loader2, PowerOff, X } from 'lucide-react';
import { useGpuStatus } from '@/lib/gpuStatus.jsx';
import { describeGpuStatus } from '@/lib/gpuStatusModel';

// Rough timings for a stopped fixed GPU, both measured from the moment it was
// powered on (EC2 power-on, then the worker loading its engine). Estimates
// only; the dialog closes on the real ready flag.
const INSTANCE_WAIT = {
  starting: { title: 'Starting the GPU', estimateSeconds: 240, maxSeconds: 480,
    message: 'The GPU was off to save cost and is powering on now. Everything unlocks automatically once it is ready — you can keep browsing meanwhile.' },
  warming: { title: 'GPU warming up', estimateSeconds: 240, maxSeconds: 480,
    message: 'The GPU is on and its voice engine is loading. Everything unlocks automatically once it is ready.' },
};

// Waits and dismissals survive a page reload in this tab. Storage can be
// blocked (private mode, previews), so every access is best effort.
const EPISODE_STORAGE_KEY = 'vcs-gpu-wait-episode';
const DISMISSED_STORAGE_KEY = 'vcs-gpu-wait-dismissed';

function readStored(key) {
  try { return JSON.parse(window.sessionStorage.getItem(key) || 'null'); } catch { return null; }
}

function writeStored(key, value) {
  try {
    if (value == null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage unavailable: the wait still works, it just restarts on reload */ }
}

// One wait per not-ready episode of the shared GPU (stopped → starting →
// warming → ready). Dismissing it covers the whole episode; a later idle stop
// and restart is a new episode and shows again. A stopped GPU nobody is
// starting (dev manual mode) is not a wait, so nothing shows. The timer runs
// from the GPU's real power-on time (shared by everyone, survives a reload);
// before the GPU reports it, from when this tab first saw the wait.
export function useGpuInstanceWait() {
  const { status, checking, starting, autoStart } = useGpuStatus();
  const view = describeGpuStatus({ status, checking, starting, autoStart });
  const episodeRef = useRef(null);
  const waiting = view.phase === 'starting' || view.phase === 'warming';
  if (!waiting) {
    if (view.phase === 'ready' || view.phase === 'stopped') {
      episodeRef.current = null;
      writeStored(EPISODE_STORAGE_KEY, null);
    }
    return null;
  }
  if (!episodeRef.current) {
    const stored = readStored(EPISODE_STORAGE_KEY);
    const firstSeenAt = Number(stored?.startedAt) > 0 ? Number(stored.startedAt) : Date.now();
    episodeRef.current = { key: stored?.key || `gpu-${firstSeenAt}`, startedAt: firstSeenAt };
    writeStored(EPISODE_STORAGE_KEY, episodeRef.current);
  }
  const launchedAt = Number(status?.launchedAt) || 0;
  const startedAt = launchedAt > 0 ? Math.min(launchedAt, Date.now()) : episodeRef.current.startedAt;
  return { ...INSTANCE_WAIT[view.phase], key: episodeRef.current.key, startedAt };
}

// The GPU is turned off on purpose (administrator pause, or outside the GPU
// schedule) and nothing will start it, so the site is not for use. One screen
// for every build — lectures, Faculty, Live Fast, Training — and it clears by
// itself when the GPU is allowed back on (the status keeps polling).
export function GpuClosedNotice() {
  const { status, checking, starting, autoStart } = useGpuStatus();
  const view = describeGpuStatus({ status, checking, starting, autoStart });
  if (view.phase !== 'closed') return null;
  return (
    <div className="fixed inset-0 z-[96] flex items-center justify-center bg-slate-950/70 px-6 backdrop-blur-md">
      <div className="w-full max-w-sm rounded-xl border border-white/10 bg-white p-8 text-center shadow-2xl" role="alert">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-slate-100">
          <PowerOff size={26} className="text-slate-600" />
        </div>
        <h1 className="text-lg font-semibold text-slate-900">
          {view.reason === 'schedule' ? 'Outside GPU hours' : 'Voice features are off'}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-600">{view.detail}</p>
        <p className="mt-3 text-xs text-slate-400">This page reopens by itself when the GPU is back on.</p>
      </div>
    </div>
  );
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

function formatEstimate(seconds) {
  if (seconds < 60) return `about ${Math.max(5, Math.round(seconds / 5) * 5)} seconds`;
  const minutes = Math.round(seconds / 60);
  return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

// Centred, dismissible notice for anything that makes a person wait on a GPU:
// a GPU powering on, a worker loading, or a voice being started/switched.
// `wait` = { key, title, message, estimateSeconds, maxSeconds, startedAt }.// Dismissing hides it for that `key` only; a new wait (different key) shows again.
// The page keeps its own inline status, so dismissing never hides the state.
export function GpuInstanceWaitDialog() {
  return <GpuWaitDialog wait={useGpuInstanceWait()} />;
}

export default function GpuWaitDialog({ wait }) {
  // Keys are stable across a reload (server start times), so a popup closed
  // before a refresh stays closed (shown as the pill) after it.
  // A list, since a page can show more than one wait (GPU start + voice switch).
  const [dismissedKeys, setDismissedKeys] = useState(() => {
    const stored = readStored(DISMISSED_STORAGE_KEY);
    return Array.isArray(stored) ? stored : [];
  });
  const setDismissedKey = (key) => {
    setDismissedKeys((current) => {
      // Merge with storage: another dialog on the page keeps its own list.
      const stored = readStored(DISMISSED_STORAGE_KEY);
      const base = Array.from(new Set([...(Array.isArray(stored) ? stored : []), ...current]));
      const others = base.filter((item) => item !== wait?.key);
      const next = key ? [...others, key].slice(-10) : others;
      writeStored(DISMISSED_STORAGE_KEY, next);
      return next;
    });
  };
  const [now, setNow] = useState(() => Date.now());
  const open = Boolean(wait) && !dismissedKeys.includes(wait.key);
  // Dismissed but still waiting: a small pill brings the popup back.
  const minimized = Boolean(wait) && !open;

  useEffect(() => {
    if (!wait) return undefined;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    if (!open) return () => window.clearInterval(id);
    const onKey = (event) => { if (event.key === 'Escape') setDismissedKey(wait.key); };
    window.addEventListener('keydown', onKey);
    return () => { window.clearInterval(id); window.removeEventListener('keydown', onKey); };
  }, [open, wait?.key]);

  if (!wait) return null;

  if (minimized) {
    const waited = Math.max(0, (now - (Number(wait.startedAt) || now)) / 1000);
    return (
      <button
        type="button"
        onClick={() => setDismissedKey('')}
        className="fixed bottom-4 right-4 z-[95] inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-800 shadow-lg hover:bg-slate-50"
        aria-label="Getting resources ready. Show details"
      >
        <Loader2 size={15} className="animate-spin text-primary" aria-hidden="true" />
        <span>Getting resources ready</span>
        <span className="tabular-nums text-slate-500">{formatDuration(waited)}</span>
        <span className="text-primary">Show</span>
      </button>
    );
  }

  const estimate = Math.max(1, Number(wait.estimateSeconds) || 60);
  const max = Math.max(estimate, Number(wait.maxSeconds) || estimate);
  const elapsed = Math.max(0, (now - (Number(wait.startedAt) || now)) / 1000);
  // Never reach 100% before it is ready; slow down past the estimate.
  const progress = elapsed <= estimate
    ? (elapsed / estimate) * 85
    : 85 + Math.min(1, (elapsed - estimate) / Math.max(1, max - estimate)) * 10;
  const remaining = estimate - elapsed;

  // Owner 2026-11-24: one plain message for every wait (GPU starting, engine
  // loading, voice switching): "Getting resources ready", how long, and that's it.
  return (
    <div className="fixed inset-0 z-[96] flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="gpu-wait-title"
        className="relative w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-2xl"
      >
        <button
          type="button"
          onClick={() => setDismissedKey(wait.key)}
          className="absolute right-3 top-3 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          aria-label="Dismiss"
        >
          <X size={16} />
        </button>
        <Loader2 size={32} className="mx-auto animate-spin text-primary" aria-hidden="true" />
        <h2 id="gpu-wait-title" className="mt-3 text-lg font-semibold tracking-tight text-slate-900">Getting resources ready</h2>
        <p className="mt-1 text-sm text-slate-600" aria-live="polite">
          {remaining > 0 ? `About ${formatEstimate(remaining).replace('about ', '')} left.` : 'Almost there.'} This closes by itself.
        </p>
        <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full bg-primary transition-[width] duration-1000 ease-linear" style={{ width: `${progress}%` }} />
        </div>
        <button
          type="button"
          onClick={() => setDismissedKey(wait.key)}
          className="mt-5 inline-flex h-10 items-center rounded-lg px-5 text-sm font-semibold text-slate-600 hover:bg-slate-100"
        >
          OK
        </button>
      </div>
    </div>
  );
}
