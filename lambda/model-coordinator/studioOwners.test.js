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

// Voice Studio, one person one GPU: two people's reserved GPUs never take each
// other, and other sites take neither while they are in use.
test('two people testing keep their own reserved GPUs', () => {
  const now = Date.now();
  const workers = [
    { instanceId: 'i-amy', modelKey: 'amy-voice' },
    { instanceId: 'i-ben', modelKey: 'ben-voice' },
  ];
  const items = [
    { entity: 'OWNER', coordinatorScope, instanceId: 'i-amy', ownerKey: 'reserved:studio-p-amy', modelKey: 'amy-voice', at: now },
    { entity: 'OWNER', coordinatorScope, instanceId: 'i-ben', ownerKey: 'reserved:studio-p-ben', modelKey: 'ben-voice', at: now },
  ];
  assert.deepEqual(reservedWorkerIds(items, workers, 'reserved:studio-p-amy', now), ['i-ben']);
  assert.deepEqual(reservedWorkerIds(items, workers, 'reserved:studio-p-ben', now), ['i-amy']);
  assert.deepEqual(reservedWorkerIds(items, workers, '', now).sort(), ['i-amy', 'i-ben']);
  // Unused for 35 min: the reservation lapses and the GPU is ordinary capacity again.
  assert.deepEqual(reservedWorkerIds(items, workers, '', now + 36 * 60_000), []);
});

// 2026-11-25: a replacement GPU adopted for a person boots on the default voice
// before it switches to theirs. It is still theirs: no other caller may switch it.
test('a studio person GPU holding another voice (replacement, mid-switch) stays reserved', () => {
  const now = Date.now();
  const workers = [{ instanceId: 'i-replacement', modelKey: 'dean-voice' }];
  const items = [
    { entity: 'OWNER', coordinatorScope, instanceId: 'i-replacement', ownerKey: 'reserved:studio-p-nat', modelKey: 'nat-voice', at: now },
  ];
  assert.deepEqual(reservedWorkerIds(items, workers, 'reserved:voice-dean', now), ['i-replacement']);
  assert.deepEqual(reservedWorkerIds(items, workers, '', now), ['i-replacement']);
  assert.deepEqual(reservedWorkerIds(items, workers, 'reserved:studio-p-nat', now), [], 'its owner may switch it');
});
