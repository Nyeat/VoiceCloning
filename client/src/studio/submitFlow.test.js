import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldNudgePartTwo } from './submitFlow.js';

const base = { part: 1, hasAudio: true, partTwoDone: false, partTwoSkipped: false };

test('nudges toward Part 2 once there is audio on Part 1 and Part 2 is not done', () => {
  assert.equal(shouldNudgePartTwo(base), true);
});

test('does not nudge before there is any audio (Submit is disabled anyway)', () => {
  assert.equal(shouldNudgePartTwo({ ...base, hasAudio: false }), false);
});

test('does not nudge once Part 2 has a take', () => {
  assert.equal(shouldNudgePartTwo({ ...base, partTwoDone: true }), false);
});

test('does not nudge while the lecturer is on the Part 2 page', () => {
  assert.equal(shouldNudgePartTwo({ ...base, part: 2 }), false);
});

test('does not nudge after the lecturer chose to skip Part 2', () => {
  assert.equal(shouldNudgePartTwo({ ...base, partTwoSkipped: true }), false);
});
