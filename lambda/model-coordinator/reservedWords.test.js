import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { releaseAdmissionLease } from './index.js';

// The fake document clients in the other tests accept any expression, so a
// DynamoDB reserved word only fails against the real service. `owner` shipped
// that way and broke every staging synthesis (2026-11-03).
const RESERVED = ['owner', 'status', 'name', 'data', 'timestamp', 'ttl', 'size', 'count', 'key', 'value', 'state', 'type', 'user', 'date', 'time', 'zone'];

test('no condition or update expression names a reserved word without a placeholder', () => {
  const source = readFileSync(new URL('./index.js', import.meta.url), 'utf-8');
  const expressions = [...source.matchAll(/(?:ConditionExpression|UpdateExpression|KeyConditionExpression|FilterExpression):\s*'([^']+)'/gu)].map((m) => m[1]);
  assert.ok(expressions.length > 0);
  for (const expression of expressions) {
    const bare = expression.replace(/[#:][A-Za-z0-9_]+/gu, ' ').toLowerCase().match(/[a-z_]+/gu) || [];
    for (const word of RESERVED) {
      assert.equal(bare.includes(word), false, `"${word}" in "${expression}" must use an #placeholder`);
    }
  }
});

test('releasing the admission lease addresses owner through a placeholder', async () => {
  const sent = [];
  await releaseAdmissionLease({ id: 'lock', owner: 'me' }, {
    documentClient: { send: async (command) => { sent.push(command); } },
    coordinatorTable: 'test-table',
  });
  const input = sent[0].input;
  assert.ok(sent[0] instanceof DeleteCommand);
  assert.equal(input.ConditionExpression, '#owner = :owner');
  assert.deepEqual(input.ExpressionAttributeNames, { '#owner': 'owner' });
});

test('a warm voice switch hints a short retry; only a cold boot uses the boot estimate', async () => {
  const { capacityRetryAfterSeconds, REASSIGN_RETRY_SECONDS } = await import('./index.js');
  assert.equal(capacityRetryAfterSeconds({ booting: false }), REASSIGN_RETRY_SECONDS);
  assert.ok(capacityRetryAfterSeconds({ booting: true }) >= REASSIGN_RETRY_SECONDS);
});

test('a full queue only promises more GPUs when one is really being added', async () => {
  const { queueFullMessage } = await import('./index.js');
  assert.match(queueFullMessage({ atMaximum: true, started: false }), /every GPU is in use/u);
  assert.match(queueFullMessage({ started: true }), /More GPU capacity is preparing/u);
  assert.doesNotMatch(queueFullMessage({ started: false }), /preparing/u);
});
