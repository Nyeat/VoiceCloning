import assert from 'node:assert/strict';
import test from 'node:test';
import { gateBootWarm, pendingWorkerMatchesBoot } from './index.js';

const now = 1_000_000_000;
const booted = {
  instanceId: 'i-new', reachable: true, state: 'READY', modelKey: 'dean',
  residencySource: 'synthesis', firstSeenAt: now - 5 * 60_000, active: 0, queued: 0,
};

test('a booted GPU whose warm script has not registered is not routable yet', () => {
  const gated = gateBootWarm(booted, now);
  assert.equal(gated.state, 'STARTING');
  assert.equal(gated.bootWarming, true);
  assert.equal(gated.bootRegistered, false);
  // The pending boot must not complete onto it either.
  assert.equal(pendingWorkerMatchesBoot({ requestedAt: now - 10 * 60_000, claimedBy: 'i-new' }, gated, 'dean'), false);
});

test('registration makes it READY and is remembered after real traffic', () => {
  const registered = gateBootWarm({ ...booted, residencySource: 'coordinator' }, now);
  assert.equal(registered.state, 'READY');
  assert.equal(registered.bootRegistered, true);
  // Real synthesis later rewrites residencySource; the persisted flag keeps it routable.
  const later = gateBootWarm({ ...registered, residencySource: 'synthesis' }, now + 60_000);
  assert.equal(later.state, 'READY');
  assert.equal(later.bootWarming, false);
});

test('a GPU whose warm script never registered becomes routable after the grace', () => {
  const stale = gateBootWarm({ ...booted, firstSeenAt: now - 16 * 60_000 }, now);
  assert.equal(stale.state, 'READY');
  assert.equal(stale.bootWarming, false);
});

test('routing-only (Dev fixed GPUs) and unreachable workers are not gated', () => {
  assert.equal(gateBootWarm(booted, now, { enabled: false }).state, 'READY');
  const down = gateBootWarm({ ...booted, reachable: false, state: 'STARTING' }, now);
  assert.equal(down.bootWarming, false);
  assert.equal(down.state, 'STARTING');
});
