import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, createStudioService } from './index.js';
import { generateKeyPairSync } from 'node:crypto';
import { createMemoryStore } from './store.js';
import { normalizeAccounts } from './accounts.js';
import { createLiveAuthGuard } from '../shared/liveAuth.js';

const SESSION_KEYS = (() => {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { STUDIO_SESSION_PRIVATE_KEY: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') };
})();

const T0 = Date.parse('2026-11-20T01:00:00Z');
const MIN = 60_000;

function harness({ realAuth = false } = {}) {
  let now = T0;
  let ids = 0;
  const sent = [];
  const trained = new Set();
  let worker = { status: 'idle', expName: '' };
  const started = [];
  const preloaded = [];
  const store = createMemoryStore();
  const env = {
    STUDIO_SUPERUSERS: 'boss@ntu.edu.sg', STUDIO_PUBLIC_URL: 'https://studio.example', ...SESSION_KEYS,
    LIVE_AUTH_ENABLED: 'true', ENTRA_TENANT_ID: 'tenant', ENTRA_AUDIENCE: 'aud',
  };
  const service = createStudioService({
    store,
    accountStore: createMemoryStore(null, normalizeAccounts),
    env,
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
    preloadVoice: async (name) => { preloaded.push(name); },
  });
  const handler = createHandler({
    service,
    authGuard: realAuth
      ? createLiveAuthGuard({ env, forceStudio: true, studioVerifier: { verify: async () => { throw new Error('not a Microsoft token'); } } })
      : { authorize: async (event) => ({ email: event.headers['x-user'], synthetic: false, passwordAccount: event.headers['x-password'] === '1' }) },
  });
  const call = async (user, method, path, body, extraHeaders = {}) => {
    const res = await handler({
      rawPath: `/api/studio/${path}`,
      requestContext: { http: { method } },
      headers: { 'x-user': user, ...extraHeaders },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  return {
    call, sent, started, store, trained, preloaded,
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

  // Recording sessions: super user publishes open sessions; lecturers sign in and pick one.
  const carol = 'carol@ntu.edu.sg';
  const at0 = (m) => new Date(T0 + m * MIN).toISOString();
  assert.equal((await h.call(carol, 'POST', 'submissions', { label: 'x', consent: { accepted: true, version: 'v' } })).status, 403, 'no session, no recording');
  for (let i = 0; i < 2; i += 1) {
    assert.equal((await h.call(boss, 'POST', 'admin/slots', { kind: 'recording', start: at0(-5), end: at0(100) })).status, 200);
  }
  const sessions = (await h.call(boss, 'POST', 'admin/slots/publish', {})).body.slots;
  assert.equal((await h.call(alice, 'POST', `slots/${sessions[0].id}/claim`, {})).status, 400, 'name required');
  const claimed = await h.call(alice, 'POST', `slots/${sessions[0].id}/claim`, { name: 'Alice' });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.recording.allowed, true);
  assert.equal((await h.call(bob, 'POST', `slots/${sessions[0].id}/claim`, { name: 'Bob' })).status, 409, 'one person per session');
  assert.equal((await h.call(bob, 'POST', `slots/${sessions[1].id}/claim`, { name: 'Bob' })).status, 200);
  assert.ok(h.sent.some((m) => m.to.includes(alice) && /recording session/u.test(m.subject)));

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

  // Approve -> lecturer emailed. Super user allocates GPU test slots (no overlaps) and publishes.
  assert.equal((await h.call(boss, 'POST', `admin/jobs/${a1}/review`, { decision: 'approve' })).status, 200);
  assert.ok(h.sent.some((m) => m.to.includes(alice) && /passed quality control/u.test(m.subject)));
  assert.equal((await h.call(boss, 'POST', `admin/jobs/${b1}/review`, { decision: 'approve' })).status, 200);
  const at = (m) => new Date(T0 + m * MIN).toISOString();
  assert.equal((await h.call(boss, 'POST', 'admin/slots', { kind: 'test', start: at(300), end: at(360) })).status, 400, 'test slot needs a person');
  const added = await h.call(boss, 'POST', 'admin/slots', { kind: 'test', start: at(300), end: at(360), assigneeEmail: alice, assigneeName: 'Alice' });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const clash = await h.call(boss, 'POST', 'admin/slots', { kind: 'test', start: at(330), end: at(400), assigneeEmail: bob });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.code, 'SLOT_CLASH');
  assert.equal((await h.call(bob, 'GET', 'me')).body.mySlot, null, 'drafts are invisible to lecturers');
  const published = await h.call(boss, 'POST', 'admin/slots/publish', {});
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.deepEqual(published.body.published.map((p) => [p.email, p.kind]), [[alice, 'slotBooked']]);
  // Editing Alice's test slot keeps it a draft until published again; republishing emails the change.
  const aliceSlot = published.body.slots.find((slot) => slot.assigneeEmail === alice && slot.kind === 'test');
  assert.equal((await h.call(boss, 'PUT', `admin/slots/${aliceSlot.id}`, { start: at(290), end: at(360) })).status, 200);
  const republished = await h.call(boss, 'POST', 'admin/slots/publish', {});
  assert.ok(republished.body.published.some((p) => p.email === alice && p.kind === 'slotBooked'));
  // Recording is closed again once the session is over.
  assert.equal((await h.call(bob, 'GET', 'me')).body.recording.allowed, false);

  // Alice's voice is visible but not usable before her slot.
  const voice = retry.expName;
  assert.equal((await h.call(alice, 'GET', `voices/${voice}/access`)).body.reason, 'too-early');
  assert.equal((await h.call(bob, 'GET', `voices/${voice}/access`)).status, 404);
  h.advance(290 - 124 - 10); // 10 min before Alice's slot: GPU wanted, her voice preloaded
  await h.call(boss, 'POST', 'admin/tick');
  assert.deepEqual(h.preloaded, [voice]);
  assert.ok(h.sent.some((m) => m.to.includes(alice) && /starts soon/u.test(m.subject)), 'reminder as the GPU warms');
  h.advance(11);
  // Super user is locked out of testing while Alice's slot runs.
  assert.equal((await h.call(boss, 'GET', `voices/${voice}/access`)).body.reason, 'slot-in-use');
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

test('email + password accounts: register, sign in, use the studio, never a super user', async () => {
  const h = harness({ realAuth: true });
  const anon = (path, body) => h.call('', 'POST', path, body);
  assert.equal((await anon('auth/register', { email: 'x@ntu.edu.sg', password: 'longenough', name: 'X' })).status, 400, 'NTU uses Microsoft');
  assert.equal((await anon('auth/register', { email: 'boss@ntu.edu.sg', password: 'longenough', name: 'B' })).status, 400);
  assert.equal((await anon('auth/register', { email: 'dee@gmail.com', password: 'short', name: 'Dee' })).status, 400, 'password length');
  const registered = await anon('auth/register', { email: 'Dee@Gmail.com', password: 'longenough', name: 'Dee' });
  assert.equal(registered.status, 200, JSON.stringify(registered.body));
  assert.equal((await anon('auth/register', { email: 'dee@gmail.com', password: 'longenough2', name: 'Dee' })).status, 409, 'one account per address');
  assert.equal((await anon('auth/login', { email: 'dee@gmail.com', password: 'wrong-password' })).status, 401);
  assert.equal((await anon('auth/login', { email: 'nobody@gmail.com', password: 'whatever1' })).status, 401);
  const login = await anon('auth/login', { email: 'dee@gmail.com', password: 'longenough' });
  assert.equal(login.status, 200);
  const auth = { 'x-vcs-entra-token': login.body.token };
  const me = await h.call('', 'GET', 'me', undefined, auth);
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.equal(me.body.email, 'dee@gmail.com');
  assert.equal(me.body.role, 'lecturer');
  assert.equal(me.body.account, 'password');
  assert.equal((await h.call('', 'GET', 'admin/overview', undefined, auth)).status, 403);
  assert.equal((await h.call('', 'GET', 'me', undefined, { 'x-vcs-entra-token': `${login.body.token}x` })).status, 401);
});

test('a password identity is never a super user, even with a super user address', async () => {
  const h = harness();
  assert.equal((await h.call('boss@ntu.edu.sg', 'GET', 'me')).body.role, 'superuser');
  assert.equal((await h.call('boss@ntu.edu.sg', 'GET', 'me', undefined, { 'x-password': '1' })).body.role, 'lecturer');
  assert.equal((await h.call('boss@ntu.edu.sg', 'GET', 'admin/overview', undefined, { 'x-password': '1' })).status, 403);
});

test('super users record without the lecturer consent; lecturers still need it', async () => {
  const h = harness();
  const created = await h.call('boss@ntu.edu.sg', 'POST', 'submissions', { label: 'Reference' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
});

test('a lecturer holds one recording session and can change it, not add another', async () => {
  const h = harness();
  const boss = 'boss@ntu.edu.sg';
  const at0 = (m) => new Date(T0 + m * MIN).toISOString();
  for (const start of [60, 180, 300]) {
    assert.equal((await h.call(boss, 'POST', 'admin/slots', { kind: 'recording', start: at0(start), end: at0(start + 60) })).status, 200);
  }
  const sessions = (await h.call(boss, 'POST', 'admin/slots/publish', {})).body.slots;
  const [s1, s2, s3] = sessions.map((slot) => slot.id);
  assert.equal((await h.call('amy@gmail.com', 'POST', `slots/${s1}/claim`, { name: 'Amy' })).status, 200);
  assert.equal((await h.call('amy@gmail.com', 'POST', `slots/${s2}/claim`, { name: 'Amy' })).status, 409, 'no second booking');
  const moved = await h.call('amy@gmail.com', 'POST', `slots/${s3}/move`, {});
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const mine = moved.body.sessions.filter((slot) => slot.mine).map((slot) => slot.id);
  assert.deepEqual(mine, [s3]);
  assert.equal(moved.body.sessions.find((slot) => slot.id === s1).open, true, 'old session is free again');
  // The console sees the booking with the person's name.
  const admin = (await h.call(boss, 'GET', 'admin/overview')).body;
  assert.equal(admin.slots.find((slot) => slot.id === s3).assigneeName, 'Amy');
  // Once it has started it cannot be changed.
  h.advance(301);
  assert.equal((await h.call('amy@gmail.com', 'POST', `slots/${s2}/move`, {})).status, 409);
});

test('feedback keeps the structured answers', async () => {
  const h = harness();
  const { updateState } = await import('./store.js');
  await updateState(h.store, (state) => {
    state.jobs.push({ id: 'j1', ownerEmail: 'amy@gmail.com', status: 'approved', approvedExpName: 'x-amy-1', expName: 'x-amy-1', sourceExpName: 'x-amy-1', attempts: [], trainingConfig: {}, notifications: [], feedback: [], reviews: [], files: [] });
    return null;
  });
  const saved = await h.call('amy@gmail.com', 'POST', 'submissions/j1/feedback', {
    rating: 3, likeness: 'mostly', issues: ['wrong-words', 'bogus'], words: 'cohesin, apoptosis', comment: 'A bit fast',
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const entry = h.store.snapshot().jobs[0].feedback[0];
  assert.deepEqual([entry.likeness, entry.issues, entry.words, entry.comment], ['mostly', ['wrong-words'], 'cohesin, apoptosis', 'A bit fast']);
});
