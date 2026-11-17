import React from 'react';
import {
  AudioLines,
  Bot,
  Check,
  Cpu,
  FileText,
  Fingerprint,
  Mic,
  ScissorsLineDashed,
  Sparkles,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const STEP_ICONS = [
  ScissorsLineDashed,
  Sparkles,
  Mic,
  FileText,
  Fingerprint,
  Cpu,
  AudioLines,
  Bot,
];

function getStatusMeta(status) {
  if (status === 'done') {
    return {
      label: 'Done',
      circleClass: 'border-emerald-200 bg-emerald-500 text-white shadow-[0_18px_40px_-24px_rgba(16,185,129,0.8)]',
      textClass: 'text-emerald-700',
      connectorClass: 'bg-emerald-300',
    };
  }

  if (status === 'running') {
    return {
      label: 'Running',
      circleClass: 'border-sky-200 bg-sky-500 text-white shadow-[0_18px_40px_-24px_rgba(14,165,233,0.9)]',
      textClass: 'text-sky-700',
      connectorClass: 'bg-sky-300',
    };
  }

  if (status === 'error') {
    return {
      label: 'Error',
      circleClass: 'border-rose-200 bg-rose-500 text-white shadow-[0_18px_40px_-24px_rgba(239,68,68,0.85)]',
      textClass: 'text-rose-700',
      connectorClass: 'bg-rose-300',
    };
  }

  return {
    label: status === 'skipped' ? 'Skipped' : 'Pending',
    circleClass: 'border-slate-200 bg-white text-slate-400',
    textClass: 'text-slate-500',
    connectorClass: 'bg-slate-200',
  };
}

export default function ProgressTracker({ steps }) {
  return (
    <div className="w-full">
      <div className="flex items-start gap-1 py-2 lg:gap-2">
        {steps.map((step, index) => {
          const Icon = STEP_ICONS[index] || AudioLines;
          const meta = getStatusMeta(step.status);
          const isDone = step.status === 'done';
          const isRunning = step.status === 'running';
          const isError = step.status === 'error';

          return (
            <React.Fragment key={step.index}>
              <div className="min-w-0 flex-1 text-center">
                <div className="flex items-center justify-center">
                  <div
                    className={cn(
                      'mx-auto flex h-10 w-10 items-center justify-center rounded-full border transition-all lg:h-11 lg:w-11',
                      meta.circleClass,
                      isRunning && 'animate-pulse-dot'
                    )}
                  >
                    {isDone ? (
                      <Check size={16} strokeWidth={2.4} />
                    ) : isError ? (
                      <X size={15} strokeWidth={2.4} />
                    ) : (
                      <Icon size={16} strokeWidth={2.2} />
                    )}
                  </div>
                </div>

                <div className="mt-3">
                  <p className="font-mono text-[9px] uppercase tracking-[0.24em] text-slate-400 lg:text-[10px] lg:tracking-[0.28em]">
                    {String(index + 1).padStart(2, '0')}
                  </p>
                  {/* Nine columns are narrow: long words ("Recognition", "Verification")
                      must hyphenate/wrap inside their column instead of spilling into the next. */}
                  <p
                    lang="en"
                    className={cn(
                      'mt-2 hyphens-auto break-words px-0.5 text-[10px] font-semibold leading-tight [overflow-wrap:anywhere] lg:text-[11px]',
                      isDone && 'text-emerald-700',
                      isRunning && 'text-sky-700',
                      isError && 'text-rose-700',
                      !isDone && !isRunning && !isError && 'text-slate-600'
                    )}
                  >
                    {step.name}
                  </p>
                  <p className={cn('mt-1.5 text-[8px] font-medium uppercase tracking-[0.08em] sm:text-[9px] lg:text-[10px]', meta.textClass)}>
                    {meta.label}
                  </p>
                </div>
              </div>

              {index < steps.length - 1 && (
                <div className="flex h-10 w-4 shrink-0 items-center justify-center lg:h-11 lg:w-6">
                  <div className={cn('h-0.5 w-full rounded-full', meta.connectorClass)} />
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
