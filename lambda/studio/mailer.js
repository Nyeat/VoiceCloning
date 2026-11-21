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
        'After training, our team checks the quality by listening to it. Quality control is done by people and can take longer than the training itself, so please allow extra time.',
        'We will email you when your voice moves into quality control, and again once it passes, with a reserved time to test it.',
      ], record ? { label: 'See your submission', url: record } : null),
    };
  },
  inQualityCheck({ job, env }) {
    const { studio } = studioLinks(env);
    return {
      subject: `Your voice is in quality control: ${job.label}`,
      ...layout('Training is done — your voice is in quality control', [
        `Your voice "${job.label}" has finished training. Our team is now listening to it to check the quality.`,
        'This is done by people, so it can take longer than training did. If something is not right we retrain it, which adds a little time.',
        'We will email you once it passes, with a reserved time to test your voice.',
      ], studio ? { label: 'See its progress', url: studio } : null),
    };
  },
  recordingReminder({ slot, kind, env }) {
    const { studio } = studioLinks(env);
    const tomorrow = kind === 'day';
    return {
      subject: tomorrow ? 'Reminder: your voice recording session is tomorrow' : 'Your voice recording session starts soon',
      ...layout(tomorrow ? 'Your recording session is tomorrow' : 'Your recording session starts soon', [
        `Your recording session is ${formatSgtRange(slot.start, slot.end)}.`,
        'Find a quiet room and use a headset or a microphone close to you. Sign in to Voice Studio when it starts — the recording page opens for you then.',
      ], studio ? { label: 'Open Voice Studio', url: studio } : null),
    };
  },
  testDayReminder({ slot, env }) {
    const { studio } = studioLinks(env);
    return {
      subject: 'Today: your voice test time',
      ...layout('Your voice test is today', [
        `Your test time is ${formatSgtRange(slot.start, slot.end)}. The GPU is reserved for you, with your voice loaded just before it starts.`,
        'Sign in to Voice Studio then to talk to your voice, have it read text aloud, fix how it says words and tell us what you think.',
      ], studio ? { label: 'Open Voice Studio', url: studio } : null),
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
  voiceApproved({ job, slot, env }) {
    const { studio } = studioLinks(env);
    return {
      subject: 'Your cloned voice passed quality control',
      ...layout('Your cloned voice is ready', [
        `Your voice "${job.label}" passed our quality check.`,
        slot
          ? `Your test time is ${formatSgtRange(slot.start, slot.end)}. The GPU is reserved for you then, with your voice already loaded; we will remind you just before.`
          : 'We will email you your test time shortly. You can also sign in to Voice Studio to see it.',
        'During your time you can talk to your voice, have it read text aloud, fix how it pronounces words, and tell us what you think.',
      ], studio ? { label: 'Open Voice Studio', url: studio } : null),
    };
  },
  slotBooked({ slot, moved, env }) {
    const { studio } = studioLinks(env);
    return {
      subject: moved ? 'Your voice test time has changed' : 'Your voice test time',
      ...layout(moved ? 'Your test time has changed' : 'Your voice test time is booked', [
        `The GPU is reserved for you on ${formatSgtRange(slot.start, slot.end)}. Your voice is loaded just before it starts.`,
        'Sign in to Voice Studio during that time to talk to your voices, have them read text aloud, fix pronunciations and leave feedback.',
      ], studio ? { label: 'Open Voice Studio', url: studio } : null),
    };
  },
  slotCancelled({ slot, env }) {
    const { studio } = studioLinks(env);
    return {
      subject: 'Your voice test time was cancelled',
      ...layout('Your test time was cancelled', [
        `Your GPU time on ${formatSgtRange(slot.start, slot.end)} was cancelled. You can pick another published time in Voice Studio, or we will assign you one.`,
      ], studio ? { label: 'Open Voice Studio', url: studio } : null),
    };
  },
  recordingBooked({ slot, moved, env }) {
    const { studio } = studioLinks(env);
    return {
      subject: moved ? 'Your recording session has changed' : 'Your voice recording session',
      ...layout(moved ? 'Your recording session has changed' : 'Your recording session is booked', [
        `Your recording session is ${formatSgtRange(slot.start, slot.end)}.`,
        'Sign in to Voice Studio during that time — the recording page unlocks for you then. Before it, you can review the consent form and FAQ.',
      ], studio ? { label: 'Open Voice Studio', url: studio } : null),
    };
  },
  recordingCancelled({ slot, env }) {
    const { studio } = studioLinks(env);
    return {
      subject: 'Your recording session was cancelled',
      ...layout('Your recording session was cancelled', [
        `Your recording session on ${formatSgtRange(slot.start, slot.end)} was cancelled. Please pick another time in Voice Studio.`,
      ], studio ? { label: 'Pick another time', url: studio } : null),
    };
  },
  slotReminder({ slot, env }) {
    const { studio } = studioLinks(env);
    return {
      subject: 'Your voice test starts soon',
      ...layout('Your voice test starts soon', [
        `Your test time is ${formatSgtRange(slot.start, slot.end)}. The GPU is warming up now with your voice loaded.`,
        'Sign in to Voice Studio when it starts to talk to your voice, have it read text aloud, fix pronunciations and leave feedback.',
      ], studio ? { label: 'Open Voice Studio', url: studio } : null),
    };
  },
  slotPicked({ slot, email, claiming, env }) {
    const { studio } = studioLinks(env);
    return {
      subject: claiming ? `Recording session picked by ${email}` : `Recording session released by ${email}`,
      ...layout(claiming ? 'A lecturer picked a recording session' : 'A lecturer released a recording session', [
        `${email} ${claiming ? 'picked' : 'released'} ${formatSgtRange(slot.start, slot.end)}.`,
      ], studio ? { label: 'Open the sessions', url: `${studio}/sessions` } : null),
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
