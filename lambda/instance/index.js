import {
  EC2Client,
  DescribeInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
} from '@aws-sdk/client-ec2';
import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
  UpdateAutoScalingGroupCommand,
} from '@aws-sdk/client-auto-scaling';
import { ok, err, preflight } from '../shared/cors.js';
import { originVerifyHeaders } from '../shared/gpuWorker.js';

function instanceId() {
  return (process.env.GPU_INSTANCE_ID || '').trim();
}

function instanceRegion() {
  return (process.env.GPU_INSTANCE_REGION || process.env.AWS_REGION || 'ap-northeast-2').trim();
}

function inferenceAutoScalingGroupName() {
  return (process.env.GPU_INFERENCE_ASG_NAME || '').trim();
}

function workerUrl() {
  return (process.env.GPU_WORKER_URL || '').replace(/\/+$/u, '');
}

function inferenceWorkerUrl() {
  return (process.env.INFERENCE_WORKER_URL || '').replace(/\/+$/u, '');
}

function statusReadinessTarget() {
  return String(process.env.GPU_STATUS_READINESS_TARGET || '').trim().toLowerCase() === 'inference'
    ? 'inference'
    : 'worker';
}

function idleStopMinutes() {
  const value = Number.parseFloat(process.env.GPU_IDLE_STOP_MINUTES || '0');
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function isTruthy(value) {
  return /^(1|true|yes|on)$/iu.test(String(value || '').trim());
}

function scheduleConfig() {
  const enabled = isTruthy(process.env.GPU_SCHEDULE_ENABLED);
  const startHour = Number.parseInt(process.env.GPU_SCHEDULE_START_HOUR || '7', 10);
  const endHour = Number.parseInt(process.env.GPU_SCHEDULE_END_HOUR || '19', 10);
  const timeZone = (process.env.GPU_SCHEDULE_TIMEZONE || 'Asia/Seoul').trim();
  return {
    enabled,
    startHour: Number.isFinite(startHour) ? startHour : 7,
    endHour: Number.isFinite(endHour) ? endHour : 19,
    timeZone,
  };
}

// Current hour (0-23) in the schedule's timezone. Lambda runs in UTC, so we
// resolve the local hour via Intl rather than the runtime clock.
function localHour(timeZone, now = new Date()) {
  try {
    const hour = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      hour12: false,
    }).format(now);
    // '24' is emitted by some engines for midnight; normalize to 0.
    return Number.parseInt(hour, 10) % 24;
  } catch {
    return now.getUTCHours();
  }
}

// Window is [startHour, endHour); handles overnight windows where end <= start.
function withinWindow(hour, startHour, endHour) {
  if (startHour === endHour) return false;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

function createEc2Client() {
  return globalThis.__voiceCloningEc2Client || new EC2Client({ region: instanceRegion() });
}

function createAutoScalingClient() {
  return globalThis.__voiceCloningAutoScalingClient
    || new AutoScalingClient({ region: instanceRegion() });
}

async function syncInferenceFleet(fixedState) {
  const groupName = inferenceAutoScalingGroupName();
  if (!groupName || !fixedState) {
    return { configured: false, changed: false };
  }

  const enabled = !['stopped', 'stopping', 'shutting-down', 'terminated'].includes(fixedState);
  const client = createAutoScalingClient();
  const response = await client.send(new DescribeAutoScalingGroupsCommand({
    AutoScalingGroupNames: [groupName],
  }));
  const group = response?.AutoScalingGroups?.[0];
  if (!group) {
    throw new Error(`Inference Auto Scaling group ${groupName} was not found.`);
  }

  const currentMin = Number(group.MinSize || 0);
  const currentDesired = Number(group.DesiredCapacity || 0);
  const targetMin = enabled ? 1 : 0;
  const targetDesired = enabled ? Math.max(currentDesired, 1) : 0;
  const changed = currentMin !== targetMin || currentDesired !== targetDesired;

  if (changed) {
    await client.send(new UpdateAutoScalingGroupCommand({
      AutoScalingGroupName: groupName,
      MinSize: targetMin,
      DesiredCapacity: targetDesired,
    }));
  }

  return {
    configured: true,
    groupName,
    enabled,
    changed,
    minSize: targetMin,
    desiredCapacity: targetDesired,
  };
}

function unconfiguredStatus() {
  return {
    configured: false,
    state: 'unconfigured',
    workerReady: false,
    startable: false,
    message: 'GPU instance control is not configured.',
  };
}

function normalizeState(response) {
  const instance = response?.Reservations?.flatMap((reservation) => reservation.Instances || [])?.[0];
  return instance?.State?.Name || 'unknown';
}

async function describeInstance(ec2, id) {
  const response = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [id] }));
  return normalizeState(response);
}

async function checkWorkerReady() {
  const target = statusReadinessTarget();
  const baseUrl = target === 'inference' ? inferenceWorkerUrl() : workerUrl();
  if (!baseUrl) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(
      `${baseUrl}${target === 'inference' ? '/models' : '/healthz'}`,
      { signal: controller.signal, headers: originVerifyHeaders() },
    );
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function statusPayload({ id, state, workerReady, started = false, previousState = null }) {
  const payload = {
    configured: true,
    instanceId: id,
    state,
    workerReady,
    startable: state === 'stopped',
  };

  if (previousState) {
    payload.previousState = previousState;
  }
  if (started) {
    payload.started = true;
  } else {
    payload.started = false;
  }

  return payload;
}

function activityProbeTargets() {
  const trainingUrl = workerUrl();
  if (!trainingUrl) {
    throw new Error('GPU_WORKER_URL is not configured.');
  }

  const targets = [{
    name: 'training',
    url: `${trainingUrl}/activity/status`,
  }];

  const fixedInferenceActivityUrl = String(process.env.GPU_FIXED_INFERENCE_ACTIVITY_URL || '').trim();
  const inferenceUrl = inferenceWorkerUrl();
  if (fixedInferenceActivityUrl) {
    targets.push({
      name: 'inference',
      url: fixedInferenceActivityUrl,
    });
  } else if (inferenceUrl) {
    targets.push({
      name: 'inference',
      url: `${inferenceUrl}/inference/activity/status`,
    });
  }

  return targets;
}

async function fetchActivityStatus(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: originVerifyHeaders() });
    if (!response.ok) {
      throw new Error(`Worker activity status returned ${response.status}`);
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function preferStatus(values, key) {
  const preferred = values.find((value) => value?.[key] && value[key] !== 'idle');
  if (preferred) return preferred[key];

  const fallback = values.find((value) => typeof value?.[key] === 'string');
  return fallback?.[key] || 'idle';
}

function mergeActivityStatuses(samples) {
  const values = samples.map((sample) => sample.activity || {});
  const lastActivityAt = values
    .map((value) => Number(value?.lastActivityAt))
    .filter(Number.isFinite)
    .reduce((max, value) => Math.max(max, value), 0);
  const idleMs = values
    .map((value) => Number(value?.idleMs))
    .filter(Number.isFinite)
    .reduce((min, value) => Math.min(min, value), Number.POSITIVE_INFINITY);

  return {
    busy: values.some((value) => Boolean(value?.busy)),
    lastActivityAt: lastActivityAt || Date.now(),
    idleMs: Number.isFinite(idleMs) ? idleMs : 0,
    trainingStatus: preferStatus(values, 'trainingStatus'),
    inferenceStatus: preferStatus(values, 'inferenceStatus'),
    trainingActive: values.some((value) => Boolean(value?.trainingActive)),
    inferenceActive: values.some((value) => Boolean(value?.inferenceActive)),
    sources: Object.fromEntries(samples.map((sample) => [sample.name, sample.activity])),
  };
}

async function getWorkerActivityStatus() {
  const targets = activityProbeTargets();
  const results = await Promise.allSettled(targets.map(async (target) => ({
    name: target.name,
    activity: await fetchActivityStatus(target.url),
  })));

  const failures = results
    .map((result, index) => (
      result.status === 'rejected'
        ? { name: targets[index].name, message: result.reason?.message || String(result.reason) }
        : null
    ))
    .filter(Boolean);

  if (failures.length) {
    throw new Error(
      `Worker activity check failed for ${failures.map((failure) => `${failure.name}: ${failure.message}`).join('; ')}`,
    );
  }

  return mergeActivityStatuses(results.map((result) => result.value));
}

async function getStatus() {
  const id = instanceId();
  if (!id) return unconfiguredStatus();

  const ec2 = createEc2Client();
  // The common path is an already-running GPU. Probe worker health in parallel with
  // EC2 state instead of paying those network latencies serially on every page load.
  const workerReadyPromise = checkWorkerReady();
  const state = await describeInstance(ec2, id);
  const workerReady = state === 'running' ? await workerReadyPromise : false;
  return statusPayload({ id, state, workerReady });
}

async function startInstance() {
  const id = instanceId();
  if (!id) {
    return {
      errorStatus: 400,
      body: unconfiguredStatus(),
    };
  }

  const ec2 = createEc2Client();
  const state = await describeInstance(ec2, id);

  // In schedule mode the window is the sole authority. Ignore activity-triggered
  // starts outside the window so a person on the page can't wake the GPU off-hours.
  const schedule = scheduleConfig();
  if (schedule.enabled
    && state === 'stopped'
    && !withinWindow(localHour(schedule.timeZone), schedule.startHour, schedule.endHour)) {
    return {
      body: {
        ...statusPayload({ id, state, workerReady: false }),
        scheduleBlocked: true,
        message: 'GPU start is disabled outside the scheduled window.',
      },
    };
  }

  if (state === 'running') {
    return {
      body: statusPayload({
        id,
        state,
        workerReady: await checkWorkerReady(),
      }),
    };
  }

  if (state !== 'stopped') {
    return {
      body: statusPayload({
        id,
        state,
        workerReady: false,
      }),
    };
  }

  const response = await ec2.send(new StartInstancesCommand({ InstanceIds: [id] }));
  const transition = response?.StartingInstances?.[0] || {};
  const nextState = transition.CurrentState?.Name || 'pending';
  const previousState = transition.PreviousState?.Name || state;

  return {
    body: statusPayload({
      id,
      state: nextState,
      previousState,
      workerReady: false,
      started: true,
    }),
  };
}

// Strict time-window control: activity is ignored entirely. Inside the window the
// GPU is forced on (started if stopped, left running otherwise); outside it is forced
// off (stopped if running). Manual/activity starts outside the window are undone on
// the next check.
async function enforceSchedule(config) {
  const id = instanceId();
  if (!id) {
    return {
      checked: false,
      changed: false,
      mode: 'schedule',
      reason: 'unconfigured',
      ...unconfiguredStatus(),
    };
  }

  const hour = localHour(config.timeZone);
  const shouldRun = withinWindow(hour, config.startHour, config.endHour);
  const ec2 = createEc2Client();
  const state = await describeInstance(ec2, id);
  const base = {
    checked: true,
    mode: 'schedule',
    instanceId: id,
    localHour: hour,
    timeZone: config.timeZone,
    window: { startHour: config.startHour, endHour: config.endHour },
    shouldRun,
  };

  if (shouldRun) {
    if (state === 'stopped') {
      await ec2.send(new StartInstancesCommand({ InstanceIds: [id] }));
      return { ...base, changed: true, reason: 'schedule-start', state: 'pending', previousState: state };
    }
    return { ...base, changed: false, reason: `in-window-${state}`, state };
  }

  if (state === 'running') {
    await ec2.send(new StopInstancesCommand({ InstanceIds: [id] }));
    return { ...base, changed: true, reason: 'schedule-stop', state: 'stopping', previousState: state };
  }
  return { ...base, changed: false, reason: `out-of-window-${state}`, state };
}

async function stopInstanceIfIdle() {
  const schedule = scheduleConfig();
  if (schedule.enabled) {
    return enforceSchedule(schedule);
  }

  const thresholdMinutes = idleStopMinutes();
  if (thresholdMinutes <= 0) {
    return {
      checked: false,
      stopped: false,
      reason: 'disabled',
      idleStopMinutes: 0,
    };
  }

  const id = instanceId();
  if (!id) {
    return {
      checked: false,
      stopped: false,
      reason: 'unconfigured',
      ...unconfiguredStatus(),
      idleStopMinutes: thresholdMinutes,
    };
  }

  const ec2 = createEc2Client();
  const state = await describeInstance(ec2, id);
  if (state !== 'running') {
    return {
      checked: true,
      stopped: false,
      reason: `instance-${state}`,
      instanceId: id,
      state,
      idleStopMinutes: thresholdMinutes,
    };
  }

  let activity;
  try {
    activity = await getWorkerActivityStatus();
  } catch (error) {
    return {
      checked: true,
      stopped: false,
      reason: 'worker-unreachable',
      instanceId: id,
      state,
      idleStopMinutes: thresholdMinutes,
      error: error.message,
    };
  }

  const thresholdMs = thresholdMinutes * 60 * 1000;
  const idleMs = Number.isFinite(Number(activity?.idleMs)) ? Number(activity.idleMs) : 0;

  if (activity?.busy && idleMs < thresholdMs) {
    return {
      checked: true,
      stopped: false,
      reason: 'worker-busy',
      instanceId: id,
      state,
      idleStopMinutes: thresholdMinutes,
      activity,
    };
  }

  if (idleMs < thresholdMs) {
    return {
      checked: true,
      stopped: false,
      reason: 'idle-threshold-not-met',
      instanceId: id,
      state,
      idleStopMinutes: thresholdMinutes,
      activity,
    };
  }

  await ec2.send(new StopInstancesCommand({ InstanceIds: [id] }));
  return {
    checked: true,
    stopped: true,
    reason: activity?.busy ? 'stale-busy-timeout' : 'idle-timeout',
    instanceId: id,
    state: 'stopping',
    previousState: state,
    idleStopMinutes: thresholdMinutes,
    activity,
  };
}

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') {
    return preflight();
  }

  const method = event.requestContext?.http?.method;
  const routePath = event.rawPath || '';

  try {
    if (method === 'GET' && routePath.endsWith('/instance/status')) {
      return ok(await getStatus());
    }

    if (method === 'POST' && routePath.endsWith('/instance/start')) {
      const result = await startInstance();
      if (result.errorStatus) {
        return {
          ...err(result.errorStatus, result.body.message || 'GPU instance control is not configured.'),
          body: JSON.stringify(result.body),
        };
      }
      if (!inferenceAutoScalingGroupName()) return ok(result.body);
      return ok({ ...result.body, inferenceFleet: await syncInferenceFleet(result.body.state) });
    }

    if ((method === 'POST' || method === 'GET') && routePath.endsWith('/instance/idle-check')) {
      const result = await stopInstanceIfIdle();
      if (!inferenceAutoScalingGroupName()) return ok(result);
      return ok({
        ...result,
        inferenceFleet: await syncInferenceFleet(result.state),
      });
    }

    return err(404, 'Not found');
  } catch (error) {
    return err(500, error.message);
  }
};
