import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMailer, emailConfigured } from './mailer.js';

const message = { subject: 'Hi', text: 'Plain', html: '<p>Plain</p>' };
const sesEnv = { EMAIL_PROVIDER: 'ses', EMAIL_FROM: '"Studio" <studio@example.org>' };

test('SES sends as EMAIL_FROM when EMAIL_PROVIDER=ses', async () => {
  const sent = [];
  const mailer = createMailer({ env: sesEnv, ses: { send: async (input) => sent.push(input) }, transport: null });
  assert.deepEqual(await mailer.send('a@b.com', message), { status: 'sent', via: 'ses' });
  assert.equal(sent[0].FromEmailAddress, '"Studio" <studio@example.org>');
  assert.deepEqual(sent[0].Destination.ToAddresses, ['a@b.com']);
  assert.equal(sent[0].Content.Simple.Subject.Data, 'Hi');
  assert.equal(sent[0].Content.Simple.Body.Html.Data, '<p>Plain</p>');
  assert.equal(emailConfigured(sesEnv), true);
  assert.equal(emailConfigured({}), false);
});

test('SES refused: SMTP is tried, and both errors are reported if both fail', async () => {
  const ses = { send: async () => { throw new Error('AccessDenied'); } };
  const ok = createMailer({ env: sesEnv, ses, transport: { sendMail: async () => {} } });
  assert.deepEqual(await ok.send('a@b.com', message), { status: 'sent', via: 'smtp' });
  const none = createMailer({ env: sesEnv, ses, transport: null });
  assert.deepEqual(await none.send('a@b.com', message), { status: 'failed', error: 'SES: AccessDenied' });
});
