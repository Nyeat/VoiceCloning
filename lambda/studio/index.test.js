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

function harness({ realAuth = false, googleVerifier = null } = {}) {
  let now = T0;
  let ids = 0;
  const sent = [];
  const trained = new Set();
  let worker = { status: 'idle', expName: '' };
  const started = [];
  const preloaded = [];
  const released = [];
  const preloadedOwners = [];
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
    preloadVoice: async (name, ownerKey) => { preloaded.push(name); preloadedOwners.push(ownerKey); },
    releaseSlotGpu: async (ownerKey) => { released.push(ownerKey); },
  });
  const handler = createHandler({
    service,
    googleVerifier,
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
    call, sent, started, store, trained, preloaded, preloadedOwners, released,
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

  // Recording sessions: a super user books each person's time (agreed in person); lecturers never book.
  const carol = 'carol@ntu.edu.sg';
  const at0 = (m) => new Date(T0 + m * MIN).toISOString();
  assert.equal((await h.call(carol, 'GET', 'me')).body.recording.reason, 'open', 'anyone not yet submitted may record without a session');
  // The person is optional (owner 2026-11-23: a blank session is free), but a given email must look like one.
  assert.equal((await h.call(boss, 'POST', 'admin/slots', { kind: 'recording', start: at0(-5), end: at0(100), assigneeEmail: 'asd' })).status, 400, 'bad email refused');
  for (const [email, name] of [[alice, 'Alice'], [bob, 'Bob']]) {
    assert.equal((await h.call(boss, 'POST', 'admin/slots', { kind: 'recording', start: at0(-5), end: at0(100), assigneeEmail: email, assigneeName: name })).status, 200);
  }
  await h.call(boss, 'POST', 'admin/slots/publish', {});
  assert.equal((await h.call(alice, 'GET', 'me')).body.recording.allowed, true);
  assert.equal((await h.call(alice, 'POST', 'slots/x/claim', { name: 'Alice' })).status, 404, 'lecturers cannot book');
  assert.ok(h.sent.some((m) => m.to.includes(alice) && /recording session/u.test(m.subject)));

  const a1 = await submit(h, alice, 'Lecture voice');
  assert.equal(h.started.length, 1, 'first job dispatched straight away');
  assert.equal(h.started[0].config.headless, true);
  assert.equal(h.started[0].config.notifyOwner, false);
  assert.ok(h.sent.some((m) => m.to.includes(alice) && /received your recordings/u.test(m.subject)), 'receipt with ETA');
  assert.equal((await h.call(bob, 'POST', 'submissions', { label: 'x' })).status, 400, 'consent is required');
  const b1 = await submit(h, bob, 'Bob');
  // One submission per person: Alice cannot send a second set while hers is in.
  const second = await h.call(alice, 'POST', 'submissions', { label: 'Second', consent: { accepted: true, version: 'test-1' } });
  assert.equal(second.status, 409);

  const overview = await h.call(boss, 'GET', 'admin/overview');
  assert.deepEqual(overview.body.queue, [b1]);
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
  assert.equal(h.started.at(-1).email, bob, 'bob\'s set next');
  assert.ok(h.sent.some((m) => m.to.includes(alice) && /quality control/u.test(m.subject)), 'lecturer told it is in QC');

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

  // Approve -> lecturer emailed. Super user books ONE test time for both (one GPU each) and publishes.
  assert.equal((await h.call(boss, 'POST', `admin/jobs/${a1}/review`, { decision: 'approve' })).status, 200);
  assert.ok(h.sent.some((m) => m.to.includes(alice) && /passed quality control/u.test(m.subject)));
  assert.equal((await h.call(boss, 'POST', `admin/jobs/${b1}/review`, { decision: 'approve' })).status, 200);
  const at = (m) => new Date(T0 + m * MIN).toISOString();
  assert.equal((await h.call(boss, 'POST', 'admin/slots', { kind: 'test', start: at(300), end: at(320) })).status, 400, 'test slot needs a person');
  const added = await h.call(boss, 'POST', 'admin/slots', {
    kind: 'test', start: at(300), end: at(320), assignees: [{ email: alice, name: 'Alice' }, { email: bob, name: 'Bob' }],
  });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.slots.filter((slot) => slot.kind === 'test').length, 2, 'one slot per person');
  const clash = await h.call(boss, 'POST', 'admin/slots', { kind: 'test', start: at(310), end: at(330), assigneeEmail: bob });
  assert.equal(clash.status, 409, 'bob cannot be in two slots at once');
  assert.equal(clash.body.code, 'SLOT_CLASH');
  assert.equal((await h.call(bob, 'GET', 'me')).body.mySlot, null, 'drafts are invisible to lecturers');
  const published = await h.call(boss, 'POST', 'admin/slots/publish', {});
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.deepEqual(published.body.published.map((p) => [p.email, p.kind]).sort(), [[alice, 'slotBooked'], [bob, 'slotBooked']]);
  // Editing Alice's test slot keeps it a draft until published again; republishing emails the change.
  const aliceSlot = published.body.slots.find((slot) => slot.assigneeEmail === alice && slot.kind === 'test');
  assert.equal((await h.call(boss, 'PUT', `admin/slots/${aliceSlot.id}`, { start: at(290), end: at(310) })).status, 200);
  const republished = await h.call(boss, 'POST', 'admin/slots/publish', {});
  assert.ok(republished.body.published.some((p) => p.email === alice && p.kind === 'slotBooked'));
  // Recording is closed again once the session is over.
  assert.equal((await h.call(bob, 'GET', 'me')).body.recording.allowed, false);

  // Before her slot Alice may already test (cold start on her own GPU).
  const voice = retry.expName;
  assert.equal((await h.call(alice, 'GET', `voices/${voice}/access`)).body.reason, 'on-demand');
  assert.equal((await h.call(bob, 'GET', `voices/${voice}/access`)).status, 404);
  h.advance(290 - 124 - 10); // 10 min before Alice's slot: her GPU warms with her voice
  await h.call(boss, 'POST', 'admin/tick');
  assert.deepEqual([...h.preloaded].sort(), [voice, 'bob'].sort(), 'Alice and Bob share the time: both GPUs warm');
  assert.equal(new Set(h.preloadedOwners).size, 2, 'one reserved GPU each');
  assert.ok(h.preloadedOwners.every((owner) => /^reserved:studio-p-/u.test(owner)));
  assert.ok(h.sent.some((m) => m.to.includes(alice) && /starts soon/u.test(m.subject)), 'reminder as the GPU warms');
  h.advance(11);
  assert.equal((await h.call(boss, 'GET', `voices/${voice}/access`)).body.allowed, true);
  assert.equal((await h.call(alice, 'GET', `voices/${voice}/access`)).body.reason, 'in-slot');
  assert.equal((await h.call(alice, 'POST', `voices/${voice}/pronunciations`, { word: 'cohesin', soundsLike: 'koh hee sin' })).status, 200);
  assert.equal((await h.call(alice, 'POST', `voices/${voice}/pronunciations/apply`, {})).status, 200);

  // Feedback ends her testing: stored for super users, her GPU released, testing closed.
  const fed = await h.call(alice, 'POST', `submissions/${a1}/feedback`, { rating: 4, comment: 'Close!' });
  assert.equal(fed.status, 200, JSON.stringify(fed.body));
  assert.equal(h.released.length, 1);
  assert.match(h.released[0], /^reserved:studio-p-/u);
  assert.ok(h.sent.some((m) => m.to.includes(boss) && /Feedback received/u.test(m.subject)));
  assert.equal((await h.call(alice, 'GET', `voices/${voice}/access`)).body.reason, 'tested');
  assert.equal((await h.call(alice, 'POST', `submissions/${a1}/feedback`, { rating: 5 })).status, 409, 'one feedback closes testing');
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

test('password sign-in is gone: its routes are closed and old password sessions must use Google', async () => {
  const h = harness({ realAuth: true });
  assert.equal((await h.call('', 'POST', 'auth/register', { email: 'dee@gmail.com', password: 'longenough', name: 'Dee' })).status, 401);
  assert.equal((await h.call('', 'POST', 'auth/login', { email: 'dee@gmail.com', password: 'longenough' })).status, 401);
  const { signStudioSession } = await import('../shared/studioSession.js');
  const old = signStudioSession({ email: 'dee@gmail.com', name: 'Dee' }, { env: SESSION_KEYS, now: Date.now() });
  const me = await h.call('', 'GET', 'me', undefined, { 'x-vcs-entra-token': old });
  assert.equal(me.status, 401);
  assert.match(me.body.error, /Google/u);
});

test('a password identity is never let in, even with a super user address', async () => {
  const h = harness();
  assert.equal((await h.call('boss@ntu.edu.sg', 'GET', 'me')).body.role, 'superuser');
  assert.equal((await h.call('boss@ntu.edu.sg', 'GET', 'me', undefined, { 'x-password': '1' })).status, 401);
  assert.equal((await h.call('boss@ntu.edu.sg', 'GET', 'admin/overview', undefined, { 'x-password': '1' })).status, 401);
});

test('super users record without the lecturer consent; lecturers still need it', async () => {
  const h = harness();
  const created = await h.call('boss@ntu.edu.sg', 'POST', 'submissions', { label: 'Reference' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
});

test('a recording session is booked for a named person; they see only their own', async () => {
  const h = harness();
  const boss = 'boss@ntu.edu.sg';
  const at0 = (m) => new Date(T0 + m * MIN).toISOString();
  assert.equal((await h.call(boss, 'POST', 'admin/slots', { kind: 'recording', start: at0(60), end: at0(120), assigneeEmail: 'amy@gmail.com', assigneeName: 'Amy' })).status, 200);
  assert.equal((await h.call(boss, 'POST', 'admin/slots', { kind: 'recording', start: at0(60), end: at0(120), assigneeEmail: 'ben@gmail.com', assigneeName: 'Ben' })).status, 200, 'parallel sessions for different people');
  const published = await h.call(boss, 'POST', 'admin/slots/publish', {});
  assert.deepEqual(published.body.published.map((p) => p.kind), ['recordingBooked', 'recordingBooked']);
  const amy = (await h.call('amy@gmail.com', 'GET', 'me')).body;
  assert.equal(amy.recording.reason, 'open', 'before her session she may already record on her own');
  assert.equal(amy.recording.slot.assigneeEmail, 'amy@gmail.com');
  assert.equal(amy.sessions, undefined, 'no booking table for lecturers');
  h.advance(61);
  assert.equal((await h.call('amy@gmail.com', 'GET', 'me')).body.recording.allowed, true);
  assert.equal((await h.call('cat@gmail.com', 'GET', 'me')).body.recording.reason, 'open', 'someone with no session may still record on their own');
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

test('Google sign-in: verified Gmail gets a session; bad token and NTU addresses do not', async () => {
  const googleVerifier = { verify: async (credential) => {
    if (credential === 'good') return { email: 'gee@gmail.com', name: 'Gee' };
    if (credential === 'ntu') return { email: 'someone@ntu.edu.sg', name: 'N' };
    const error = new Error('Google sign-in token is not valid.'); error.code = 'bad_signature'; throw error;
  } };
  const h = harness({ realAuth: true, googleVerifier });
  const signedIn = await h.call('', 'POST', 'auth/google', { credential: 'good' });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  assert.equal(signedIn.body.email, 'gee@gmail.com');
  const me = await h.call('', 'GET', 'me', undefined, { 'x-vcs-entra-token': signedIn.body.token });
  assert.equal(me.body.email, 'gee@gmail.com');
  assert.equal(me.body.role, 'lecturer');
  assert.equal(me.body.account, 'google');
  assert.equal((await h.call('', 'POST', 'auth/google', { credential: 'forged' })).status, 401);
  assert.equal((await h.call('', 'POST', 'auth/google', { credential: 'ntu' })).status, 400);
});

test('a Google-verified super user address is a super user', async () => {
  const googleVerifier = { verify: async () => ({ email: 'boss@gmail.com', name: 'Boss' }) };
  const h = harness({ realAuth: true, googleVerifier });
  const { store } = h;
  const { updateState } = await import('./store.js');
  await updateState(store, (state) => { state.superusers.push({ email: 'boss@gmail.com', name: 'Boss' }); return null; });
  const signedIn = await h.call('', 'POST', 'auth/google', { credential: 'good' });
  const me = await h.call('', 'GET', 'me', undefined, { 'x-vcs-entra-token': signedIn.body.token });
  assert.equal(me.body.role, 'superuser');
});

test('DELETE routes work with no body (CloudFront rejects a DELETE that has one)', async () => {
  const h = harness();
  const boss = 'boss@ntu.edu.sg';
  const at = (m) => new Date(T0 + m * MIN).toISOString();
  await h.call(boss, 'POST', 'admin/slots', { kind: 'recording', start: at(60), end: at(120), assigneeEmail: 'a@gmail.com', assigneeName: 'A' });
  const id = (await h.call(boss, 'POST', 'admin/slots/publish', {})).body.slots[0].id;
  const removed = await h.call(boss, 'DELETE', `admin/slots/${id}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.slots.length, 0);
  assert.ok(h.sent.some((m) => m.to.includes('a@gmail.com') && /cancelled/u.test(m.subject)));
  await h.call(boss, 'POST', 'admin/superusers', { email: 'two@ntu.edu.sg' });
  assert.equal((await h.call(boss, 'DELETE', 'admin/superusers/two%40ntu.edu.sg')).status, 200);
});

test('deleting or moving a test slot whose GPU is warming releases that GPU at once', async () => {
  const h = harness();
  const boss = 'boss@ntu.edu.sg';
  const { updateState } = await import('./store.js');
  await updateState(h.store, (state) => {
    state.jobs.push({ id: 'j1', ownerEmail: 'amy@gmail.com', status: 'approved', approvedExpName: 'x-amy-1', expName: 'x-amy-1', sourceExpName: 'x-amy-1', attempts: [], trainingConfig: {}, notifications: [], feedback: [], reviews: [{ at: new Date(T0).toISOString() }], files: [] });
    return null;
  });
  const at = (m) => new Date(T0 + m * MIN).toISOString();
  const refused = await h.call(boss, 'POST', 'admin/slots', { kind: 'test', start: at(30), end: at(50), assigneeEmail: 'nobody@gmail.com' });
  assert.equal(refused.status, 400, 'no test slot without an approved voice');
  assert.equal(refused.body.code, 'VOICE_NOT_APPROVED');
  await h.call(boss, 'POST', 'admin/slots', { kind: 'test', start: at(30), end: at(50), assigneeEmail: 'amy@gmail.com' });
  await h.call(boss, 'POST', 'admin/slots', { kind: 'test', start: at(130), end: at(150), assigneeEmail: 'amy@gmail.com' });
  const slots = (await h.call(boss, 'POST', 'admin/slots/publish', {})).body.slots;
  assert.equal((await h.call(boss, 'PUT', `admin/slots/${slots[0].id}`, { assigneeEmail: 'nobody@gmail.com' })).status, 400, 'nor handed to someone unapproved');
  // Amy chatting with her approved voice keeps the fixed GPU on; others cannot.
  assert.equal((await h.call('nobody@gmail.com', 'POST', 'voices/x-amy-1/activity')).status, 404, 'someone else\'s voice is not even visible');
  const activity = await h.call('amy@gmail.com', 'POST', 'voices/x-amy-1/activity');
  assert.equal(activity.status, 200, JSON.stringify(activity.body));
  assert.equal(activity.body.demand, 'testing');
  h.advance(15); // 15 min before the first slot: Amy's GPU warms
  await h.call(boss, 'POST', 'admin/tick');
  assert.equal(h.preloaded.length, 1);
  assert.equal(h.released.length, 0);
  // Moving it to later: the warming GPU is given back now.
  assert.equal((await h.call(boss, 'PUT', `admin/slots/${slots[0].id}`, { start: at(200), end: at(220) })).status, 200);
  assert.equal(h.released.length, 1);
  assert.match(h.released[0], /^reserved:studio-p-/u);
  // Deleting a slot that never warmed releases nothing.
  assert.equal((await h.call(boss, 'DELETE', `admin/slots/${slots[1].id}`)).status, 200);
  assert.equal(h.released.length, 1);
});

test('a super user can upload for someone: the voice is theirs to follow and test', async () => {
  const h = harness();
  const boss = 'boss@ntu.edu.sg';
  const lee = 'lee@gmail.com';
  assert.equal((await h.call('carol@gmail.com', 'POST', 'submissions', { label: 'x', forEmail: lee, consent: { accepted: true, version: 'v' } })).status, 403, 'only super users upload for others');
  const created = await h.call(boss, 'POST', 'submissions', { label: 'Lee voice', forEmail: 'Lee@Gmail.com', forName: 'Dr Lee' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.jobId;
  const presigned = await h.call(boss, 'POST', `submissions/${id}/presign`, { files: [{ name: 'a.wav', type: 'audio/wav' }] });
  assert.equal(presigned.status, 200, 'the uploader finishes the upload');
  const submitted = await h.call(boss, 'POST', `submissions/${id}/submit`, { keys: presigned.body.uploads.map((u) => u.key) });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const mine = submitted.body.jobs.find((job) => job.id === id);
  assert.equal(mine.forEmail, lee, 'the uploader sees who it is for');
  const theirs = (await h.call(lee, 'GET', 'me')).body.jobs;
  assert.equal(theirs.length, 1, 'the person sees it when they sign in');
  assert.ok(['queued', 'training'].includes(theirs[0].status), theirs[0].status);
  assert.ok(h.sent.some((m) => m.to.includes(lee)), 'and is emailed the receipt');
});

test('sessions and test slots that are over are not sent to the console', async () => {
  const h = harness();
  const boss = 'boss@ntu.edu.sg';
  const at = (m) => new Date(T0 + m * MIN).toISOString();
  await h.call(boss, 'POST', 'admin/slots', { kind: 'recording', start: at(10), end: at(70), assigneeEmail: 'r@gmail.com', assigneeName: 'R' });
  await h.call(boss, 'POST', 'admin/slots/publish', {});
  assert.equal((await h.call(boss, 'GET', 'admin/overview')).body.slots.length, 1, 'upcoming is shown');
  h.advance(30);
  assert.equal((await h.call(boss, 'GET', 'admin/overview')).body.slots.length, 1, 'running is shown');
  h.advance(45);
  assert.equal((await h.call(boss, 'GET', 'admin/overview')).body.slots.length, 0, 'over: gone');
});
