// Staff availability on the recording calendar (rule lives in lambda/studio/workflow.js):
// a free recording session is a staff member's free time; the first booking over
// a time overrides everyone else's free time there.
import { sgtIso } from './slotCalendar.js';
import { slotHosts } from './staffColors.js';

const time = (value) => (typeof value === 'number' ? value : Date.parse(value));
const overlaps = (a, b) => time(a.start) < time(b.end) && time(b.start) < time(a.end);
const sameName = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

const isRecording = (slot) => slot.kind === 'recording';
export const isFree = (slot) => isRecording(slot) && !slot.assigneeEmail && !slot.overriddenBy;
export const isBooked = (slot) => isRecording(slot) && Boolean(slot.assigneeEmail);

/** Other staff's free time a booking at `range` would take (excluding the slot being booked). */
export function freeTimeTaken(slots, range, excludeId = '') {
  return slots.filter((slot) => slot.id !== excludeId && isFree(slot) && overlaps(slot, range));
}

/** The booking (lecturer session) that `range` overlaps, or null. Free time cannot be added over one. */
export function bookingAt(slots, range, excludeId = '') {
  return slots.find((slot) => slot.id !== excludeId && isBooked(slot) && overlaps(slot, range)) || null;
}

/** Staff free across `range` who could run the booking instead (from overlapping free time). */
export function staffFreeAt(slots, range, excludeId = '') {
  const names = [];
  for (const slot of freeTimeTaken(slots, range, excludeId)) {
    for (const name of slotHosts(slot)) if (!names.some((other) => sameName(other, name))) names.push(name);
  }
  return names;
}

/** Of the free time taken, what belongs to staff who are not running the booking (they get emailed). */
export function overriddenOthers(taken, hosts) {
  return taken.filter((slot) => slotHosts(slot).some((name) => !hosts.some((host) => sameName(host, name))));
}

/** Times where two or more different staff are free at once (merged), for the "Overlap" bracket. */
export function overlapBands(slots) {
  const free = slots.filter(isFree);
  const pieces = [];
  for (let i = 0; i < free.length; i += 1) {
    for (let j = i + 1; j < free.length; j += 1) {
      const [a, b] = [free[i], free[j]];
      const sameStaff = slotHosts(a).every((name) => slotHosts(b).some((other) => sameName(other, name)))
        && slotHosts(b).every((name) => slotHosts(a).some((other) => sameName(other, name)));
      if (sameStaff || !overlaps(a, b)) continue;
      pieces.push({ start: Math.max(time(a.start), time(b.start)), end: Math.min(time(a.end), time(b.end)) });
    }
  }
  pieces.sort((x, y) => x.start - y.start);
  const merged = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    if (last && piece.start <= last.end) last.end = Math.max(last.end, piece.end);
    else merged.push({ ...piece });
  }
  return merged.map((band) => ({ start: new Date(band.start).toISOString(), end: new Date(band.end).toISOString() }));
}

/** Overridden free time of this staff member, soonest first. */
export function overriddenFor(slots, me) {
  if (!me) return [];
  return slots
    .filter((slot) => isRecording(slot) && slot.overriddenBy && slotHosts(slot).some((name) => sameName(name, me)))
    .sort((a, b) => time(a.start) - time(b.start));
}

/**
 * Whole hours on `day` (SGT) between `from` and `to` that are still to come, not
 * booked for anyone, and not already free time of `who`. [{ start, end }] ISO.
 */
export function openHours(slots, day, { nowMs, who = '', from = 8, to = 20 } = {}) {
  const hours = [];
  for (let hour = from; hour < to; hour += 1) {
    const range = { start: sgtIso(day, hour * 60), end: sgtIso(day, (hour + 1) * 60) };
    if (time(range.start) < nowMs) continue;
    const busy = slots.some((slot) => isRecording(slot) && overlaps(slot, range)
      && (isBooked(slot) || (isFree(slot) && who && slotHosts(slot).some((name) => sameName(name, who)))));
    if (!busy) hours.push(range);
  }
  return hours;
}

// ── Per-person calendar (owner 2026-11-24) ──────────────────────────────
// Staff are super users, shown by name (else email). A booking goes to the
// staff member free then who marked the time first (whole cover beats partial),
// mirrored from lambda/studio/workflow.js staffFreeFor; they confirm or hand it on.

export const staffLabel = (user) => String(user?.name || '').trim() || user?.email || '';
const marked = (slot) => time(slot.createdAt || slot.updatedAt || slot.start);

export const isBookingSlot = isBooked;

/**
 * A booking on its host's own free time, not confirmed yet (Publish leaves it a
 * draft; confirming sends it). Mirrors workflow.awaitsHost.
 */
export function awaitsHost(slot, slots = []) {
  if (!isBooked(slot) || slot.status !== 'draft' || slot.hostConfirmedAt) return false;
  const hosts = slotHosts(slot);
  return hosts.length > 0 && slots.some((free) => free.id !== slot.id && isRecording(free) && !free.assigneeEmail
    && overlaps(free, slot) && slotHosts(free).some((name) => hosts.some((host) => sameName(host, name))));
}

/** Staff free over `range`, priority first; staff running another booking then are left out. */
export function staffFreeFor(slots, range, excludeId = '') {
  const live = slots.filter((slot) => slot.id !== excludeId && isRecording(slot) && overlaps(slot, range));
  const busy = live.filter(isBooked).flatMap((slot) => slotHosts(slot));
  const covers = (slot) => time(slot.start) <= time(range.start) && time(slot.end) >= time(range.end);
  const ranked = live.filter((slot) => !slot.assigneeEmail)
    .sort((a, b) => Number(covers(b)) - Number(covers(a)) || marked(a) - marked(b));
  const names = [];
  for (const slot of ranked) {
    for (const name of slotHosts(slot)) {
      if (!names.some((other) => sameName(other, name)) && !busy.some((other) => sameName(other, name))) names.push(name);
    }
  }
  return names;
}

/** One column per person on the day, in order of first appearance; '' = nobody named. */
export function staffColumns(slots) {
  const keys = [];
  const sorted = [...slots].sort((a, b) => time(a.start) - time(b.start));
  for (const slot of sorted) {
    const key = slotHosts(slot)[0] || '';
    if (!keys.some((other) => sameName(other, key))) keys.push(key);
  }
  return [...keys.filter(Boolean), ...keys.filter((key) => !key)];
}

/** Parts of a free block that someone else's booking took (clipped to the block). */
export function takenParts(slot, slots) {
  if (!isRecording(slot) || slot.assigneeEmail) return [];
  const hosts = slotHosts(slot);
  return slots
    .filter((other) => isBooked(other) && overlaps(other, slot)
      && !(hosts.length && hosts.every((name) => slotHosts(other).some((host) => sameName(host, name)))))
    .map((booking) => ({
      booking,
      start: new Date(Math.max(time(slot.start), time(booking.start))).toISOString(),
      end: new Date(Math.min(time(slot.end), time(booking.end))).toISOString(),
    }));
}
