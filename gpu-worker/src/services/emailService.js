import nodemailer from 'nodemailer';

function escapeHtml(str) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(str).replace(/[&<>"']/g, c => map[c]);
}

function createTransport() {
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  const host = process.env.EMAIL_HOST || 'smtp.gmail.com';
  const port = Number(process.env.EMAIL_PORT) || 587;

  if (!user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

// Only an https link is ever placed in the email: the URL comes from the
// Lambda's configuration, but a malformed value must not become a mail link.
export function safeTestVoiceUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

// Recipients see a service name, not a bare mailbox address. An EMAIL_FROM
// that already carries a name ("Name <addr>") is used as is.
export function formatSender(address, name = 'LKCMedicine Voice Cloning') {
  const value = String(address || '').trim();
  if (!value || value.includes('<')) return value;
  const label = String(name || '').replace(/["\\\r\n]/g, '').trim();
  return label ? `"${label}" <${value}>` : value;
}

export async function sendTrainingCompleteEmail(email, expName, {
  transport = createTransport(),
  fromEmail = formatSender(
    process.env.EMAIL_FROM || process.env.EMAIL_USER,
    process.env.EMAIL_FROM_NAME ?? 'LKCMedicine Voice Cloning',
  ),
  testVoiceUrl = '',
} = {}) {

  if (!transport || !fromEmail) {
    console.warn('[gpu-worker] EMAIL_USER/EMAIL_PASS not configured — skipping training complete email');
    return;
  }

  const link = safeTestVoiceUrl(testVoiceUrl);
  await transport.sendMail({
    from: fromEmail,
    to: email,
    subject: `Your voice model is ready: ${expName}`,
    text: [
      'Training is complete, you may now come back to test it.',
      '',
      `Voice model: ${expName}`,
      ...(link ? ['', `Test your voice: ${link}`] : []),
    ].join('\n'),
    html: '<p>Training is complete, you may now come back to test it.</p>'
      + `<p>Voice model: <strong>${escapeHtml(expName)}</strong></p>`
      + (link
        ? `<p><a href="${escapeHtml(link)}">Test your voice</a></p>`
          + '<p style="color:#64748b;font-size:12px">Sign in with your NTU account to open it. Only you can see and use this voice there.</p>'
        : ''),
  });
}

// Logs once at startup whether the SMTP login works, without sending mail, so a
// revoked password shows up immediately instead of after an hour of training.
export async function checkEmailLogin({ transport = createTransport(), log = console } = {}) {
  if (!transport) {
    log.warn('[gpu-worker][email] EMAIL_USER/EMAIL_PASS not set — training emails are OFF');
    return false;
  }
  try {
    await transport.verify();
    log.log('[gpu-worker][email] SMTP login OK — training emails are ON');
    return true;
  } catch (error) {
    log.error(`[gpu-worker][email] SMTP login FAILED — training emails will not send: ${error.message}`);
    return false;
  }
}
