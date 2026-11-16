import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionActivity } from './sessionActivity.js';

test('an open conversation keeps the gateway busy; idle time counts from the last close', () => {
  let t = 1_000;
  const activity = createSessionActivity(() => t);
  activity.opened();
  t = 600_000;
  assert.deepEqual([activity.status().busy, activity.status().idleMs], [true, 0]);
  activity.closed();
  t = 660_000;
  assert.deepEqual([activity.status().busy, activity.status().idleMs, activity.status().liveSessions], [false, 60_000, 0]);
  activity.closed();
  assert.equal(activity.status().liveSessions, 0);
});
