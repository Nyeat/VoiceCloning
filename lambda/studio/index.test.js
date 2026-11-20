import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, createStudioService } from './index.js';
import { createMemoryStore } from './store.js';

const T0 = Date.parse('2026-11-20T01:00:00Z');
const MIN = 60_000;

function harness() {
  let now = T0;
  let ids = 0;
  const sent = [];
  const trained = new Set();
  let worker = { status: 'idle', expName: '' };
  const started = [];
  const store = createMemoryStore();
  const service = createStudioService({
    store,
    env: { STUDIO_SUPERUSERS: 'boss@ntu.edu.sg', STUDIO_PUBLIC_URL: 'https://studio.example' },
    clock: () => now,
    newId: () => `id${(ids += 1)}`,
    mailer: { send: async (to, message) => { sent.push({ to: [].concat(to), subject: message.subject }); return { status: 'sent' }; } },
    listVoices: async () => [...trained],
    modelsFor: async (name) => (trained.has(name) ? { gptKey: 'g', sovitsKey: 's' } : null),
    readWorker: async () => worker,
    startTraining: async (body) => { started.push(body); worker = { status: 'running', expName: body.expName }; return { sessionId: 'sess' }; },
    startGpu: async () => ({ started: true }),
    presign: async (key) => ({ url: `https://s3/${key}` }),
    head: async () => ({ size: 1000 }),
    readJson: async () => null,
    writeJson: async () => {},
    applyPronunciation: async () => ({ ready: true }),
  });
  const handler = createHandler({
    service,
    authGuard: { authorize: async (event) => ({ email: event.headers['x-user'], synthetic: false }) },
  });
  const call = async (user, method, path, body) => {
    const res = await handler({
      rawPath: `/api/studio/${path}`,
      requestContext: { http: { method } },
      headers: { 'x-user': user },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  return {
    call, sent, started, store, trained,
    advance: (minutes) => { now += minutes * MIN; },
    finishWorker: (expName, status = 'complete') => { worker = { status, expName }; if (status === 'complete') trained.add(expName); },
  };
}

async function submit(h, user, label) {
  const created = await h.call(user, 'POST', 'submissions', { label, consent: { accepted: true, version: 'test-1' } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.jobId;
  const presigned = await h.call(user, 'POST', `submissions/${id}/presign`, { files: [{ name: 'take 1.wav', type: 'audio/wav' }] });
  assert.equal(presigned.status, 200, JSON.stringify(presigned.body));
  const submitted = await h.call(user, 'POST', `submissions/${id}/submit`, { keys: presigned.body.uploads.map((u) => u.key) });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  return id;
}

test('full workflow: queue, train, review, retrain, approve, book, test, feedback', async () => {
  const h = harness();
  const alice = 'alice@ntu.edu.sg';
  const bob = 'bob@ntu.edu.sg';
  const boss = 'boss@ntu.edu.sg';

  const a1 = await submit(h, alice, 'Lecture voice');
  assert.equal(h.started.length, 1, 'first job dispatched straight away');
  assert.equal(h.started[0].config.headless, true);
  assert.equal(h.started[0].config.notifyOwner, false);
  assert.ok(h.sent.some((m) => m.to.includes(alice) && /received your recordings/u.test(m.subject)), 'receipt with ETA');
  assert.equal((await h.call(bob, 'POST', 'submissions', { label: 'x' })).status, 400, 'consent is required');
  const b1 = await submit(h, bob, 'Bob');
  const a2 = await submit(h, alice, 'Second');

  // Alice's second set runs before Bob even though Bob queued first.
  const overview = await h.call(boss, 'GET', 'admin/overview');
  assert.deepEqual(overview.body.queue, [a2, b1]);
  const me = await h.call(bob, 'GET', 'me');
  assert.equal(me.body.role, 'lecturer');
  assert.equal(me.body.jobs.length, 1, 'bob sees only his own job');
  assert.ok(me.body.jobs[0].estimate.finishAt);

  // Lecturers cannot use admin routes.
  assert.equal((await h.call(alice, 'GET', 'admin/overview')).status, 403);

  // Training finishes -> review, super users emailed, next job dispatched.
  h.advance(31);
  h.finishWorker('alice');
  const tick = await h.call(boss, 'POST', 'admin/tick');
  assert.equal(tick.status, 200);
  const job1 = tick.body.jobs.find((j) => j.id === a1);
  assert.equal(job1.status, 'review');
  assert.ok(h.sent.some((m) => m.to.includes(boss) && /ready for review/u.test(m.subject)));
  assert.equal(h.started.at(-1).expName, 'alice_2', 'alice\'s second set next');

  // Reject -> new voice name trained from the same recordings, queued at the back.
  const rejected = await h.call(boss, 'POST', `admin/jobs/${a1}/review`, { decision: 'reject', reasons: ['not-their-voice'] });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  const retry = rejected.body.jobs.find((j) => j.id === a1);
  assert.equal(retry.status, 'queued');
  assert.equal(retry.sourceExpName, 'alice');
  assert.notEqual(retry.expName, 'alice');
  assert.equal(retry.trainingConfig.sovitsEpochs, 12);

  // Finish the remaining runs in order.
  for (let i = 0; i < 3; i += 1) {
    h.advance(31);
    h.finishWorker(h.started.at(-1).expName);
    await h.call(boss, 'POST', 'admin/tick');
  }
  const after = (await h.call(boss, 'GET', 'admin/overview')).body;
  assert.equal(after.jobs.find((j) => j.id === a1).status, 'review');
  assert.equal(h.started.find((s) => s.expName === retry.expName).config.sourceExpName, 'alice');

  // Approve and book; a clashing slot is refused.
  assert.equal((await h.call(boss, 'POST', `admin/jobs/${a1}/review`, { decision: 'approve' })).status, 200);
  assert.equal((await h.call(boss, 'POST', `admin/jobs/${b1}/review`, { decision: 'approve' })).status, 200);
  const at = (m) => new Date(T0 + m * MIN).toISOString();
  const booked = await h.call(boss, 'POST', `admin/jobs/${a1}/slot`, { start: at(300), end: at(360) });
  assert.equal(booked.status, 200, JSON.stringify(booked.body));
  assert.ok(h.sent.some((m) => m.to.includes(alice) && /ready to test/u.test(m.subject)));
  const clash = await h.call(boss, 'POST', `admin/jobs/${b1}/slot`, { start: at(330), end: at(400) });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.code, 'SLOT_CLASH');

  // Alice's voice is visible but not usable before her slot.
  const voice = retry.expName;
  assert.equal((await h.call(alice, 'GET', `voices/${voice}/access`)).body.reason, 'too-early');
  assert.equal((await h.call(bob, 'GET', `voices/${voice}/access`)).status, 404);
  h.advance(300 - 124 + 1);
  assert.equal((await h.call(alice, 'GET', `voices/${voice}/access`)).body.allowed, true);
  assert.equal((await h.call(alice, 'POST', `voices/${voice}/pronunciations`, { word: 'cohesin', soundsLike: 'koh hee sin' })).status, 200);
  assert.equal((await h.call(alice, 'POST', `voices/${voice}/pronunciations/apply`, {})).status, 200);

  // Feedback is stored and visible to super users.
  assert.equal((await h.call(alice, 'POST', `submissions/${a1}/feedback`, { rating: 4, comment: 'Close!' })).status, 200);
  const final = (await h.call(boss, 'GET', 'admin/overview')).body;
  assert.equal(final.jobs.find((j) => j.id === a1).feedback[0].comment, 'Close!');
});

test('super users can be added, renamed and removed by super users only', async () => {
  const h = harness();
  const boss = 'boss@ntu.edu.sg';
  assert.equal((await h.call('x@ntu.edu.sg', 'POST', 'admin/superusers', { email: 'y@ntu.edu.sg' })).status, 403);
  const added = await h.call(boss, 'POST', 'admin/superusers', { email: 'new@ntu.edu.sg', name: 'New' });
  assert.equal(added.status, 200);
  assert.equal((await h.call('new@ntu.edu.sg', 'GET', 'me')).body.role, 'superuser');
  assert.equal((await h.call('new@ntu.edu.sg', 'PUT', 'admin/superusers/new%40ntu.edu.sg', { name: 'Renamed' })).status, 200);
  assert.equal((await h.call('new@ntu.edu.sg', 'DELETE', 'admin/superusers/boss%40ntu.edu.sg', {})).status, 409);
  assert.equal((await h.call(boss, 'DELETE', 'admin/superusers/new%40ntu.edu.sg', {})).status, 200);
  assert.equal((await h.call('new@ntu.edu.sg', 'GET', 'me')).body.role, 'lecturer');
});

test('worker refusing a dispatch leaves the job queued', async () => {
  const h = harness();
  const store = createMemoryStore();
  const service = createStudioService({
    store, env: {}, clock: () => T0, newId: () => 'j',
    mailer: { send: async () => ({ status: 'skipped' }) },
    listVoices: async () => [], modelsFor: async () => null,
    readWorker: async () => ({ status: 'idle' }),
    startTraining: async () => { throw new Error('busy'); },
    startGpu: async () => ({}),
  });
  await (await import('./store.js')).updateState(store, (state) => {
    state.jobs.push({ id: 'j', ownerEmail: 'a@ntu.edu.sg', status: 'queued', queuedAt: new Date(T0).toISOString(), expName: 'a', sourceExpName: 'a', attempts: [], trainingConfig: {}, notifications: [], feedback: [], reviews: [] });
    return null;
  });
  await service.tick({ force: true });
  const job = store.snapshot().jobs[0];
  assert.equal(job.status, 'queued');
  assert.match(job.error, /busy/u);
  assert.ok(h);
});
