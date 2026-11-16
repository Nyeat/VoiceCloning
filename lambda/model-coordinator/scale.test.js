import assert from 'node:assert/strict';
import test from 'node:test';
import { UpdateAutoScalingGroupCommand } from '@aws-sdk/client-auto-scaling';
import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { coordinationKey, requestScale } from './index.js';

const MODEL_KEY = 'a1b2c3';
const PENDING_ID = coordinationKey('PENDING', MODEL_KEY);
const GROUP = { DesiredCapacity: 2, MaxSize: 8 };
const BODY = { voice_model: { gptRef: 'gpt', sovitsRef: 'sovits' } };
const NOW = 1_700_000_000_000;

function label(command) {
  if (command instanceof GetCommand) return 'Get';
  if (command instanceof PutCommand) return 'Put';
  if (command instanceof DeleteCommand) return 'Delete';
  return 'Unknown';
}

/** Records commands and answers Get with a fixed row. */
function recordingDocument({ existingItem = null } = {}) {
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push(command);
      return command instanceof GetCommand ? { Item: existingItem } : {};
    },
  };
}

/** A real enough table: Put/Delete actually mutate what Get sees. */
function statefulDocument() {
  const rows = new Map();
  return {
    rows,
    async send(command) {
      const id = command.input.Key?.id ?? command.input.Item?.id;
      if (command instanceof GetCommand) return { Item: rows.get(id) || null };
      if (command instanceof PutCommand) rows.set(id, command.input.Item);
      if (command instanceof DeleteCommand) rows.delete(id);
      return {};
    },
  };
}

function fakeAutoscaling({ error = null } = {}) {
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push(command);
      if (error) throw error;
      return {};
    },
  };
}

const accessDenied = () => Object.assign(
  new Error('is not authorized to perform: autoscaling:UpdateAutoScalingGroup'),
  { name: 'AccessDeniedException' },
);

test('claims a boot and grows the group by one', async () => {
  const documentClient = recordingDocument();
  const autoscalingClient = fakeAutoscaling();

  const result = await requestScale(GROUP, MODEL_KEY, BODY, NOW, { documentClient, autoscalingClient });

  assert.equal(result.started, true);
  assert.deepEqual(documentClient.calls.map(label), ['Get', 'Put']);
  const updates = autoscalingClient.calls.filter((call) => call instanceof UpdateAutoScalingGroupCommand);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].input.DesiredCapacity, 3);
  assert.equal(documentClient.calls[1].input.Item.coordinatorScope, 'vcs-staging-gpu-inference');
});

test('releases the PENDING claim when the scale-up call fails', async () => {
  const documentClient = recordingDocument();
  const autoscalingClient = fakeAutoscaling({ error: accessDenied() });

  await assert.rejects(
    requestScale(GROUP, MODEL_KEY, BODY, NOW, { documentClient, autoscalingClient }),
    /UpdateAutoScalingGroup/,
  );

  assert.deepEqual(documentClient.calls.map(label), ['Get', 'Put', 'Delete']);
  assert.deepEqual(documentClient.calls.at(-1).input.Key, { id: PENDING_ID });
});

test('a failed scale-up leaves no claim, so the next poll retries the group', async () => {
  // The regression this guards: the claim is written before the bump, so a failed
  // bump used to strand a PENDING row. prepareCapacity short-circuits on that row
  // and answers STARTING for the whole TTL — the browser shows "a GPU is starting"
  // while nothing launches and no later poll ever reaches the group again.
  const documentClient = statefulDocument();

  const failing = fakeAutoscaling({ error: accessDenied() });
  await assert.rejects(
    requestScale(GROUP, MODEL_KEY, BODY, NOW, { documentClient, autoscalingClient: failing }),
  );
  assert.equal(documentClient.rows.size, 0, 'a failed bump must not strand a PENDING claim');

  const recovered = fakeAutoscaling();
  const result = await requestScale(GROUP, MODEL_KEY, BODY, NOW + 15_000, {
    documentClient,
    autoscalingClient: recovered,
  });

  assert.equal(result.started, true);
  assert.equal(
    recovered.calls.filter((call) => call instanceof UpdateAutoScalingGroupCommand).length,
    1,
    'the retry must reach the Auto Scaling group',
  );
  assert.equal(documentClient.rows.get(PENDING_ID)?.requestedAt, NOW + 15_000);
});

test('leaves the group alone while a live PENDING claim exists', async () => {
  const documentClient = recordingDocument({
    existingItem: { id: PENDING_ID, requestedAt: NOW - 1_000 },
  });
  const autoscalingClient = fakeAutoscaling();

  const result = await requestScale(GROUP, MODEL_KEY, BODY, NOW, { documentClient, autoscalingClient });

  assert.equal(result.started, false);
  assert.equal(autoscalingClient.calls.length, 0);
  assert.deepEqual(documentClient.calls.map(label), ['Get']);
});

test('reports atMaximum without claiming a boot', async () => {
  const documentClient = recordingDocument();
  const autoscalingClient = fakeAutoscaling();

  const result = await requestScale(
    { DesiredCapacity: 8, MaxSize: 8 },
    MODEL_KEY,
    BODY,
    NOW,
    { documentClient, autoscalingClient },
  );

  assert.deepEqual(result, { started: false, atMaximum: true });
  assert.equal(autoscalingClient.calls.length, 0);
  assert.deepEqual(documentClient.calls.map(label), ['Get']);
});

test('a scale-up re-reads desired capacity so two voices starting together both get a GPU', async () => {
  const documentClient = recordingDocument();
  const calls = [];
  const autoscalingClient = {
    calls,
    async send(command) {
      calls.push(command);
      // Another voice already raised the group past this caller's snapshot.
      if (command.constructor.name === 'DescribeAutoScalingGroupsCommand') {
        return { AutoScalingGroups: [{ DesiredCapacity: Number(GROUP.DesiredCapacity) + 1 }] };
      }
      return {};
    },
  };
  const result = await requestScale(GROUP, MODEL_KEY, BODY, NOW, { documentClient, autoscalingClient });
  assert.equal(result.started, true);
  const update = calls.find((call) => call instanceof UpdateAutoScalingGroupCommand);
  assert.equal(update.input.DesiredCapacity, Number(GROUP.DesiredCapacity) + 2);
});
