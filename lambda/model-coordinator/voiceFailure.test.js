import test from 'node:test';
import assert from 'node:assert/strict';
import {
  replacementGpu,
  scaleInCandidates,
  studioPersonAction,
  voiceFailed,
  VOICE_FAILURE_THRESHOLD,
} from './decision.js';

const now = Date.parse('2026-11-25T12:00:00Z');

test('a voice is failed only after the threshold (one transient error is retried once)', () => {
  assert.equal(voiceFailed({ entity: 'VOICEFAIL', failures: 1 }), false);
  assert.equal(voiceFailed({ entity: 'VOICEFAIL', failures: VOICE_FAILURE_THRESHOLD }), true);
  assert.equal(voiceFailed({ entity: 'VOICEFAIL', failures: 1, failed: true }), true);
  assert.equal(voiceFailed(null), false);
  assert.equal(voiceFailed({ entity: 'OWNER', failures: 5 }), false);
});

test('studio person: no GPU -> start one; never anyone else', () => {
  assert.deepEqual(studioPersonAction({ ownGpu: null, requestedModelKey: 'nat' }), { type: 'scale' });
});

test('studio person: own GPU still booting -> wait for it, never a second GPU (2026-11-25 19:56 incident)', () => {
  const ownGpu = { instanceId: 'i-own', state: 'STARTING', reachable: true, modelKey: '' };
  assert.deepEqual(studioPersonAction({ ownGpu, requestedModelKey: 'nat' }), { type: 'wait', reason: 'starting' });
});

test('studio person: own GPU came up holding another voice -> it switches, no new GPU', () => {
  const ownGpu = { instanceId: 'i-own', state: 'READY', reachable: true, modelKey: 'dean', active: 0, queued: 0 };
  assert.equal(studioPersonAction({ ownGpu, requestedModelKey: 'nat' }).type, 'reassign');
});

test('studio person: own GPU busy -> wait', () => {
  const ownGpu = { instanceId: 'i-own', state: 'READY', reachable: true, modelKey: 'dean', active: 1, queued: 0 };
  assert.deepEqual(studioPersonAction({ ownGpu, requestedModelKey: 'nat' }), { type: 'wait', reason: 'busy' });
});

test('replacement GPU: the unowned GPU launched after the dead one becomes theirs', () => {
  const deadLastSeenAt = now - 10 * 60_000;
  const workers = [
    { instanceId: 'i-old-baseline', state: 'READY', firstSeenAt: now - 5 * 3_600_000 },
    { instanceId: 'i-someone-else', state: 'READY', firstSeenAt: now - 5 * 60_000 },
    { instanceId: 'i-replacement', state: 'STARTING', firstSeenAt: now - 9 * 60_000 },
  ];
  const picked = replacementGpu({ workers, ownedInstanceIds: new Set(['i-someone-else']), deadLastSeenAt });
  assert.equal(picked.instanceId, 'i-replacement');
  assert.equal(replacementGpu({ workers: [workers[0]], ownedInstanceIds: new Set(), deadLastSeenAt }), null);
  assert.equal(replacementGpu({ workers, ownedInstanceIds: new Set(), deadLastSeenAt: 0 }), null);
});

test('scale-in never removes a reserved studio GPU for being idle', () => {
  const workers = [{ instanceId: 'i-slot', state: 'READY', reachable: true, active: 0, queued: 0, firstSeenAt: now - 3_600_000, lastActivityAt: now - 3_600_000, modelKey: 'dean' }];
  assert.equal(scaleInCandidates({ workers, now, idleMs: 60_000, desired: 1 }).length, 1);
  assert.equal(scaleInCandidates({ workers, now, idleMs: 60_000, desired: 1, reservedWorkerIds: ['i-slot'] }).length, 0);
  // ...but its owner's release does.
  assert.equal(scaleInCandidates({ workers, now, idleMs: 60_000, desired: 1, reservedWorkerIds: ['i-slot'], releasedWorkerIds: ['i-slot'] }).length, 1);
});

test('a released GPU that is still booting (or stuck retrying a voice) is removed', () => {
  const workers = [{ instanceId: 'i-loop', state: 'STARTING', reachable: false, active: 1, queued: 0, firstSeenAt: now - 600_000 }];
  assert.equal(scaleInCandidates({ workers, now, idleMs: 60_000, desired: 1 }).length, 0);
  assert.equal(scaleInCandidates({ workers, now, idleMs: 60_000, desired: 1, releasedWorkerIds: ['i-loop'] })[0].instanceId, 'i-loop');
});
