import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyResidencyLocks,
  chooseCapacityAction,
  scaleInCandidates,
  choosePreparationAction,
  chooseQueuedMatchingWorker,
  chooseSynthesisAdmission,
  fleetIsInMotion,
  matchingFreeSlots,
} from './decision.js';

const now = 1_000_000;
const worker = (overrides = {}) => ({
  instanceId: 'i-1',
  state: 'READY',
  reachable: true,
  modelKey: 'dean',
  voiceProfileId: 'deanvoice-v1',
  active: 0,
  queued: 0,
  maxSlots: 2,
  firstSeenAt: now - 900_000,
  lastActivityAt: now - 600_000,
  ...overrides,
});

test('routes to a matching free slot before considering reassignment', () => {
  const result = chooseCapacityAction({
    requestedModelKey: 'dean-v2',
    now,
    workers: [
      worker({ instanceId: 'i-dean', modelKey: 'dean' }),
      worker({ instanceId: 'i-v2', modelKey: 'dean-v2', active: 1 }),
    ],
  });
  assert.equal(result.type, 'route');
  assert.equal(result.worker.instanceId, 'i-v2');
});

test('reassigns an idle worker when the matching pool is full', () => {
  const result = chooseCapacityAction({
    requestedModelKey: 'dean-v2',
    now,
    reassignIdleMs: 300_000,
    workers: [
      worker({ instanceId: 'i-v2', modelKey: 'dean-v2', active: 2 }),
      worker({ instanceId: 'i-dean', modelKey: 'dean' }),
    ],
  });
  assert.equal(result.type, 'reassign');
  assert.equal(result.worker.instanceId, 'i-dean');
});

test('reassigns an idle worker immediately for a sequential request to another voice', () => {
  const result = chooseCapacityAction({
    requestedModelKey: 'dean-v2',
    now,
    reassignIdleMs: 0,
    lastDemandByModel: { dean: now - 30_000 },
    workers: [worker({ modelKey: 'dean' })],
  });
  assert.equal(result.type, 'reassign');
  assert.equal(result.worker.instanceId, 'i-1');
});

test('assigns a base-ready worker that has no resident model yet', () => {
  const worker = {
    instanceId: 'i-unassigned',
    state: 'UNASSIGNED',
    reachable: true,
    modelKey: '',
    active: 0,
    queued: 0,
    maxSlots: 2,
    lastActivityAt: 0,
  };

  const result = chooseCapacityAction({
    workers: [worker],
    requestedModelKey: 'dean-model',
    now: 10_000,
    reassignIdleMs: 0,
  });

  assert.equal(result.type, 'reassign');
  assert.equal(result.worker.instanceId, 'i-unassigned');
});

test('a positive event residency window can protect a recently demanded voice', () => {
  const result = chooseCapacityAction({
    requestedModelKey: 'dean-v2',
    now,
    reassignIdleMs: 300_000,
    lastDemandByModel: { dean: now - 30_000 },
    workers: [worker({ modelKey: 'dean' })],
  });
  assert.equal(result.type, 'scale');
});

test('does not reassign busy or queued workers', () => {
  const result = chooseCapacityAction({
    requestedModelKey: 'dean-v2',
    now,
    workers: [
      worker({ active: 1 }),
      worker({ instanceId: 'i-queued', queued: 1 }),
    ],
  });
  assert.equal(result.type, 'scale');
});

test('counts only free slots on reachable ready matching workers', () => {
  assert.equal(matchingFreeSlots([
    worker({ modelKey: 'dean-v2', active: 1 }),
    worker({ instanceId: 'i-v2-2', modelKey: 'dean-v2', active: 0 }),
    worker({ instanceId: 'i-other', modelKey: 'dean' }),
    worker({ instanceId: 'i-starting', modelKey: 'dean-v2', state: 'STARTING' }),
  ], 'dean-v2'), 3);
});

test('packs matching work onto the oldest worker so newer capacity can scale in', () => {
  const result = chooseCapacityAction({
    requestedModelKey: 'dean',
    now,
    workers: [
      worker({ instanceId: 'i-new', firstSeenAt: now - 60_000, active: 1 }),
      worker({ instanceId: 'i-old', firstSeenAt: now - 900_000, active: 0 }),
    ],
  });

  assert.equal(result.type, 'route');
  assert.equal(result.worker.instanceId, 'i-old');
});

test('does not route to a worker whose queued work consumes its final slot', () => {
  const result = chooseCapacityAction({
    requestedModelKey: 'dean',
    now,
    workers: [
      worker({ instanceId: 'i-full', active: 1, queued: 1 }),
      worker({ instanceId: 'i-free', firstSeenAt: now - 60_000, active: 0, queued: 0 }),
    ],
  });

  assert.equal(result.type, 'route');
  assert.equal(result.worker.instanceId, 'i-free');
});

test('event residency minimum protects only the oldest required workers', () => {
  const workers = applyResidencyLocks([
    worker({ instanceId: 'i-old', firstSeenAt: now - 900_000 }),
    worker({ instanceId: 'i-new', firstSeenAt: now - 60_000 }),
  ], [{
    entity: 'RESIDENCY_LOCK',
    voiceProfileId: 'deanvoice-v1',
    minimumWorkers: 1,
  }], now);

  assert.equal(workers.find((item) => item.instanceId === 'i-old').residencyLocked, true);
  assert.notEqual(workers.find((item) => item.instanceId === 'i-new').residencyLocked, true);
  const result = chooseCapacityAction({
    requestedModelKey: 'alex',
    workers,
    now,
  });
  assert.equal(result.type, 'reassign');
  assert.equal(result.worker.instanceId, 'i-new');
});

test('event residency minimum makes the last protected voice worker unavailable', () => {
  const workers = applyResidencyLocks([worker()], [{
    entity: 'RESIDENCY_LOCK',
    voiceProfileId: 'deanvoice-v1',
    minimumWorkers: 1,
  }], now);

  assert.equal(chooseCapacityAction({
    requestedModelKey: 'alex',
    workers,
    now,
  }).type, 'scale');
});

test('expired event residency locks do not protect workers', () => {
  const workers = applyResidencyLocks([worker()], [{
    entity: 'RESIDENCY_LOCK',
    voiceProfileId: 'deanvoice-v1',
    minimumWorkers: 1,
    expiresAt: Math.floor((now - 1) / 1_000),
  }], now);

  assert.notEqual(workers[0].residencyLocked, true);
});

test('model selection defers instead of scaling while the only GPU is warming', () => {
  const result = choosePreparationAction({
    requestedModelKey: 'dean',
    now,
    workers: [worker({ modelKey: 'alex', state: 'STARTING', active: 0, queued: 0 })],
  });

  assert.deepEqual(result, { type: 'defer' });
});

test('explicit event preparation may scale while the only GPU is warming', () => {
  const result = choosePreparationAction({
    requestedModelKey: 'dean',
    now,
    allowScale: true,
    workers: [worker({ modelKey: 'alex', state: 'STARTING', active: 0, queued: 0 })],
  });

  assert.deepEqual(result, { type: 'scale' });
});

test('model selection still reassigns an existing idle GPU without scaling', () => {
  const result = choosePreparationAction({
    requestedModelKey: 'dean-v2',
    now,
    workers: [worker({ modelKey: 'dean' })],
  });

  assert.equal(result.type, 'reassign');
  assert.equal(result.worker.instanceId, 'i-1');
});

test('queues on the least-loaded resident worker when every matching slot is occupied', () => {
  const selected = chooseQueuedMatchingWorker([
    worker({ instanceId: 'i-busier', active: 2, queued: 2 }),
    worker({ instanceId: 'i-next', active: 2, queued: 0 }),
    worker({ instanceId: 'i-other-model', modelKey: 'alex', active: 0 }),
  ], 'dean');

  assert.equal(selected.instanceId, 'i-next');
});

test('does not queue an absent model on a worker holding different weights', () => {
  assert.equal(chooseQueuedMatchingWorker([
    worker({ modelKey: 'alex', active: 2 }),
  ], 'dean'), null);
});

test('spreads a burst across matching workers instead of stacking one queue', () => {
  const fleet = [
    worker({ instanceId: 'i-a', active: 2, queued: 1 }),
    worker({ instanceId: 'i-b', active: 2, queued: 0 }),
    worker({ instanceId: 'i-c', active: 2, queued: 0 }),
  ];

  assert.equal(chooseQueuedMatchingWorker(fleet, 'dean', 2).instanceId, 'i-b');
});

test('refuses to queue deeper than the configured per-worker ceiling', () => {
  assert.equal(chooseQueuedMatchingWorker([
    worker({ instanceId: 'i-a', active: 2, queued: 2 }),
    worker({ instanceId: 'i-b', active: 2, queued: 2 }),
  ], 'dean', 2), null);
});

test('a worker below the ceiling still accepts overflow while another is full', () => {
  const selected = chooseQueuedMatchingWorker([
    worker({ instanceId: 'i-full', active: 2, queued: 2 }),
    worker({ instanceId: 'i-room', active: 2, queued: 1 }),
  ], 'dean', 2);

  assert.equal(selected.instanceId, 'i-room');
});

test('six atomic admissions fill three matching GPUs two slots at a time', () => {
  const fleet = [
    worker({ instanceId: 'i-old', firstSeenAt: now - 900_000 }),
    worker({ instanceId: 'i-middle', firstSeenAt: now - 600_000 }),
    worker({ instanceId: 'i-new', firstSeenAt: now - 300_000 }),
  ];
  const assigned = [];
  for (let request = 0; request < 6; request += 1) {
    const admission = chooseSynthesisAdmission({
      workers: fleet,
      requestedModelKey: 'dean',
      maxQueuedPerWorker: 2,
      now,
    });
    assert.equal(admission.type, 'direct');
    assigned.push(admission.worker.instanceId);
    const target = fleet.find((item) => item.instanceId === admission.worker.instanceId);
    target.active += 1;
  }
  assert.deepEqual(assigned, ['i-old', 'i-old', 'i-middle', 'i-middle', 'i-new', 'i-new']);
});

test('three overflow admissions spread across four saturated matching GPUs', () => {
  const fleet = ['i-a', 'i-b', 'i-c', 'i-d'].map((instanceId) =>
    worker({ instanceId, active: 2 }));
  const assigned = [];
  for (let request = 0; request < 3; request += 1) {
    const admission = chooseSynthesisAdmission({
      workers: fleet,
      requestedModelKey: 'dean',
      maxQueuedPerWorker: 2,
      now,
    });
    assert.equal(admission.type, 'queue');
    assigned.push(admission.worker.instanceId);
    fleet.find((item) => item.instanceId === admission.worker.instanceId).queued += 1;
  }
  assert.deepEqual(assigned, ['i-a', 'i-b', 'i-c']);
});

test('super-overflow stops at two queued requests per matching GPU', () => {
  const fleet = ['i-a', 'i-b', 'i-c', 'i-d'].map((instanceId) =>
    worker({ instanceId, active: 2 }));
  const admissions = [];
  for (let request = 0; request < 9; request += 1) {
    const admission = chooseSynthesisAdmission({
      workers: fleet,
      requestedModelKey: 'dean',
      maxQueuedPerWorker: 2,
      now,
    });
    admissions.push(admission.type);
    if (admission.type === 'queue') {
      fleet.find((item) => item.instanceId === admission.worker.instanceId).queued += 1;
    }
  }
  assert.deepEqual(admissions, [
    'queue', 'queue', 'queue', 'queue',
    'queue', 'queue', 'queue', 'queue',
    'queue-full',
  ]);
  assert.deepEqual(fleet.map((item) => item.queued), [2, 2, 2, 2]);
});

test('same-model overflow queues while an idle different-model GPU is reassigned', () => {
  const admission = chooseSynthesisAdmission({
    workers: [
      worker({ instanceId: 'i-dean', active: 2 }),
      worker({ instanceId: 'i-idle', modelKey: 'alex', active: 0 }),
    ],
    requestedModelKey: 'dean',
    maxQueuedPerWorker: 2,
    now,
  });
  assert.equal(admission.type, 'queue');
  assert.equal(admission.worker.instanceId, 'i-dean');
  assert.equal(admission.capacityAction.type, 'reassign');
  assert.equal(admission.capacityAction.worker.instanceId, 'i-idle');
});

test('a live reassignment for another model still counts as fleet motion', () => {
  assert.equal(fleetIsInMotion({
    coordinationItems: [{
      entity: 'REASSIGN',
      modelKey: 'someone-elses-model',
      synthesisBody: {},
      requestedAt: now - 5_000,
    }],
    workers: [worker({ state: 'READY' })],
    now,
  }), true);
});

test('a warming worker counts as fleet motion even with no coordination rows', () => {
  assert.equal(fleetIsInMotion({
    coordinationItems: [],
    workers: [worker({ state: 'DRAINING' })],
    now,
  }), true);
});

test('a stale reassignment row does not pin the fleet in motion forever', () => {
  assert.equal(fleetIsInMotion({
    coordinationItems: [{
      entity: 'REASSIGN',
      synthesisBody: {},
      requestedAt: now - 900_000,
    }],
    workers: [worker({ state: 'READY' })],
    now,
    pendingTtlMs: 600_000,
  }), false);
});

test('a settled ready fleet is not in motion, so real demand may still scale', () => {
  assert.equal(fleetIsInMotion({
    coordinationItems: [{ entity: 'MODEL', lastDemandAt: now }],
    workers: [worker({ state: 'READY' }), worker({ instanceId: 'i-2', state: 'READY' })],
    now,
  }), false);
});

test('selection defers instead of scaling while the fleet is mid-transition', () => {
  // The 1->2->3->4 incident: the only GPU is switching to another user's model,
  // so nothing is routable or reassignable for this selection.
  const workers = [worker({ modelKey: 'other', state: 'DRAINING' })];
  const inMotion = fleetIsInMotion({ coordinationItems: [], workers, now });
  const action = choosePreparationAction({
    workers,
    requestedModelKey: 'dean',
    now,
    allowScale: true && !inMotion,
  });

  assert.equal(inMotion, true);
  assert.equal(action.type, 'defer');
});

test('a worker already promised to another model is not spare capacity', () => {
  const fleet = [worker({ instanceId: 'i-idle', modelKey: 'other', active: 0, queued: 0 })];

  // Without the promise, this idle GPU looks reassignable to every caller.
  assert.equal(chooseCapacityAction({
    workers: fleet, requestedModelKey: 'dean', now,
  }).type, 'reassign');

  // Once it is committed to someone else's switch, it is not offered again.
  assert.equal(chooseCapacityAction({
    workers: fleet, requestedModelKey: 'dean', now, reassigningWorkerIds: ['i-idle'],
  }).type, 'scale');
});

test('a promised worker does not block a genuinely free second GPU', () => {
  const action = chooseCapacityAction({
    workers: [
      worker({ instanceId: 'i-promised', modelKey: 'other' }),
      worker({ instanceId: 'i-spare', modelKey: 'another' }),
    ],
    requestedModelKey: 'dean',
    now,
    reassigningWorkerIds: ['i-promised'],
  });

  assert.equal(action.type, 'reassign');
  assert.equal(action.worker.instanceId, 'i-spare');
});

test('the preflight grace delays a reassignment but must not justify scaling', () => {
  // Idle GPU holding another model, whose model was in demand 5s ago. The 30s
  // preflight grace blocks the switch right now, but the GPU is still idle
  // capacity — buying a second GPU here is exactly the waste to avoid.
  const workers = [worker({ instanceId: 'i-idle', modelKey: 'other', lastActivityAt: now - 5_000 })];
  const input = {
    workers,
    requestedModelKey: 'dean',
    lastDemandByModel: { other: now - 5_000 },
    now,
  };

  assert.equal(chooseCapacityAction({ ...input, reassignIdleMs: 30_000 }).type, 'scale');
  assert.equal(chooseCapacityAction({ ...input, reassignIdleMs: 0 }).type, 'reassign');
});

test('once the grace expires the same idle GPU is reassigned, not scaled', () => {
  const workers = [worker({ instanceId: 'i-idle', modelKey: 'other', lastActivityAt: now - 60_000 })];
  const action = chooseCapacityAction({
    workers,
    requestedModelKey: 'dean',
    lastDemandByModel: { other: now - 60_000 },
    now,
    reassignIdleMs: 30_000,
  });

  assert.equal(action.type, 'reassign');
  assert.equal(action.worker.instanceId, 'i-idle');
});

test('preflight boots are independent per voice: another voice booting does not block this one', async () => {
  const { preflightScaleBlocked } = await import('./decision.js');
  const now = 1_000_000;
  const tomBooting = [{ entity: 'PENDING', modelKey: 'tom', requestedAt: now - 120_000 }];
  const workers = [{ instanceId: 'i-tom', state: 'BOOTING', reachable: true }];
  assert.equal(preflightScaleBlocked({ coordinationItems: tomBooting, workers, now }), false);
});

test('preflight boot cooldown stops one person clicking through lectures from buying several GPUs', async () => {
  const { preflightScaleBlocked } = await import('./decision.js');
  const now = 1_000_000;
  const justStarted = [{ entity: 'PENDING', modelKey: 'a', requestedAt: now - 10_000 }];
  assert.equal(preflightScaleBlocked({ coordinationItems: justStarted, workers: [], now }), true);
});

test('an unclaimed booting GPU blocks a selection-triggered boot (it can serve this voice)', async () => {
  const { preflightScaleBlocked } = await import('./decision.js');
  const workers = [{ instanceId: 'i-new', state: 'BOOTING', reachable: true }];
  assert.equal(preflightScaleBlocked({ coordinationItems: [], workers, now: 1_000_000 }), true);
});

test('per-GPU scale-in removes the longest-idle GPU and keeps busy ones', async () => {
  const { chooseScaleInCandidate } = await import('./decision.js');
  const now = 10_000_000;
  const workers = [
    { instanceId: 'busy', state: 'READY', active: 1, queued: 0, lastActivityAt: now - 30 * 60_000, firstSeenAt: 0 },
    { instanceId: 'idle20', state: 'READY', active: 0, queued: 0, lastActivityAt: now - 20 * 60_000, firstSeenAt: 0 },
    { instanceId: 'idle16', state: 'READY', active: 0, queued: 0, lastActivityAt: now - 16 * 60_000, firstSeenAt: 0 },
    { instanceId: 'idle5', state: 'READY', active: 0, queued: 0, lastActivityAt: now - 5 * 60_000, firstSeenAt: 0 },
  ];
  assert.equal(chooseScaleInCandidate({ workers, now, desired: 4, minSize: 0 }).instanceId, 'idle20');
});

test('per-GPU scale-in respects the group minimum, event locks and recent voice demand', async () => {
  const { chooseScaleInCandidate } = await import('./decision.js');
  const now = 10_000_000;
  const idle = { state: 'READY', active: 0, queued: 0, lastActivityAt: now - 20 * 60_000, firstSeenAt: 0 };
  assert.equal(chooseScaleInCandidate({ workers: [{ ...idle, instanceId: 'a' }], now, desired: 1, minSize: 1 }), null);
  assert.equal(chooseScaleInCandidate({ workers: [{ ...idle, instanceId: 'a', residencyLocked: true }], now, desired: 2 }), null);
  assert.equal(chooseScaleInCandidate({
    workers: [{ ...idle, instanceId: 'a', modelKey: 'tom' }], now, desired: 2, lastDemandByModel: { tom: now - 60_000 },
  }), null);
});

test('a spare copy of a voice in use scales in by its own idleness; the last copy stays', async () => {
  const { chooseScaleInCandidate } = await import('./decision.js');
  const now = 10 * 60 * 60_000;
  const hour = 60 * 60_000;
  const workers = [
    { instanceId: 'i-old', state: 'READY', modelKey: 'voice', firstSeenAt: now - 3 * hour, lastActivityAt: now - 1_000, active: 0, queued: 0 },
    { instanceId: 'i-spare', state: 'READY', modelKey: 'voice', firstSeenAt: now - 2 * hour, lastActivityAt: now - hour, active: 0, queued: 0 },
  ];
  const lastDemandByModel = { voice: now - 1_000 };
  const pick = chooseScaleInCandidate({ workers, now, idleMs: 40 * 60_000, minSize: 0, desired: 2, lastDemandByModel });
  assert.equal(pick?.instanceId, 'i-spare');
  // Once it is the only copy, the voice's demand keeps it.
  const alone = chooseScaleInCandidate({ workers: [workers[0]], now, idleMs: 40 * 60_000, minSize: 0, desired: 1, lastDemandByModel });
  assert.equal(alone, null);
});

test('a spare copy of a busy voice can switch to another voice; the last copy cannot', () => {
  const now = 10_000_000;
  const oldest = {
    instanceId: 'i-old', state: 'READY', modelKey: 'dean', active: 0, queued: 0, maxSlots: 2,
    firstSeenAt: 1, lastActivityAt: now - 10_000,
  };
  const spare = {
    instanceId: 'i-spare', state: 'READY', modelKey: 'dean', active: 0, queued: 0, maxSlots: 2,
    firstSeenAt: 2, lastActivityAt: now - 7 * 60_000,
  };
  const lastDemandByModel = { dean: now - 5_000 };
  const both = chooseCapacityAction({
    workers: [oldest, spare], requestedModelKey: 'tengyu', lastDemandByModel, now, reassignIdleMs: 180_000,
  });
  assert.equal(both.type, 'reassign');
  assert.equal(both.worker.instanceId, 'i-spare');

  const lastCopy = chooseCapacityAction({
    workers: [{ ...spare }], requestedModelKey: 'tengyu', lastDemandByModel, now, reassignIdleMs: 180_000,
  });
  assert.equal(lastCopy.type, 'scale');
});

test('scale-in candidates cover the whole fleet only when every GPU is idle', () => {
  const now = 100_000_000;
  const idle = (id, mins) => ({
    instanceId: id, state: 'READY', reachable: true, modelKey: id, active: 0, queued: 0,
    firstSeenAt: 1, lastActivityAt: now - mins * 60_000,
  });
  const all = scaleInCandidates({ workers: [idle('a', 50), idle('b', 45)], now, idleMs: 40 * 60_000, desired: 2 });
  assert.deepEqual(all.map((w) => w.instanceId), ['a', 'b']);
  const some = scaleInCandidates({ workers: [idle('a', 50), idle('b', 5)], now, idleMs: 40 * 60_000, desired: 2 });
  assert.deepEqual(some.map((w) => w.instanceId), ['a']);
  assert.deepEqual(scaleInCandidates({ workers: [idle('a', 50)], now, idleMs: 40 * 60_000, desired: 1, minSize: 1 }), []);
});
