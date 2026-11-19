import assert from 'node:assert/strict';
import test from 'node:test';
import { gateBootWarm, pendingWorkerMatchesBoot } from './index.js';

const now = 1_000_000_000;
// The current staging AMI reports no residencySource; its own warm synthesis
// already sets the model key, so READY+modelKey alone does not mean "warmed".
const booted = {
  instanceId: 'i-new', reachable: true, state: 'READY', modelKey: 'dean',
  firstSeenAt: now - 9 * 60_000, firstReachableAt: now - 5 * 60_000, active: 2, queued: 0,
};

test('a booted GPU still running its warm script is not routable or boot-complete', () => {
  const gated = gateBootWarm(booted, now);
  assert.equal(gated.state, 'STARTING');
  assert.equal(gated.bootWarming, true);
  assert.equal(gated.bootRegistered, false);
  assert.equal(pendingWorkerMatchesBoot({ requestedAt: now - 10 * 60_000, claimedBy: 'i-new' }, gated, 'dean'), false);
});

test('the Target Optimizer port opening releases it on the current AMI', () => {
  const ready = gateBootWarm({ ...booted, active: 0, warmPortOpen: true }, now);
  assert.equal(ready.state, 'READY');
  assert.equal(ready.bootRegistered, true);
  assert.equal('warmPortOpen' in ready, false);
});

test('registration releases newer workers and stays remembered after real traffic', () => {
  const registered = gateBootWarm({ ...booted, residencySource: 'coordinator' }, now);
  assert.equal(registered.state, 'READY');
  const later = gateBootWarm({ ...registered, residencySource: 'synthesis' }, now + 60_000);
  assert.equal(later.state, 'READY');
  assert.equal(later.bootWarming, false);
});

test('the grace counts from the first answer, not from instance launch', () => {
  // 16 min since launch but only 5 since the worker answered: still warming.
  assert.equal(gateBootWarm({ ...booted, firstSeenAt: now - 16 * 60_000 }, now).state, 'STARTING');
  const stale = gateBootWarm({ ...booted, firstReachableAt: now - 16 * 60_000 }, now);
  assert.equal(stale.state, 'READY');
  assert.equal(stale.bootRegistered, true);
});

test('routing-only (Dev fixed GPUs) and unreachable workers are not gated', () => {
  assert.equal(gateBootWarm(booted, now, { enabled: false }).state, 'READY');
  const down = gateBootWarm({ ...booted, reachable: false, state: 'STARTING', firstReachableAt: 0 }, now);
  assert.equal(down.bootWarming, false);
  assert.equal(down.state, 'STARTING');
});

test('desired is raised to the live GPUs so AWS cannot remove one in use, within max and not right after a scale-in', async () => {
  const { reconciledDesired } = await import('./index.js');
  const now = 50_000_000;
  const live = [{ reachable: true, state: 'READY' }];
  // 18:42 SGT incident: desired 0, one GPU serving a conversation.
  assert.equal(reconciledDesired({ group: { DesiredCapacity: 0, MaxSize: 3 }, workers: live, now }), 1);
  assert.equal(reconciledDesired({ group: { DesiredCapacity: 1, MaxSize: 3 }, workers: live, now }), null);
  // max 0 = deliberate shutdown: never raised.
  assert.equal(reconciledDesired({ group: { DesiredCapacity: 0, MaxSize: 0 }, workers: live, now }), null);
  // The coordinator's own scale-in just lowered desired: leave it.
  assert.equal(reconciledDesired({ group: { DesiredCapacity: 0, MaxSize: 3 }, workers: live, now, lastScaleInAt: now - 60_000 }), null);
  // Unreachable/draining GPUs do not count.
  assert.equal(reconciledDesired({ group: { DesiredCapacity: 0, MaxSize: 3 }, workers: [{ reachable: false }, { state: 'DRAINING' }], now }), null);
});
