// Staff who run recording sessions: each name gets a stable colour (like
// calendar guests), so a glance at the day shows who runs what. Green and red
// are left out on purpose: they mean free and booked on the recording calendar.
export const STAFF_COLORS = Object.freeze([
  { dot: 'bg-violet-500', chip: 'bg-violet-50 text-violet-900 ring-violet-300' },
  { dot: 'bg-sky-500', chip: 'bg-sky-50 text-sky-900 ring-sky-300' },
  { dot: 'bg-amber-500', chip: 'bg-amber-50 text-amber-900 ring-amber-300' },
  { dot: 'bg-fuchsia-500', chip: 'bg-fuchsia-50 text-fuchsia-900 ring-fuchsia-300' },
  { dot: 'bg-indigo-500', chip: 'bg-indigo-50 text-indigo-900 ring-indigo-300' },
  { dot: 'bg-yellow-800', chip: 'bg-yellow-50 text-yellow-900 ring-yellow-700/40' },
  { dot: 'bg-cyan-600', chip: 'bg-cyan-50 text-cyan-900 ring-cyan-300' },
  { dot: 'bg-slate-500', chip: 'bg-slate-100 text-slate-800 ring-slate-300' },
]);

/** The same name (any case or spacing) always gets the same colour. */
export function staffColor(name) {
  const key = String(name || '').trim().toLowerCase();
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return STAFF_COLORS[hash % STAFF_COLORS.length];
}

/** A slot's staff as a list; older slots stored one comma-joined `hostName`. */
export function slotHosts(slot) {
  if (Array.isArray(slot?.hostNames) && slot.hostNames.length) return slot.hostNames;
  return String(slot?.hostName || '').split(',').map((name) => name.trim()).filter(Boolean);
}

/** Adds names to a staff list: trimmed, no case-insensitive duplicates, at most `max`. */
export function addHosts(current, typed, max = 8) {
  const next = [...current];
  for (const raw of String(typed || '').split(/[,;\n]/u)) {
    const name = raw.trim().slice(0, 80);
    if (!name || next.some((existing) => existing.toLowerCase() === name.toLowerCase())) continue;
    if (next.length >= max) break;
    next.push(name);
  }
  return next;
}
