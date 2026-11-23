// Calendar pieces shared by the super-user schedule and the lecturer session
// picker: a month view to choose the day (dots show what is on it) and a day
// timeline where sessions are blocks and empty time can be clicked.
import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  addMonths, formatMinutes, formatMonth, layoutLanes, monthGrid, monthOf, sgtDayKey, sgtMinutes,
} from './slotCalendar.js';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const TONES = {
  open: { block: 'border-sky-300 bg-sky-50 text-sky-900', dot: 'bg-sky-500', label: 'Open' },
  booked: { block: 'border-indigo-300 bg-indigo-100 text-indigo-950', dot: 'bg-indigo-600', label: 'Booked' },
  mine: { block: 'border-emerald-400 bg-emerald-100 text-emerald-950', dot: 'bg-emerald-600', label: 'Yours' },
  draft: { block: 'border-amber-300 bg-amber-50 text-amber-950 border-dashed', dot: 'bg-amber-500', label: 'Draft (not published)' },
  live: { block: 'border-rose-400 bg-rose-100 text-rose-950', dot: 'bg-rose-600', label: 'Happening now' },
  taken: { block: 'border-slate-200 bg-slate-100 text-slate-500', dot: 'bg-slate-400', label: 'Taken' },
};

export function Legend({ tones }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
      {tones.map((tone) => (
        <span key={tone} className="inline-flex items-center gap-1.5"><span className={cn('h-2.5 w-2.5 rounded-full', TONES[tone].dot)} />{TONES[tone].label}</span>
      ))}
    </div>
  );
}

/**
 * marks: Map(dayKey -> array of tone names) for the dots under each day.
 * Days before `today` are greyed out and not selectable.
 */
export function MonthCalendar({ month, onMonth, selected, onSelect, marks, today }) {
  const weeks = monthGrid(month);
  const todayMonth = monthOf(today);
  return (
    <div className="select-none">
      <div className="flex items-center justify-between">
        <button type="button" onClick={() => onMonth(addMonths(month, -1))} disabled={month <= todayMonth} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-30" aria-label="Previous month"><ChevronLeft size={18} /></button>
        <p className="text-sm font-semibold text-slate-900">{formatMonth(month)}</p>
        <button type="button" onClick={() => onMonth(addMonths(month, 1))} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100" aria-label="Next month"><ChevronRight size={18} /></button>
      </div>
      <div className="mt-2 grid grid-cols-7 text-center text-[11px] font-medium uppercase tracking-wide text-slate-400">
        {WEEKDAYS.map((day) => <span key={day} className="py-1">{day.slice(0, 2)}</span>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {weeks.flat().map((day) => {
          const inMonth = monthOf(day) === month;
          const past = day < today;
          const dots = [...new Set(marks.get(day) || [])].slice(0, 3);
          const isSelected = day === selected;
          return (
            <button
              key={day}
              type="button"
              disabled={past}
              onClick={() => onSelect(day)}
              aria-pressed={isSelected}
              aria-label={`${day}${dots.length ? `, ${dots.map((tone) => TONES[tone].label).join(', ')}` : ''}`}
              className={cn(
                'flex h-11 flex-col items-center justify-center rounded-lg text-sm transition',
                !inMonth && 'text-slate-300',
                inMonth && !past && 'text-slate-800 hover:bg-slate-100',
                past && 'cursor-default text-slate-300',
                day === today && !isSelected && 'font-bold text-primary ring-1 ring-primary/40',
                isSelected && 'bg-slate-900 font-semibold text-white hover:bg-slate-900',
              )}
            >
              {Number(day.slice(8))}
              <span className="mt-0.5 flex h-1.5 gap-0.5">
                {dots.map((tone) => <span key={tone} className={cn('h-1.5 w-1.5 rounded-full', TONES[tone].dot)} />)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const ROW_PX = 26; // one 30-minute row

/**
 * A day timeline. slots: [{ id, start, end, tone, title, subtitle }].
 * onEmptyClick(minutes) makes empty half-hours clickable (super users adding).
 * pending: { start, minutes } draws a ghost block for the slot being composed.
 */
export function DayTimeline({ day, hours, slots, onSlotClick, onEmptyClick, selectedId, pending, nowMs }) {
  const rows = [];
  for (let minutes = hours.start; minutes < hours.end; minutes += 30) rows.push(minutes);
  const top = (minutes) => ((minutes - hours.start) / 30) * ROW_PX;
  const nowMinutes = nowMs && sgtDayKey(nowMs) === day ? sgtMinutes(nowMs) : null;
  const laneOf = layoutLanes(slots);
  return (
    <div className="relative" style={{ height: rows.length * ROW_PX }}>
      {rows.map((minutes) => {
        const past = nowMinutes !== null && minutes + 30 <= nowMinutes;
        return (
          <div key={minutes} className="absolute inset-x-0 flex" style={{ top: top(minutes), height: ROW_PX }}>
            <span className="w-16 shrink-0 -translate-y-2 pr-2 text-right text-[11px] text-slate-400">{minutes % 60 === 0 ? formatMinutes(minutes) : ''}</span>
            {onEmptyClick && !past ? (
              <button
                type="button"
                onClick={() => onEmptyClick(minutes)}
                className={cn('group flex-1 border-t text-left text-[11px] text-transparent hover:bg-primary/5 hover:text-primary', minutes % 60 === 0 ? 'border-slate-200' : 'border-dashed border-slate-100')}
                aria-label={`Add at ${formatMinutes(minutes)}`}
              >
                <span className="pl-2">+ {formatMinutes(minutes)}</span>
              </button>
            ) : (
              <div className={cn('flex-1 border-t', minutes % 60 === 0 ? 'border-slate-200' : 'border-dashed border-slate-100', past && 'bg-slate-50')} />
            )}
          </div>
        );
      })}
      {nowMinutes !== null && nowMinutes >= hours.start && nowMinutes < hours.end && (
        <div className="pointer-events-none absolute left-16 right-0 z-20 border-t-2 border-rose-500" style={{ top: top(nowMinutes) }}>
          <span className="absolute -left-1.5 -top-[5px] h-2 w-2 rounded-full bg-rose-500" />
        </div>
      )}
      {pending && (
        <div className="pointer-events-none absolute left-16 right-1 z-10 rounded-lg border-2 border-dashed border-primary bg-primary/10 px-2 py-1 text-xs font-semibold text-primary" style={{ top: top(pending.start) + 1, height: Math.max(ROW_PX - 2, (pending.minutes / 30) * ROW_PX - 2) }}>
          New · {formatMinutes(pending.start)} – {formatMinutes(pending.start + pending.minutes)}
        </div>
      )}
      {slots.map((slot) => {
        const { lane, lanes } = laneOf[slot.id] || { lane: 0, lanes: 1 };
        const startMinutes = sgtDayKey(slot.start) === day ? sgtMinutes(slot.start) : 0;
        const endMinutes = sgtDayKey(slot.end) === day ? sgtMinutes(slot.end) : 24 * 60;
        const tone = TONES[slot.tone] || TONES.open;
        const short = endMinutes - startMinutes <= 30;
        const Tag = onSlotClick ? 'button' : 'div';
        return (
          <Tag
            key={slot.id}
            type={onSlotClick ? 'button' : undefined}
            onClick={onSlotClick ? () => onSlotClick(slot) : undefined}
            className={cn(
              'absolute z-10 overflow-hidden rounded-lg border px-2 text-left shadow-sm transition',
              tone.block,
              short ? 'flex items-center gap-2 py-0' : 'py-1',
              onSlotClick && 'hover:shadow-md',
              selectedId === slot.id && 'ring-2 ring-slate-900 ring-offset-1',
            )}
            style={{
              top: top(startMinutes) + 1,
              height: Math.max(ROW_PX - 2, ((endMinutes - startMinutes) / 30) * ROW_PX - 2),
              // Several people at the same time sit side by side (4rem = time labels).
              left: `calc(4rem + (100% - 4.25rem) * ${lane / lanes})`,
              width: `calc((100% - 4.25rem) / ${lanes} - 2px)`,
            }}
          >
            <p className="truncate text-xs font-semibold">{slot.title}</p>
            {slot.subtitle && <p className={cn('truncate text-[11px] opacity-80', short && 'hidden sm:block')}>{slot.subtitle}</p>}
          </Tag>
        );
      })}
    </div>
  );
}
