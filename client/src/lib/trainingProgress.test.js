import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTrainingProgress } from './trainingProgress.js';

const steps = (statuses) => statuses.map((status, index) => ({ index, status }));

test('training shows three plain stages and one percentage', () => {
  const start = summarizeTrainingProgress(steps(['done', 'running', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending']), 'running');
  assert.equal(start.currentLabel, 'Preparing your recordings');
  assert.equal(start.currentIndex, 0);
  assert.equal(start.percent, 5);
  assert.deepEqual(start.stages.map((stage) => stage.state), ['active', 'pending', 'pending']);

  const learning = summarizeTrainingProgress(steps(['done', 'done', 'done', 'done', 'done', 'done', 'done', 'running', 'pending']), 'running');
  assert.equal(learning.currentLabel, 'Learning your voice');
  assert.equal(learning.percent, 45);
  assert.deepEqual(learning.stages.map((stage) => stage.state), ['done', 'done', 'active']);
});

test('never 100% until complete; an error is shown as an error', () => {
  const allDone = steps(Array(9).fill('done'));
  assert.equal(summarizeTrainingProgress(allDone, 'running').percent, 99);
  const done = summarizeTrainingProgress(allDone, 'complete');
  assert.equal(done.percent, 100);
  assert.equal(done.currentLabel, 'Your voice is ready');
  const failed = summarizeTrainingProgress(steps(['done', 'done', 'error', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending']), 'error');
  assert.equal(failed.failed, true);
  assert.equal(failed.stages[0].state, 'error');
});
