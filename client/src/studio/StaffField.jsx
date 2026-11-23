// "Run by" for a recording session: several staff, added like calendar guests.
// Each name keeps its own colour (staffColors.js) here and on the day timeline.
import React, { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { addHosts, staffColor } from './staffColors.js';

const KNOWN_KEY = 'voice-studio-staff';
const LEGACY_KEY = 'voice-studio-host-name';

/** Staff names this browser has used before, newest first (per-viewer convenience only). */
export function knownStaff() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(KNOWN_KEY) || '[]');
    if (Array.isArray(saved) && saved.length) return saved.filter((name) => typeof name === 'string');
    const legacy = window.localStorage.getItem(LEGACY_KEY);
    return legacy ? [legacy] : [];
  } catch {
    return [];
  }
}

export function rememberStaff(names) {
  if (!names.length) return;
  try {
    const merged = addHosts(names, knownStaff().join(','), 20);
    window.localStorage.setItem(KNOWN_KEY, JSON.stringify(merged));
  } catch { /* private mode: suggestions just won't persist */ }
}

/** One staff name as a coloured chip; `onRemove` adds the × button. */
export function StaffChip({ name, onRemove, size = 'md' }) {
  const color = staffColor(name);
  return (
    <span className={cn('inline-flex max-w-full items-center gap-1.5 rounded-full ring-1', color.chip, size === 'sm' ? 'py-0.5 pl-1 pr-2 text-[11px] font-semibold' : 'py-1 pl-1.5 pr-1 text-xs font-semibold')}>
      <span aria-hidden="true" className={cn('shrink-0 rounded-full', color.dot, size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5')} />
      <span className="truncate">{name}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${name}`} className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full hover:bg-black/10">
          <X size={12} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

export function StaffField({ value, onChange, suggestions = [] }) {
  const [typed, setTyped] = useState('');
  const add = (text) => {
    onChange(addHosts(value, text));
    setTyped('');
  };
  const unused = suggestions.filter((name) => !value.some((chosen) => chosen.toLowerCase() === name.toLowerCase())).slice(0, 6);
  return (
    <div className="text-xs font-medium text-slate-600">
      <label htmlFor="staff-input">Run by (staff, optional)</label>
      {value.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {value.map((name) => <StaffChip key={name} name={name} onRemove={() => onChange(value.filter((other) => other !== name))} />)}
        </div>
      )}
      <div className="mt-1.5 flex gap-2">
        <input
          id="staff-input"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); add(typed); }
            if (event.key === 'Backspace' && !typed && value.length) onChange(value.slice(0, -1));
          }}
          maxLength={80}
          placeholder="Add a staff member, e.g. Dr Tan"
          className="block h-10 min-w-0 flex-1 rounded-lg border border-slate-300 px-3 text-sm"
        />
        <button type="button" onClick={() => add(typed)} disabled={!typed.trim()} className="inline-flex h-10 items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
          <Plus size={14} aria-hidden="true" /> Add
        </button>
      </div>
      {unused.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-slate-500">Recent:</span>
          {unused.map((name) => (
            <button key={name} type="button" onClick={() => add(name)} className="rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" aria-label={`Add ${name}`}>
              <StaffChip name={name} size="sm" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
