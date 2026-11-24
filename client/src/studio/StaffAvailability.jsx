// Staff availability (recording sessions), a calendar with a column per staff
// member (owner 2026-11-24). Staff are super users. Each marks their free time
// (green); overlapping free time sits side by side. Booking a lecturer at a
// time gives the session to whoever free then marked the time first (red, on
// their own column); everyone else free then is hatched ("taken") and emailed
// on Publish to pick another time. The host confirms, or hands it to another
// free staff member, before Publish sends it. Rules: lambda/studio/workflow.js.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, CheckCircle2, ChevronLeft, ChevronRight, Trash2, UserCheck, X } from 'lucide-react';
import { useAuth } from '@/auth/useAuth';
import { cn } from '@/lib/utils';
import { DayTimeline, MonthCalendar } from './SlotCalendar.jsx';
import {
  addDays, dayHours, formatDay, formatLength, formatMinutes, monthOf, sgtDayKey, sgtIso, sgtMinutes,
} from './slotCalendar.js';
import { addSlot, deleteSlot, editSlot, formatSgt, publishSlots } from './studioApi.js';
import { Button, Card } from './StudioChrome.jsx';
import { StaffChip } from './StaffField.jsx';
import { slotHosts } from './staffColors.js';
import {
  awaitsHost, overlapBands, overriddenFor, staffColumns, staffFreeFor, staffLabel, takenParts,
} from './availability.js';

const LENGTHS = [30, 45, 60, 90, 120, 180, 240];
const START_STEPS = Array.from({ length: 96 }, (_, i) => i * 15);
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const fieldClass = 'mt-1 block h-10 w-full rounded-lg border border-slate-300 px-3 text-sm';
const sgtTime = (value) => formatSgt(value, { withDate: false });
const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
const isBooking = (slot) => Boolean(slot?.assigneeEmail);


function rangeOf(draft) {
  const start = sgtIso(draft.day, draft.start);
  return { start, end: new Date(Date.parse(start) + draft.minutes * 60_000).toISOString() };
}

function TimeFields({ draft, setDraft }) {
  return (
    <div className="grid grid-cols-1 gap-3">
      <label className="block text-xs font-medium text-slate-600">Starts
        <select value={draft.start} onChange={(event) => setDraft({ ...draft, start: Number(event.target.value) })} className={fieldClass}>
          {START_STEPS.map((minutes) => <option key={minutes} value={minutes}>{formatMinutes(minutes)}</option>)}
        </select>
      </label>
      <div className="text-xs font-medium text-slate-600">Length
        <div className="mt-1 flex flex-wrap gap-1.5">
          {[...new Set([...LENGTHS, draft.minutes])].sort((a, b) => a - b).map((value) => (
            <button key={value} type="button" onClick={() => setDraft({ ...draft, minutes: value })} className={cn('h-9 rounded-full px-3 text-xs font-semibold sm:h-8', draft.minutes === value ? 'bg-slate-900 text-white' : 'bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-100')}>
              {formatLength(value)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Who runs a booking: free staff in priority order (first come first), then any other super user.
function HostPicker({ candidates, staff, value, onChange }) {
  const others = staff.filter((name) => !candidates.some((other) => same(other, name)));
  const row = (name, note, index) => {
    const chosen = same(value, name);
    return (
      <label key={name} className={cn('flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 ring-1', chosen ? 'bg-white ring-slate-900' : 'ring-slate-200 hover:bg-white')}>
        <input type="radio" name="booking-host" checked={chosen} onChange={() => onChange(name)} />
        <StaffChip name={name} size="sm" />
        <span className="text-[11px] font-normal text-slate-500">{note(index)}</span>
      </label>
    );
  };
  return (
    <div className="text-xs font-medium text-slate-600">Who runs it
      <div className="mt-1 space-y-1">
        {candidates.length === 0 && <p className="rounded-lg bg-slate-100 px-2.5 py-2 text-[11px] font-normal text-slate-600">Nobody marked themselves free then. Pick a super user below, or leave it to sort out later.</p>}
        {candidates.map((name, index) => row(name, (i) => (i === 0 ? 'marked this time first: gets it' : 'also free then'), index))}
        {others.length > 0 && (
          <details className="pt-1" open={candidates.length === 0 || others.some((name) => same(name, value))}>
            <summary className="cursor-pointer text-[11px] text-slate-500">Someone not marked free</summary>
            <div className="mt-1 space-y-1">{others.map((name) => row(name, () => 'not marked free then'))}</div>
          </details>
        )}
        {value && (
          <button type="button" onClick={() => onChange('')} className="text-[11px] font-normal text-slate-500 underline">Nobody yet</button>
        )}
      </div>
    </div>
  );
}

function Composer({ draft, setDraft, slots, staff, me, onSave, onDelete, onCancel, onBookHere }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const booking = draft.mode === 'booking';
  const range = rangeOf(draft);
  const candidates = booking ? staffFreeFor(slots, range, draft.id || '').filter((name) => staff.some((other) => same(other, name))) : [];
  const host = booking ? (draft.hostTouched ? draft.host : candidates[0] || draft.host || '') : '';
  const email = String(draft.person || '').trim();
  const badEmail = Boolean(email) && !EMAIL_SHAPE.test(email);
  const bumped = booking ? candidates.filter((name) => !same(name, host)) : [];
  const canSave = booking ? EMAIL_SHAPE.test(email) : Boolean(me);
  const title = booking ? (draft.id ? 'Edit booking' : 'Book a lecturer') : (draft.id ? 'Your free time' : 'Mark your free time');
  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">{title}</p>
          <p className="text-sm font-semibold text-slate-900">{formatDay(draft.day)} · {formatMinutes(draft.start)} – {formatMinutes((draft.start + draft.minutes) % (24 * 60))}</p>
        </div>
        <button type="button" onClick={onCancel} className="-m-1 shrink-0 rounded-lg p-2 text-slate-400 hover:bg-slate-200" aria-label="Close"><X size={16} /></button>
      </div>
      {!draft.id && (
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-200/70 p-1 text-xs font-semibold" role="tablist">
          {[['free', 'Free time'], ['booking', 'Book a lecturer']].map(([mode, label]) => (
            <button key={mode} type="button" role="tab" aria-selected={draft.mode === mode} onClick={() => setDraft({ ...draft, mode })} className={cn('h-8 rounded-md', draft.mode === mode ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900')}>
              {label}
            </button>
          ))}
        </div>
      )}
      <TimeFields draft={draft} setDraft={setDraft} />
      {booking ? (
        <>
          <label className="block text-xs font-medium text-slate-600">Lecturer&apos;s email
            <input value={draft.person || ''} onChange={(event) => setDraft({ ...draft, person: event.target.value })} type="email" placeholder="name@ntu.edu.sg" aria-invalid={badEmail} className={cn(fieldClass, badEmail && 'border-rose-400')} />
          </label>
          <label className="block text-xs font-medium text-slate-600">Their name (optional)
            <input value={draft.name || ''} onChange={(event) => setDraft({ ...draft, name: event.target.value })} maxLength={80} placeholder="e.g. Dr Lim" className={fieldClass} />
          </label>
          <HostPicker candidates={candidates} staff={staff} value={host} onChange={(name) => setDraft({ ...draft, host: name, hostTouched: true })} />
          {bumped.length > 0 && (
            <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] leading-snug text-amber-950">
              <b>{bumped.join(', ')}</b> {bumped.length === 1 ? 'is' : 'are'} free then too. Once {host || 'the host'} confirms and you publish, they are emailed to pick another time.
            </p>
          )}
        </>
      ) : (
        me
          ? <p className="flex flex-wrap items-center gap-1.5 text-xs text-slate-600">Free time for <StaffChip name={me} size="sm" /> (you). Each account marks its own.</p>
          : <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">Your account is not on the Super users list yet, so it cannot mark free time.</p>
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        <Button variant="dark" disabled={!canSave} onClick={() => onSave(booking ? { ...draft, host } : draft)}>
          {draft.id ? 'Save changes' : booking ? 'Book' : 'Add my free time'}
        </Button>
        {draft.id && !booking && <Button variant="outline" onClick={onBookHere}>Book a lecturer here</Button>}
        {draft.id && (confirmDelete
          ? <Button variant="danger" onClick={onDelete}>Confirm delete</Button>
          : <Button variant="ghost" onClick={() => setConfirmDelete(true)}><Trash2 size={14} /> Delete</Button>)}
      </div>
      <p className="text-[11px] text-slate-500">Everything here is a draft (dashed) until you press Publish.</p>
    </div>
  );
}

// The booking's host: confirm, or hand it to someone else free then.
function HostStatus({ booking, slots, staff, me, onAction }) {
  const hosts = slotHosts(booking);
  const isHost = Boolean(me) && same(hosts[0] || '', me);
  const others = staffFreeFor(slots, booking, booking.id).filter((name) => !hosts.some((host) => same(host, name)) && staff.some((other) => same(other, name)));
  const takenFrom = slots.filter((slot) => slot.overriddenBy?.slotId === booking.id);
  return (
    <Card className="p-4">
      <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.12em] text-rose-700"><span className="h-2 w-2 rounded-full bg-rose-500" /> Booked · {booking.status === 'draft' ? 'draft' : 'published'}</p>
      <p className="mt-1 text-lg font-bold text-slate-900">{booking.assigneeName || booking.assigneeEmail}</p>
      <p className="text-xs text-slate-600">{formatDay(sgtDayKey(booking.start))} · {sgtTime(booking.start)} – {sgtTime(booking.end)} · {booking.assigneeEmail}</p>
      {hosts.length === 0 ? (
        <p className="mt-3 rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-600">Nobody runs it yet. Edit it below to pick a super user.</p>
      ) : awaitsHost(booking, slots) ? (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
          <p className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-amber-950">Waiting for <StaffChip name={hosts[0]} size="sm" /> to confirm</p>
          {isHost ? (
            <>
              <p className="mt-1 text-[11px] text-amber-900">It is on your free time. Confirming sends it right away: the lecturer is emailed, and so is anyone else free then (asked to pick another time). Or hand it to someone else free then.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" variant="dark" onClick={() => onAction(() => editSlot(booking.id, { confirmHost: true }))}><UserCheck size={14} /> I&apos;ll run it</Button>
                {others.map((name) => (
                  <Button key={name} size="sm" variant="outline" onClick={() => onAction(() => editSlot(booking.id, { hostNames: [name] }))}>Hand to {name}</Button>
                ))}
              </div>
            </>
          ) : (
            <p className="mt-1 text-[11px] text-amber-900">It is on {hosts[0]}&apos;s free time (they marked it first). Only {hosts[0]} can confirm it or hand it on, from their own account.</p>
          )}
        </div>
      ) : (
        <p className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-emerald-800"><CheckCircle2 size={14} /> Run by <StaffChip name={hosts[0]} size="sm" />{booking.hostConfirmedAt ? ' (confirmed)' : ''}{booking.status === 'draft' ? ' · draft, press Publish to send' : ' · sent'}</p>
      )}
      {takenFrom.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-semibold text-slate-700">Free time this takes</p>
          <ul className="mt-1 space-y-1">
            {takenFrom.map((slot) => (
              <li key={slot.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-[repeating-linear-gradient(135deg,#f1f5f9_0_6px,#ffffff_6px_12px)] px-2.5 py-1.5 text-[11px] text-slate-600 ring-1 ring-slate-200">
                {slotHosts(slot).map((name) => <StaffChip key={name} name={name} size="sm" />)}
                {sgtTime(slot.start)} – {sgtTime(slot.end)}
                <span className="ml-auto font-semibold">{slot.overriddenBy.notifiedAt ? 'emailed' : 'emailed on publish'}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

export function StaffAvailability({ overview, onAction }) {
  const auth = useAuth();
  const nowMs = Date.parse(overview.now) || Date.now();
  const today = sgtDayKey(nowMs);
  const slots = useMemo(
    () => overview.slots.filter((slot) => slot.kind === 'recording' && Date.parse(slot.end) > nowMs),
    [overview.slots, nowMs],
  );
  const staff = useMemo(() => (overview.superusers || []).map(staffLabel).filter(Boolean), [overview.superusers]);
  // Account based (owner 2026-11-24): you are the super user you signed in as.
  const signedIn = (overview.superusers || []).find((user) => same(user.email, auth.user?.email || ''));
  const me = signedIn ? staffLabel(signedIn) : '';
  const [day, setDay] = useState(today);
  const [month, setMonth] = useState(monthOf(today));
  const [draft, setDraft] = useState(null);
  const [selectedId, setSelectedId] = useState('');
  const composerRef = useRef(null);
  useEffect(() => {
    if (!draft || !window.matchMedia?.('(max-width: 1023px)').matches) return;
    composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [draft?.id, draft?.day, draft?.start, draft?.mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = slots.find((slot) => slot.id === selectedId) || null;
  const daySlots = slots.filter((slot) => sgtDayKey(slot.start) === day || sgtDayKey(slot.end) === day);
  const columnKeys = useMemo(() => {
    const keys = staffColumns(daySlots);
    // Your own column is always there, so you can click straight into it.
    if (me && !keys.some((key) => same(key, me))) keys.unshift(me);
    return keys.length ? keys : [''];
  }, [daySlots, me]);
  const columnOf = (slot) => Math.max(0, columnKeys.findIndex((key) => same(key, slotHosts(slot)[0] || '')));
  const hours = dayHours(daySlots, { nowMinutes: day === today ? sgtMinutes(nowMs) : null });

  const ms = (value) => Date.parse(value);
  const marked = (slot) => ms(slot.createdAt || slot.updatedAt || slot.start);
  const ORDINAL = ['1st', '2nd', '3rd'];
  const blocks = [];
  for (const slot of daySlots) {
    const draftTag = slot.status === 'draft';
    if (isBooking(slot)) {
      const waiting = awaitsHost(slot, slots);
      blocks.push({
        id: slot.id,
        start: slot.start,
        end: slot.end,
        column: columnOf(slot),
        tone: draftTag ? 'reservedDraft' : 'reserved',
        title: slot.assigneeName || slot.assigneeEmail,
        subtitle: `${sgtTime(slot.start)} – ${sgtTime(slot.end)}${waiting ? ` · waiting for ${slotHosts(slot)[0]} to confirm` : draftTag ? ' · draft' : ''}`,
        staff: [],
      });
      continue;
    }
    const host = slotHosts(slot)[0] || '';
    // Who marked overlapping time first (different people): 1st, 2nd, ...
    const rivals = daySlots.filter((other) => !isBooking(other) && other.id !== slot.id && !same(slotHosts(other)[0] || '', host)
      && ms(other.start) < ms(slot.end) && ms(slot.start) < ms(other.end));
    const rank = rivals.length ? [slot, ...rivals].sort((a, b) => marked(a) - marked(b)).indexOf(slot) : -1;
    // The host's own booking turns that part of their free slot into the booking (no overlap).
    let pieces = [[ms(slot.start), ms(slot.end)]];
    for (const booking of slots.filter((other) => isBooking(other) && host && slotHosts(other).some((name) => same(name, host)))) {
      pieces = pieces.flatMap(([from, to]) => {
        if (ms(booking.end) <= from || ms(booking.start) >= to) return [[from, to]];
        return [[from, ms(booking.start)], [ms(booking.end), to]].filter(([a, b]) => b - a >= 5 * 60_000);
      });
    }
    const mine = same(host, me);
    pieces.forEach(([from, to], index) => {
      blocks.push({
        id: pieces.length > 1 || from !== ms(slot.start) || to !== ms(slot.end) ? `${slot.id}::${index}` : slot.id,
        start: new Date(from).toISOString(),
        end: new Date(to).toISOString(),
        column: columnOf(slot),
        tone: draftTag ? 'freeDraft' : 'free',
        title: rank >= 0 ? `Free · ${ORDINAL[rank] || `${rank + 1}th`}` : 'Free',
        subtitle: `${sgtTime(slot.start)} – ${sgtTime(slot.end)}${rank >= 0 ? ` · marked ${formatSgt(slot.createdAt || slot.updatedAt)}` : ''}${draftTag ? ' · draft' : ''}`,
        staff: [],
        canDelete: mine || !staff.some((name) => same(name, host)),
      });
    });
  }
  const shades = daySlots.flatMap((slot) => takenParts(slot, slots).map((part) => ({
    column: columnOf(slot),
    start: part.start,
    end: part.end,
    label: same(slotHosts(slot)[0] || '', me) ? 'Taken · pick another time' : `Taken by ${slotHosts(part.booking)[0] || 'a booking'}`,
  })));
  const columns = columnKeys.map((key) => ({
    key: key || 'nobody',
    label: key ? (
      <span className="flex min-w-0 items-center gap-1">
        <StaffChip name={key} size="sm" />
        {same(key, me) && <span className="text-[10px] font-semibold text-slate-400">you</span>}
      </span>
    ) : <span className="text-[11px] font-semibold text-slate-400">No host</span>,
  }));

  const waitingAll = slots.filter((slot) => awaitsHost(slot, slots) && same(slotHosts(slot)[0] || '', me)).sort((a, b) => a.start.localeCompare(b.start));
  const takenFromMe = overriddenFor(slots, me);
  const drafts = overview.draftCount || 0;
  const awaiting = overview.awaitingHost ?? waitingAll.length;
  const marks = useMemo(() => {
    const map = new Map();
    for (const slot of slots) {
      const key = sgtDayKey(slot.start);
      map.set(key, [...(map.get(key) || []), isBooking(slot) ? 'reserved' : 'free']);
    }
    return map;
  }, [slots]);

  function goTo(key) {
    setDay(key);
    setMonth(monthOf(key));
  }
  function openSlot(block) {
    const slot = slots.find((item) => item.id === String(block.id).split('::')[0]);
    if (!slot) return;
    goTo(sgtDayKey(slot.start));
    setSelectedId(slot.id);
    // Someone else's free time: show it (and "book here"); only they can edit it.
    if (!isBooking(slot) && !same(slotHosts(slot)[0] || '', me) && staff.some((name) => same(name, slotHosts(slot)[0] || ''))) {
      setDraft(null);
      return;
    }
    setDraft({
      id: slot.id,
      mode: isBooking(slot) ? 'booking' : 'free',
      day: sgtDayKey(slot.start),
      start: sgtMinutes(slot.start),
      minutes: Math.round((Date.parse(slot.end) - Date.parse(slot.start)) / 60000),
      hosts: slotHosts(slot),
      host: slotHosts(slot)[0] || '',
      hostTouched: isBooking(slot),
      person: slot.assigneeEmail || '',
      name: slot.assigneeName || '',
    });
  }
  function newDraft(fields) {
    setSelectedId('');
    setDraft({ mode: 'free', day, start: 9 * 60, minutes: 60, hosts: me ? [me] : [], host: '', person: '', name: '', ...fields });
  }
  async function save(next) {
    const { start, end } = rangeOf(next);
    let done;
    if (next.mode === 'booking') {
      const body = { kind: 'recording', start, end, assigneeEmail: String(next.person).trim(), assigneeName: String(next.name || '').trim(), hostNames: next.host ? [next.host] : [] };
      done = await onAction(async () => (next.id ? editSlot(next.id, body) : addSlot(body)));
      if (done && !next.id) {
        // Select the new booking so its host can confirm or hand it on right away.
        setDraft(null);
        setSelectedId(`pending:${start}|${body.assigneeEmail}`);
        return;
      }
    } else if (next.id) {
      done = await onAction(() => editSlot(next.id, { start, end }));
    } else {
      done = await onAction(() => addSlot({ kind: 'recording', start, end, hostNames: [me] }));
    }
    if (done) setDraft(null);
  }
  // After booking: find the new slot once the overview refreshes.
  useEffect(() => {
    if (!selectedId.startsWith('pending:')) return;
    const [start, email] = selectedId.slice(8).split('|');
    const found = slots.find((slot) => slot.start === start && slot.assigneeEmail === email.toLowerCase());
    if (found) setSelectedId(found.id);
  }, [selectedId, slots]);

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-2xl">
            <h2 className="text-xl font-bold text-slate-900">Staff availability</h2>
            <p className="mt-1 text-sm text-slate-600">Each staff member has a column. Mark when you are free; overlapping time sits side by side. A booking goes to whoever marked that time first, who confirms it or hands it on.</p>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            {me && <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">Signed in as <StaffChip name={me} size="sm" /></span>}
            <Button variant={drafts ? 'success' : 'outline'} disabled={!drafts} className="w-full sm:w-auto" onClick={() => onAction(publishSlots)}>
              Publish {drafts ? `${drafts} change${drafts === 1 ? '' : 's'}` : '(nothing to publish)'}
            </Button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-600">
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-sm border border-emerald-400 bg-emerald-100" /> Free</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-sm border border-rose-400 bg-rose-100" /> Booked (in the host&apos;s free slot)</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-sm border border-slate-300 bg-slate-200" /> Taken: someone marked it first (pick another time)</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-sm border border-dashed border-slate-500" /> Draft</span>
          {awaiting > 0 && <span className="font-semibold text-amber-800 sm:ml-auto">{awaiting} booking{awaiting === 1 ? '' : 's'} on someone&apos;s free time, waiting for them to confirm</span>}
        </div>
      </Card>

      {staff.length === 0 && (
        <div role="status" className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">Only super users can be on this calendar. Add each staff member under <b>Super users</b> with their name and email first.</div>
      )}

      {waitingAll.map((slot) => {
        return (
          <div key={slot.id} role="status" className="flex flex-wrap items-center gap-3 rounded-2xl border border-amber-400 bg-amber-50 px-4 py-3 text-sm text-amber-950">
            <UserCheck size={18} className="shrink-0 text-amber-700" aria-hidden="true" />
            <p className="min-w-0 flex-1">
              {slot.assigneeName || slot.assigneeEmail} was booked into <b>your</b> free time, {formatDay(sgtDayKey(slot.start))} {sgtTime(slot.start)} – {sgtTime(slot.end)}. Confirm to send it, or hand it on.
            </p>
            <Button size="sm" variant="dark" onClick={() => onAction(() => editSlot(slot.id, { confirmHost: true }))}>I&apos;ll run it</Button>
            <Button size="sm" variant="ghost" onClick={() => openSlot({ id: slot.id })}>Hand on…</Button>
          </div>
        );
      })}
      {takenFromMe.map((slot) => (
        <div key={slot.id} role="status" className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-800">
          <CalendarClock size={18} className="shrink-0 text-slate-500" aria-hidden="true" />
          <p className="min-w-0 flex-1">Your free time {formatDay(sgtDayKey(slot.start))} {sgtTime(slot.overriddenBy.start)} – {sgtTime(slot.overriddenBy.end)} was taken: {(slot.overriddenBy.hostNames || []).join(', ') || 'someone'} marked it first and runs {slot.overriddenBy.assigneeName || 'a lecturer'} then. We recommend picking another time.</p>
          <Button size="sm" variant="outline" onClick={() => { goTo(sgtDayKey(slot.start)); newDraft({ day: sgtDayKey(slot.start), start: sgtMinutes(slot.overriddenBy.end), hosts: [me] }); }}>Pick another time</Button>
        </div>
      ))}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="min-w-0 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => goTo(addDays(day, -1))} disabled={day <= today} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-30" aria-label="Previous day"><ChevronLeft size={18} /></button>
              <h3 className="text-base font-bold text-slate-900">{formatDay(day)}</h3>
              <button type="button" onClick={() => goTo(addDays(day, 1))} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100" aria-label="Next day"><ChevronRight size={18} /></button>
              {day !== today && <Button size="sm" variant="ghost" onClick={() => goTo(today)}>Today</Button>}
            </div>
            <p className="text-xs text-slate-500">Click your column to mark yourself free; click a free block (or someone else&apos;s column) to book a lecturer.</p>
          </div>
          <div className="max-h-[min(720px,72dvh)] overflow-y-auto overscroll-contain pr-1">
            <DayTimeline
              day={day}
              hours={hours}
              slots={blocks}
              columns={columns}
              shades={shades}
              bands={overlapBands(daySlots)}
              nowMs={nowMs}
              selectedId={blocks.find((block) => String(block.id).split('::')[0] === selectedId)?.id || selectedId}
              pending={draft && !draft.id && draft.day === day ? { start: draft.start, minutes: draft.minutes, column: draft.mode === 'free' ? Math.max(0, columnKeys.findIndex((key) => same(key, draft.hosts?.[0] || ''))) : null } : null}
              onSlotClick={openSlot}
              onSlotDelete={(block) => { const id = String(block.id).split('::')[0]; onAction(() => deleteSlot(id)).then((done) => { if (done && draft?.id === id) setDraft(null); }); }}
              onEmptyClick={(minutes, column) => {
                const key = column !== null ? columnKeys[column] : me;
                newDraft({ day, start: minutes, mode: key && !same(key, me) ? 'booking' : 'free', hosts: me ? [me] : [] });
              }}
            />
          </div>
        </Card>

        <div className="space-y-4">
          {selected && isBooking(selected) && <HostStatus booking={selected} slots={slots} staff={staff} me={me} onAction={onAction} />}
          {selected && !isBooking(selected) && !same(slotHosts(selected)[0] || '', me) && (
            <Card className="p-4">
              <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.12em] text-emerald-700"><span className="h-2 w-2 rounded-full bg-emerald-500" /> Free time</p>
              <p className="mt-1 flex flex-wrap items-center gap-1.5 text-sm font-bold text-slate-900"><StaffChip name={slotHosts(selected)[0] || 'Nobody'} size="sm" /> {sgtTime(selected.start)} – {sgtTime(selected.end)}</p>
              <p className="mt-1 text-xs text-slate-600">Marked {formatSgt(selected.createdAt || selected.updatedAt)}. Only they can change it.</p>
              <Button variant="dark" className="mt-3 w-full" onClick={() => { setSelectedId(''); setDraft({ mode: 'booking', day: sgtDayKey(selected.start), start: sgtMinutes(selected.start), minutes: Math.round((Date.parse(selected.end) - Date.parse(selected.start)) / 60000), host: '', hostTouched: false, person: '', name: '' }); }}>Book a lecturer here</Button>
            </Card>
          )}
          {draft && (
            <div ref={composerRef} className="scroll-mt-32">
              <Composer
                key={`${draft.id || 'new'}-${draft.mode}`}
                draft={draft}
                setDraft={setDraft}
                slots={slots}
                staff={staff}
                me={me}
                onSave={save}
                onCancel={() => { setDraft(null); setSelectedId(''); }}
                onDelete={() => onAction(() => deleteSlot(draft.id)).then((done) => { if (done) { setDraft(null); setSelectedId(''); } })}
                onBookHere={() => { setSelectedId(''); setDraft({ ...draft, id: undefined, mode: 'booking', host: '', hostTouched: false, person: '', name: '' }); }}
              />
            </div>
          )}
          {!draft && !selected && (
            <Card className="border-indigo-200 p-4">
              <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-indigo-700">{formatDay(day)}</p>
              <p className="mt-0.5 text-sm font-bold text-slate-900">What do you want to do?</p>
              <div className="mt-3 grid gap-2">
                <Button variant="dark" disabled={!me} onClick={() => newDraft({ start: day === today ? Math.min(22 * 60, Math.ceil(sgtMinutes(nowMs) / 60) * 60) : 9 * 60 })}>
                  <CalendarClock size={15} /> Mark myself free
                </Button>
                <Button variant="outline" onClick={() => newDraft({ mode: 'booking', start: 9 * 60 })}>Book a lecturer</Button>
              </div>
            </Card>
          )}
          <Card className="p-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">Pick a day</p>
            <MonthCalendar month={month} onMonth={setMonth} selected={day} onSelect={goTo} marks={marks} today={today} />
          </Card>
        </div>
      </div>
    </div>
  );
}
