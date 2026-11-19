export function chooseCapacityAction({
  workers = [],
  requestedModelKey,
  lastDemandByModel = {},
  now = Date.now(),
  reassignIdleMs = 0,
  reassigningWorkerIds = [],
} = {}) {
  // A worker already promised to another model is not spare capacity. Without
  // this, three selections arriving before the first switch begins each see the
  // same still-idle GPU and each schedule their own reassignment onto it, so it
  // thrashes through three models and two of the three callers are told a GPU is
  // warming for a voice it will never hold.
  const promised = new Set(reassigningWorkerIds.filter(Boolean));
  const available = workers.filter((worker) => (
    ['READY', 'UNASSIGNED'].includes(worker.state) && worker.reachable !== false
  ));
  const ready = available.filter((worker) => worker.state === 'READY');
  const matching = ready
    .filter((worker) => (
      worker.modelKey === requestedModelKey
      && Number(worker.active || 0) + Number(worker.queued || 0) < Number(worker.maxSlots || 0)
    ))
    // Stable packing order: fill the longest-lived matching worker first so
    // newer overflow workers become continuously idle and eligible for scale-in.
    // Every candidate already has a real free slot; age never overrides capacity.
    .sort((a, b) => (
      Number(a.firstSeenAt || Number.MAX_SAFE_INTEGER)
      - Number(b.firstSeenAt || Number.MAX_SAFE_INTEGER)
      || (Number(b.active || 0) + Number(b.queued || 0))
        - (Number(a.active || 0) + Number(a.queued || 0))
      || String(a.instanceId || '').localeCompare(String(b.instanceId || ''))
    ));
  if (matching.length > 0) return { type: 'route', worker: matching[0] };

  // Demand for a voice protects its LAST GPU, not every copy: routing packs
  // onto the oldest copy, so a spare copy idles by its own activity. Counting
  // the voice's demand against it meant no other voice could take it while
  // anyone used that voice (2026-11-19 staging, same rule as scale-in).
  const holders = new Map();
  for (const worker of ready) {
    if (worker.modelKey) holders.set(worker.modelKey, (holders.get(worker.modelKey) || 0) + 1);
  }
  const reassignable = available
    .filter((worker) => {
      if (worker.modelKey === requestedModelKey) return false;
      if (worker.residencyLocked === true) return false;
      if (promised.has(worker.instanceId)) return false;
      if (worker.active !== 0 || worker.queued !== 0) return false;
      const spareCopy = (holders.get(worker.modelKey) || 0) > 1;
      const modelLastDemand = spareCopy ? 0 : Number(lastDemandByModel[worker.modelKey] || 0);
      const idleSince = Math.max(Number(worker.lastActivityAt || 0), modelLastDemand);
      return now - idleSince >= reassignIdleMs;
    })
    .sort((a, b) => {
      const aDemand = Number(lastDemandByModel[a.modelKey] || 0);
      const bDemand = Number(lastDemandByModel[b.modelKey] || 0);
      return aDemand - bDemand || a.lastActivityAt - b.lastActivityAt;
    });
  if (reassignable.length > 0) return { type: 'reassign', worker: reassignable[0] };

  return { type: 'scale' };
}

// Event capacity is a minimum resident pool, not a blanket fleet freeze. For
// each live lock, protect the oldest matching workers up to its minimum; any
// overflow workers remain eligible for ordinary reassignment and scale-in.
export function applyResidencyLocks(workers = [], locks = [], now = Date.now()) {
  const protectedIds = new Set();
  const liveLocks = locks.filter((lock) => (
    lock?.entity === 'RESIDENCY_LOCK'
    && Number(lock.minimumWorkers || 0) > 0
    && (!Number(lock.expiresAt || 0) || Number(lock.expiresAt) * 1_000 > now)
  ));

  for (const lock of liveLocks) {
    const candidates = workers
      .filter((worker) => (
        worker.reachable !== false
        && worker.state === 'READY'
        && (lock.modelKey
          ? worker.modelKey === lock.modelKey
          : worker.voiceProfileId === lock.voiceProfileId)
      ))
      .sort((left, right) => (
        Number(left.firstSeenAt || Number.MAX_SAFE_INTEGER)
        - Number(right.firstSeenAt || Number.MAX_SAFE_INTEGER)
        || String(left.instanceId || '').localeCompare(String(right.instanceId || ''))
      ));
    for (const worker of candidates.slice(0, Number(lock.minimumWorkers))) {
      protectedIds.add(worker.instanceId);
    }
  }

  return workers.map((worker) => (
    protectedIds.has(worker.instanceId) ? { ...worker, residencyLocked: true } : worker
  ));
}

// Page-load/model-selection preflight may reuse capacity that already exists, but
// it must not purchase another GPU. Real synthesis and explicit event prewarming
// are the only callers allowed to turn a scale decision into an ASG mutation.
export function choosePreparationAction({ allowScale = false, ...capacityInput } = {}) {
  const action = chooseCapacityAction(capacityInput);
  if (action.type === 'scale' && !allowScale) return { type: 'defer' };
  return action;
}

// True when the fleet is already changing shape for anyone: a live reassignment,
// a claimed boot, or a worker that is not yet READY. A selection preflight must
// not buy a GPU in this state. The per-model short-circuits cannot see it,
// because a transition for a DIFFERENT model leaves no record under this model's
// key — the gap that turned one person's three lecture clicks into desired
// capacity 1->2->3->4.
export function fleetIsInMotion({
  coordinationItems = [],
  workers = [],
  now = Date.now(),
  pendingTtlMs = 600_000,
} = {}) {
  const liveRecord = (item) => {
    if (!item) return false;
    const fresh = now - Number(item.requestedAt || 0) < pendingTtlMs;
    if (item.entity === 'REASSIGN') return Boolean(item.synthesisBody) && fresh;
    if (item.entity === 'PENDING') return fresh;
    return false;
  };
  return coordinationItems.some(liveRecord)
    || workers.some((worker) => worker.reachable !== false && worker.state !== 'READY');
}

// Voice-independent version of the selection guard. A boot or switch already
// running for ANOTHER voice must not make this voice wait for it: Jack's new
// voice gets its own GPU while Tom's is still booting. Two things still block a
// selection-triggered boot:
//   - a booting GPU nobody has claimed yet (it can serve this voice), and
//   - any selection/boot started in the last `cooldownMs`, so one person
//     clicking through three lectures does not buy three GPUs (the original
//     1->2->3->4 incident). A page that stays open retries after the cooldown.
export function preflightScaleBlocked({
  coordinationItems = [],
  workers = [],
  now = Date.now(),
  pendingTtlMs = 600_000,
  cooldownMs = 60_000,
} = {}) {
  const livePending = coordinationItems.filter((item) => (
    item?.entity === 'PENDING' && now - Number(item.requestedAt || 0) < pendingTtlMs
  ));
  if (livePending.some((item) => now - Number(item.requestedAt || 0) < cooldownMs)) return true;
  const booting = workers.filter((worker) => worker.reachable !== false && worker.state !== 'READY').length;
  return booting > livePending.length;
}

export function matchingFreeSlots(workers = [], requestedModelKey = '') {
  return workers
    .filter((worker) =>
      worker.state === 'READY'
      && worker.reachable !== false
      && worker.modelKey === requestedModelKey)
    .reduce((total, worker) => total + Math.max(
      0,
      Number(worker.maxSlots || 0) - Number(worker.active || 0) - Number(worker.queued || 0),
    ), 0);
}

// Overflow waiting is bounded and spread. Each matching worker accepts at most
// `maxQueuedPerWorker` waiting requests, and the least-loaded worker is chosen
// first so a burst distributes across the fleet instead of stacking on one GPU.
// Returning null while matching workers exist means every one is at its queue
// ceiling; the caller must retry rather than queue deeper.
export function chooseQueuedMatchingWorker(
  workers = [],
  requestedModelKey = '',
  maxQueuedPerWorker = Number.MAX_SAFE_INTEGER,
) {
  return workers
    .filter((worker) => (
      worker.state === 'READY'
      && worker.reachable !== false
      && worker.modelKey === requestedModelKey
      && Number(worker.queued || 0) < Number(maxQueuedPerWorker)
    ))
    .sort((left, right) => (
      Number(left.active || 0) + Number(left.queued || 0)
      - Number(right.active || 0) - Number(right.queued || 0)
      || String(left.instanceId || '').localeCompare(String(right.instanceId || ''))
    ))[0] || null;
}

// One atomic synthesis admission decision. Callers must serialize this against
// reservations from other coordinator invocations; keeping the policy pure
// makes the two active slots and bounded distributed queue directly testable.
export function chooseSynthesisAdmission({
  workers = [],
  requestedModelKey = '',
  maxQueuedPerWorker = Number.MAX_SAFE_INTEGER,
  ...capacityInput
} = {}) {
  const capacityAction = chooseCapacityAction({
    ...capacityInput,
    workers,
    requestedModelKey,
  });
  if (capacityAction.type === 'route') {
    return { type: 'direct', worker: capacityAction.worker };
  }

  const matchingWorkers = workers.filter((worker) => (
    worker.state === 'READY'
    && worker.reachable !== false
    && worker.modelKey === requestedModelKey
  ));
  if (matchingWorkers.length === 0) return capacityAction;

  const queuedWorker = chooseQueuedMatchingWorker(
    workers,
    requestedModelKey,
    maxQueuedPerWorker,
  );
  return queuedWorker
    ? { type: 'queue', worker: queuedWorker, capacityAction }
    : { type: 'queue-full', capacityAction };
}

// Per-GPU scale-in. Picks the GPU that has been idle the longest, where idle
// means: READY, nothing speaking or waiting, not event-locked, and neither the
// GPU nor its voice has been used/selected for `idleMs` (an open page that keeps
// selecting a voice keeps that voice's GPU). Never takes the group below its
// minimum. Returns null when nothing should be removed.
export function chooseScaleInCandidate({
  workers = [],
  now = Date.now(),
  idleMs = 15 * 60_000,
  minSize = 0,
  desired = 0,
  lastDemandByModel = {},
} = {}) {
  if (Number(desired) - 1 < Number(minSize)) return null;
  const holders = new Map();
  for (const worker of workers) {
    if (worker.state === 'READY' && worker.reachable !== false && worker.modelKey) {
      holders.set(worker.modelKey, (holders.get(worker.modelKey) || 0) + 1);
    }
  }
  // Demand for a voice keeps its LAST GPU warm, not every copy of it. Routing
  // packs requests onto the oldest matching GPU, so a spare overflow copy goes
  // idle by its own activity; counting the voice's demand against it meant it
  // never scaled in while anyone used that voice (2026-11-17 staging).
  const idleSince = (worker) => Math.max(
    Number(worker.lastActivityAt || 0),
    Number(worker.firstSeenAt || 0),
    (holders.get(worker.modelKey) || 0) > 1 ? 0 : Number(lastDemandByModel[worker.modelKey] || 0),
  );
  return workers
    .filter((worker) => (
      worker.state === 'READY'
      && worker.reachable !== false
      && worker.residencyLocked !== true
      && Number(worker.active || 0) === 0
      && Number(worker.queued || 0) === 0
      && now - idleSince(worker) >= idleMs
    ))
    .sort((a, b) => idleSince(a) - idleSince(b)
      || Number(b.firstSeenAt || 0) - Number(a.firstSeenAt || 0))[0] || null;
}
