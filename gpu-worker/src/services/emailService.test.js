import test from 'node:test';
import assert from 'node:assert/strict';

test('sendTrainingCompleteEmail sends the configured SMTP message', async () => {
  const calls = [];
  const transport = {
    sendMail: async (message) => {
      calls.push(message);
    },
  };

  const { sendTrainingCompleteEmail } = await import('./emailService.js');

  await sendTrainingCompleteEmail('user@example.com', 'my_voice', {
    transport,
    fromEmail: 'sender@example.com',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].from, 'sender@example.com');
  assert.equal(calls[0].to, 'user@example.com');
  assert.ok(calls[0].subject.includes('my_voice'), 'subject should contain expName');
  assert.ok(calls[0].text.includes('my_voice'), 'text body should contain expName');
  assert.ok(calls[0].html.includes('my_voice'), 'html body should contain expName');
});

test('sendTrainingCompleteEmail skips silently when fromEmail is not provided', async () => {
  const calls = [];
  const transport = {
    sendMail: async (message) => {
      calls.push(message);
    },
  };

  const { sendTrainingCompleteEmail } = await import('./emailService.js');

  await sendTrainingCompleteEmail('user@example.com', 'my_voice', {
    transport,
    fromEmail: '',
  });

  assert.equal(calls.length, 0);
});

test('sendTrainingCompleteEmail links to the test-your-voice page when given an https URL', async () => {
  const calls = [];
  const { sendTrainingCompleteEmail } = await import('./emailService.js');
  await sendTrainingCompleteEmail('user@example.com', 'my_voice', {
    transport: { sendMail: async (message) => { calls.push(message); } },
    fromEmail: 'sender@example.com',
    testVoiceUrl: 'https://voicecloning.lkcmedicine.org/test-voice?voice=my_voice',
  });
  assert.match(calls[0].text, /Test your voice: https:\/\/voicecloning\.lkcmedicine\.org\/test-voice\?voice=my_voice/);
  assert.match(calls[0].html, /href="https:\/\/voicecloning\.lkcmedicine\.org\/test-voice\?voice=my_voice"/);
});

test('sendTrainingCompleteEmail drops a non-https test link', async () => {
  const calls = [];
  const { sendTrainingCompleteEmail } = await import('./emailService.js');
  await sendTrainingCompleteEmail('user@example.com', 'my_voice', {
    transport: { sendMail: async (message) => { calls.push(message); } },
    fromEmail: 'sender@example.com',
    testVoiceUrl: 'javascript:alert(1)',
  });
  assert.doesNotMatch(calls[0].html, /href=/);
});

test('the sender shows a service name instead of a bare personal address', async () => {
  const { formatSender, sendTrainingCompleteEmail } = await import('./emailService.js');
  assert.equal(formatSender('someone@gmail.com'), '"LKCMedicine Voice Cloning" <someone@gmail.com>');
  assert.equal(formatSender('Team <team@x.sg>'), 'Team <team@x.sg>');
  assert.equal(formatSender('a@b.c', ''), 'a@b.c');
  assert.equal(formatSender('a@b.c', 'Bad"\r\nName'), '"BadName" <a@b.c>');
  let sent;
  await sendTrainingCompleteEmail('u@ntu.edu.sg', 'voice', {
    transport: { sendMail: async (mail) => { sent = mail; } },
    fromEmail: formatSender('someone@gmail.com'),
  });
  assert.equal(sent.from, '"LKCMedicine Voice Cloning" <someone@gmail.com>');
});

test('startup email check reports a working, failing or missing SMTP login without sending', async () => {
  const { checkEmailLogin } = await import('./emailService.js');
  const logs = [];
  const log = { log: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  assert.equal(await checkEmailLogin({ transport: { verify: async () => true }, log }), true);
  assert.equal(await checkEmailLogin({ transport: { verify: async () => { throw new Error('535 bad password'); } }, log }), false);
  assert.equal(await checkEmailLogin({ transport: null, log }), false);
  assert.match(logs.join('\n'), /login OK[\s\S]*FAILED.*535[\s\S]*OFF/);
});
