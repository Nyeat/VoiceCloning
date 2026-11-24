import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLine, positionOf, stopForPath, STOPS } from './superLine.js';

const NOW = '2026-11-23T03:00:00.000Z';
const at = (minutesFromNow) => new Date(Date.parse(NOW) + minutesFromNow * 60_000).toISOString();
const job = (fields) => ({ id: fields.id || 'j1', ownerEmail: 'a@x.com', ownerName: 'A', attempt: 1, createdAt: at(-600), feedback: [], ...fields });
const slot = (fields) => ({ id: 's1', assigneeEmail: 'a@x.com', assigneeName: 'A', status: 'published', kind: 'recording', start: at(60), end: at(120), ...fields });
const place = (fields) => positionOf({ jobs: [], recordingSlots: [], testSlots: [], now: Date.parse(NOW), ...fields });

test('stop 5 is "Assign test slot", never "book"', () => {
  assert.equal(STOPS[4].label, 'Assign test slot');
});

test('an upcoming draft recording session waits on you at stop 1', () => {
  const position = place({ recordingSlots: [slot({ status: 'draft' })] });
  assert.equal(position.stop, 'book');
  assert.equal(position.alert, true);
});

test('a published upcoming session is at stop 1 without an alert', () => {
  assert.deepEqual([place({ recordingSlots: [slot()] }).stop, place({ recordingSlots: [slot()] }).alert], ['book', false]);
});

test('a session that ended with no upload asks you to upload audio', () => {
  const position = place({ recordingSlots: [slot({ start: at(-120), end: at(-60) })] });
  assert.equal(position.stop, 'record');
  assert.equal(position.alert, true);
});

test('a session in progress is at stop 2 without an alert', () => {
  const position = place({ recordingSlots: [slot({ start: at(-10), end: at(50) })] });
  assert.deepEqual([position.stop, position.alert, position.note], ['record', false, 'Recording now']);
});

test('a job created after the session places the person by the job', () => {
  const position = place({ recordingSlots: [slot({ start: at(-700), end: at(-640) })], jobs: [job({ status: 'queued' })] });
  assert.equal(position.stop, 'train');
});

test('review and failed jobs wait on you at quality check', () => {
  assert.equal(place({ jobs: [job({ status: 'review' })] }).stop, 'qc');
  assert.equal(place({ jobs: [job({ status: 'failed' })] }).alert, true);
});

test('approved without a slot waits on you at stop 5', () => {
  const position = place({ jobs: [job({ status: 'approved' })] });
  assert.deepEqual([position.stop, position.alert], ['assign', true]);
});

test('scheduled: live slot is testing now, feedback means done', () => {
  const live = [slot({ kind: 'test', start: at(-5), end: at(15) })];
  assert.equal(place({ jobs: [job({ status: 'scheduled' })], testSlots: live }).note, 'Testing now');
  const done = place({ jobs: [job({ status: 'scheduled', feedback: [{ email: 'A@x.com', at: at(-1) }] })] });
  assert.equal(done.done, true);
});

test('approved with a test slot moves on: drafted, upcoming, now, over (slot from the server, ended ones too)', () => {
  const withSlot = (testSlot) => place({ jobs: [job({ status: 'approved', testSlot })] });
  assert.deepEqual([withSlot({ status: 'draft', start: at(30), end: at(90) }).stop, withSlot({ status: 'draft', start: at(30), end: at(90) }).alert], ['assign', true]);
  assert.deepEqual([withSlot({ status: 'published', start: at(30), end: at(90) }).stop, withSlot({ status: 'published', start: at(30), end: at(90) }).note], ['test', 'Test slot']);
  assert.equal(withSlot({ status: 'published', start: at(-30), end: at(30) }).note, 'Testing now');
  assert.deepEqual([withSlot({ status: 'published', start: at(-90), end: at(-30) }).note, withSlot({ status: 'published', start: at(-90), end: at(-30) }).alert], ['Slot over · no feedback yet', false]);
  // The overview's own (upcoming) slots still count when the job has none attached.
  assert.equal(place({ jobs: [job({ status: 'approved' })], testSlots: [slot({ kind: 'test', start: at(-5), end: at(15) })] }).note, 'Testing now');
});

test('buildLine counts alerts, labels badges and picks quality check as next', () => {
  const overview = {
    now: NOW,
    jobs: [
      job({ id: 'r1', ownerEmail: 'r@x.com', ownerName: 'R', status: 'review' }),
      job({ id: 'p1', ownerEmail: 'p@x.com', ownerName: 'P', status: 'approved' }),
      job({ id: 't1', ownerEmail: 't@x.com', ownerName: 'T', status: 'training' }),
      job({ id: 'c1', ownerEmail: 'c@x.com', ownerName: 'C', status: 'cancelled' }),
    ],
    slots: [slot({ assigneeEmail: 'd@x.com', assigneeName: 'D', status: 'draft' })],
  };
  const line = buildLine(overview);
  assert.equal(line.alertTotal, 3);
  assert.equal(line.stops.qc.badge, '1 to review');
  assert.equal(line.stops.book.badge, '1 draft');
  assert.equal(line.stops.train.badge, '1');
  assert.equal(line.next.key, 'qc');
  assert.deepEqual(line.next.names, ['R']);
  assert.equal(line.riders.some((rider) => rider.email === 'c@x.com'), false);
  assert.equal(line.riders[0].alert, true);
});

test('stopForPath maps console routes to stops', () => {
  assert.equal(stopForPath('/review/abc'), 'qc');
  assert.equal(stopForPath('/schedule'), 'assign');
  assert.equal(stopForPath('/record'), 'record');
  assert.equal(stopForPath('/'), '');
});
