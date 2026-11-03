import assert from 'node:assert/strict';
import test from 'node:test';
import { DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  acquireAdmissionLease,
  applyAdmissionReservations,
  bootAssignmentClaimable,
  capacityStartingMessage,
  consumeCompletedBoot,
  pendingWorkerMatchesBoot,
  releaseAdmissionLease,
} from './index.js';

test('live coordinator reservations bridge stale worker probes without double-counting', () => {
  const workers = [{
    instanceId: 'i-a', active: 1, queued: 0, maxSlots: 2,
  }];
  const items = [
    {
      entity: 'ADMISSION', coordinatorScope: 'vcs-staging-gpu-inference',
      workerId: 'i-a', lane: 'direct', baselineActive: 1, baselineQueued: 0,
      expiresAtMs: now + 10_000,
    },
    {
      entity: 'ADMISSION', coordinatorScope: 'vcs-staging-gpu-inference',
      workerId: 'i-a', lane: 'queue', baselineActive: 1, baselineQueued: 0,
      expiresAtMs: now + 10_000,
    },
  ];
  const [effective] = applyAdmissionReservations(workers, items, now);
  assert.equal(effective.active, 2);
  assert.equal(effective.queued, 1);
  assert.equal(effective.reservedDirect, 1);
  assert.equal(effective.reservedQueued, 1);
});

test('expired and other-scope admissions do not consume staging capacity', () => {
  const workers = [{ instanceId: 'i-a', active: 0, queued: 0, maxSlots: 2 }];
  const items = [
    {
      entity: 'ADMISSION', coordinatorScope: 'vcs-staging-gpu-inference',
      workerId: 'i-a', lane: 'direct', expiresAtMs: now - 1,
    },
    {
      entity: 'ADMISSION', coordinatorScope: 'dev',
      workerId: 'i-a', lane: 'queue', expiresAtMs: now + 10_000,
    },
  ];
  const [effective] = applyAdmissionReservations(workers, items, now);
  assert.equal(effective.active, 0);
  assert.equal(effective.queued, 0);
});

test('finishing reservations out of order releases capacity without target-count holes', () => {
  const workers = [{ instanceId: 'i-a', active: 1, queued: 0, maxSlots: 2 }];
  const twoLive = [
    {
      entity: 'ADMISSION', coordinatorScope: 'vcs-staging-gpu-inference',
      workerId: 'i-a', lane: 'direct', baselineActive: 0, expiresAtMs: now + 10_000,
    },
    {
      entity: 'ADMISSION', coordinatorScope: 'vcs-staging-gpu-inference',
      workerId: 'i-a', lane: 'direct', baselineActive: 0, expiresAtMs: now + 10_000,
    },
  ];
  assert.equal(applyAdmissionReservations(workers, twoLive, now)[0].active, 2);
  assert.equal(applyAdmissionReservations(workers, twoLive.slice(1), now)[0].active, 1);
});

test('fleet admission lease retries a conditional loser and releases only its owner', async () => {
  const calls = [];
  let attempts = 0;
  const documentClient = {
    send: async (command) => {
      calls.push(command);
      if (command instanceof PutCommand && attempts++ === 0) {
        const error = new Error('lease held');
        error.name = 'ConditionalCheckFailedException';
        throw error;
      }
      return {};
    },
  };
  const lease = await acquireAdmissionLease(Date.now(), {
    documentClient,
    coordinatorTable: 'test-table',
    waitMs: 1_000,
    leaseMs: 2_000,
  });
  await releaseAdmissionLease(lease, { documentClient, coordinatorTable: 'test-table' });

  assert.equal(calls.filter((command) => command instanceof PutCommand).length, 2);
  const release = calls.find((command) => command instanceof DeleteCommand);
  assert.equal(release.input.Key.id, lease.id);
  assert.equal(release.input.ExpressionAttributeValues[':owner'], lease.owner);
  assert.equal(release.input.ConditionExpression, '#owner = :owner');
  assert.deepEqual(release.input.ExpressionAttributeNames, { '#owner': 'owner' });
});

test('capacity copy distinguishes an autoscale boot from an idle-worker switch', () => {
  assert.match(capacityStartingMessage({ booting: true }), /new GPU is starting/i);
  assert.doesNotMatch(capacityStartingMessage({ booting: true }), /idle GPU is switching/i);
  assert.match(capacityStartingMessage(), /idle GPU is switching/i);
});

const now = 1_000_000;
const pending = (overrides = {}) => ({
  entity: 'PENDING',
  coordinatorScope: 'vcs-staging-gpu-inference',
  synthesisBody: { voice_model: { gptRef: 'gpt', sovitsRef: 'sovits' } },
  requestedAt: now - 1_000,
  ...overrides,
});

test('a pending Staging assignment is invisible to the Dev coordinator scope', () => {
  assert.equal(bootAssignmentClaimable(pending(), 'i-dev', now, 'dev'), false);
});

test('an old matching worker cannot clear a pending overflow launch', () => {
  assert.equal(pendingWorkerMatchesBoot(pending({
    claimedBy: undefined,
  }), {
    instanceId: 'i-existing',
    firstSeenAt: now - 600_000,
    reachable: true,
    state: 'READY',
    modelKey: 'model-a',
    active: 1,
    queued: 0,
    maxSlots: 2,
  }, 'model-a'), false);
});

test('the claimed new worker may satisfy and clear its pending overflow launch', () => {
  assert.equal(pendingWorkerMatchesBoot(pending({
    claimedBy: 'i-new',
  }), {
    instanceId: 'i-new',
    firstSeenAt: now + 1,
    reachable: true,
    state: 'READY',
    modelKey: 'model-a',
    active: 0,
    queued: 0,
    maxSlots: 2,
  }, 'model-a'), true);
});

test('capacity polling consumes a completed claimed boot marker', async () => {
  const calls = [];
  const documentClient = { send: async (command) => { calls.push(command); return {}; } };
  const marker = pending({ id: 'PENDING#staging#model-a', claimedBy: 'i-new' });
  const worker = {
    instanceId: 'i-new',
    firstSeenAt: now + 1,
    reachable: true,
    state: 'READY',
    modelKey: 'model-a',
    active: 0,
    queued: 0,
    maxSlots: 2,
  };

  assert.equal(await consumeCompletedBoot(marker, [worker], 'model-a', {
    documentClient,
    coordinatorTable: 'test-table',
  }), worker);
  assert.equal(calls.length, 1);
  assert.ok(calls[0] instanceof DeleteCommand);
  assert.deepEqual(calls[0].input, {
    TableName: 'test-table',
    Key: { id: marker.id },
  });
});

test('capacity polling preserves a boot marker when only an older worker matches', async () => {
  const calls = [];
  const documentClient = { send: async (command) => { calls.push(command); return {}; } };
  const marker = pending({ id: 'PENDING#staging#model-a' });
  const worker = {
    instanceId: 'i-existing',
    firstSeenAt: now - 600_000,
    reachable: true,
    state: 'READY',
    modelKey: 'model-a',
    active: 0,
    queued: 0,
    maxSlots: 2,
  };

  assert.equal(await consumeCompletedBoot(marker, [worker], 'model-a', {
    documentClient,
    coordinatorTable: 'test-table',
  }), null);
  assert.equal(calls.length, 0);
});

test('the same booting instance can reclaim its assignment after a service restart', () => {
  assert.equal(bootAssignmentClaimable(pending({
    claimedBy: 'i-canary',
    claimExpiresAt: now + 60_000,
  }), 'i-canary', now), true);
});

test('a different instance cannot steal a live boot assignment claim', () => {
  assert.equal(bootAssignmentClaimable(pending({
    claimedBy: 'i-original',
    claimExpiresAt: now + 60_000,
  }), 'i-other', now), false);
});

test('a different instance may claim after the prior lease expires', () => {
  assert.equal(bootAssignmentClaimable(pending({
    claimedBy: 'i-original',
    claimExpiresAt: now - 1,
  }), 'i-other', now), true);
});
