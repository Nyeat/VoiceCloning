#!/usr/bin/env node
// Seeds (or removes) Voice Studio test accounts, one per flow, on an
// environment's S3 state. Fixtures use the reserved @voice-studio.test domain,
// are marked `fixture: true`, never reach the GPU and are invisible to real
// lecturers (see FIXTURE_DOMAIN in studio/workflow.js). Re-running replaces
// the previous fixtures with fresh ones timed relative to now.
//
//   STUDIO_FIXTURE_PASSWORD=... node scripts/seed-studio-fixtures.mjs --env staging
//   node scripts/seed-studio-fixtures.mjs --env staging --remove
//
// Needs AWS credentials for the project role in the environment.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createS3StateStore, updateState } from '../studio/store.js';
import { ACCOUNTS_KEY, hashPassword, normalizeAccounts } from '../studio/accounts.js';
import { FIXTURE_DOMAIN, isFixtureEmail } from '../studio/workflow.js';

const args = process.argv.slice(2);
const envName = args[args.indexOf('--env') + 1];
const remove = args.includes('--remove');
if (!['dev', 'staging'].includes(envName)) throw new Error('Usage: --env dev|staging [--remove]');

const envFile = new URL(`../.env.deployment${envName === 'staging' ? '.staging' : ''}`, import.meta.url);
const deployEnv = Object.fromEntries(readFileSync(envFile, 'utf8').split(/\r?\n/u)
  .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/u)).filter(Boolean).map((match) => [match[1], match[2]]));
const env = { S3_BUCKET: deployEnv.S3_BUCKET, S3_PREFIX: deployEnv.S3_PREFIX };
process.env.S3_REGION = deployEnv.S3_REGION || 'ap-southeast-1';

const MIN = 60_000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
// Whole SGT hours from today, so times read naturally ("tomorrow 10:00").
const sgtMidnight = Date.parse(`${new Date(now + 8 * 3600_000).toISOString().slice(0, 10)}T00:00:00+08:00`);
const at = (dayOffset, hour, minute = 0) => sgtMidnight + dayOffset * 24 * 3600_000 + (hour * 60 + minute) * MIN;
const email = (flow) => `${flow}@${FIXTURE_DOMAIN}`;

const ACCOUNTS = [
  ['new', 'Test · New (nothing booked)'],
  ['booked', 'Test · Booked a session'],
  ['recording', 'Test · Recording now'],
  ['queued', 'Test · Waiting to train'],
  ['qc', 'Test · In quality check'],
  ['ready', 'Test · Ready, no test slot'],
  ['testslot', 'Test · Ready with test slot'],
];

function fixtureJob(flow, status, { label, attempt = 1, extra = {} } = {}) {
  const voice = `x-fixture-${flow}`;
  return {
    id: `fixture-${flow}`,
    fixture: true,
    ownerEmail: email(flow),
    ownerName: ACCOUNTS.find(([name]) => name === flow)[1],
    label: label || 'My teaching voice',
    expName: voice,
    sourceExpName: voice,
    consent: { version: 'fixture', acceptedAt: iso(now) },
    status,
    attempt,
    attempts: status === 'queued' ? [] : [{ attempt: 1, expName: voice, config: { sovitsEpochs: 8, gptEpochs: 15, skipDenoise: false }, startedAt: iso(now - 90 * MIN), finishedAt: iso(now - 60 * MIN), result: 'trained' }],
    files: [{ name: 'guided-reading.wav', bytes: 98_000_000, source: 'recorded' }, { name: 'lecture-week3.mp3', bytes: 24_000_000, source: 'upload' }],
    totalBytes: 122_000_000,
    trainingConfig: { sovitsEpochs: 8, gptEpochs: 15, skipDenoise: false, asrModel: 'large-v3' },
    createdAt: iso(now - 3 * 3600_000),
    queuedAt: iso(now - 2 * 3600_000),
    startedAt: null,
    finishedAt: null,
    reviews: [],
    feedback: [],
    notifications: [],
    error: '',
    ...extra,
  };
}

function fixtureSlot(kind, start, end, flow = '') {
  return {
    id: `fixture-${kind}-${randomUUID().slice(0, 8)}`,
    fixture: true,
    kind,
    start: iso(start),
    end: iso(end),
    status: 'published',
    assigneeEmail: flow ? email(flow) : '',
    assigneeName: flow ? ACCOUNTS.find(([name]) => name === flow)[1] : '',
    createdBy: 'fixture-seed',
    updatedAt: iso(now),
    publishedAt: iso(now),
    notified: flow ? { assigneeEmail: email(flow), start: iso(start), end: iso(end) } : null,
    ...(flow && kind === 'recording' ? { claimedAt: iso(now) } : {}),
    preloadedAt: null,
    reminderSentAt: null,
  };
}

function seededState() {
  const approvedAt = iso(now - 30 * MIN);
  const approved = (flow, extra = {}) => fixtureJob(flow, 'approved', {
    extra: { approvedExpName: `x-fixture-${flow}`, reviews: [{ attempt: 1, expName: `x-fixture-${flow}`, decision: 'approve', reasons: [], notes: 'fixture', reviewer: 'fixture-seed', at: approvedAt }], ...extra },
  });
  const jobs = [
    fixtureJob('queued', 'queued'),
    fixtureJob('qc', 'review'),
    approved('ready', {
      feedback: [{ email: email('ready'), rating: 3, likeness: 'mostly', issues: ['wrong-words', 'pace'], words: 'cohesin, apoptosis', comment: 'Close, but a bit fast on long sentences.', at: iso(now - 10 * MIN) }],
    }),
    approved('testslot'),
  ];
  // Recording "now" lasts until the end of today (at most 8 h, the slot limit).
  const recordingEnd = Math.min(now + 8 * 60 * MIN, Math.max(now + 60 * MIN, at(0, 23, 30)));
  const slots = [
    fixtureSlot('recording', at(1, 10), at(1, 11), 'booked'),
    fixtureSlot('recording', now - 5 * MIN, recordingEnd, 'recording'),
    // Open sessions for "new" (and "booked", to try Change).
    fixtureSlot('recording', at(1, 14), at(1, 15)),
    fixtureSlot('recording', at(2, 9, 30), at(2, 10, 30)),
    fixtureSlot('recording', at(2, 13), at(2, 14)),
    fixtureSlot('recording', at(3, 11), at(3, 12, 30)),
    // A GPU test slot booked for tomorrow (fixtures never warm the GPU).
    fixtureSlot('test', at(1, 15), at(1, 16), 'testslot'),
  ];
  return { jobs, slots };
}

const store = createS3StateStore({ env });
const accountStore = createS3StateStore({ env, key: ACCOUNTS_KEY, normalize: normalizeAccounts });

const passwordHash = remove ? '' : await hashPassword((() => {
  const value = process.env.STUDIO_FIXTURE_PASSWORD || '';
  if (value.length < 8) throw new Error('Set STUDIO_FIXTURE_PASSWORD (at least 8 characters)');
  return value;
})());

await updateState(accountStore, (accounts) => {
  accounts.accounts = accounts.accounts.filter((account) => !isFixtureEmail(account.email));
  if (!remove) {
    for (const [flow, name] of ACCOUNTS) accounts.accounts.push({ email: email(flow), name, passwordHash, fixture: true, createdAt: iso(now) });
  }
  return null;
});

const { state } = await updateState(store, (draft) => {
  draft.jobs = draft.jobs.filter((job) => job.fixture !== true);
  draft.slots = draft.slots.filter((slot) => slot.fixture !== true);
  if (!remove) {
    const { jobs, slots } = seededState();
    draft.jobs.push(...jobs);
    draft.slots.push(...slots);
  }
  return null;
});

console.log(`${remove ? 'Removed' : 'Seeded'} Voice Studio fixtures on ${envName}: `
  + `${remove ? 0 : ACCOUNTS.length} accounts, ${state.jobs.filter((job) => job.fixture).length} jobs, ${state.slots.filter((slot) => slot.fixture).length} slots.`);
if (!remove) for (const [flow, name] of ACCOUNTS) console.log(`  ${email(flow).padEnd(32)} ${name}`);
