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

export async function sendTrainingCompleteEmail(email, expName, {
  transport = createTransport(),
  fromEmail = process.env.EMAIL_FROM || process.env.EMAIL_USER,
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
