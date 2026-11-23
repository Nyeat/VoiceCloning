// Date maths for the Voice Studio calendars. Everything is in Singapore time
// (UTC+8, no daylight saving), keyed by "YYYY-MM-DD" day strings, so the
// calendar shows the same days to everyone whatever their device's time zone.

const SGT_OFFSET_MS = 8 * 3600_000;
const DAY_MS = 24 * 3600_000;

/** "YYYY-MM-DD" (SGT) of an ISO time or epoch ms. */
export function sgtDayKey(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return new Date(ms + SGT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Minutes since SGT midnight. */
export function sgtMinutes(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  const shifted = new Date(ms + SGT_OFFSET_MS);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/** ISO time for a day key plus minutes after SGT midnight. */
export function sgtIso(dayKey, minutes) {
  return new Date(Date.parse(`${dayKey}T00:00:00+08:00`) + minutes * 60_000).toISOString();
}

export function addDays(dayKey, days) {
  return new Date(Date.parse(`${dayKey}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function monthOf(dayKey) {
  return dayKey.slice(0, 7);
}

export function addMonths(monthKey, months) {
  const [year, month] = monthKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + months, 1));
  return date.toISOString().slice(0, 7);
}

/** Weeks (Monday first) covering the month: arrays of 7 day keys. */
export function monthGrid(monthKey) {
  const first = `${monthKey}-01`;
  const weekday = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7; // Mon = 0
  let cursor = addDays(first, -weekday);
  const weeks = [];
  do {
    const week = [];
    for (let i = 0; i < 7; i += 1) {
      week.push(cursor);
      cursor = addDays(cursor, 1);
    }
    weeks.push(week);
  } while (monthOf(cursor) === monthKey);
  return weeks;
}

export function formatMonth(monthKey) {
  return new Intl.DateTimeFormat('en-SG', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${monthKey}-01T00:00:00Z`));
}

export function formatDay(dayKey) {
  return new Intl.DateTimeFormat('en-SG', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${dayKey}T00:00:00Z`));
}

/** "1:30 pm" for minutes after midnight. */
export function formatMinutes(minutes) {
  const hours = Math.floor(minutes / 60) % 24;
  const rest = minutes % 60;
  const suffix = hours >= 12 ? 'pm' : 'am';
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  return `${twelve}:${String(rest).padStart(2, '0')} ${suffix}`;
}

export function formatLength(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours} h` : `${Math.floor(hours)} h ${minutes % 60}`;
}

/** Visible hour range for a day: default 8–20, stretched to include every slot. */
// nowMinutes (today only): the window always reaches a few hours past now, so the
// rest of today can still be booked in the evening.
export function dayHours(slots, { from = 8, to = 20, nowMinutes = null } = {}) {
  let start = from * 60;
  let end = to * 60;
  if (nowMinutes !== null) end = Math.min(24 * 60, Math.max(end, Math.ceil(nowMinutes / 60) * 60 + 3 * 60));
  for (const slot of slots) {
    start = Math.min(start, Math.floor(sgtMinutes(slot.start) / 60) * 60);
    const endMinutes = sgtDayKey(slot.end) === sgtDayKey(slot.start) ? sgtMinutes(slot.end) : 24 * 60;
    end = Math.max(end, Math.ceil(endMinutes / 60) * 60);
  }
  return { start, end };
}

/**
 * Side-by-side lanes for blocks that overlap in time (several people at once).
 * blocks: [{ id, start, end }] (ISO or ms). Returns { [id]: { lane, lanes } }.
 */
export function layoutLanes(blocks) {
  const time = (value) => (typeof value === 'number' ? value : Date.parse(value));
  const sorted = [...blocks].sort((a, b) => time(a.start) - time(b.start) || time(a.end) - time(b.end));
  const result = {};
  let cluster = [];
  let clusterEnd = -Infinity;
  const close = () => {
    const lanes = Math.max(1, ...cluster.map((id) => result[id].lane + 1));
    for (const id of cluster) result[id].lanes = lanes;
    cluster = [];
  };
  let laneEnds = [];
  for (const block of sorted) {
    const start = time(block.start);
    if (start >= clusterEnd) { close(); laneEnds = []; clusterEnd = -Infinity; }
    let lane = laneEnds.findIndex((end) => end <= start);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = time(block.end);
    result[block.id] = { lane, lanes: 1 };
    cluster.push(block.id);
    clusterEnd = Math.max(clusterEnd, time(block.end));
  }
  close();
  return result;
}
