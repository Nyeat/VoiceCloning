import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookingAt, freeTimeTaken, openHours, overlapBands, overriddenFor, overriddenOthers, staffFreeAt } from './availability.js';

const at = (hour) => `2026-11-24T${String(hour - 8).padStart(2, '0')}:00:00.000Z`; // SGT hour -> ISO
const slot = (id, from, to, fields = {}) => ({ id, kind: 'recording', start: at(from), end: at(to), assigneeEmail: '', hostNames: [], overriddenBy: null, ...fields });
const slots = [
  slot('teng', 15, 16, { hostNames: ['Teng Yu'] }),
  slot('adam', 15, 16, { hostNames: ['Adam'] }),
  slot('wh', 9, 10, { hostNames: ['Wei Han'] }),
  slot('lee', 11, 12, { assigneeEmail: 'lee@gmail.com', hostNames: ['Bea'] }),
  slot('gone', 13, 14, { hostNames: ['Adam'], overriddenBy: { slotId: 'x' } }),
];

test("booking Teng Yu's hour would take Adam's overlapping free time", () => {
  const range = { start: at(15), end: at(16) };
  assert.deepEqual(freeTimeTaken(slots, range, 'teng').map((s) => s.id), ['adam']);
  assert.deepEqual(staffFreeAt(slots, range, 'teng'), ['Adam']);
});

test('handing the session to Adam means nobody else loses time', () => {
  const taken = freeTimeTaken(slots, { start: at(15), end: at(16) }, 'teng');
  assert.deepEqual(overriddenOthers(taken, ['Teng Yu']).map((s) => s.id), ['adam']);
  assert.deepEqual(overriddenOthers(taken, ['adam']), []);
});

test('free time over a booking is spotted (the form warns before the server refuses)', () => {
  assert.equal(bookingAt(slots, { start: at(10), end: at(13) })?.id, 'lee');
  assert.equal(bookingAt(slots, { start: at(12), end: at(13) }), null, 'touching the end is fine');
  assert.equal(bookingAt(slots, { start: at(11), end: at(12) }, 'lee'), null, 'the booking itself');
});

test('overlap bands: different staff free at once, merged; bookings and overridden time do not count', () => {
  const extra = [...slots, slot('bea', 15, 17, { hostNames: ['Bea'] }), slot('teng2', 15, 16, { hostNames: ['Teng Yu'] })];
  assert.deepEqual(overlapBands(extra), [{ start: at(15), end: at(16) }]);
  assert.deepEqual(overlapBands(slots.filter((s) => s.id !== 'adam')), []);
});

test("finds this staff member's overridden time", () => {
  assert.deepEqual(overriddenFor(slots, 'ADAM').map((s) => s.id), ['gone']);
  assert.deepEqual(overriddenFor(slots, ''), []);
});

test("open hours skip bookings, the past and the person's own free time", () => {
  const open = openHours(slots, '2026-11-24', { nowMs: Date.parse(at(10)), who: 'Adam', from: 9, to: 17 }).map((r) => r.start);
  assert.deepEqual(open, [at(10), at(12), at(13), at(14), at(16)]);
});
