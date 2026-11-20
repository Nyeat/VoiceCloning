export function chooseCapacityAction({
  workers = [],
  requestedModelKey,
  lastDemandByModel = {},
  now = Date.now(),
  reassignIdleMs = 0,
  reassigningWorkerIds = [],
  ownedWorkerIds = [],
  foreignOwnedWorkerIds = [],
} = {}) {
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

  const reassignable = reassignCandidates({
    workers, requestedModelKey, lastDemandByModel, now, reassignIdleMs, reassigningWorkerIds, ownedWorkerIds,
    foreignOwnedWorkerIds,
  });
  if (reassignable.length > 0) return { type: 'reassign', worker: reassignable[0] };

  return { type: 'scale' };
}

// Idle GPUs that may switch to `requestedModelKey`, best candidate first.
// A GPU is in use when it spoke or switched recently (lastActivityAt), or when
// someone selected its voice recently (lastDemandByModel: every selection and
// message for the voice). Selection protects only the voice's LAST GPU:
// routing packs onto the oldest copy, so a spare copy idles by its own
// activity (2026-11-19 staging, same rule as scale-in).
// Page polls run every 15 s while someone waits for a booting GPU.
export const BOOT_WAITER_GRACE_MS = 60_000;

// A freshly booted GPU's warm-up sentences run before it registers its voice,
// so "registered after its last activity" means nobody has spoken through it
// yet: that warm-up is not use, and its idle time runs from when it started.
// Only someone still waiting for its voice protects it, so a GPU that came up
// for a prewarm guess (or for someone who left) switches to the voice someone is
// actually waiting for instead of a second GPU being bought (2026-11-20).
// Training site, one person one GPU: a GPU holding one of the signed-in
// account's own voices (its boot or switch loaded it, or the account picked a
// voice already on it) switches to another voice that account picks at once,
// even inside the 10 min window, whenever nothing is running or waiting on it.
// While it is busy the pick waits for it; the account never gets a second GPU
// (owner rule 2026-11-21). Ownership is the account, never the voice name: a
// GPU someone else loaded with your published voice is not yours to switch.

export function reassignCandidates({
  workers = [],
  requestedModelKey,
  lastDemandByModel = {},
  now = Date.now(),
  reassignIdleMs = 0,
  reassigningWorkerIds = [],
  ownedWorkerIds = [],
  foreignOwnedWorkerIds = [],
} = {}) {
  // A worker already promised to another model is not spare capacity. Without
  // this, three selections arriving before the first switch begins each see the
  // same still-idle GPU and each schedule their own reassignment onto it, so it
  // thrashes through three models.
  const promised = new Set(reassigningWorkerIds.filter(Boolean));
  const available = workers.filter((worker) => (
    ['READY', 'UNASSIGNED'].includes(worker.state) && worker.reachable !== false
  ));
  const owned = new Set(ownedWorkerIds.filter(Boolean));
  // Training site: another account's GPU is theirs from the moment it starts.
  // It is never "idle at once" after warming up; only the ordinary idle rule,
  // timed from when it came up, frees it for someone else.
  const foreign = new Set(foreignOwnedWorkerIds.filter(Boolean));
  const ownSwitchable = (worker) => owned.has(worker.instanceId)
    && Number(worker.active || 0) === 0
    && Number(worker.queued || 0) === 0;
  const holders = new Map();
  for (const worker of available) {
    if (worker.state === 'READY' && worker.modelKey) {
      holders.set(worker.modelKey, (holders.get(worker.modelKey) || 0) + 1);
    }
  }
  return available
    .filter((worker) => {
      if (worker.modelKey === requestedModelKey) return false;
      if (worker.residencyLocked === true) return false;
      if (promised.has(worker.instanceId)) return false;
      if (worker.active !== 0 || worker.queued !== 0) return false;
      if (ownSwitchable(worker)) return true;
      const spareCopy = (holders.get(worker.modelKey) || 0) > 1;
      const selectedAt = spareCopy ? 0 : Number(lastDemandByModel[worker.modelKey] || 0);
      const warmUpOnly = !spareCopy && Boolean(worker.modelKey) && !foreign.has(worker.instanceId)
        && Number(worker.residencyUpdatedAt || 0) > Number(worker.lastActivityAt || 0);
      // A GPU that has finished warming up and that nobody has spoken through is
      // idle at once (owner rule 2026-11-20), whatever its age. Only someone
      // still waiting for its voice when it came up (a selection within a
      // minute of registering, or later) keeps it. A switch marks activity, so
      // after a switch the ordinary 10 min applies.
      const stillWanted = selectedAt >= Number(worker.residencyUpdatedAt || 0) - BOOT_WAITER_GRACE_MS;
      const idleSince = warmUpOnly
        ? (stillWanted ? selectedAt : 0)
        : Math.max(
          Number(worker.lastActivityAt || 0),
          selectedAt,
          foreign.has(worker.instanceId) ? Number(worker.residencyUpdatedAt || 0) : 0,
        );
      return now - idleSince >= reassignIdleMs;
    })
    .sort((a, b) => {
      // Your own GPU first: one person, one GPU.
      const own = Number(ownSwitchable(b)) - Number(ownSwitchable(a));
      if (own) return own;
      const aDemand = Number(lastDemandByModel[a.modelKey] || 0);
      const bDemand = Number(lastDemandByModel[b.modelKey] || 0);
      return aDemand - bDemand || a.lastActivityAt - b.lastActivityAt;
    });
}

// No inference GPU is on yet, but one is already on its way (a boot request,
// a GPU still booting, or an instance the group is launching). Until that first
// GPU is up, every voice and all load wait for it instead of buying more; the
// first GPU then switches to whoever is waiting. Once any GPU is READY the
// ordinary switch/add rules apply (owner rule, 2026-11-20). Returns null when
// there is nothing to wait for, else the earliest known start (0 = unknown).
export function firstGpuHold({
  workers = [],
  coordinationItems = [],
  launchingInstances = 0,
  now = Date.now(),
  pendingTtlMs = 600_000,
} = {}) {
  if (workers.some((worker) => worker.reachable !== false && worker.state === 'READY')) return null;
  const booting = workers.filter((worker) => worker.state !== 'DRAINING');
  const pendingStarts = coordinationItems
    .filter((item) => item?.entity === 'PENDING' && now - Number(item.requestedAt || 0) < pendingTtlMs)
    .map((item) => Number(item.requestedAt) || 0);
  if (pendingStarts.length === 0 && booting.length === 0 && Number(launchingInstances) <= 0) return null;
  const starts = [...pendingStarts, ...booting.map((worker) => Number(worker.firstSeenAt) || 0)]
    .filter((value) => value > 0);
  return { startedAt: starts.length ? Math.min(...starts) : 0 };
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

// Read-only "is this voice heavily loaded right now?" for every page using it.
// Works from the worker rows the coordinator saved on its last request (no
// probes), so it is cheap to poll; rows older than `freshMs` count as unknown
// (not busy). Busy = no free slot on any of its GPUs, someone queued, or a GPU
// being added for it while it already has one.
export function peekVoiceLoad({
  workers = [],
  modelKey = '',
  pendingBoot = false,
  reassigning = false,
  now = Date.now(),
  freshMs = 90_000,
} = {}) {
  const matching = workers.filter((worker) => (
    worker.state === 'READY'
    && worker.reachable !== false
    && worker.modelKey === modelKey
    && now - Number(worker.updatedAt || 0) <= freshMs
  ));
  if (matching.length === 0) {
    // `resident: false` only when the rows are fresh: the voice is on no GPU
    // right now (switched away, scaled in, or never loaded). Stale rows say
    // nothing either way.
    const known = workers.some((worker) => now - Number(worker.updatedAt || 0) <= freshMs);
    return { state: 'UNKNOWN', busy: false, matchingWorkers: 0, ...(known ? { resident: false } : {}) };
  }
  const free = matchingFreeSlots(matching, modelKey);
  const queued = matching.reduce((total, worker) => total + Number(worker.queued || 0), 0);
  const busy = free === 0 || queued > 0 || pendingBoot || reassigning;
  const state = !busy
    ? 'READY'
    : pendingBoot ? 'BUSY_STARTING' : reassigning ? 'BUSY_WARMING' : 'BUSY_QUEUED';
  return { state, busy, matchingWorkers: matching.length, availableSlots: free, queued, resident: true };
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
export function chooseScaleInCandidate(options = {}) {
  return scaleInCandidates(options)[0] || null;
}

// Every worker that may be removed, longest-idle first. When this is the whole
// fleet, removing ANY one of them is safe — the coordinator relies on that when
// it can only lower the desired count and let the group pick (2026-11-19).
export function scaleInCandidates({
  workers = [],
  now = Date.now(),
  idleMs = 15 * 60_000,
  minSize = 0,
  desired = 0,
  lastDemandByModel = {},
} = {}) {
  if (Number(desired) - 1 < Number(minSize)) return [];
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
      || Number(b.firstSeenAt || 0) - Number(a.firstSeenAt || 0));
}
