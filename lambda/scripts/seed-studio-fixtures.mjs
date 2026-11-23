#!/usr/bin/env node
// Seeds (or removes) Voice Studio dummy people, one per state on the super-user
// train line, on an environment's S3 state. They use the reserved
// @voice-studio.test domain, are marked `fixture: true`, never reach the GPU,
// and only STUDIO_FIXTURE_VIEWERS see them (see FIXTURE_DOMAIN in
// studio/workflow.js). Re-running replaces every previous fixture with fresh
// ones timed relative to now.
//
// Sign-in is Google-only since 2026-11-23, so dummies are console data only:
// no password accounts are created, and any left from before are deleted.
// No dummy is ever "training": that would hold the real training queue.
//
//   node scripts/seed-studio-fixtures.mjs --env dev|staging [--remove]
//
// Needs AWS credentials for the project role in the environment.
import { readFileSync } from 'node:fs';
import { createS3StateStore, updateState } from '../studio/store.js';
import { ACCOUNTS_KEY, normalizeAccounts } from '../studio/accounts.js';
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

// One dummy person per state the console shows.
const PEOPLE = [
  ['booked', 'Dummy · Session booked'],
  ['draft', 'Dummy · Session draft'],
  ['recording', 'Dummy · Recording now'],
  ['uploading', 'Dummy · Upload in progress'],
  ['queued', 'Dummy · Queued to train'],
  ['retrain', 'Dummy · Queued, retrain 2'],
  ['qc', 'Dummy · Ready to review'],
  ['failed', 'Dummy · Training failed'],
  ['approved', 'Dummy · Approved, no test slot'],
  ['testslot', 'Dummy · Test slot tomorrow'],
  ['testingnow', 'Dummy · Testing now'],
  ['feedback', 'Dummy · Feedback sent'],
];
const nameOf = (flow) => PEOPLE.find(([key]) => key === flow)?.[1] || '';

function trainedAttempt(n, voice, result = 'trained') {
  return { attempt: n, expName: voice, config: { sovitsEpochs: 8, gptEpochs: 15, skipDenoise: false }, startedAt: iso(now - 90 * MIN), finishedAt: iso(now - 60 * MIN), result };
}

function fixtureJob(flow, status, extra = {}) {
  const voice = `x-fixture-${flow}`;
  const uploading = status === 'uploading';
  return {
    id: `fixture-${flow}`,
    fixture: true,
    ownerEmail: email(flow),
    ownerName: nameOf(flow),
    label: 'My teaching voice',
    expName: voice,
    sourceExpName: voice,
    consent: { version: 'fixture', acceptedAt: iso(now) },
    status,
    attempt: 1,
    attempts: uploading || status === 'queued' ? [] : [trainedAttempt(1, voice)],
    files: uploading ? [] : [{ name: 'guided-reading.wav', bytes: 98_000_000, source: 'recorded' }, { name: 'lecture-week3.mp3', bytes: 24_000_000, source: 'upload' }],
    totalBytes: uploading ? 0 : 122_000_000,
    trainingConfig: { sovitsEpochs: 8, gptEpochs: 15, skipDenoise: false, asrModel: 'large-v3' },
    createdAt: iso(now - 3 * 3600_000),
    queuedAt: uploading ? null : iso(now - 2 * 3600_000),
    startedAt: null,
    finishedAt: null,
    reviews: [],
    feedback: [],
    notifications: [],
    error: '',
    ...extra,
  };
}

let slotCount = 0;
function fixtureSlot(kind, start, end, { flow = '', hosts = [], status = 'published', extra = {} } = {}) {
  slotCount += 1;
  return {
    id: `fixture-${kind}-${slotCount}`,
    fixture: true,
    kind,
    start: iso(start),
    end: iso(end),
    status,
    assigneeEmail: flow ? email(flow) : '',
    assigneeName: nameOf(flow),
    hostNames: hosts,
    hostName: hosts.join(', '),
    createdBy: 'fixture-seed',
    updatedAt: iso(now),
    publishedAt: status === 'published' ? iso(now) : null,
    notified: flow && status === 'published' ? { assigneeEmail: email(flow), start: iso(start), end: iso(end) } : null,
    preloadedAt: null,
    reminderSentAt: null,
    overriddenBy: null,
    ...extra,
  };
}

function seededState() {
  const approvedReview = (flow) => ({ attempt: 1, expName: `x-fixture-${flow}`, decision: 'approve', reasons: [], notes: 'fixture', reviewer: 'fixture-seed', at: iso(now - 30 * MIN) });
  const approved = (flow, status, extra = {}) => fixtureJob(flow, status, { approvedExpName: `x-fixture-${flow}`, reviews: [approvedReview(flow)], ...extra });
  const jobs = [
    fixtureJob('uploading', 'uploading', { createdAt: iso(now - 20 * MIN) }),
    fixtureJob('queued', 'queued'),
    fixtureJob('retrain', 'queued', {
      attempt: 2,
      expName: 'x-fixture-retrain-2',
      attempts: [trainedAttempt(1, 'x-fixture-retrain')],
      reviews: [{ attempt: 1, expName: 'x-fixture-retrain', decision: 'reject', reasons: ['robotic'], notes: 'fixture: flat rhythm', reviewer: 'fixture-seed', at: iso(now - 40 * MIN) }],
    }),
    fixtureJob('qc', 'review'),
    fixtureJob('failed', 'failed', { attempts: [trainedAttempt(1, 'x-fixture-failed', 'failed')], error: 'fixture: the training run was lost' }),
    approved('approved', 'approved'),
    approved('testslot', 'scheduled'),
    approved('testingnow', 'scheduled'),
    approved('feedback', 'scheduled', {
      testingClosedAt: iso(now - 15 * MIN),
      feedback: [{ email: email('feedback'), rating: 3, likeness: 'mostly', issues: ['wrong-words', 'pace'], words: 'cohesin, apoptosis', comment: 'Close, but a bit fast on long sentences.', at: iso(now - 15 * MIN) }],
    }),
  ];
  // Recording "now" lasts until the end of today (at most 8 h, the slot limit).
  const recordingEnd = Math.min(now + 8 * 60 * MIN, Math.max(now + 60 * MIN, at(0, 23, 30)));
  // Staff availability tomorrow: Teng Yu and Adam both free 15-16. At 13-14 Teng Yu
  // booked the "booked" dummy first, so Adam's overlapping free hour is overridden.
  const booking = fixtureSlot('recording', at(1, 13), at(1, 14), { flow: 'booked', hosts: ['Teng Yu'] });
  const slots = [
    booking,
    fixtureSlot('recording', at(1, 13), at(1, 14), {
      hosts: ['Adam'],
      extra: { overriddenBy: { slotId: booking.id, start: booking.start, end: booking.end, assigneeName: booking.assigneeName, hostNames: ['Teng Yu'], at: iso(now), notifiedAt: iso(now) } },
    }),
    fixtureSlot('recording', at(1, 15), at(1, 16), { hosts: ['Teng Yu'] }),
    fixtureSlot('recording', at(1, 15), at(1, 16), { hosts: ['Adam'] }),
    fixtureSlot('recording', at(2, 10), at(2, 11), { flow: 'draft', hosts: ['Adam'], status: 'draft' }),
    fixtureSlot('recording', now - 5 * MIN, recordingEnd, { flow: 'recording', hosts: ['Teng Yu'] }),
    // Test slots (fixtures never warm a GPU).
    fixtureSlot('test', at(1, 15), at(1, 15, 20), { flow: 'testslot' }),
    fixtureSlot('test', now - 5 * MIN, now + 15 * MIN, { flow: 'testingnow' }),
  ];
  return { jobs, slots };
}

const store = createS3StateStore({ env });
const accountStore = createS3StateStore({ env, key: ACCOUNTS_KEY, normalize: normalizeAccounts });

// Old password accounts for dummies cannot sign in any more (Google-only): delete them.
await updateState(accountStore, (accounts) => {
  accounts.accounts = accounts.accounts.filter((account) => !isFixtureEmail(account.email));
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

console.log(`${remove ? 'Removed' : 'Seeded'} Voice Studio dummies on ${envName}: `
  + `${state.jobs.filter((job) => job.fixture).length} jobs, ${state.slots.filter((slot) => slot.fixture).length} slots.`);
if (!remove) for (const [flow, name] of PEOPLE) console.log(`  ${email(flow).padEnd(34)} ${name}`);
