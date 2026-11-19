import assert from 'node:assert/strict';
import test from 'node:test';

import {
  voiceCapacityBlocksConversation,
  voiceCapacityNotice,
} from './voiceCapacity.js';

test('a missing model blocks conversation and gives the truthful fifteen-minute alternative', () => {
  const capacity = { state: 'STARTING', canStartConversation: false, retryAfterSeconds: 900 };
  assert.equal(voiceCapacityBlocksConversation(capacity), true);
  assert.match(voiceCapacityNotice(capacity), /Starting a GPU with this voice/i);
  assert.match(voiceCapacityNotice(capacity), /up to 15/i);
});

test('a busy resident model remains usable while background capacity starts', () => {
  const capacity = { state: 'BUSY_STARTING', canStartConversation: true };
  assert.equal(voiceCapacityBlocksConversation(capacity), false);
  assert.match(voiceCapacityNotice(capacity), /continue/i);
  assert.match(voiceCapacityNotice(capacity), /new GPU is starting in the background/i);
  assert.match(voiceCapacityNotice(capacity), /queued/i);
});

test('a ready voice shows no warning, even with one slot left', () => {
  const capacity = { state: 'READY', canStartConversation: true, capacityTight: true };
  assert.equal(voiceCapacityBlocksConversation(capacity), false);
  assert.equal(voiceCapacityNotice(capacity), '');
});

test('a switch says so and locks the chat until it finishes', () => {
  const capacity = { state: 'WARMING', canStartConversation: false };
  assert.equal(voiceCapacityBlocksConversation(capacity), true);
  assert.match(voiceCapacityNotice(capacity), /Switching a GPU to this voice/i);
});

test('a ready voice with background scale-out shows no warning', () => {
  const capacity = { state: 'READY_SCALING', canStartConversation: true };
  assert.equal(voiceCapacityBlocksConversation(capacity), false);
  assert.equal(voiceCapacityNotice(capacity), '');
});

test('selection-only preparation is usable without claiming that another GPU started', () => {
  const capacity = {
    state: 'ON_DEMAND',
    canStartConversation: true,
    message: 'Selecting this voice did not start another GPU.',
  };
  assert.equal(voiceCapacityBlocksConversation(capacity), false);
  assert.match(voiceCapacityNotice(capacity), /did not start another GPU/i);
});

test('Dev routing simulation never renders as a staging GPU limit', () => {
  const capacity = {
    state: 'SIMULATED',
    canStartConversation: true,
    simulated: true,
    message: 'Dev capacity simulation: staging would wait for real synthesis.',
  };
  assert.equal(voiceCapacityBlocksConversation(capacity), false);
  assert.match(voiceCapacityNotice(capacity), /Dev capacity simulation/i);
  assert.doesNotMatch(voiceCapacityNotice(capacity), /staging is at its GPU limit/i);
});

test('voice wait popup: same titles/timings everywhere, stable across polls, none when usable', async () => {
  const { voiceCapacityWait } = await import('./voiceCapacity.js');
  const starting = voiceCapacityWait({ state: 'STARTING' }, null, 'dean', 1_000);
  assert.equal(starting.title, 'Starting a GPU with this voice');
  assert.equal(starting.estimateSeconds, 600);
  assert.equal(starting.key, 'dean:STARTING:1000');
  // A later poll in the same phase keeps the key and start time.
  const again = voiceCapacityWait({ state: 'STARTING' }, starting, 'dean', 9_000);
  assert.equal(again.key, starting.key);
  assert.equal(again.startedAt, 1_000);
  // A new phase is a new wait.
  const switching = voiceCapacityWait({ state: 'WARMING' }, again, 'dean', 9_000);
  assert.equal(switching.title, 'Switching a GPU to this voice');
  assert.notEqual(switching.key, starting.key);
  // Usable, busy, simulated or unknown states never pop up.
  assert.equal(voiceCapacityWait({ state: 'READY', canStartConversation: true }), null);
  assert.equal(voiceCapacityWait({ state: 'BUSY_STARTING', canStartConversation: true }), null);
  assert.equal(voiceCapacityWait({ state: 'STARTING', simulated: true }), null);
  assert.equal(voiceCapacityWait({ state: 'LIMIT' }), null);
});

test('a reloaded page keeps the real boot start time from the coordinator', async () => {
  const { voiceCapacityWait } = await import('./voiceCapacity.js');
  const bootedAt = 1_000_000;
  const now = bootedAt + 7 * 60_000;
  const wait = voiceCapacityWait({ state: 'STARTING', waitStartedAt: bootedAt }, null, 'v', now);
  assert.equal(wait.startedAt, bootedAt);
  // A later poll keeps it; a future timestamp is clamped to now.
  assert.equal(voiceCapacityWait({ state: 'STARTING', waitStartedAt: bootedAt }, wait, 'v', now + 5_000).key, wait.key);
  assert.equal(voiceCapacityWait({ state: 'STARTING', waitStartedAt: now + 60_000 }, null, 'v', now).startedAt, now);
});
