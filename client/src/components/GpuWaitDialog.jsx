import React, { useEffect, useRef, useState } from 'react';
import { Clock, Cpu, Loader2, PowerOff, X } from 'lucide-react';
import { useGpuStatus } from '@/lib/gpuStatus.jsx';
import { describeGpuStatus } from '@/lib/gpuStatusModel';

// Rough timings for a stopped fixed GPU: EC2 power-on, then the worker loading
// its engine. Shown as estimates only; the dialog closes on the real ready flag.
const INSTANCE_WAIT = {
  starting: { title: 'Starting the GPU', estimateSeconds: 180, maxSeconds: 360,
    message: 'The GPU was off to save cost and is powering on now. Everything unlocks automatically once it is ready — you can keep browsing meanwhile.' },
  warming: { title: 'GPU warming up', estimateSeconds: 90, maxSeconds: 240,
    message: 'The GPU is on and its voice engine is loading. Everything unlocks automatically once it is ready.' },
};

// One wait per not-ready episode of the shared GPU (stopped → starting →
// warming → ready). Dismissing it covers the whole episode; a later idle stop
// and restart is a new episode and shows again. A stopped GPU nobody is
// starting (dev manual mode) is not a wait, so nothing shows.
export function useGpuInstanceWait() {
  const { status, checking, starting, autoStart } = useGpuStatus();
  const view = describeGpuStatus({ status, checking, starting, autoStart });
  const episodeRef = useRef(null);
  const waiting = view.phase === 'starting' || view.phase === 'warming';
  if (!waiting) {
    if (view.phase === 'ready' || view.phase === 'stopped') episodeRef.current = null;
    return null;
  }
  if (!episodeRef.current) {
    const startedAt = Date.now();
    episodeRef.current = { key: `gpu-${startedAt}`, startedAt };
  }
  return { ...INSTANCE_WAIT[view.phase], ...episodeRef.current };
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
  const [dismissedKey, setDismissedKey] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const open = Boolean(wait) && wait.key !== dismissedKey;

  useEffect(() => {
    if (!open) return undefined;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    const onKey = (event) => { if (event.key === 'Escape') setDismissedKey(wait.key); };
    window.addEventListener('keydown', onKey);
    return () => { window.clearInterval(id); window.removeEventListener('keydown', onKey); };
  }, [open, wait?.key]);

  if (!open) return null;

  const estimate = Math.max(1, Number(wait.estimateSeconds) || 60);
  const max = Math.max(estimate, Number(wait.maxSeconds) || estimate);
  const elapsed = Math.max(0, (now - (Number(wait.startedAt) || now)) / 1000);
  // Never reach 100% before the GPU says ready; slow down past the estimate.
  const progress = elapsed <= estimate
    ? (elapsed / estimate) * 85
    : 85 + Math.min(1, (elapsed - estimate) / Math.max(1, max - estimate)) * 10;
  const overdue = elapsed > max;
  const remaining = estimate - elapsed;

  return (
    <div className="fixed inset-0 z-[96] flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="gpu-wait-title"
        className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl sm:p-7"
      >
        <button
          type="button"
          onClick={() => setDismissedKey(wait.key)}
          className="absolute right-3 top-3 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          aria-label="Dismiss"
        >
          <X size={16} />
        </button>
        <div className="flex items-center gap-3">
          <span className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Cpu size={20} aria-hidden="true" />
            <Loader2 size={44} className="absolute inset-0 animate-spin text-primary/40" aria-hidden="true" />
          </span>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-600">Please wait</p>
            <h2 id="gpu-wait-title" className="text-lg font-semibold tracking-tight text-slate-900">{wait.title}</h2>
          </div>
        </div>

        {wait.message ? <p className="mt-4 text-sm leading-6 text-slate-600">{wait.message}</p> : null}

        <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4" aria-live="polite">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-1.5 font-medium text-slate-800">
              <Clock size={14} aria-hidden="true" />
              Estimated wait: {formatEstimate(estimate)}
            </span>
            <span className="tabular-nums text-slate-500">{formatDuration(elapsed)} elapsed</span>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200">
            <div className="h-full rounded-full bg-primary transition-[width] duration-1000 ease-linear" style={{ width: `${progress}%` }} />
          </div>
          <p className="mt-2 text-xs text-slate-500">
            {overdue
              ? 'Taking longer than usual. It is still being prepared and retries automatically.'
              : remaining > 0
                ? `Roughly ${formatDuration(remaining)} left${max > estimate ? ` (can take up to ${formatEstimate(max).replace('about ', '')})` : ''}.`
                : 'Almost there — finishing up.'}
          </p>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-slate-500">This closes by itself when ready.</p>
          <button
            type="button"
            onClick={() => setDismissedKey(wait.key)}
            className="inline-flex h-10 items-center rounded-lg bg-primary px-5 text-sm font-semibold text-white hover:bg-primary/90"
          >
            OK, I'll wait
          </button>
        </div>
      </div>
    </div>
  );
}
