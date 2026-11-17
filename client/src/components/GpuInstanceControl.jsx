import React from 'react';
import { Power } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useGpuStatus } from '@/lib/gpuStatus.jsx';
import { describeGpuStatus } from '@/lib/gpuStatusModel';

// `name` relabels the badge when a page has more than one kind of GPU (the
// training site shows its fixed training GPU as "Training GPU").
function relabel(label, name) {
  if (name === 'GPU') return label;
  const out = label.replace('GPU', name);
  return out.startsWith(name) ? out : out.replace(name, name.toLowerCase());
}

export default function GpuInstanceControl({ name = 'GPU' }) {
  const { status, checking, starting, autoStart, start: handleStart } = useGpuStatus();
  const view = describeGpuStatus({ status, checking, starting, autoStart });
  const canStart = view.phase === 'stopped' && Boolean(status?.startable) && !starting;
  const dot = {
    ready: 'bg-emerald-500',
    starting: 'bg-amber-400 animate-pulse',
    warming: 'bg-amber-400 animate-pulse',
    stopping: 'bg-slate-400 animate-pulse',
    stopped: 'bg-slate-400',
  }[view.phase] || 'bg-slate-300';

  return (
    <button
      type="button"
      onClick={canStart ? handleStart : undefined}
      disabled={!canStart}
      title={canStart ? 'The GPU is off. Click to start it.' : view.detail}
      aria-live="polite"
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors',
        view.phase === 'ready'
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
          : canStart
            ? 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
            : 'cursor-default border-slate-200 bg-white text-slate-500'
      )}
    >
      {view.phase === 'checking' ? <Power size={12} /> : <span className={cn('h-2 w-2 rounded-full', dot)} />}
      {relabel(view.label, name)}
      {canStart && <span className="text-slate-400">· Start</span>}
    </button>
  );
}

