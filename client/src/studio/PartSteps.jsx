// "Your recording has 2 parts": Part 1 the standard script, Part 2 the
// specialty terms. Shows which one is open and which are done; switching is
// locked while a recording is running.
import React from 'react';
import { ArrowRight, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card } from './StudioChrome.jsx';

function PartCard({ number, title, description, meta, state, status, onClick, disabled }) {
  const open = state === 'open';
  const done = state === 'done';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-current={open ? 'step' : undefined}
      className={cn(
        'flex min-w-0 flex-1 basis-64 flex-col gap-1.5 rounded-xl bg-white p-4 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed',
        open ? 'border-2 border-slate-900 shadow-sm' : 'border border-slate-200 p-[17px] hover:border-slate-300 hover:bg-slate-50',
      )}
    >
      <span className="flex flex-wrap items-center gap-2">
        <span className={cn(
          'rounded-md px-2 py-0.5 text-[11px] font-bold tracking-[0.12em]',
          open ? 'bg-slate-900 text-white' : done ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-700',
        )}
        >
          PART {number}
        </span>
        <span className={cn('flex items-center gap-1 text-xs font-semibold', done ? 'text-emerald-700' : open ? 'text-slate-900' : 'text-slate-500')}>
          {done && <Check size={13} strokeWidth={3} aria-hidden="true" />}
          {status}
        </span>
      </span>
      <span className="text-base font-semibold text-slate-900 sm:text-[17px]">{title}</span>
      <span className="text-sm leading-snug text-slate-600">{description}</span>
      <span className="text-xs text-slate-500">{meta}</span>
    </button>
  );
}

/**
 * parts: [{ title, description, meta, done, status }] for Part 1 and Part 2.
 * current: 1 | 2. locked: true while recording (no switching mid-take).
 */
export function PartSteps({ parts, current, onSelect, locked = false }) {
  const stateOf = (number) => (number === current ? 'open' : parts[number - 1].done ? 'done' : 'next');
  return (
    <Card className="bg-slate-50 p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-base font-semibold text-slate-900">Your recording has 2 parts</h2>
        <p className="text-sm text-slate-600">
          {locked ? 'Finish or pause this recording before switching parts.' : 'Do Part 1 first, then Part 2. Both train the same voice.'}
        </p>
      </div>
      <div className="flex flex-wrap items-stretch gap-2.5">
        <PartCard number={1} {...parts[0]} state={stateOf(1)} onClick={() => onSelect(1)} disabled={locked && current !== 1} />
        <span className="hidden items-center text-slate-400 sm:flex" aria-hidden="true"><ArrowRight size={20} /></span>
        <PartCard number={2} {...parts[1]} state={stateOf(2)} onClick={() => onSelect(2)} disabled={locked && current !== 2} />
      </div>
    </Card>
  );
}
