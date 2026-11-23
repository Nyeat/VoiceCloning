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
