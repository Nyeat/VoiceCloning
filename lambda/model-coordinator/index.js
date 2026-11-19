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
  preflightScaleBlocked,
  matchingFreeSlots,
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
// Lecture pages poll capacity. A short preparation-only grace prevents two open
// lectures with different voices from continuously switching the same idle GPU.
// Real synthesis still uses reassignIdleMs and can claim a genuinely idle GPU.
const preflightReassignIdleMs = Math.max(
  reassignIdleMs,
  Number(process.env.MODEL_PREFLIGHT_REASSIGN_IDLE_MS) || 30_000,
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
const scaleInIdleMs = Math.max(60_000, Number(process.env.MODEL_SCALE_IN_IDLE_MS) || 40 * 60_000);
const scaleInSweepMs = 60_000;
// A newly booted autoscaled GPU runs warm-staging-deanvoice.sh as its
// ExecStartPost: model load, then ten rounds that fill every slot, then
// /coordinator/register. It reports ready with the voice minutes before that
// script finishes, so routing there earlier bounced users off busy slots and
// launched a needless second GPU (2026-11-19 staging). It stays STARTING until
// it registers; the grace caps that wait if the script failed.
const bootWarmGraceMs = Math.max(0, Number(process.env.MODEL_BOOT_WARM_GRACE_MS) || 15 * 60_000);
const preflightDwellMs = Math.max(0, Number(process.env.MODEL_PREFLIGHT_DWELL_MS) || 8_000);
// A gap longer than this restarts the dwell (the page was closed).
const selectionGapMs = 30_000;
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
  const signalled = worker.residencySource === 'coordinator' || worker.warmPortOpen === true;
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

// Workers already committed to a live reassignment for some other model. They
// still probe as idle READY until the switch actually begins, so without this
// they look like spare capacity to every concurrent selection.
function promisedWorkerIds(items, now = Date.now()) {
  return items
    .filter((item) => itemInScope(item) && liveReassignment(item, now))
    .map((item) => clean(item.workerId))
    .filter(Boolean);
}

async function scheduleReassignment(worker, modelKey, synthesisBody, now = Date.now(), {
  requiredIdleMs = reassignIdleMs,
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
    const action = chooseCapacityAction({
      workers,
      requestedModelKey: pending.modelKey,
      lastDemandByModel: demandMap(existing),
      now,
      reassignIdleMs: Math.max(0, Number(pending.requiredIdleMs) || 0),
    });
    // Re-evaluate immediately before the destructive model switch. New work or
    // renewed demand for the resident voice invalidates the old decision.
    if (action.type !== 'reassign' || action.worker.instanceId !== pending.workerId) {
      return { statusCode: 200, assigned: false, reason: 'no-longer-idle' };
    }
    const worker = await assignWorker(action.worker, pending.synthesisBody, {
      requiredIdleMs: Math.max(0, Number(pending.requiredIdleMs) || 0),
    });
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
  { documentClient = document, autoscalingClient = autoscaling } = {},
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
  const existing = await scanState();
  await recordDemand(modelKey, model.voiceProfileId, now);
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
  const capacityInput = {
    workers,
    requestedModelKey: modelKey,
    lastDemandByModel: demandMap(existing),
    now,
    reassigningWorkerIds: promisedWorkerIds(existing, now),
  };
  // The preflight grace exists to stop two open lectures from swapping one GPU
  // back and forth. It must not turn into a reason to BUY a GPU: a worker that
  // is idle now and merely inside its grace window is still an idle worker to
  // switch, which is exactly the capacity the user expects to be reused. If the
  // grace is the only thing blocking a reassignment, wait for it rather than
  // scaling.
  const gracedOnly = allowScale
    && chooseCapacityAction({ ...capacityInput, reassignIdleMs: preflightReassignIdleMs }).type === 'scale'
    && chooseCapacityAction({ ...capacityInput, reassignIdleMs: 0 }).type === 'reassign';
  const action = choosePreparationAction({
    ...capacityInput,
    reassignIdleMs: preflightReassignIdleMs,
    allowScale: allowScale && !fleetInMotion && !gracedOnly,
  });
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
      message: 'An idle GPU will switch to this voice shortly. No additional GPU is being started.',
    });
  }
  if (action.type === 'defer' && fleetInMotion) {
    console.log('[model-coordinator][decision]', JSON.stringify({
      request: 'prepare', source, decision: 'await-fleet-transition', allowScale,
      voiceProfileId: clean(model.voiceProfileId), modelKey: modelKey.slice(0, 12),
      desiredCapacity: group.DesiredCapacity,
    }));
    return capacityResponse({
      state: readyMatching.length > 0 ? 'BUSY_WARMING' : 'WARMING',
      canStartConversation: readyMatching.length > 0,
      model,
      matchingWorkers: readyMatching.length,
      capacityAction: 'reassign',
      message: 'GPU capacity is already being prepared. This voice will be ready shortly without starting another GPU.',
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
      requiredIdleMs: preflightReassignIdleMs,
    });
    return capacityResponse({
      state: readyMatching.length > 0 ? 'BUSY_WARMING' : 'WARMING',
      canStartConversation: readyMatching.length > 0,
      model,
      matchingWorkers: readyMatching.length,
      capacityAction: 'reassign',
      started: scheduled.started,
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
  const scale = await requestScale(group, modelKey, body, now);
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
