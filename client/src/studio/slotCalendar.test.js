import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addMonths, dayHours, formatMinutes, monthGrid, sgtDayKey, sgtIso, sgtMinutes,
} from './slotCalendar.js';

test('SGT day keys and minutes do not depend on the device time zone', () => {
  // 16:30 UTC on the 20th is 00:30 SGT on the 21st.
  assert.equal(sgtDayKey('2026-11-20T16:30:00Z'), '2026-11-21');
  assert.equal(sgtMinutes('2026-11-20T16:30:00Z'), 30);
  assert.equal(sgtIso('2026-11-21', 13 * 60), '2026-11-21T05:00:00.000Z');
  assert.equal(formatMinutes(13 * 60 + 30), '1:30 pm');
  assert.equal(formatMinutes(0), '12:00 am');
});

test('month grid starts on Monday and covers the whole month', () => {
  const weeks = monthGrid('2026-11'); // 1 Nov 2026 is a Sunday
  assert.equal(weeks[0][0], '2026-10-26');
  assert.equal(weeks[0][6], '2026-11-01');
  assert.ok(weeks.flat().includes('2026-11-30'));
  assert.ok(weeks.every((week) => week.length === 7));
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(addMonths('2026-01', -1), '2025-12');
});

test('day view stretches to fit early or late slots', () => {
  assert.deepEqual(dayHours([]), { start: 480, end: 1200 });
  assert.deepEqual(dayHours([{ start: sgtIso('2026-11-21', 7 * 60 + 30), end: sgtIso('2026-11-21', 21 * 60 + 15) }]), { start: 420, end: 1320 });
});

test('today\'s window reaches a few hours past now, so the evening can be booked', async () => {
  const { dayHours } = await import('./slotCalendar.js');
  assert.deepEqual(dayHours([], { nowMinutes: 20 * 60 + 15 }), { start: 8 * 60, end: 24 * 60 });
  assert.deepEqual(dayHours([], { nowMinutes: 10 * 60 }), { start: 8 * 60, end: 20 * 60 });
  assert.deepEqual(dayHours([]), { start: 8 * 60, end: 20 * 60 });
});
