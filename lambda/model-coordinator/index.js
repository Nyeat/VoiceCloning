import crypto from 'node:crypto';
import net from 'node:net';
import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
  SetInstanceProtectionCommand,
  TerminateInstanceInAutoScalingGroupCommand,
  UpdateAutoScalingGroupCommand,
} from '@aws-sdk/client-auto-scaling';
import { DescribeInstancesCommand, EC2Client } from '@aws-sdk/client-ec2';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  applyResidencyLocks,
  chooseCapacityAction,
  choosePreparationAction,
  chooseScaleInCandidate,
  scaleInCandidates,
  chooseSynthesisAdmission,
  firstGpuHold,
  preflightScaleBlocked,
  reassignCandidates,
  matchingFreeSlots,
  peekVoiceLoad,
} from './decision.js';

const region = process.env.AWS_REGION || 'ap-northeast-2';
const tableName = process.env.MODEL_COORDINATOR_TABLE || 'vcs-staging-model-workers';
const asgName = process.env.MODEL_COORDINATOR_ASG || 'vcs-staging-gpu-inference';
const coordinatorMode = cleanEnv(process.env.MODEL_COORDINATOR_MODE || 'autoscale').toLowerCase();
const configuredInstanceIds = cleanEnv(process.env.MODEL_COORDINATOR_INSTANCE_IDS)
  .split(',').map((item) => item.trim()).filter(Boolean);
const authToken = String(process.env.MODEL_COORDINATOR_AUTH_TOKEN || '').trim();
// Sequential requests from one user must reuse idle capacity even when they
// select a different model. A positive value remains available for an event
// that deliberately wants short-lived model residency, but staging uses zero
// so scale-out is reserved for genuinely overlapping work.
const reassignIdleMs = Math.max(0, Number(process.env.MODEL_REASSIGN_IDLE_MS) || 0);
// Selecting a voice only switches a GPU whose last message (or switch) was at
// least this long ago; a GPU used more recently than this is someone's and a
// new GPU is added instead (autoscaled staging). Fixed-GPU Dev cannot add, so
// there the grace only delays the switch. Real synthesis uses reassignIdleMs.
const preflightReassignIdleMs = Math.max(
  reassignIdleMs,
  Number(process.env.MODEL_PREFLIGHT_REASSIGN_IDLE_MS) || 10 * 60_000,
);
const bootEstimateSeconds = Math.max(60, Number(process.env.MODEL_BOOT_ESTIMATE_SECONDS) || 360);
const requestTimeoutMs = Math.max(5_000, Number(process.env.MODEL_WORKER_TIMEOUT_MS) || 110_000);
const assignmentTimeoutMs = Math.max(
  requestTimeoutMs,
  Number(process.env.MODEL_ASSIGNMENT_TIMEOUT_MS) || 840_000,
);
const pendingTtlMs = Math.max(120_000, Number(process.env.MODEL_PENDING_TTL_MS) || 600_000);
// A voice selection only starts a NEW GPU once that same voice has been
// selected continuously for this long (pages re-check every 5 s). A quick
// click-through of several lectures never buys GPUs; other voices are never
// held up by it. Real synthesis is not subject to it.
// Per-GPU scale-in: a GPU idle this long (and whose voice nobody is using or
// selecting) is terminated individually, longest-idle first, one per sweep.
const scaleInIdleMs = Math.max(60_000, Number(process.env.MODEL_SCALE_IN_IDLE_MS) || 30 * 60_000);
const scaleInSweepMs = 60_000;
// A newly booted autoscaled GPU runs warm-staging-deanvoice.sh as its
// ExecStartPost: model load, then ten rounds that fill every slot, then
// /coordinator/register. It reports ready with the voice minutes before that
// script finishes, so routing there earlier bounced users off busy slots and
// launched a needless second GPU (2026-11-19 staging). It stays STARTING until
// it registers; the grace caps that wait if the script failed.
const bootWarmGraceMs = Math.max(0, Number(process.env.MODEL_BOOT_WARM_GRACE_MS) || 15 * 60_000);
const preflightDwellMs = Math.max(0, Number(process.env.MODEL_PREFLIGHT_DWELL_MS) || 8_000);
// A gap longer than this restarts the dwell (the page was closed). Waiting
// pages poll every 5-15 s but pause while hidden; a short gap restarted the
// shared wait timer whenever the waiting tab was in the background.
const selectionGapMs = 2 * 60_000;
// Bounded overflow waiting per GPU. A burst spreads across matching workers up
// to this depth; beyond it the request is retried by the caller instead of
// queueing without limit behind work that has not started.
const maxQueuedPerWorker = Math.max(1, Number(process.env.MODEL_MAX_QUEUED_PER_WORKER) || 2);
const admissionLeaseMs = Math.max(2_000, Number(process.env.MODEL_ADMISSION_LEASE_MS) || 10_000);
const admissionWaitMs = Math.max(admissionLeaseMs, Number(process.env.MODEL_ADMISSION_WAIT_MS) || 15_000);
const admissionReservationMs = Math.max(
  requestTimeoutMs,
  Number(process.env.MODEL_ADMISSION_RESERVATION_MS) || assignmentTimeoutMs,
);

const autoscaling = new AutoScalingClient({ region });
const ec2 = new EC2Client({ region });
const lambda = new LambdaClient({ region });
const document = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
});

function cleanEnv(value) {
  return String(value || '').trim();
}

function routingOnly() {
  return coordinatorMode === 'routing-only';
}

const coordinatorScope = cleanEnv(process.env.MODEL_COORDINATOR_SCOPE)
  || (routingOnly() ? 'dev' : asgName);

export function coordinationKey(entity, key, scope = coordinatorScope) {
  return `${entity}#${scope}#${key}`;
}

function itemInScope(item, scope = coordinatorScope) {
  return clean(item?.coordinatorScope) === scope;
}

function clean(value) {
  return String(value || '').trim();
}

export function modelResidencyKey(body = {}) {
  const raw = body.voice_model && typeof body.voice_model === 'object' ? body.voice_model : {};
  const gptRef = clean(raw.gptRef);
  const sovitsRef = clean(raw.sovitsRef);
  if (!gptRef && !sovitsRef) return '';
  return crypto.createHash('sha256').update(JSON.stringify({ gptRef, sovitsRef })).digest('hex');
}

function workerUrl(worker, path) {
  return `http://${worker.privateIp}:3003${path}`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = requestTimeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function coordinatorHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json',
    'X-VCS-Coordinator-Token': authToken,
    ...extra,
  };
}

async function scanState() {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await document.send(new ScanCommand({ TableName: tableName, ExclusiveStartKey }));
    items.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function probeWorker(worker) {
  try {
    const response = await fetchWithTimeout(workerUrl(worker, '/coordinator/status'), {
      headers: coordinatorHeaders(),
    }, 3_000);
    if (!response.ok) throw new Error(`status ${response.status}`);
    const status = await response.json();
    return {
      ...worker,
      reachable: true,
      state: status.draining ? 'DRAINING' : status.ready ? 'READY' : 'STARTING',
      modelKey: clean(status.modelKey),
      voiceProfileId: clean(status.voiceProfileId),
      residencySource: clean(status.residencySource),
      residencyUpdatedAt: Number(status.updatedAt) || 0,
      active: Number(status.active) || 0,
      queued: Number(status.queued) || 0,
      maxSlots: Number(status.maxSlots) || 2,
      lastActivityAt: Number(status.lastActivityAt) || Date.now(),
    };
  } catch {
    return {
      ...worker,
      reachable: false,
      state: 'STARTING',
      active: 0,
      queued: 0,
      maxSlots: 2,
      lastActivityAt: worker.lastActivityAt || Date.now(),
    };
  }
}

// Boot warm is done when the worker registers (newer workers report
// residencySource 'coordinator'), or when the AMI's Target Optimizer on 3103
// accepts connections: systemd starts it only after the warm ExecStartPost
// exits. The grace runs from the worker's first answer, so a failed script
// cannot strand a GPU; once released, a worker is never gated again.
export function gateBootWarm(worker, now = Date.now(), {
  enabled = true,
  graceMs = bootWarmGraceMs,
} = {}) {
  const reachableSince = Number(worker.firstReachableAt || 0);
  // The warm script ends with /coordinator/register, which sets the residency
  // timestamp WITHOUT marking activity; every synthesis sets residency first
  // and marks activity after. So an idle worker whose residency is newer than
  // its last activity has just registered: warm-up is over (works on the
  // current AMI, no network rule needed).
  const registeredNow = Boolean(worker.modelKey)
    && Number(worker.active || 0) === 0
    && Number(worker.queued || 0) === 0
    && Number(worker.residencyUpdatedAt || 0) > Number(worker.lastActivityAt || 0);
  const signalled = worker.residencySource === 'coordinator' || worker.warmPortOpen === true || registeredNow;
  const graceOver = reachableSince > 0 && now - reachableSince >= graceMs;
  const bootRegistered = !enabled || worker.bootRegistered === true || signalled || graceOver;
  const bootWarming = !bootRegistered && worker.reachable !== false;
  const { warmPortOpen, ...rest } = worker;
  return {
    ...rest,
    bootRegistered,
    bootWarming,
    ...(bootWarming && worker.state === 'READY' ? { state: 'STARTING' } : {}),
  };
}

function tcpPortOpen(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// AWS removes GPUs whenever desired < running. A stale manual desired (or a
// protection flag that held a GPU past it) let the group terminate a GPU in the
// middle of a conversation (2026-11-19 18:42 SGT). The coordinator owns
// scale-in, so it raises desired to the live GPUs it can route to — never above
// the group's maximum (max 0 = deliberate shutdown) and not right after its own
// scale-in, which lowers desired a moment before the group removes the GPU.
export function reconciledDesired({ group = {}, workers = [], lastScaleInAt = 0, now = Date.now(), graceMs = 5 * 60_000 } = {}) {
  const desired = Number(group.DesiredCapacity || 0);
  const max = Number(group.MaxSize || 0);
  const live = workers.filter((worker) => worker.reachable !== false && worker.state !== 'DRAINING').length;
  if (live <= desired || now - Number(lastScaleInAt || 0) < graceMs) return null;
  const target = Math.min(live, max);
  return target > desired ? target : null;
}

async function refreshFleet(existingItems, now = Date.now()) {
  const existing = new Map(
    existingItems.filter((item) => item.entity === 'WORKER').map((item) => [item.instanceId, item]),
  );
  let group;
  let ids;
  if (routingOnly()) {
    ids = configuredInstanceIds;
    group = {
      DesiredCapacity: ids.length,
      MaxSize: ids.length,
      Instances: ids.map((InstanceId) => ({ InstanceId, LifecycleState: 'InService' })),
    };
  } else {
    const fleet = await autoscaling.send(new DescribeAutoScalingGroupsCommand({
      AutoScalingGroupNames: [asgName],
    }));
    group = fleet.AutoScalingGroups?.[0];
    if (!group) throw new Error(`Auto Scaling group ${asgName} was not found`);
    const candidates = (group.Instances || []).filter((item) =>
      ['InService', 'Pending', 'Pending:Wait', 'Pending:Proceed'].includes(item.LifecycleState));
    ids = candidates.map((item) => item.InstanceId).filter(Boolean);
  }
  if (ids.length === 0) return { group, workers: [] };

  const described = await ec2.send(new DescribeInstancesCommand({ InstanceIds: ids }));
  const instances = (described.Reservations || []).flatMap((reservation) => reservation.Instances || [])
    .filter((instance) => instance.State?.Name === 'running');
  const workers = await Promise.all(instances.filter((instance) => instance.PrivateIpAddress).map(async (instance) => {
    const prior = existing.get(instance.InstanceId) || {};
    const probed = await probeWorker({
      ...prior,
      entity: 'WORKER',
      id: `WORKER#${instance.InstanceId}`,
      // Dev and staging share the table; peek reads rows without probing.
      coordinatorScope,
      instanceId: instance.InstanceId,
      privateIp: instance.PrivateIpAddress,
      firstSeenAt: prior.firstSeenAt || now,
      updatedAt: now,
    });
    // A worker already serving before this field existed keeps its old start.
    probed.firstReachableAt = prior.firstReachableAt
      || (prior.reachable === true ? prior.firstSeenAt : 0)
      || (probed.reachable ? now : 0);
    const gateEnabled = !routingOnly();
    if (gateEnabled && probed.reachable && prior.bootRegistered !== true
      && probed.residencySource !== 'coordinator') {
      probed.warmPortOpen = await tcpPortOpen(probed.privateIp, 3103);
    }
    return gateBootWarm(probed, now, { enabled: gateEnabled });
  }));
  await Promise.all(workers.map((worker) => document.send(new PutCommand({
    TableName: tableName,
    Item: worker,
  }))));
  if (!routingOnly()) {
    const lastScaleIn = existingItems.find((item) => item.id === coordinationKey('SWEEP', 'last-scale-in'));
    const target = reconciledDesired({ group, workers, lastScaleInAt: lastScaleIn?.at, now });
    if (target !== null) {
      try {
        await autoscaling.send(new UpdateAutoScalingGroupCommand({
          AutoScalingGroupName: asgName,
          DesiredCapacity: target,
        }));
        console.log('[model-coordinator][decision]', JSON.stringify({
          request: 'refresh', decision: 'reconcile-desired', from: Number(group.DesiredCapacity || 0), to: target,
        }));
        group = { ...group, DesiredCapacity: target };
      } catch (error) {
        console.error('[model-coordinator][reconcile]', error?.name || '', error?.message || error);
      }
    }
  }
  return { group, workers };
}

async function recordDemand(modelKey, voiceProfileId, now = Date.now()) {
  await document.send(new PutCommand({
    TableName: tableName,
    Item: {
      entity: 'MODEL',
      id: coordinationKey('MODEL', modelKey),
      coordinatorScope,
      modelKey,
      voiceProfileId: clean(voiceProfileId),
      lastDemandAt: now,
      expiresAt: Math.floor((now + 86_400_000) / 1_000),
    },
  }));
}

// Tracks how long a voice has been continuously selected. Returns the dwell in ms.
async function recordSelection(modelKey, existingItems, now = Date.now()) {
  const id = coordinationKey('SELECT', modelKey);
  const previous = existingItems.find((item) => item.id === id);
  const continuing = previous && now - Number(previous.lastSeenAt || 0) < selectionGapMs;
  const firstSeenAt = continuing ? Number(previous.firstSeenAt || now) : now;
  await document.send(new PutCommand({
    TableName: tableName,
    Item: {
      entity: 'SELECT',
      id,
      coordinatorScope,
      modelKey,
      firstSeenAt,
      lastSeenAt: now,
      expiresAt: Math.floor((now + 3_600_000) / 1_000),
    },
  }));
  return now - firstSeenAt;
}

function demandMap(items) {
  return Object.fromEntries(items
    .filter((item) => item.entity === 'MODEL' && item.modelKey && itemInScope(item))
    .map((item) => [item.modelKey, Number(item.lastDemandAt) || 0]));
}

function lockedFleet(items, workers, now = Date.now()) {
  return applyResidencyLocks(
    workers,
    items.filter((item) => item.entity === 'RESIDENCY_LOCK' && itemInScope(item)),
    now,
  );
}

export async function lockResidency(event, now = Date.now(), {
  documentClient = document,
  coordinatorTable = tableName,
} = {}) {
  const voiceProfileId = clean(event.voiceProfileId);
  const bodyModelKey = modelResidencyKey(event.body || {});
  if (!voiceProfileId && !bodyModelKey) {
    return { statusCode: 400, error: 'A voiceProfileId or immutable model body is required.' };
  }
  const minimumWorkers = Number(event.minimumWorkers);
  if (!Number.isInteger(minimumWorkers) || minimumWorkers < 1 || minimumWorkers > 192) {
    return { statusCode: 400, error: 'minimumWorkers must be an integer from 1 to 192.' };
  }
  const lockKey = bodyModelKey || `profile:${voiceProfileId}`;
  const expiresAt = Math.max(0, Number(event.expiresAt) || 0);
  await documentClient.send(new PutCommand({
    TableName: coordinatorTable,
    Item: {
      entity: 'RESIDENCY_LOCK',
      id: coordinationKey('LOCK', lockKey),
      coordinatorScope,
      voiceProfileId,
      modelKey: bodyModelKey || undefined,
      minimumWorkers,
      requestedAt: now,
      expiresAt: expiresAt || undefined,
    },
  }));
  return { statusCode: 200, locked: true, voiceProfileId, modelKey: bodyModelKey, minimumWorkers, expiresAt };
}

export async function unlockResidency(event, {
  documentClient = document,
  coordinatorTable = tableName,
} = {}) {
  const voiceProfileId = clean(event.voiceProfileId);
  const bodyModelKey = modelResidencyKey(event.body || {});
  if (!voiceProfileId && !bodyModelKey) {
    return { statusCode: 400, error: 'A voiceProfileId or immutable model body is required.' };
  }
  const lockKey = bodyModelKey || `profile:${voiceProfileId}`;
  await documentClient.send(new DeleteCommand({
    TableName: coordinatorTable,
    Key: { id: coordinationKey('LOCK', lockKey) },
  }));
  return { statusCode: 200, locked: false, voiceProfileId, modelKey: bodyModelKey };
}

async function assignWorker(worker, synthesisBody, {
  ignoreIdle = false,
  requiredIdleMs = reassignIdleMs,
} = {}) {
  await setWorkerProtection(worker.instanceId, true);
  try {
    const response = await fetchWithTimeout(workerUrl(worker, '/coordinator/assign'), {
      method: 'POST',
      headers: coordinatorHeaders(),
      body: JSON.stringify({
        synthesisBody,
        requiredIdleMs: ignoreIdle ? 0 : requiredIdleMs,
      }),
    }, assignmentTimeoutMs);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `Worker assignment failed (${response.status})`);
      error.statusCode = response.status;
      error.retryAfterMs = data.retryAfterMs;
      throw error;
    }
    return { ...worker, ...data.status, state: 'READY', reachable: true };
  } finally {
    await setWorkerProtection(worker.instanceId, false).catch(() => {});
  }
}

function liveReassignment(item, now = Date.now()) {
  return item?.entity === 'REASSIGN'
    && Boolean(item.synthesisBody)
    && now - Number(item.requestedAt || 0) < pendingTtlMs;
}

// Instances the group is launching that are not running GPUs yet.
function launchingInstanceCount(group) {
  return (group?.Instances || []).filter((item) => /^Pending/u.test(String(item.LifecycleState || ''))).length;
}

function holdForFirstGpu(items, workers, group, now, ownerKey = '') {
  if (routingOnly()) return null;
  const scoped = items.filter((item) => itemInScope(item));
  if (ownerKey) {
    // Training site: a GPU starting for ANOTHER account is theirs. When only
    // other people's GPUs are starting, this account gets its own instead of
    // waiting for (and then taking) theirs.
    const live = (item) => item.entity === 'PENDING' && now - Number(item.requestedAt || 0) < pendingTtlMs;
    const foreign = scoped.filter((item) => live(item) && item.ownerKey && item.ownerKey !== ownerKey).length;
    const others = scoped.filter((item) => live(item) && !(item.ownerKey && item.ownerKey !== ownerKey)).length;
    const booting = Math.max(
      workers.filter((worker) => worker.state !== 'READY' && worker.state !== 'DRAINING').length,
      launchingInstanceCount(group),
    );
    if (foreign > 0 && others === 0 && booting <= foreign) return null;
  }
  return firstGpuHold({
    workers,
    coordinationItems: scoped,
    launchingInstances: launchingInstanceCount(group),
    now,
    pendingTtlMs,
  });
}

export const FIRST_GPU_WAIT_MESSAGE = 'A GPU is already starting. This voice loads on it as soon as it is up; no extra GPU is added while it starts.';

// Workers already committed to a live reassignment for some other model. They
// still probe as idle READY until the switch actually begins, so without this
// they look like spare capacity to every concurrent selection.
function promisedWorkerIds(items, now = Date.now()) {
  return items
    .filter((item) => itemInScope(item) && liveReassignment(item, now))
    .map((item) => clean(item.workerId))
    .filter(Boolean);
}

// Which signed-in account loaded which GPU (training site, one person one GPU).
// `ownerKey` is an opaque hash of the account id from the main Lambda.
async function recordGpuOwner(instanceId, ownerKey, modelKey, now = Date.now()) {
  if (!instanceId || !ownerKey || !modelKey) return;
  await document.send(new PutCommand({
    TableName: tableName,
    Item: {
      entity: 'OWNER',
      id: coordinationKey('OWNER', instanceId),
      coordinatorScope,
      instanceId,
      ownerKey,
      modelKey,
      at: now,
      expiresAt: Math.floor((now + 86_400_000) / 1_000),
    },
  })).catch((error) => console.error('[model-coordinator][owner]', error?.message || error));
}

// Training site: GPUs another account loaded that still hold that account's
// voice. Not someone else's to take straight after they warm up.
function foreignOwnedWorkerIds(items, workers, ownerKey) {
  if (!ownerKey) return [];
  const owners = new Map(items
    .filter((item) => item.entity === 'OWNER' && itemInScope(item) && item.ownerKey && item.ownerKey !== ownerKey)
    .map((item) => [item.instanceId, item.modelKey]));
  return workers
    .filter((worker) => owners.has(worker.instanceId) && owners.get(worker.instanceId) === worker.modelKey)
    .map((worker) => worker.instanceId);
}

// GPUs this account loaded that still hold the voice it loaded on them.
function ownedWorkerIds(items, workers, ownerKey) {
  if (!ownerKey) return [];
  const owners = new Map(items
    .filter((item) => item.entity === 'OWNER' && itemInScope(item) && item.ownerKey === ownerKey)
    .map((item) => [item.instanceId, item.modelKey]));
  return workers
    .filter((worker) => owners.has(worker.instanceId) && owners.get(worker.instanceId) === worker.modelKey)
    .map((worker) => worker.instanceId);
}

async function scheduleReassignment(worker, modelKey, synthesisBody, now = Date.now(), {
  requiredIdleMs = reassignIdleMs,
  ownerKey = '',
} = {}) {
  const id = coordinationKey('REASSIGN', modelKey);
  const existing = await document.send(new GetCommand({ TableName: tableName, Key: { id } }));
  if (liveReassignment(existing.Item, now)) {
    return { started: false, pending: existing.Item };
  }
  const pending = {
    entity: 'REASSIGN',
    id,
    coordinatorScope,
    modelKey,
    workerId: worker.instanceId,
    synthesisBody,
    requestedAt: now,
    requiredIdleMs,
    ...(ownerKey ? { ownerKey } : {}),
    expiresAt: Math.floor((now + pendingTtlMs) / 1_000),
  };
  try {
    await document.send(new PutCommand({
      TableName: tableName,
      Item: pending,
      ConditionExpression: 'attribute_not_exists(id) OR requestedAt < :staleBefore',
      ExpressionAttributeValues: { ':staleBefore': now - pendingTtlMs },
    }));
  } catch (error) {
    if (error.name !== 'ConditionalCheckFailedException') throw error;
    const winner = await document.send(new GetCommand({ TableName: tableName, Key: { id } }));
    return { started: false, pending: winner.Item };
  }
  try {
    await lambda.send(new InvokeCommand({
      FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({ action: 'reassign', id })),
    }));
  } catch (error) {
    await document.send(new DeleteCommand({ TableName: tableName, Key: { id } })).catch(() => {});
    throw error;
  }
  return { started: true, pending };
}

async function runReassignment(id, now = Date.now()) {
  const result = await document.send(new GetCommand({ TableName: tableName, Key: { id } }));
  const pending = result.Item;
  if (!liveReassignment(pending, now)) {
    return { statusCode: 200, assigned: false, reason: 'expired' };
  }
  try {
    const existing = await scanState();
    const refreshed = await refreshFleet(existing, now);
    const workers = lockedFleet(existing, refreshed.workers, now);
    const capacityInput = {
      workers,
      requestedModelKey: pending.modelKey,
      lastDemandByModel: demandMap(existing),
      now,
      reassignIdleMs: Math.max(0, Number(pending.requiredIdleMs) || 0),
      ownedWorkerIds: ownedWorkerIds(existing, workers, clean(pending.ownerKey)),
      foreignOwnedWorkerIds: foreignOwnedWorkerIds(existing, workers, clean(pending.ownerKey)),
    };
    // Re-evaluate immediately before the destructive model switch. New work or
    // renewed demand for the resident voice invalidates the old decision. The
    // chosen GPU only has to still be switchable: requiring it to still rank
    // first silently dropped switches whenever a fresh probe reordered two idle
    // GPUs, and the page then waited on a switch that never ran.
    if (chooseCapacityAction(capacityInput).type === 'route') {
      return { statusCode: 200, assigned: false, reason: 'already-resident' };
    }
    const target = reassignCandidates(capacityInput)
      .find((candidate) => candidate.instanceId === pending.workerId);
    if (!target) {
      console.log('[model-coordinator][decision]', JSON.stringify({
        request: 'reassign', decision: 'reassign-dropped', reason: 'no-longer-idle',
        modelKey: String(pending.modelKey || '').slice(0, 12), workerId: pending.workerId,
      }));
      return { statusCode: 200, assigned: false, reason: 'no-longer-idle' };
    }
    const worker = await assignWorker(target, pending.synthesisBody, {
      // The idle rules were just checked against a fresh probe above
      // (reassignCandidates: owner's own GPU, a GPU only warmed up by its boot).
      // The worker's own clock counts warm-up sentences as activity, so it
      // would refuse those; it still refuses if anything is running.
      ignoreIdle: true,
    });
    await recordGpuOwner(worker.instanceId, clean(pending.ownerKey), pending.modelKey);
    return { statusCode: 200, assigned: true, workerId: worker.instanceId };
  } finally {
    await document.send(new DeleteCommand({ TableName: tableName, Key: { id } })).catch(() => {});
  }
}

async function setWorkerProtection(instanceId, protectedFromScaleIn) {
  if (!instanceId || routingOnly()) return;
  await autoscaling.send(new SetInstanceProtectionCommand({
    AutoScalingGroupName: asgName,
    InstanceIds: [instanceId],
    ProtectedFromScaleIn: protectedFromScaleIn,
  }));
}

async function forwardSynthesis(worker, routePath, body, headers = {}, {
  allowQueue = false,
  priority = false,
} = {}) {
  const replyToken = clean(headers['X-VCS-Reply-Token'] || headers['x-vcs-reply-token']);
  if (replyToken) {
    await document.send(new PutCommand({
      TableName: tableName,
      Item: {
        entity: 'REPLY',
        id: `REPLY#${replyToken}`,
        replyToken,
        instanceId: worker.instanceId,
        privateIp: worker.privateIp,
        expiresAt: Math.floor((Date.now() + 120_000) / 1_000),
      },
    }));
  }
  await setWorkerProtection(worker.instanceId, true);
  try {
    const response = await fetchWithTimeout(workerUrl(worker, routePath), {
      method: 'POST',
      headers: coordinatorHeaders({
        ...(!allowQueue ? { 'X-VCS-Coordinator-Direct': '1' } : {}),
        ...(priority ? { 'X-VCS-Capacity-Retry': '1' } : {}),
        ...headers,
      }),
      body: JSON.stringify(body),
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      let message = `Worker request failed (${response.status})`;
      try { message = JSON.parse(buffer.toString('utf8')).error || message; } catch { /* binary/empty */ }
      const error = new Error(message);
      error.statusCode = response.status;
      throw error;
    }
    return {
      statusCode: response.status,
      bodyBase64: buffer.toString('base64'),
      contentType: response.headers.get('content-type') || 'application/octet-stream',
      queueWaitMs: response.headers.get('x-synthesis-queue-wait-ms'),
      workerId: worker.instanceId,
    };
  } finally {
    if (replyToken) {
      await document.send(new DeleteCommand({ TableName: tableName, Key: { id: `REPLY#${replyToken}` } })).catch(() => {});
    }
    try {
      const current = await probeWorker(worker);
      if (current.active === 0 && current.queued === 0 && current.state !== 'DRAINING') {
        await setWorkerProtection(worker.instanceId, false);
      }
    } catch { /* retain protection when worker state is unknown */ }
  }
}

export async function requestScale(
  group,
  modelKey,
  synthesisBody,
  now = Date.now(),
  { documentClient = document, autoscalingClient = autoscaling, ownerKey = '' } = {},
) {
  if (routingOnly()) {
    return {
      started: false,
      simulated: true,
      atMaximum: true,
      message: 'Dev routing simulation: staging would request another GPU; Dev autoscaling is disabled.',
    };
  }
  const pendingId = coordinationKey('PENDING', modelKey);
  const existing = await documentClient.send(new GetCommand({ TableName: tableName, Key: { id: pendingId } }));
  if (existing.Item && now - Number(existing.Item.requestedAt || 0) < pendingTtlMs) {
    return { started: false, pending: existing.Item };
  }
  const desired = Number(group.DesiredCapacity) || 0;
  const maximum = Number(group.MaxSize) || desired;
  if (desired >= maximum) return { started: false, atMaximum: true };
  const pending = {
    entity: 'PENDING',
    id: pendingId,
    coordinatorScope,
    modelKey,
    synthesisBody,
    requestedAt: now,
    targetDesired: desired + 1,
    ...(ownerKey ? { ownerKey } : {}),
    expiresAt: Math.floor((now + pendingTtlMs) / 1_000),
  };
  try {
    await documentClient.send(new PutCommand({
      TableName: tableName,
      Item: pending,
      ConditionExpression: 'attribute_not_exists(id) OR requestedAt < :staleBefore',
      ExpressionAttributeValues: { ':staleBefore': now - pendingTtlMs },
    }));
  } catch (error) {
    if (error.name !== 'ConditionalCheckFailedException') throw error;
    const winner = await documentClient.send(new GetCommand({ TableName: tableName, Key: { id: pendingId } }));
    return { started: false, pending: winner.Item };
  }
  try {
    // Re-read just before the bump: two voices starting a GPU at the same time
    // both held the same snapshot and both wrote desired+1, losing one GPU.
    let currentDesired = desired;
    try {
      const fresh = await autoscalingClient.send(new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [asgName] }));
      currentDesired = Math.max(desired, Number(fresh?.AutoScalingGroups?.[0]?.DesiredCapacity) || 0);
    } catch { /* fall back to the snapshot */ }
    if (currentDesired >= maximum) {
      await documentClient.send(new DeleteCommand({ TableName: tableName, Key: { id: pendingId } })).catch(() => {});
      return { started: false, atMaximum: true };
    }
    await autoscalingClient.send(new UpdateAutoScalingGroupCommand({
      AutoScalingGroupName: asgName,
      DesiredCapacity: Math.min(maximum, currentDesired + 1),
    }));
  } catch (error) {
    // The marker is claimed before the bump so two concurrent callers cannot both
    // grow the group. That ordering means a failed bump would otherwise strand a
    // PENDING row asserting a boot that never happened, and prepareCapacity
    // short-circuits on that row — reporting STARTING for the whole TTL while
    // nothing launches and no later poll ever retries. Release the claim instead.
    await documentClient
      .send(new DeleteCommand({ TableName: tableName, Key: { id: pendingId } }))
      .catch(() => {});
    throw error;
  }
  return { started: true, pending };
}

export function bootAssignmentClaimable(item, instanceId, now = Date.now(), scope = coordinatorScope) {
  return item?.entity === 'PENDING'
    && clean(item.coordinatorScope) === scope
    && Boolean(item.synthesisBody)
    && now - Number(item.requestedAt || 0) < pendingTtlMs
    && (!item.claimedBy || item.claimedBy === instanceId || Number(item.claimExpiresAt || 0) < now);
}

export function pendingWorkerMatchesBoot(pending, worker, modelKey) {
  if (!pending || !worker) return false;
  return worker.reachable !== false
    && worker.state === 'READY'
    && worker.modelKey === modelKey
    && (worker.instanceId === pending.claimedBy
      || Number(worker.firstSeenAt || 0) >= Number(pending.requestedAt || 0));
}

function liveAdmission(item, now = Date.now()) {
  return item?.entity === 'ADMISSION'
    && itemInScope(item)
    && Number(item.expiresAtMs || 0) > now
    && Boolean(clean(item.workerId));
}

// A worker probe and a coordinator reservation describe the same work at
// different points in time. Use the larger count instead of adding them, or a
// request becomes double-counted as soon as the worker accepts it.
export function applyAdmissionReservations(workers = [], items = [], now = Date.now()) {
  const counts = new Map();
  for (const item of items.filter((candidate) => liveAdmission(candidate, now))) {
    const current = counts.get(item.workerId) || {
      direct: 0, queued: 0, baselineActive: 0, baselineQueued: 0,
    };
    if (item.lane === 'queue') current.queued += 1;
    else current.direct += 1;
    current.baselineActive = Math.max(current.baselineActive, Number(item.baselineActive || 0));
    current.baselineQueued = Math.max(current.baselineQueued, Number(item.baselineQueued || 0));
    counts.set(item.workerId, current);
  }
  return workers.map((worker) => {
    const reserved = counts.get(worker.instanceId) || {
      direct: 0, queued: 0, baselineActive: 0, baselineQueued: 0,
    };
    const probedActive = Number(worker.active || 0);
    const probedQueued = Number(worker.queued || 0);
    const active = Math.max(probedActive, reserved.baselineActive + reserved.direct);
    const queued = Math.max(probedQueued, reserved.baselineQueued + reserved.queued);
    return {
      ...worker,
      active,
      queued,
      reservedDirect: reserved.direct,
      reservedQueued: reserved.queued,
      untrackedActive: Math.max(0, active - reserved.direct),
      untrackedQueued: Math.max(0, queued - reserved.queued),
    };
  });
}

export async function acquireAdmissionLease(now = Date.now(), {
  documentClient = document,
  coordinatorTable = tableName,
  waitMs = admissionWaitMs,
  leaseMs = admissionLeaseMs,
} = {}) {
  const id = coordinationKey('ADMISSION_LOCK', 'fleet');
  const owner = crypto.randomUUID();
  const deadline = now + waitMs;
  while (Date.now() <= deadline) {
    const attemptAt = Date.now();
    try {
      await documentClient.send(new PutCommand({
        TableName: coordinatorTable,
        Item: {
          entity: 'ADMISSION_LOCK', id, coordinatorScope, owner,
          leaseExpiresAt: attemptAt + leaseMs,
          expiresAt: Math.floor((attemptAt + leaseMs) / 1_000),
        },
        ConditionExpression: 'attribute_not_exists(id) OR leaseExpiresAt < :now',
        ExpressionAttributeValues: { ':now': attemptAt },
      }));
      return { id, owner };
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
      await delay(25 + Math.floor(Math.random() * 50));
    }
  }
  const error = new Error('GPU admission is briefly busy. Retry automatically.');
  error.statusCode = 503;
  error.code = 'MODEL_ADMISSION_BUSY';
  throw error;
}

export async function releaseAdmissionLease(lease, {
  documentClient = document,
  coordinatorTable = tableName,
} = {}) {
  if (!lease?.id || !lease?.owner) return;
  await documentClient.send(new DeleteCommand({
    TableName: coordinatorTable,
    Key: { id: lease.id },
    // `owner` is a DynamoDB reserved word: it must go through an attribute name
    // placeholder or every release fails validation (and the lease is held
    // until it expires, stalling all admissions).
    ConditionExpression: '#owner = :owner',
    ExpressionAttributeNames: { '#owner': 'owner' },
    ExpressionAttributeValues: { ':owner': lease.owner },
  })).catch((error) => {
    if (error.name !== 'ConditionalCheckFailedException') throw error;
  });
}

async function reserveAdmission(worker, modelKey, lane, now = Date.now()) {
  const token = crypto.randomUUID();
  const id = coordinationKey('ADMISSION', token);
  await document.send(new PutCommand({
    TableName: tableName,
    Item: {
      entity: 'ADMISSION', id, coordinatorScope, token, modelKey,
      workerId: worker.instanceId, lane, requestedAt: now,
      baselineActive: Number(worker.untrackedActive || 0),
      baselineQueued: Number(worker.untrackedQueued || 0),
      expiresAtMs: now + admissionReservationMs,
      expiresAt: Math.floor((now + admissionReservationMs) / 1_000),
    },
    ConditionExpression: 'attribute_not_exists(id)',
  }));
  return { id, token, workerId: worker.instanceId, lane };
}

async function releaseAdmission(reservation) {
  if (!reservation?.id) return;
  await document.send(new DeleteCommand({
    TableName: tableName,
    Key: { id: reservation.id },
  })).catch(() => {});
}

export async function consumeCompletedBoot(
  pending,
  workers,
  modelKey,
  { documentClient = document, coordinatorTable = tableName } = {},
) {
  if (!pending) return null;
  const worker = workers.find((candidate) => pendingWorkerMatchesBoot(pending, candidate, modelKey));
  if (!worker) return null;
  await documentClient.send(new DeleteCommand({
    TableName: coordinatorTable,
    Key: { id: pending.id },
  }));
  return worker;
}

async function claimBootAssignment(instanceId, now = Date.now()) {
  if (!instanceId) return { statusCode: 400, error: 'instanceId is required' };
  const items = await scanState();
  const pending = items
    .filter((item) => bootAssignmentClaimable(item, instanceId, now, coordinatorScope))
    .sort((left, right) => Number(left.requestedAt || 0) - Number(right.requestedAt || 0));

  for (const candidate of pending) {
    try {
      const claimed = await document.send(new UpdateCommand({
        TableName: tableName,
        Key: { id: candidate.id },
        UpdateExpression: 'SET claimedBy = :instanceId, claimExpiresAt = :claimExpiresAt',
        ConditionExpression: 'attribute_not_exists(claimedBy) OR claimedBy = :instanceId OR claimExpiresAt < :now',
        ExpressionAttributeValues: {
          ':instanceId': instanceId,
          ':claimExpiresAt': now + pendingTtlMs,
          ':now': now,
        },
        ReturnValues: 'ALL_NEW',
      }));
      await recordGpuOwner(instanceId, clean(claimed.Attributes?.ownerKey), claimed.Attributes?.modelKey, now);
      return { statusCode: 200, assignment: claimed.Attributes };
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
    }
  }
  return { statusCode: 200, assignment: null };
}

async function cancelReply(replyToken) {
  const result = await document.send(new GetCommand({
    TableName: tableName,
    Key: { id: `REPLY#${replyToken}` },
  }));
  if (!result.Item?.privateIp) return { freed: 0 };
  const response = await fetchWithTimeout(`http://${result.Item.privateIp}:3003/live/cancel`, {
    method: 'POST',
    headers: coordinatorHeaders(),
    body: JSON.stringify({ replyToken }),
  }, 5_000);
  return response.json().catch(() => ({ freed: 0 }));
}

function capacityResponse({
  state,
  canStartConversation,
  model,
  availableSlots = 0,
  matchingWorkers = 0,
  capacityAction = 'none',
  started = false,
  atMaximum = false,
  simulated = false,
  message = '',
  startedAt = 0,
  sharedBoot = false,
} = {}) {
  const waiting = ['STARTING', 'WARMING'].includes(state);
  return {
    statusCode: 200,
    state,
    canStartConversation,
    availableSlots,
    matchingWorkers,
    capacityTight: state === 'READY' && availableSlots === 1,
    capacityAction,
    capacityStarted: started,
    atMaximum,
    simulated,
    message: clean(message) || (simulated
      ? 'Dev routing simulation: staging would prepare another GPU, but Dev autoscaling is disabled.'
      : ''),
    retryAfterSeconds: waiting ? bootEstimateSeconds : 0,
    // When this boot/switch really began, so a page reload keeps the true
    // elapsed time instead of restarting the wait timer at zero.
    ...(waiting && Number(startedAt) > 0 ? { waitStartedAt: Number(startedAt) } : {}),
    // This voice waits on a GPU that was already starting (not one started for
    // it), so the page can say "already starting" rather than "starting".
    ...(sharedBoot ? { sharedBoot: true } : {}),
    voiceProfileId: clean(model?.voiceProfileId),
  };
}

// Only promise more capacity when a GPU is actually being added.
export function queueFullMessage(capacityAction = {}) {
  if (capacityAction?.atMaximum) {
    return 'This voice is busy and every GPU is in use. Your request will retry automatically.';
  }
  return capacityAction?.started
    ? 'This voice is busy and its waiting list is full. More GPU capacity is preparing; your request will retry automatically.'
    : 'This voice is busy and its waiting list is full. Your request will retry automatically.';
}

// A warm GPU switches voices in seconds; only a cold boot needs the boot estimate.
export const REASSIGN_RETRY_SECONDS = 5;
export function capacityRetryAfterSeconds({ booting = false } = {}) {
  return booting ? bootEstimateSeconds : REASSIGN_RETRY_SECONDS;
}

// A boot request whose GPU never materialised: the marker is older than
// `lostAfterMs` yet the group is not adding capacity (desired <= READY workers).
// 2026-11-17 staging: a legacy idle scale-in alarm still in ALARM reverted the
// desired 0->1 bump at once, and the stranded marker made every poll answer
// "GPU starting" for the full 15-minute TTL while nothing launched.
export function bootLooksLost(pending, group, workers = [], now = Date.now(), lostAfterMs = 90_000) {
  if (!pending || pending.claimedBy) return false;
  if (now - Number(pending.requestedAt || 0) < lostAfterMs) return false;
  const desired = Number(group?.DesiredCapacity || 0);
  const target = Number(pending.targetDesired || 0);
  if (target > 0) return desired < target;
  // Markers written before targetDesired existed: only the unambiguous case.
  return desired === 0 && workers.length === 0;
}

export function capacityStartingMessage({ booting = false } = {}) {
  return booting
    ? 'A new GPU is starting and loading this voice. Please wait a moment.'
    : 'An idle GPU is switching to this voice. Please wait a moment.';
}

async function prepareCapacity(event) {
  const body = event.body || {};
  const modelKey = modelResidencyKey(body);
  if (!modelKey) return { statusCode: 400, error: 'The request has no immutable GPT/SoVITS model pair.' };
  const now = Date.now();
  const model = body.voice_model || {};
  const allowScale = event.allowScale === true;
  const source = clean(event.source) || 'preflight';
  // Training site only: one person, one GPU across their own voices.
  const ownerKey = clean(event.ownerKey);
  // Admin TTS site: switch on selection with no idle wait; add a GPU only when
  // there is none (ttsSiteOption in the main Lambda).
  const singleGpu = event.singleGpu === true;
  const existing = await scanState();
  // A prewarm is a guess (the person's latest voice), not someone using it, so
  // it must not protect the GPU it lands on from switching to a real selection.
  if (source !== 'prewarm') await recordDemand(modelKey, model.voiceProfileId, now);
  const selectionDwellMs = await recordSelection(modelKey, existing, now);
  const refreshed = await refreshFleet(existing, now);
  const { group } = refreshed;
  const workers = lockedFleet(existing, refreshed.workers, now);
  const readyMatching = workers.filter((worker) =>
    worker.reachable && worker.state === 'READY' && worker.modelKey === modelKey);
  const freeSlots = matchingFreeSlots(workers, modelKey);
  const reassigning = existing.find((item) => (
    item.id === coordinationKey('REASSIGN', modelKey) && liveReassignment(item, now)
  ));
  let booting = existing.find((item) => (
    item.id === coordinationKey('PENDING', modelKey) && now - item.requestedAt < pendingTtlMs
  ));
  if (await consumeCompletedBoot(booting, workers, modelKey)) booting = null;
  if (!routingOnly() && bootLooksLost(booting, group, workers, now)) {
    console.log('[model-coordinator][decision]', JSON.stringify({
      request: 'prepare', source, decision: 'boot-lost-retry', allowScale,
      voiceProfileId: clean(model.voiceProfileId), modelKey: modelKey.slice(0, 12),
      desiredCapacity: group.DesiredCapacity,
    }));
    await document.send(new DeleteCommand({ TableName: tableName, Key: { id: booting.id } })).catch(() => {});
    booting = null;
  }
  // Training-site voices are private to their account, so a GPU already
  // holding this account's voice is its GPU, however it got loaded (a message,
  // the first GPU, a prewarm). Without this, the account's next pick saw no GPU
  // of its own and added one instead of switching it.
  if (ownerKey) {
    await Promise.all(readyMatching
      .filter((worker) => !existing.some((item) => (
        item.entity === 'OWNER' && itemInScope(item) && item.instanceId === worker.instanceId
        && item.ownerKey === ownerKey && item.modelKey === modelKey
      )))
      .map((worker) => recordGpuOwner(worker.instanceId, ownerKey, modelKey, now)));
  }
  if (freeSlots > 0) {
    console.log('[model-coordinator][decision]', JSON.stringify({
      request: 'prepare', source, decision: 'route', allowScale, voiceProfileId: clean(model.voiceProfileId),
      modelKey: modelKey.slice(0, 12), availableSlots: freeSlots, desiredCapacity: group.DesiredCapacity,
    }));
    return capacityResponse({
      state: reassigning ? 'READY_WARMING' : booting ? 'READY_SCALING' : 'READY',
      canStartConversation: true,
      model,
      availableSlots: freeSlots,
      matchingWorkers: readyMatching.length,
      capacityAction: reassigning ? 'reassign' : booting ? 'scale' : 'none',
    });
  }

  if (reassigning) {
    console.log('[model-coordinator][decision]', JSON.stringify({
      request: 'prepare', source, decision: 'reassign-pending', allowScale,
      voiceProfileId: clean(model.voiceProfileId), modelKey: modelKey.slice(0, 12),
      desiredCapacity: group.DesiredCapacity,
    }));
    return capacityResponse({
      state: readyMatching.length > 0 ? 'BUSY_WARMING' : 'WARMING',
      canStartConversation: readyMatching.length > 0,
      model,
      matchingWorkers: readyMatching.length,
      capacityAction: 'reassign',
      startedAt: Math.min(Number(reassigning.requestedAt) || now, now - selectionDwellMs),
    });
  }
  if (booting) {
    console.log('[model-coordinator][decision]', JSON.stringify({
      request: 'prepare', source, decision: 'scale-pending', allowScale,
      voiceProfileId: clean(model.voiceProfileId), modelKey: modelKey.slice(0, 12),
      desiredCapacity: group.DesiredCapacity,
    }));
    return capacityResponse({
      state: readyMatching.length > 0 ? 'BUSY_STARTING' : 'STARTING',
      canStartConversation: readyMatching.length > 0,
      model,
      matchingWorkers: readyMatching.length,
      capacityAction: 'scale',
      startedAt: booting.requestedAt,
    });
  }

  // The voice is already loaded and only its slots are full. Opening a page is
  // not demand: messages that actually wait (synthesis queue overflow) add a
  // GPU. Usable now, possibly queued.
  if (readyMatching.length > 0) {
    console.log('[model-coordinator][decision]', JSON.stringify({
      request: 'prepare', source, decision: 'busy-no-scale', allowScale,
      voiceProfileId: clean(model.voiceProfileId), modelKey: modelKey.slice(0, 12),
      desiredCapacity: group.DesiredCapacity,
    }));
    return capacityResponse({
      state: 'BUSY_QUEUED',
      canStartConversation: true,
      model,
      matchingWorkers: readyMatching.length,
    });
  }

  // The first GPU is still starting: every voice waits for it (it switches to
  // this voice once up) instead of buying a second one.
  const firstGpu = holdForFirstGpu(existing, workers, group, now, ownerKey);
  if (firstGpu) {
    console.log('[model-coordinator][decision]', JSON.stringify({
      request: 'prepare', source, decision: 'await-first-gpu', allowScale,
      voiceProfileId: clean(model.voiceProfileId), modelKey: modelKey.slice(0, 12),
      desiredCapacity: group.DesiredCapacity,
    }));
    return capacityResponse({
      state: 'STARTING',
      canStartConversation: false,
      model,
      capacityAction: 'scale',
      startedAt: firstGpu.startedAt || now - selectionDwellMs,
      sharedBoot: true,
      message: FIRST_GPU_WAIT_MESSAGE,
    });
  }

  // The reassign/boot short-circuits above are keyed to the REQUESTED model, so
  // they cannot see a transition running for a different one. That gap is what
  // produced the 1->2->3->4 incident: one person clicking through three voices,
  // each click finding the only GPU mid-switch for someone else's model, nothing
  // reassignable, and therefore scaling. A selection waits for capacity already
  // in motion instead of buying more. Real synthesis is unaffected and still
  // scales on real overlapping demand.
  const fleetInMotion = preflightScaleBlocked({
    coordinationItems: existing.filter((item) => itemInScope(item)),
    workers,
    now,
    pendingTtlMs,
    cooldownMs: 0,
  });
  // One person, one GPU: a GPU already starting for another of this person's
  // voices switches to this one once it is up, instead of a second GPU.
  const ownBoot = ownerKey && existing.find((item) => (
    item.entity === 'PENDING' && itemInScope(item)
    && now - Number(item.requestedAt || 0) < pendingTtlMs
    && item.modelKey !== modelKey
    && item.ownerKey === ownerKey
    // Already up: then the ordinary own-GPU switch below applies.
    && !workers.some((worker) => pendingWorkerMatchesBoot(item, worker, item.modelKey))
  ));
  if (ownBoot) {
    console.log('[model-coordinator][decision]', JSON.stringify({
      request: 'prepare', source, decision: 'await-own-gpu', allowScale,
      voiceProfileId: clean(model.voiceProfileId), modelKey: modelKey.slice(0, 12),
      desiredCapacity: group.DesiredCapacity,
    }));
    return capacityResponse({
      state: 'STARTING',
      canStartConversation: false,
      model,
      capacityAction: 'scale',
      startedAt: Number(ownBoot.requestedAt) || now,
      sharedBoot: true,
      message: 'The GPU starting for your other voice switches to this one as soon as it is up; one GPU per person.',
    });
  }
  const capacityInput = {
    workers,
    requestedModelKey: modelKey,
    lastDemandByModel: demandMap(existing),
    now,
    reassigningWorkerIds: promisedWorkerIds(existing, now),
    ownedWorkerIds: ownedWorkerIds(existing, workers, ownerKey),
    foreignOwnedWorkerIds: foreignOwnedWorkerIds(existing, workers, ownerKey),
  };
  // A GPU used within the grace belongs to whoever used it: autoscaled staging
  // adds a GPU (2026-11-19 feedback: switching a voice someone just used is
  // wrong). Fixed-GPU Dev cannot add, so there the grace only delays the switch.
  const gracedOnly = routingOnly()
    && allowScale
    && chooseCapacityAction({ ...capacityInput, reassignIdleMs: preflightReassignIdleMs }).type === 'scale'
    && chooseCapacityAction({ ...capacityInput, reassignIdleMs: 0 }).type === 'reassign';
  const switchIdleMs = singleGpu ? 0 : preflightReassignIdleMs;
  const noGpuYet = !workers.some((worker) => worker.reachable !== false);
  // Training site: this account already has a GPU (holding one of its own
  // voices). It switches to this pick when free; never a second GPU.
  const ownGpu = capacityInput.ownedWorkerIds.some((id) => workers.some((worker) => (
    worker.instanceId === id && worker.reachable !== false && worker.state !== 'DRAINING'
  )));
  const action = choosePreparationAction({
    ...capacityInput,
    reassignIdleMs: switchIdleMs,
    allowScale: allowScale && !fleetInMotion && !gracedOnly && !ownGpu && (!singleGpu || noGpuYet),
  });
  if (action.type === 'defer' && ownGpu) {
    console.log('[model-coordinator][decision]', JSON.stringify({
      request: 'prepare', source, decision: 'own-gpu-await-idle', allowScale,
      voiceProfileId: clean(model.voiceProfileId), modelKey: modelKey.slice(0, 12),
      desiredCapacity: group.DesiredCapacity,
    }));
    return capacityResponse({
      state: 'WARMING',
      canStartConversation: false,
      model,
      capacityAction: 'reassign',
      startedAt: now - selectionDwellMs,
      message: 'Your GPU is finishing its current reply. It switches to this voice as soon as it is free; one GPU per person.',
    });
  }
  if (action.type === 'defer' && singleGpu && !fleetInMotion) {
    // Every GPU is busy right now: wait for one to finish, never add one.
    console.log('[model-coordinator][decision]', JSON.stringify({
      request: 'prepare', source, decision: 'single-gpu-await-idle', allowScale,
      voiceProfileId: clean(model.voiceProfileId), modelKey: modelKey.slice(0, 12),
      desiredCapacity: group.DesiredCapacity,
    }));
    return capacityResponse({
      state: 'WARMING',
      canStartConversation: false,
      model,
      capacityAction: 'reassign',
      startedAt: now - selectionDwellMs,
      message: 'The GPU is finishing other work. It switches to this voice as soon as it is free; no extra GPU is added.',
    });
  }
  if (action.type === 'defer' && gracedOnly && !fleetInMotion) {
    console.log('[model-coordinator][decision]', JSON.stringify({
      request: 'prepare', source, decision: 'await-reassign-grace', allowScale,
      voiceProfileId: clean(model.voiceProfileId), modelKey: modelKey.slice(0, 12),
      desiredCapacity: group.DesiredCapacity,
    }));
    return capacityResponse({
      state: readyMatching.length > 0 ? 'BUSY_WARMING' : 'WARMING',
      canStartConversation: readyMatching.length > 0,
      model,
      matchingWorkers: readyMatching.length,
      capacityAction: 'reassign',
      // The wait began when this voice was first selected (the dwell start).
      startedAt: now - selectionDwellMs,
      message: 'An idle GPU will switch to this voice shortly. No additional GPU is being started.',
    });
  }
  if (action.type === 'defer' && fleetInMotion) {
    console.log('[model-coordinator][decision]', JSON.stringify({
      request: 'prepare', source, decision: 'await-fleet-transition', allowScale,
      voiceProfileId: clean(model.voiceProfileId), modelKey: modelKey.slice(0, 12),
      desiredCapacity: group.DesiredCapacity,
    }));
    // What it waits for is a GPU that is still booting (preflightScaleBlocked),
    // not a switch: say so, with that boot's real start, instead of "Switching".
    const bootStarts = workers
      .filter((worker) => worker.reachable !== false && worker.state !== 'READY')
      .map((worker) => Number(worker.firstSeenAt) || 0)
      .filter((value) => value > 0);
    return capacityResponse({
      state: readyMatching.length > 0 ? 'BUSY_STARTING' : 'STARTING',
      canStartConversation: readyMatching.length > 0,
      model,
      matchingWorkers: readyMatching.length,
      capacityAction: 'scale',
      startedAt: bootStarts.length ? Math.min(...bootStarts) : now - selectionDwellMs,
      sharedBoot: true,
      message: 'Another GPU is already starting. This voice loads on it as soon as it is up; no extra GPU is added while it starts.',
    });
  }
  if ((action.type === 'reassign' || action.type === 'scale') && selectionDwellMs < preflightDwellMs) {
    // Not yet: confirm the person is staying on this voice before switching or
    // starting a GPU for it.
    return capacityResponse({
      state: 'CHECKING',
      canStartConversation: false,
      model,
      matchingWorkers: 0,
      capacityAction: 'none',
      message: 'Getting this voice ready…',
    });
  }
  if (action.type === 'reassign') {
    console.log('[model-coordinator][decision]', JSON.stringify({
      request: 'prepare', source, decision: 'reassign', allowScale,
      voiceProfileId: clean(model.voiceProfileId), modelKey: modelKey.slice(0, 12),
      workerId: action.worker.instanceId, desiredCapacity: group.DesiredCapacity,
    }));
    const scheduled = await scheduleReassignment(action.worker, modelKey, body, now, {
      requiredIdleMs: switchIdleMs,
      ownerKey,
    });
    return capacityResponse({
      state: readyMatching.length > 0 ? 'BUSY_WARMING' : 'WARMING',
      canStartConversation: readyMatching.length > 0,
      model,
      matchingWorkers: readyMatching.length,
      capacityAction: 'reassign',
      started: scheduled.started,
      startedAt: now - selectionDwellMs,
    });
  }
  if (action.type === 'defer') {
    const simulated = routingOnly();
    console.log('[model-coordinator][decision]', JSON.stringify({
      request: 'prepare', source, decision: simulated ? 'simulate-on-demand' : 'on-demand', allowScale,
      voiceProfileId: clean(model.voiceProfileId), modelKey: modelKey.slice(0, 12),
      desiredCapacity: group.DesiredCapacity,
    }));
    return capacityResponse({
      state: simulated ? 'SIMULATED' : 'ON_DEMAND',
      canStartConversation: true,
      model,
      matchingWorkers: readyMatching.length,
      capacityAction: 'none',
      simulated,
      message: simulated
        ? 'Dev capacity simulation: no idle fixed GPU can prepare this voice. Staging would wait for a real synthesis request before requesting another GPU; Dev autoscaling is disabled.'
        : 'This voice will load on demand. Selecting it did not start another GPU; the first synthesis request will prepare capacity if needed.',
    });
  }
  console.log('[model-coordinator][decision]', JSON.stringify({
    request: 'prepare', source, decision: 'scale', allowScale,
    voiceProfileId: clean(model.voiceProfileId), modelKey: modelKey.slice(0, 12),
    desiredCapacity: group.DesiredCapacity,
  }));
  const scale = await requestScale(group, modelKey, body, now, { ownerKey });
  return capacityResponse({
    state: scale.simulated
      ? 'SIMULATED'
      : scale.atMaximum
      ? readyMatching.length > 0 ? 'BUSY_LIMIT' : 'LIMIT'
      : readyMatching.length > 0 ? 'BUSY_STARTING' : 'STARTING',
    canStartConversation: scale.simulated === true || readyMatching.length > 0,
    model,
    matchingWorkers: readyMatching.length,
    capacityAction: 'scale',
    started: scale.started,
    atMaximum: scale.atMaximum,
    simulated: scale.simulated === true,
  });
}

// Read-only load check for every open page on a voice: one table scan, no
// worker probes, no demand/selection record (a polling tab must not count as
// someone using the voice), never switches or scales.
async function peekCapacity(event) {
  const body = event.body || {};
  const modelKey = modelResidencyKey(body);
  if (!modelKey) return { statusCode: 400, error: 'The request has no immutable GPT/SoVITS model pair.' };
  const now = Date.now();
  const allItems = await scanState();
  const items = allItems.filter((item) => itemInScope(item));
  let rows = items.filter((item) => item.entity === 'WORKER' && item.coordinatorScope === coordinatorScope);
  // Saved rows are refreshed by every coordinator request; on a quiet fleet
  // they go stale, and a page would keep saying "loaded" after its GPU was
  // switched or removed. Re-probe (no demand, no switching) when they are old.
  let fleetKnown = rows.some((row) => now - Number(row.updatedAt || 0) <= PEEK_REFRESH_MS);
  if (!fleetKnown) {
    try {
      rows = (await refreshFleet(allItems, now)).workers;
      fleetKnown = true;
    } catch (error) {
      console.error('[model-coordinator][peek-refresh]', error?.message || error);
    }
  }
  const workers = applyAdmissionReservations(rows, items, now);
  const pending = items.find((item) => (
    item.id === coordinationKey('PENDING', modelKey) && now - Number(item.requestedAt || 0) < pendingTtlMs
  ));
  const reassign = items.find((item) => (
    item.id === coordinationKey('REASSIGN', modelKey) && liveReassignment(item, now)
  ));
  const load = peekVoiceLoad({ workers, modelKey, pendingBoot: Boolean(pending), reassigning: Boolean(reassign), now });
  return {
    statusCode: 200,
    ...load,
    // An empty or fresh fleet without this voice: it is on no GPU right now.
    ...(fleetKnown && load.matchingWorkers === 0 ? { resident: false } : {}),
    // Background work for this voice, so a page can show its real wait.
    ...(pending ? { pendingBoot: true, waitStartedAt: Number(pending.requestedAt) || 0 } : {}),
    ...(!pending && reassign ? { reassigning: true, waitStartedAt: Number(reassign.requestedAt) || 0 } : {}),
    voiceProfileId: clean(body.voice_model?.voiceProfileId),
  };
}

const PEEK_REFRESH_MS = 45_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function synthesize(event) {
  const body = event.body || {};
  const routePath = clean(event.routePath) || '/inference/tts';
  const modelKey = modelResidencyKey(body);
  if (!modelKey) return { statusCode: 400, error: 'The request has no immutable GPT/SoVITS model pair.' };
  const now = Date.now();
  const model = body.voice_model || {};
  const existing = await scanState();
  await recordDemand(modelKey, model.voiceProfileId, now);
  const refreshed = await refreshFleet(existing, now);
  const { group } = refreshed;
  const initiallyLockedWorkers = lockedFleet(existing, refreshed.workers, now);
  let pending = existing.find((item) => (
    item.id === coordinationKey('PENDING', modelKey) && now - item.requestedAt < pendingTtlMs
  ));
  let selected;

  if (pending) {
    const bootWarmed = await consumeCompletedBoot(pending, initiallyLockedWorkers, modelKey);
    if (bootWarmed) {
      selected = bootWarmed;
      pending = null;
    }
    const fresh = !selected && initiallyLockedWorkers.find((worker) =>
      worker.reachable
      && worker.bootWarming !== true
      && worker.residencyLocked !== true
      && worker.active === 0
      && worker.queued === 0
      && worker.firstSeenAt >= pending.requestedAt);
    if (fresh) {
      try {
        selected = await assignWorker(fresh, pending.synthesisBody || body, { ignoreIdle: true });
        await document.send(new DeleteCommand({ TableName: tableName, Key: { id: pending.id } }));
      } catch { /* keep pending and continue through ordinary selection */ }
    }
  }

  let reservation;
  let lane;
  let capacityAction = null;
  let matchingWorkerCount = 0;
  let reassigning = null;
  let queueFull = false;
  let startupResponse = null;
  const lease = await acquireAdmissionLease();
  try {
    // The fleet probes above may all have happened concurrently. Reservations
    // written by earlier lease holders are the authoritative bridge until those
    // requests appear in a later worker probe.
    const currentItems = await scanState();
    const workers = applyAdmissionReservations(
      lockedFleet(currentItems, refreshed.workers, Date.now()),
      currentItems,
      Date.now(),
    );
    pending = currentItems.find((item) => (
      item.id === coordinationKey('PENDING', modelKey)
      && Date.now() - Number(item.requestedAt || 0) < pendingTtlMs
    )) || pending;
    reassigning = currentItems.find((item) => (
      item.id === coordinationKey('REASSIGN', modelKey) && liveReassignment(item)
    ));
    const matchingWorkers = workers.filter((worker) =>
      worker.reachable && worker.state === 'READY' && worker.modelKey === modelKey);
    matchingWorkerCount = matchingWorkers.length;

    // A freshly booted worker selected before the lease still has to pass the
    // same atomic capacity check as every ordinary route.
    if (selected) {
      selected = workers.find((worker) => worker.instanceId === selected.instanceId);
      if (selected && selected.active + selected.queued < selected.maxSlots) {
        lane = 'direct';
        reservation = await reserveAdmission(selected, modelKey, lane);
      } else {
        selected = null;
      }
    }

    if (!selected) {
      const action = chooseSynthesisAdmission({
        workers,
        requestedModelKey: modelKey,
        lastDemandByModel: demandMap(currentItems),
        now: Date.now(),
        reassignIdleMs,
        reassigningWorkerIds: promisedWorkerIds(currentItems),
        maxQueuedPerWorker,
      });
      if (action.type === 'direct') {
        selected = action.worker;
        lane = 'direct';
        reservation = await reserveAdmission(selected, modelKey, lane);
      } else if (action.type === 'queue' || action.type === 'queue-full') {
        // Existing matching capacity remains usable while an idle/new GPU is
        // prepared. Queue the caller instead of returning a false hard stop.
        if (action.type === 'queue') {
          selected = action.worker;
          lane = 'queue';
          reservation = await reserveAdmission(selected, modelKey, lane);
        } else {
          queueFull = true;
        }
        if (action.capacityAction.type === 'reassign') {
          const result = await scheduleReassignment(action.capacityAction.worker, modelKey, body, Date.now());
          capacityAction = { type: 'reassign', started: result.started };
        } else {
          const result = pending
            ? { started: false, simulated: routingOnly() }
            : await requestScale(group, modelKey, body, Date.now());
          capacityAction = {
            type: result.simulated ? 'simulate-scale' : 'scale',
            started: result.started === true,
            atMaximum: result.atMaximum === true,
            simulated: result.simulated === true,
          };
        }
      } else if (action.type === 'reassign') {
        const scheduled = await scheduleReassignment(action.worker, modelKey, body, Date.now());
        startupResponse = {
          statusCode: 503, code: 'MODEL_CAPACITY_STARTING',
          error: capacityStartingMessage({ booting: Boolean(pending) }),
          retryAfterSeconds: capacityRetryAfterSeconds({ booting: Boolean(pending) }), scaleStarted: false,
          reassignmentStarted: scheduled.started,
          voiceProfileId: clean(model.voiceProfileId), modelKey,
        };
      }
    }
  } finally {
    await releaseAdmissionLease(lease);
  }

  if (startupResponse) return startupResponse;

  if (queueFull) {
    console.log('[model-coordinator][decision]', JSON.stringify({
      request: 'synthesize', decision: 'queue-full-retry', voiceProfileId: clean(model.voiceProfileId),
      modelKey: modelKey.slice(0, 12), matchingWorkers: matchingWorkerCount,
      maxQueuedPerWorker, capacityAction, desiredCapacity: group.DesiredCapacity,
    }));
    return {
      statusCode: 503,
      code: capacityAction?.simulated ? 'DEV_CAPACITY_SIMULATED' : 'MODEL_QUEUE_FULL',
      error: capacityAction?.simulated
        ? 'Dev capacity simulation: every fixed GPU for this voice is busy with a full waiting list. Staging would prepare another GPU; retry shortly.'
        : queueFullMessage(capacityAction),
      retryAfterSeconds: 5,
      scaleStarted: capacityAction?.started === true,
      retryable: true,
      simulated: capacityAction?.simulated === true,
      voiceProfileId: clean(model.voiceProfileId), modelKey,
    };
  }

  if (selected && reservation) {
    console.log('[model-coordinator][decision]', JSON.stringify({
      request: 'synthesize', decision: lane === 'queue' ? 'queue' : 'route',
      voiceProfileId: clean(model.voiceProfileId), modelKey: modelKey.slice(0, 12),
      workerId: selected.instanceId, active: selected.active, queued: selected.queued,
      capacityAction, desiredCapacity: group.DesiredCapacity,
    }));
    try {
      const result = await forwardSynthesis(selected, routePath, body, event.headers || {}, {
        allowQueue: lane === 'queue',
        priority: lane === 'queue',
      });
      return lane === 'queue'
        ? { ...result, queuedAdmission: true, capacityAction }
        : result;
    } catch (error) {
      if (![429, 503].includes(error.statusCode)) throw error;
      if (lane === 'queue') {
        return {
          statusCode: 503,
          code: capacityAction?.simulated ? 'DEV_CAPACITY_SIMULATED' : 'MODEL_QUEUE_TIMEOUT',
          error: capacityAction?.simulated
            ? 'Dev routing simulation: this fixed GPU is busy. Staging would retry this request against the growing fleet.'
            : capacityAction?.atMaximum
            ? 'This voice is heavily loaded and every GPU is in use. Your request will retry automatically.'
            : 'This voice is heavily loaded. Your queue wait expired while more GPU capacity was preparing; this request will retry automatically.',
          retryAfterSeconds: capacityAction?.simulated ? 5 : 2,
          scaleStarted: capacityAction?.started === true,
          retryable: true,
          simulated: capacityAction?.simulated === true,
          voiceProfileId: clean(model.voiceProfileId), modelKey,
        };
      }
      if (event.admissionRetry === true) throw error;
      // A process-local request outside this coordinator can still consume a
      // slot after our probe. Re-enter the atomic allocator once rather than
      // bypassing its queue ceiling with the old same-worker fallback.
      return synthesize({ ...event, admissionRetry: true });
    } finally {
      await releaseAdmission(reservation);
    }
  }

  if (reassigning) {
    return {
      statusCode: 503,
      code: 'MODEL_CAPACITY_STARTING',
      error: capacityStartingMessage({ booting: Boolean(pending) }),
      retryAfterSeconds: capacityRetryAfterSeconds({ booting: Boolean(pending) }),
      scaleStarted: false,
      reassignmentStarted: false,
      voiceProfileId: clean(model.voiceProfileId),
      modelKey,
    };
  }

  const firstGpu = !pending && holdForFirstGpu(existing, refreshed.workers, group, now);
  if (firstGpu) {
    console.log('[model-coordinator][decision]', JSON.stringify({
      request: 'synthesize', decision: 'await-first-gpu', voiceProfileId: clean(model.voiceProfileId),
      modelKey: modelKey.slice(0, 12), desiredCapacity: group.DesiredCapacity,
    }));
    return {
      statusCode: 503,
      code: 'MODEL_CAPACITY_STARTING',
      error: FIRST_GPU_WAIT_MESSAGE,
      retryAfterSeconds: bootEstimateSeconds,
      scaleStarted: false,
      voiceProfileId: clean(model.voiceProfileId),
      modelKey,
    };
  }
  console.log('[model-coordinator][decision]', JSON.stringify({
    request: 'synthesize', decision: 'scale', voiceProfileId: clean(model.voiceProfileId),
    modelKey: modelKey.slice(0, 12), desiredCapacity: group.DesiredCapacity,
  }));
  const scale = await requestScale(group, modelKey, body, now);
  return {
    statusCode: 503,
    code: scale.simulated ? 'DEV_CAPACITY_SIMULATED' : scale.atMaximum ? 'MODEL_CAPACITY_LIMIT' : 'MODEL_CAPACITY_STARTING',
    error: scale.simulated
      ? scale.message
      : scale.atMaximum
      ? 'No GPU is available for this voice and staging is at its capacity limit.'
      : 'This voice is preparing on a GPU. You can wait, or use another voice or lecture meanwhile.',
    retryAfterSeconds: scale.simulated ? 5 : scale.atMaximum ? 30 : bootEstimateSeconds,
    scaleStarted: scale.started,
    simulated: scale.simulated === true,
    voiceProfileId: clean(model.voiceProfileId),
    modelKey,
  };
}

// Throttled to one sweep per minute across all coordinator invocations. Runs
// under the admission lease so no request can be routed to a GPU while it is
// being removed. Never fails the caller's request.
async function sweepIdleWorkers(now = Date.now()) {
  if (routingOnly()) return null;
  try {
    await document.send(new PutCommand({
      TableName: tableName,
      Item: {
        entity: 'SWEEP', id: coordinationKey('SWEEP', 'scale-in'), coordinatorScope,
        sweptAt: now, expiresAt: Math.floor((now + 3_600_000) / 1_000),
      },
      ConditionExpression: 'attribute_not_exists(id) OR sweptAt < :since',
      ExpressionAttributeValues: { ':since': now - scaleInSweepMs },
    }));
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') return null;
    throw error;
  }
  const lease = await acquireAdmissionLease();
  try {
    const items = await scanState();
    const { group, workers: probed } = await refreshFleet(items, now);
    const workers = applyAdmissionReservations(lockedFleet(items, probed, now), items, now);
    const candidates = scaleInCandidates({
      workers,
      now,
      idleMs: scaleInIdleMs,
      minSize: Number(group?.MinSize || 0),
      desired: Number(group?.DesiredCapacity || 0),
      lastDemandByModel: demandMap(items),
    });
    const candidate = candidates[0];
    if (!candidate) return null;
    // A protection flag left on an idle GPU (a switch whose clean-up never ran)
    // would otherwise keep it alive and block the desired-capacity fallback.
    const live = new Set(items.filter((item) => liveReassignment(item, now)).map((item) => item.workerId));
    const stale = (group?.Instances || []).filter((instance) => instance.ProtectedFromScaleIn
      && candidates.some((worker) => worker.instanceId === instance.InstanceId)
      && !live.has(instance.InstanceId));
    await Promise.all(stale.map((instance) => setWorkerProtection(instance.InstanceId, false).catch(() => {})));
    await document.send(new PutCommand({
      TableName: tableName,
      Item: {
        entity: 'SWEEP', id: coordinationKey('SWEEP', 'last-scale-in'), coordinatorScope,
        at: now, expiresAt: Math.floor((now + 3_600_000) / 1_000),
      },
    }));
    let method = 'terminate';
    try {
      await autoscaling.send(new TerminateInstanceInAutoScalingGroupCommand({
        InstanceId: candidate.instanceId,
        ShouldDecrementDesiredCapacity: true,
      }));
    } catch (error) {
      // Without TerminateInstanceInAutoScalingGroup (2026-11-19 staging) the
      // group can still shrink by one when EVERY worker is idle: whichever it
      // removes, nobody is cut off. A busy fleet waits for the permission.
      const fleetIdle = error?.name === 'AccessDenied'
        && candidates.length === workers.length
        && candidates.length === Number(group?.DesiredCapacity || 0);
      if (!fleetIdle) throw error;
      await autoscaling.send(new UpdateAutoScalingGroupCommand({
        AutoScalingGroupName: asgName,
        DesiredCapacity: Number(group.DesiredCapacity) - 1,
      }));
      method = 'decrement-desired';
    }
    await document.send(new DeleteCommand({ TableName: tableName, Key: { id: candidate.id || `WORKER#${candidate.instanceId}` } }))
      .catch(() => {});
    console.log('[model-coordinator][decision]', JSON.stringify({
      request: 'sweep', decision: 'scale-in', method, workerId: candidate.instanceId,
      modelKey: String(candidate.modelKey || '').slice(0, 12),
      idleMinutes: Math.round((now - Number(candidate.lastActivityAt || now)) / 60_000),
      desiredCapacity: Number(group?.DesiredCapacity || 0) - 1,
    }));
    return candidate.instanceId;
  } finally {
    await releaseAdmissionLease(lease);
  }
}

async function withSweep(result) {
  try {
    await sweepIdleWorkers();
  } catch (error) {
    console.error('[model-coordinator][sweep]', error?.name || '', error?.message || error);
  }
  return result;
}

export async function handler(event = {}) {
  try {
    if (event.action === 'claim') return claimBootAssignment(clean(event.instanceId));
    if (event.action === 'cancel') return cancelReply(clean(event.replyToken));
    if (event.action === 'lock-residency') return lockResidency(event);
    if (event.action === 'unlock-residency') return unlockResidency(event);
    if (event.action === 'prepare') return withSweep(await prepareCapacity(event));
    if (event.action === 'peek') return peekCapacity(event);
    if (event.action === 'reassign') return runReassignment(clean(event.id));
    if (event.action === 'status') {
      const existing = await scanState();
      const { group, workers } = await refreshFleet(existing);
      return {
        statusCode: 200,
        desiredCapacity: group.DesiredCapacity,
        workers: lockedFleet(existing, workers),
        residencyLocks: existing.filter((item) => (
          item.entity === 'RESIDENCY_LOCK' && itemInScope(item)
        )),
      };
    }
    if (event.action === 'synthesize') return withSweep(await synthesize(event));
    if (event.action === 'sweep') return { statusCode: 200, removed: await sweepIdleWorkers() };
    return { statusCode: 400, error: 'Unknown coordinator action' };
  } catch (error) {
    console.error('[model-coordinator]', error);
    return {
      statusCode: Number(error.statusCode) || 500,
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(error.code === 'MODEL_ADMISSION_BUSY' ? { retryAfterSeconds: 1, retryable: true } : {}),
    };
  }
}
