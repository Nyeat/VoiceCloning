// Voice Studio email. Same SMTP settings as the training worker (EMAIL_HOST,
// EMAIL_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_FROM). With no mailbox configured
// nothing is sent and the event is recorded as "skipped": every message is also
// visible in the portals, so the workflow never depends on email arriving.

const SGT = 'Asia/Singapore';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
}

export function formatSgt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${new Intl.DateTimeFormat('en-SG', {
    timeZone: SGT, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(date)} SGT`;
}

export function formatSgtRange(start, end) {
  const endTime = new Intl.DateTimeFormat('en-SG', { timeZone: SGT, hour: 'numeric', minute: '2-digit' }).format(new Date(end));
  return `${formatSgt(start).replace(/ SGT$/u, '')} – ${endTime} SGT`;
}

function httpsBase(value) {
  const base = String(value || '').trim().replace(/\/+$/u, '');
  return /^https:\/\//iu.test(base) ? base : '';
}

export function studioLinks(env = process.env) {
  return {
    record: httpsBase(env.STUDIO_RECORD_URL),
    studio: httpsBase(env.STUDIO_PUBLIC_URL),
  };
}

function layout(title, paragraphs, link) {
  const text = [...paragraphs, ...(link ? ['', `${link.label}: ${link.url}`] : [])].join('\n');
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#0f172a;line-height:1.55">`
    + `<p style="font-size:16px;font-weight:600">${escapeHtml(title)}</p>`
    + paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('')
    + (link ? `<p><a href="${escapeHtml(link.url)}" style="display:inline-block;background:#1d4ed8;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">${escapeHtml(link.label)}</a></p>` : '')
    + '<p style="color:#64748b;font-size:12px">LKCMedicine Voice Cloning · sign in with your NTU account to open the link.</p></div>';
  return { text, html };
}

export const templates = {
  submissionReceived({ job, estimate, minutes, env }) {
    const { record } = studioLinks(env);
    const eta = estimate?.finishAt ? formatSgt(estimate.finishAt) : '';
    return {
      subject: `We received your recordings: ${job.label}`,
      ...layout('Your recordings are in the training queue', [
        `Thank you — we received ${job.files.length} audio file(s) for "${job.label}".`,
        eta
          ? `Estimated training finish: ${eta} (position ${estimate.position || 1} in the queue; each voice takes about ${minutes} minutes).`
          : `Each voice takes about ${minutes} minutes to train; yours will start as soon as the GPU is free.`,
        'After training, our team checks the quality. We will email you again once it passes, with a reserved time to test your voice.',
      ], record ? { label: 'See your submission', url: record } : null),
    };
  },
  readyForReview({ job, env }) {
    const { studio } = studioLinks(env);
    return {
      subject: `Voice ready for review: ${job.ownerName || job.ownerEmail} (attempt ${job.attempt})`,
      ...layout('A trained voice is waiting for quality control', [
        `${job.ownerName || job.ownerEmail} — "${job.label}" finished training (attempt ${job.attempt}, voice ${job.expName}).`,
        'Listen to it, then mark it good (and book their test slot) or send it back for a retrain.',
      ], studio ? { label: 'Open the review', url: `${studio}/review/${encodeURIComponent(job.id)}` } : null),
    };
  },
  trainingFailed({ job, env }) {
    const { studio } = studioLinks(env);
    return {
      subject: `Voice training failed: ${job.ownerName || job.ownerEmail}`,
      ...layout('A training run failed', [
        `${job.ownerName || job.ownerEmail} — "${job.label}" (attempt ${job.attempt}) failed: ${job.error || 'unknown error'}.`,
        'You can retry it or ask the lecturer for new recordings.',
      ], studio ? { label: 'Open the job', url: `${studio}/review/${encodeURIComponent(job.id)}` } : null),
    };
  },
  slotBooked({ job, slot, moved, env }) {
    const { studio } = studioLinks(env);
    return {
      subject: moved ? 'Your voice test time has changed' : 'Your cloned voice is ready to test',
      ...layout(moved ? 'Your test time has changed' : 'Your cloned voice passed quality control', [
        `Your voice "${job.label}" is ready. The GPU is reserved for you on ${formatSgtRange(slot.start, slot.end)}.`,
        'Open the link during that time to talk to your voice, adjust how it pronounces words, and tell us what you think.',
      ], studio ? { label: 'Test your voice', url: `${studio}/?voice=${encodeURIComponent(slot.voiceName)}` } : null),
    };
  },
  slotCancelled({ job, env }) {
    const { studio } = studioLinks(env);
    return {
      subject: 'Your voice test time was cancelled',
      ...layout('Your test time was cancelled', [
        `The GPU time booked for your voice "${job.label}" was cancelled. We will email you again with a new time.`,
      ], studio ? { label: 'Open Voice Studio', url: studio } : null),
    };
  },
  newRecordingsNeeded({ job, notes, env }) {
    const { record } = studioLinks(env);
    return {
      subject: 'Please record your voice again',
      ...layout('We need new recordings', [
        `We tried ${job.attempt} times but could not make a good copy of your voice from "${job.label}".`,
        ...(notes ? [`Reviewer's note: ${notes}`] : []),
        'A quieter room and a steady distance from the microphone usually fix this.',
      ], record ? { label: 'Record again', url: record } : null),
    };
  },
  superuserAdded({ email, actor, env }) {
    const { studio } = studioLinks(env);
    return {
      subject: 'You are now a Voice Studio super user',
      ...layout('You were added as a super user', [
        `${actor} gave ${email} super-user access to LKCMedicine Voice Studio: review trained voices, book test slots and manage other super users.`,
      ], studio ? { label: 'Open Voice Studio', url: studio } : null),
    };
  },
};

function formatSender(env) {
  const address = String(env.EMAIL_FROM || env.EMAIL_USER || '').trim();
  if (!address || address.includes('<')) return address;
  return `"LKCMedicine Voice Cloning" <${address}>`;
}

let cachedTransport;

async function defaultTransport(env) {
  if (cachedTransport !== undefined) return cachedTransport;
  if (!env.EMAIL_USER || !env.EMAIL_PASS) {
    cachedTransport = null;
    return null;
  }
  const { default: nodemailer } = await import('nodemailer');
  const port = Number(env.EMAIL_PORT) || 587;
  cachedTransport = nodemailer.createTransport({
    host: env.EMAIL_HOST || 'smtp.office365.com',
    port,
    secure: port === 465,
    auth: { user: env.EMAIL_USER, pass: env.EMAIL_PASS },
  });
  return cachedTransport;
}

export function createMailer({ env = process.env, transport } = {}) {
  return {
    /** Never throws: returns { status: 'sent'|'skipped'|'failed', error? } per message. */
    async send(to, message) {
      const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
      if (recipients.length === 0) return { status: 'skipped', error: 'no recipients' };
      let activeTransport;
      try {
        activeTransport = transport === undefined ? await defaultTransport(env) : transport;
      } catch (error) {
        return { status: 'failed', error: error.message };
      }
      if (!activeTransport) return { status: 'skipped', error: 'email is not configured' };
      try {
        await activeTransport.sendMail({ from: formatSender(env), to: recipients.join(', '), ...message });
        return { status: 'sent' };
      } catch (error) {
        console.warn('[studio][email] send failed:', error.message);
        return { status: 'failed', error: error.message };
      }
    },
  };
}
