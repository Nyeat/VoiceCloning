import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { dirname } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// Usage:
//   node scripts/load-test-staging-tts.mjs [concurrency]
// Steady mode (legacy): N users, one request each, or looping for
// VCS_LOAD_TEST_DURATION_MS. Ramp mode: set VCS_LOAD_TEST_RAMP to a schedule
// like "0:10,180:50,360:100,720:100,780:0" (seconds:users, linearly
// interpolated); it overrides concurrency/duration and the run ends at the
// last point.

const concurrency = Number.parseInt(process.argv[2] || '10', 10);
const url = process.env.VCS_LOAD_TEST_URL
  || 'https://d25sg72wp8oj5g.cloudfront.net/api/live/tts-sentence';
const timeoutMs = Number.parseInt(process.env.VCS_LOAD_TEST_TIMEOUT_MS || '180000', 10);
const durationMs = Number.parseInt(process.env.VCS_LOAD_TEST_DURATION_MS || '0', 10);
const reportFile = process.env.VCS_LOAD_TEST_REPORT_FILE || '';
const fixedText = process.env.VCS_LOAD_TEST_TEXT || '';
const textsFile = process.env.VCS_LOAD_TEST_TEXTS_FILE || '';
const skipVerify = process.env.VCS_LOAD_TEST_SKIP_VERIFY === 'true';
const rampSpec = process.env.VCS_LOAD_TEST_RAMP || '';
const bucketMs = Number.parseInt(process.env.VCS_LOAD_TEST_BUCKET_MS || '15000', 10);
// Staging GI requires a signed-in learner; pass the browser's Entra ID token.
const entraToken = process.env.VCS_LOAD_TEST_ENTRA_TOKEN || '';
const pacePlayback = process.env.VCS_LOAD_TEST_PACE_PLAYBACK !== 'false';
const thinkMsMin = Number.parseInt(process.env.VCS_LOAD_TEST_THINK_MS_MIN || '1000', 10);
const thinkMsMax = Number.parseInt(process.env.VCS_LOAD_TEST_THINK_MS_MAX || '4000', 10);
const freshConnections = process.env.VCS_LOAD_TEST_FRESH_CONNECTIONS === 'true';
const sloP95Ms = Number.parseInt(process.env.VCS_LOAD_TEST_SLO_P95_MS || '0', 10);
const sloErrorRate = Number.parseFloat(process.env.VCS_LOAD_TEST_SLO_ERROR_RATE || '0');
const MAX_USERS = 500;
const MAX_REPORTED_FAILURES = 50;
const MAX_PLAYBACK_PACE_MS = 30_000;
const PCM_BYTES_PER_SECOND = 24_000 * 2;

if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_USERS) {
  throw new Error(`Concurrency must be an integer from 1 to ${MAX_USERS}.`);
}
if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > 3_600_000) {
  throw new Error('VCS_LOAD_TEST_DURATION_MS must be from 0 to 3600000.');
}
if (!Number.isInteger(bucketMs) || bucketMs < 1000 || bucketMs > 300_000) {
  throw new Error('VCS_LOAD_TEST_BUCKET_MS must be from 1000 to 300000.');
}
if (!Number.isInteger(thinkMsMin) || !Number.isInteger(thinkMsMax)
  || thinkMsMin < 0 || thinkMsMax < thinkMsMin || thinkMsMax > 120_000) {
  throw new Error('Think time bounds must satisfy 0 <= min <= max <= 120000.');
}

function parseRamp(spec) {
  if (!spec) return null;
  const points = spec.split(',').map((entry) => {
    const [seconds, users] = entry.split(':').map((value) => Number.parseInt(value.trim(), 10));
    if (!Number.isInteger(seconds) || seconds < 0
      || !Number.isInteger(users) || users < 0 || users > MAX_USERS) {
      throw new Error(`Invalid ramp entry "${entry}"; expected seconds:users with users 0-${MAX_USERS}.`);
    }
    return { atMs: seconds * 1000, users };
  });
  if (points.length < 2) throw new Error('VCS_LOAD_TEST_RAMP needs at least two points.');
  for (let i = 1; i < points.length; i += 1) {
    if (points[i].atMs <= points[i - 1].atMs) {
      throw new Error('VCS_LOAD_TEST_RAMP times must be strictly increasing.');
    }
  }
  if (points.at(-1).atMs > 3_600_000) {
    throw new Error('VCS_LOAD_TEST_RAMP must end within 3600 seconds.');
  }
  return points;
}

function rampTargetAt(points, elapsedMs) {
  if (elapsedMs <= points[0].atMs) return points[0].users;
  for (let i = 1; i < points.length; i += 1) {
    if (elapsedMs <= points[i].atMs) {
      const prev = points[i - 1];
      const next = points[i];
      const fraction = (elapsedMs - prev.atMs) / (next.atMs - prev.atMs);
      return Math.round(prev.users + (next.users - prev.users) * fraction);
    }
  }
  return points.at(-1).users;
}

const DEFAULT_TEXT_POOL = [
  'Concurrent staging voice check.',
  'Gastrointestinal bleeding means bleeding somewhere inside the digestive tract.',
  'Doctors first assess how severe the bleeding is before looking for the source.',
  'A gastroscopy lets the doctor inspect the stomach lining directly with a camera.',
  'Please arrive fasting, because food in the stomach can hide the bleeding source.',
  'Iron supplements can darken stool, which is sometimes mistaken for melena.',
  'If you feel dizzy or notice black tarry stools, seek medical help right away.',
  'The procedure itself usually takes less than fifteen minutes under light sedation.',
  'Most patients go home the same day once the sedation has fully worn off.',
  'Treatment depends on the cause, ranging from medication to endoscopic clipping of the vessel.',
];

function loadTextPool() {
  if (fixedText) return [fixedText];
  if (textsFile) {
    const lines = readFileSync(textsFile, 'utf8')
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) throw new Error(`No usable lines in ${textsFile}.`);
    return lines;
  }
  return DEFAULT_TEXT_POOL;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function summarizeLatencies(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    min: sorted.length ? Math.round(sorted[0]) : null,
    p50: percentile(sorted, 0.50) == null ? null : Math.round(percentile(sorted, 0.50)),
    p95: percentile(sorted, 0.95) == null ? null : Math.round(percentile(sorted, 0.95)),
    p99: percentile(sorted, 0.99) == null ? null : Math.round(percentile(sorted, 0.99)),
    max: sorted.length ? Math.round(sorted.at(-1)) : null,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBetween = (min, max) => min + Math.random() * (max - min);

const rampPoints = parseRamp(rampSpec);
const textPool = loadTextPool();
const runId = Date.now();
const wallStarted = performance.now();
const results = [];
let inFlight = 0;
let requestSequence = 0;

async function runRequest(userIndex) {
  const sequence = requestSequence;
  requestSequence += 1;
  const text = textPool[Math.floor(Math.random() * textPool.length)];
  const started = performance.now();
  inFlight += 1;
  let outcome;
  try {
    const body = JSON.stringify({
      voiceProfileId: 'deanvoice-v1',
      text,
      ...(skipVerify ? { skip_verify: true } : {}),
    });
    const response = await fetch(`${url}?loadTest=${runId}-${userIndex}-${sequence}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        // CloudFront signs the Lambda URL origin (AWS_IAM) and needs the body hash.
        'x-amz-content-sha256': createHash('sha256').update(body).digest('hex'),
        ...(entraToken ? { 'X-VCS-Entra-Token': entraToken } : {}),
        ...(freshConnections ? { Connection: 'close' } : {}),
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const audio = Buffer.from(await response.arrayBuffer());
    outcome = {
      user: userIndex,
      ok: response.ok
        && response.headers.get('content-type')?.startsWith('audio/wav')
        && audio.subarray(0, 4).toString('ascii') === 'RIFF',
      status: response.status,
      contentType: response.headers.get('content-type'),
      bytes: audio.length,
      startedAtMs: started - wallStarted,
      latencyMs: performance.now() - started,
    };
  } catch (error) {
    outcome = {
      user: userIndex,
      ok: false,
      status: 0,
      contentType: null,
      bytes: 0,
      startedAtMs: started - wallStarted,
      latencyMs: performance.now() - started,
      error: error.message,
    };
  }
  inFlight -= 1;
  results.push(outcome);
  return outcome;
}

async function thinkAfter(outcome) {
  let pauseMs = randomBetween(thinkMsMin, thinkMsMax);
  if (pacePlayback && outcome.ok) {
    pauseMs += Math.min(MAX_PLAYBACK_PACE_MS, (outcome.bytes / PCM_BYTES_PER_SECOND) * 1000);
  }
  if (pauseMs > 0) await sleep(pauseMs);
}

const timelineSamples = [];

function sampleTimeline(activeUsers, targetUsers) {
  timelineSamples.push({
    atMs: performance.now() - wallStarted,
    activeUsers,
    targetUsers,
    inFlight,
  });
}

async function runSteady() {
  const deadline = durationMs > 0 ? wallStarted + durationMs : null;
  const sampler = deadline == null
    ? null
    : setInterval(() => sampleTimeline(concurrency, concurrency), 1000);
  await Promise.all(
    Array.from({ length: concurrency }, async (_, index) => {
      do {
        const outcome = await runRequest(index);
        if (deadline != null && performance.now() < deadline) await thinkAfter(outcome);
      } while (deadline != null && performance.now() < deadline);
    }),
  );
  if (sampler) clearInterval(sampler);
  return concurrency;
}

async function runRamp(points) {
  const users = [];
  const userPromises = [];
  const endAtMs = points.at(-1).atMs;

  const spawnUser = () => {
    const user = { index: users.length, stopped: false };
    users.push(user);
    userPromises.push((async () => {
      while (!user.stopped && performance.now() - wallStarted < endAtMs) {
        const outcome = await runRequest(user.index);
        if (user.stopped) break;
        await thinkAfter(outcome);
      }
    })());
  };

  let active = 0;
  while (performance.now() - wallStarted < endAtMs) {
    const elapsed = performance.now() - wallStarted;
    const target = rampTargetAt(points, elapsed);
    while (active < target) {
      spawnUser();
      active += 1;
    }
    while (active > target) {
      const runningUser = users.findLast((user) => !user.stopped);
      if (!runningUser) break;
      runningUser.stopped = true;
      active -= 1;
    }
    sampleTimeline(active, target);
    await sleep(Math.min(1000, Math.max(50, endAtMs - elapsed)));
  }
  for (const user of users) user.stopped = true;
  await Promise.all(userPromises);
  return Math.max(...points.map((point) => point.users));
}

const peakUsers = rampPoints ? await runRamp(rampPoints) : await runSteady();
const wallMs = performance.now() - wallStarted;

const successful = results.filter((result) => result.ok);
const failures = results.filter((result) => !result.ok);
const statusCounts = results.reduce((counts, result) => {
  counts[result.status] = (counts[result.status] || 0) + 1;
  return counts;
}, {});

const bucketCount = Math.max(1, Math.ceil(wallMs / bucketMs));
const timeline = Array.from({ length: bucketCount }, (_, index) => ({
  bucket: index + 1,
  fromSec: Math.round((index * bucketMs) / 1000),
  toSec: Math.round(Math.min(wallMs, (index + 1) * bucketMs) / 1000),
  started: 0,
  completed: 0,
  failed: 0,
  latencies: [],
  activeUsers: null,
  targetUsers: null,
  maxInFlight: 0,
}));
for (const result of results) {
  const startBucket = timeline[Math.min(bucketCount - 1, Math.floor(result.startedAtMs / bucketMs))];
  startBucket.started += 1;
  const endBucket = timeline[
    Math.min(bucketCount - 1, Math.floor((result.startedAtMs + result.latencyMs) / bucketMs))
  ];
  if (result.ok) {
    endBucket.completed += 1;
    endBucket.latencies.push(result.latencyMs);
  } else {
    endBucket.failed += 1;
  }
}
for (const sample of timelineSamples) {
  const bucket = timeline[Math.min(bucketCount - 1, Math.floor(sample.atMs / bucketMs))];
  bucket.activeUsers = sample.activeUsers;
  bucket.targetUsers = sample.targetUsers;
  bucket.maxInFlight = Math.max(bucket.maxInFlight, sample.inFlight);
}
const timelineReport = timeline.map(({ latencies, ...bucket }) => ({
  ...bucket,
  latencyMs: summarizeLatencies(latencies),
}));

const errorRate = results.length === 0 ? 1 : failures.length / results.length;
const overallLatency = summarizeLatencies(successful.map((result) => result.latencyMs));
const slo = {};
if (sloP95Ms > 0) {
  slo.p95Ms = {
    threshold: sloP95Ms,
    actual: overallLatency.p95,
    pass: overallLatency.p95 != null && overallLatency.p95 <= sloP95Ms,
  };
}
if (sloErrorRate > 0) {
  slo.errorRate = {
    threshold: sloErrorRate,
    actual: Number(errorRate.toFixed(4)),
    pass: errorRate <= sloErrorRate,
  };
}
const sloChecks = Object.values(slo);
const sloPass = sloChecks.length === 0 ? null : sloChecks.every((check) => check.pass);
if (sloPass === false) process.exitCode = 1;

const report = {
  url,
  mode: rampPoints ? 'ramp' : 'steady',
  ramp: rampSpec || null,
  concurrency: rampPoints ? null : concurrency,
  peakUsers,
  durationMs: rampPoints ? rampPoints.at(-1).atMs : durationMs,
  textPoolSize: textPool.length,
  skipVerify,
  pacePlayback,
  thinkMs: { min: thinkMsMin, max: thinkMsMax },
  freshConnections,
  totalRequests: results.length,
  startedAt: new Date(runId).toISOString(),
  wallMs: Math.round(wallMs),
  success: successful.length,
  failed: failures.length,
  errorRate: Number(errorRate.toFixed(4)),
  statusCounts,
  latencyMs: overallLatency,
  audioBytes: {
    min: successful.length ? Math.min(...successful.map((result) => result.bytes)) : null,
    max: successful.length ? Math.max(...successful.map((result) => result.bytes)) : null,
  },
  timeline: timelineReport,
  ...(sloPass == null ? {} : { slo: { pass: sloPass, ...slo } }),
  failureCount: failures.length,
  failures: failures.slice(0, MAX_REPORTED_FAILURES).map(
    ({ user, status, contentType, bytes, startedAtMs, latencyMs, error }) => ({
      user,
      status,
      contentType,
      bytes,
      atSec: Math.round(startedAtMs / 1000),
      latencyMs: Math.round(latencyMs),
      ...(error ? { error } : {}),
    }),
  ),
};
if (reportFile) {
  mkdirSync(dirname(reportFile), { recursive: true });
  writeFileSync(reportFile, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ ...report, ...(reportFile ? { reportFile } : {}) }, null, 2));
