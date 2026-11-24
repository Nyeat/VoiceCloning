// The super-user "train line": every lecturer rides the same six stops, from a
// booked recording session to a finished voice. Pure data + derivation only
// (no React, no imports) so it can be tested with node:test.

export const STOPS = Object.freeze([
  { key: 'book', n: 1, label: 'Book recording', who: 'You', kind: 'you', path: '/sessions' },
  { key: 'record', n: 2, label: 'Recording', who: 'You upload', kind: 'you', path: '/recording' },
  { key: 'train', n: 3, label: 'Training', who: 'Automatic', kind: 'auto', path: '/training' },
  { key: 'qc', n: 4, label: 'Quality check', who: 'You', kind: 'you', path: '/quality' },
  // Super users ASSIGN test slots; lecturers never book them (owner decision 2026-11-23).
  { key: 'assign', n: 5, label: 'Assign test slot', who: 'You', kind: 'you', path: '/schedule' },
  { key: 'test', n: 6, label: 'Testing & feedback', who: 'Lecturer', kind: 'them', path: '/feedback' },
]);

export const STOP_COPY = Object.freeze({
  book: {
    title: 'Book recording sessions',
    what: 'Put the session times on the calendar. Add a lecturer to book a session for them (red), or leave it free (green) and fill them in later. Publishing emails the booked lecturers, with reminders the day before and on the day.',
    todo: ['The session is on the calendar (with its lecturer, or free)', 'You pressed Publish (drafts are not sent to anyone)'],
  },
  record: {
    title: 'Recording',
    what: 'The lecturer records in their session. Afterwards, upload their audio files here; uploading sends the set to training.',
    todo: ['The lecturer recorded in their session', 'You uploaded their audio files'],
  },
  train: {
    title: 'Training',
    what: 'The GPU trains one voice at a time. It starts by itself when a set arrives and waits while a lecturer is testing.',
    todo: ['You are emailed when a voice is ready for quality check', 'A failed run also goes to quality check, with the error'],
    nothingToDo: true,
  },
  qc: {
    title: 'Quality check',
    what: 'Check each new voice before the lecturer hears it. Listen, then approve it or send it back to retrain on the same audio.',
    todo: ['You tested the voice (chat or text to speech)', 'You chose Approve or Retrain'],
  },
  assign: {
    title: 'Assign test slots',
    what: 'You assign each approved lecturer 20 minutes to try their voice on a GPU of their own; lecturers do not book or pick slots. Several people can share one time. Drafts stay private until you publish.',
    todo: ['The approved lecturer is assigned a slot on the calendar', 'You pressed Publish, which emails them their time'],
  },
  test: {
    title: 'Testing and feedback',
    what: 'The lecturer tests in their slot (their GPU warms up 20 minutes before) and sends feedback. Sending feedback ends their testing and the voice reaches the end of the line.',
    todo: ['The lecturer tested in their slot', 'Their feedback arrived (it shows below)'],
  },
});

const STOP_INDEX = new Map(STOPS.map((stop, index) => [stop.key, index]));
// Which waiting-on-you stop is offered first as "Next".
const NEXT_PRIORITY = ['qc', 'record', 'assign', 'book'];
const ALERT_LABEL = {
  book: (n) => `${n} draft${n === 1 ? '' : 's'}`,
  record: (n) => `${n} to upload`,
  qc: (n) => `${n} to review`,
  assign: (n) => `${n} waiting`,
};

/** The stop a console path belongs to ('' for home and the tools). */
export function stopForPath(pathname = '/') {
  if (pathname.startsWith('/review/') || pathname.startsWith('/quality')) return 'qc';
  if (pathname === '/record') return 'record';
  return STOPS.find((stop) => stop.path === pathname)?.key || '';
}

const lower = (value) => String(value || '').trim().toLowerCase();
const ms = (value) => Date.parse(value || '') || 0;

function latestBy(items, field) {
  return items.reduce((best, item) => (!best || ms(item[field]) > ms(best[field]) ? item : best), null);
}

/**
 * Where one person is on the line.
 * Returns { stop, alert, note, at, href } — `note` is a short phrase; `at`
 * (ISO) is a time the UI formats and appends where relevant.
 */
export function positionOf({ jobs, recordingSlots, testSlots, now }) {
  const job = latestBy(jobs, 'createdAt');
  const session = latestBy(recordingSlots, 'start');
  if (session && (!job || ms(session.start) > ms(job.createdAt))) {
    if (ms(session.start) > now) {
      return session.status === 'draft'
        ? { stop: 'book', alert: true, note: 'Draft · publish it', at: session.start, href: '/sessions' }
        : { stop: 'book', alert: false, note: 'Session', at: session.start, href: '/sessions' };
    }
    if (ms(session.end) > now) return { stop: 'record', alert: false, note: 'Recording now', at: null, href: '/recording' };
    return { stop: 'record', alert: true, note: 'Recorded · upload audio', at: null, href: '/recording' };
  }
  if (!job) return null;
  const review = `/review/${encodeURIComponent(job.id)}`;
  switch (job.status) {
    case 'uploading':
      return { stop: 'record', alert: false, note: 'Uploading', at: null, href: '/recording' };
    case 'queued':
      return { stop: 'train', alert: false, note: job.attempt > 1 ? `Queued · retrain ${job.attempt}` : 'Queued', at: null, href: '/training' };
    case 'training':
      return { stop: 'train', alert: false, note: 'On the GPU · done', at: job.estimate?.finishAt || null, href: '/training' };
    case 'review':
      return { stop: 'qc', alert: true, note: job.attempt > 1 ? `Retrain ${job.attempt} · review` : 'Ready to review', at: null, href: review };
    case 'failed':
      return { stop: 'qc', alert: true, note: 'Training failed', at: null, href: review };
    case 'approved':
      return { stop: 'assign', alert: true, note: 'Approved · no slot', at: null, href: `/schedule?person=${encodeURIComponent(job.ownerEmail)}` };
    case 'scheduled': {
      const owner = job.feedback?.some((entry) => lower(entry.email) === lower(job.ownerEmail));
      if (job.testingClosedAt || owner) return { stop: 'test', alert: false, note: 'Feedback sent', at: null, href: '/feedback', done: true };
      const slot = latestBy(testSlots, 'start');
      if (slot && ms(slot.start) <= now && now < ms(slot.end)) return { stop: 'test', alert: false, note: 'Testing now', at: null, href: '/feedback' };
      if (slot && ms(slot.start) > now) return { stop: 'test', alert: false, note: 'Test slot', at: slot.start, href: '/feedback' };
      return { stop: 'test', alert: false, note: 'Slot over · no feedback yet', at: null, href: '/feedback' };
    }
    default:
      return null;
  }
}

/**
 * Everything the line map, sidebar and stage headers show, from the admin overview.
 * @returns {{ stops: Record<string, {count:number, alerts:number, badge:string, people:object[]}>,
 *   riders: object[], alertTotal: number, next: null | {key:string, count:number, names:string[]} }}
 */
export function buildLine(overview) {
  const now = ms(overview?.now) || Date.now();
  const jobs = (overview?.jobs || []).filter((job) => job.status !== 'cancelled');
  const slots = overview?.slots || [];
  const people = new Map();
  const touch = (email, name) => {
    const key = lower(email);
    if (!key) return null;
    const entry = people.get(key) || { email: key, name: '', jobs: [], recordingSlots: [], testSlots: [] };
    if (name && !entry.name) entry.name = name;
    people.set(key, entry);
    return entry;
  };
  for (const job of jobs) touch(job.ownerEmail, job.ownerName)?.jobs.push(job);
  for (const slot of slots) {
    const entry = touch(slot.assigneeEmail, slot.assigneeName);
    if (!entry) continue;
    (slot.kind === 'recording' ? entry.recordingSlots : entry.testSlots).push(slot);
  }

  const stops = Object.fromEntries(STOPS.map((stop) => [stop.key, { count: 0, alerts: 0, badge: '', people: [] }]));
  const riders = [];
  for (const person of people.values()) {
    const position = positionOf({ ...person, now });
    if (!position) continue;
    const rider = { email: person.email, name: person.name || person.email, ...position };
    riders.push(rider);
    const stop = stops[position.stop];
    stop.count += 1;
    if (position.alert) stop.alerts += 1;
    stop.people.push(rider);
  }
  for (const [key, stop] of Object.entries(stops)) {
    stop.people.sort((a, b) => Number(b.alert) - Number(a.alert) || a.name.localeCompare(b.name));
    stop.badge = stop.alerts && ALERT_LABEL[key] ? ALERT_LABEL[key](stop.alerts) : stop.count ? String(stop.count) : '';
  }
  riders.sort((a, b) => Number(b.alert) - Number(a.alert) || STOP_INDEX.get(a.stop) - STOP_INDEX.get(b.stop) || a.name.localeCompare(b.name));
  const alertTotal = riders.filter((rider) => rider.alert).length;
  const nextKey = NEXT_PRIORITY.find((key) => stops[key].alerts > 0);
  const next = nextKey
    ? { key: nextKey, count: stops[nextKey].alerts, names: stops[nextKey].people.filter((p) => p.alert).map((p) => p.name) }
    : null;
  return { stops, riders, alertTotal, next };
}
