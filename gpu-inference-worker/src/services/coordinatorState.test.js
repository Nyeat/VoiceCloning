import test from 'node:test';
import assert from 'node:assert/strict';
import { coordinatorState, registrationConflicts } from './coordinatorState.js';

test('boot residency is reported but may be replaced by an explicit registration', () => {
  coordinatorState.assign({ modelKey: 'k-boot', voiceProfileId: 'old-v1', source: 'boot' });
  const snapshot = coordinatorState.snapshot();
  assert.equal(snapshot.modelKey, 'k-boot');
  assert.equal(snapshot.residencySource, 'boot');
  assert.equal(registrationConflicts(snapshot, 'k-dean'), false);
});

test('coordinator or synthesis residency still refuses a different registration', () => {
  coordinatorState.assign({ modelKey: 'k-a', source: 'synthesis' });
  assert.equal(registrationConflicts(coordinatorState.snapshot(), 'k-b'), true);
  assert.equal(registrationConflicts(coordinatorState.snapshot(), 'k-a'), false);
  coordinatorState.assign({ modelKey: 'k-a' });
  assert.equal(coordinatorState.snapshot().residencySource, 'coordinator');
});

test('an empty worker has no source and no conflict', () => {
  coordinatorState.assign({ modelKey: '' });
  assert.equal(coordinatorState.snapshot().residencySource, null);
  assert.equal(registrationConflicts(coordinatorState.snapshot(), 'k'), false);
});
