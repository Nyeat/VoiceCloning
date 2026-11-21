import assert from 'node:assert/strict';
import test from 'node:test';
import { coordinationKey, reservedWorkerIds } from './index.js';

// Owner records are read only in this coordinator's scope.
const coordinatorScope = coordinationKey('X', 'k').split('#')[1];

// Voice Studio: the lecturers' slot GPU and the super users' QC GPU never take each other.
test('slot and QC GPUs are kept apart', () => {
  const now = Date.now();
  const workers = [
    { instanceId: 'i-qc', modelKey: 'qc-voice' },
    { instanceId: 'i-slot', modelKey: 'slot-voice' },
  ];
  const items = [
    { entity: 'OWNER', coordinatorScope, instanceId: 'i-qc', ownerKey: 'held:studio-qc', modelKey: 'qc-voice', at: now - 60 * 60_000 },
    { entity: 'OWNER', coordinatorScope, instanceId: 'i-slot', ownerKey: 'reserved:studio-slot', modelKey: 'slot-voice', at: now },
  ];
  // The slot never takes the QC GPU, even unused for an hour.
  assert.deepEqual(reservedWorkerIds(items, workers, 'reserved:studio-slot', now), ['i-qc']);
  // The QC GPU never takes the slot GPU while it is reserved.
  assert.deepEqual(reservedWorkerIds(items, workers, 'held:studio-qc', now), ['i-slot']);
  // Other sites: the slot GPU is off limits; the QC GPU falls to the 10 min held rule.
  assert.deepEqual(reservedWorkerIds(items, workers, '', now), ['i-slot']);
});
