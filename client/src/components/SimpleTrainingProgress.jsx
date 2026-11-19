import React from 'react';
import { AlertCircle, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { summarizeTrainingProgress } from '@/lib/trainingProgress';

// One bar, one sentence, three stages. The nine technical pipeline steps stay
// in useSSE for the dev/admin tools; a person training their voice only needs
// to know it is moving and roughly how far along it is.
export default function SimpleTrainingProgress({ steps, pipelineStatus }) {
  const progress = summarizeTrainingProgress(steps, pipelineStatus);
  const stageCount = progress.stages.length;

  return (
    <div className="mt-3" aria-live="polite">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium text-slate-900">
          {progress.failed
            ? 'Something went wrong'
            : progress.complete
              ? progress.currentLabel
              : `Step ${progress.currentIndex + 1} of ${stageCount}: ${progress.currentLabel}`}
        </p>
        <span className="tabular-nums text-sm text-slate-500">{progress.percent}%</span>
      </div>

      <div
        className="mt-2 h-2.5 overflow-hidden rounded-full bg-slate-200"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
        aria-label="Training progress"
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-700 ease-out',
            progress.failed ? 'bg-red-500' : progress.complete ? 'bg-emerald-500' : 'bg-primary',
          )}
          style={{ width: `${Math.max(progress.percent, 3)}%` }}
        />
      </div>

      <ol className="mt-3 grid grid-cols-3 gap-2 text-xs">
        {progress.stages.map((stage) => (
          <li
            key={stage.label}
            className={cn(
              'flex items-center gap-1.5',
              stage.state === 'done' && 'text-emerald-700',
              stage.state === 'active' && 'font-medium text-slate-900',
              stage.state === 'pending' && 'text-slate-400',
              stage.state === 'error' && 'text-red-600',
            )}
          >
            {stage.state === 'done' ? <Check size={13} aria-hidden="true" /> : null}
            {stage.state === 'error' ? <AlertCircle size={13} aria-hidden="true" /> : null}
            {stage.state === 'active' ? <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden="true" /> : null}
            <span>{stage.label}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
