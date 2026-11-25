// Recording portal: a lecturer records against the guided script and/or
// uploads their own audio files, then submits the set. Submission queues
// training on the GPU; super users are emailed when it is ready for quality
// control, and the lecturer is emailed (with a test time) once it passes.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import {
  Check, CheckCircle2, Clock, FileAudio, Mail, Pause, Pencil, Play, Trash2, Upload, X,
} from 'lucide-react';
import { useAuth } from '@/auth/useAuth';
import { PostLoginRedirectHandler, ProtectedRoute } from '@/auth/AppAuthGate';
import { TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { RECORDING_SCRIPT, RECORDING_SCRIPT_MINUTES, SCRIPT_TIPS } from './recordingScript.js';
import { ScriptReader } from './ScriptReader.jsx';
import { PartSteps } from './PartSteps.jsx';
import { SpecialtyTermsPanel } from './SpecialtyTermsPanel.jsx';
import { sectionMinutes } from './specialtyTerms.js';
import {
  createSubmission, errorText, formatSgt, getMe, relativeFromNow, uploadAndSubmit, withdrawSubmission,
} from './studioApi.js';
import {
  Button, Card, Header, Notice, SignInScreen, StatusPill, formatBytes, formatDuration,
} from './StudioChrome.jsx';
import { ConsentDialog, FaqList, FaqPage, readStudioConsent } from './ConsentAndFaq.jsx';
import { CONSENT_VERSION } from './faqContent.js';
import { TrainingSettings, trainingSettingsPayload } from './TrainingSettings.jsx';

const AUDIO_ACCEPT = '.wav,.mp3,.m4a,.flac,.ogg,audio/wav,audio/mpeg,audio/mp4,audio/flac,audio/ogg';
const AUDIO_EXT = /\.(wav|mp3|m4a|flac|ogg)$/iu;
const RECOMMENDED_MINUTES = [10, 40];
const PART_ONE_TAKE = { name: 'guided-reading', label: 'Part 1 · Guided reading', part: 1 };
const PART_TWO_TAKE = { name: 'specialty-terms', label: 'Part 2 · Specialty terms', part: 2 };

function audioDuration(url) {
  return new Promise((resolve) => {
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => resolve(Number.isFinite(audio.duration) ? audio.duration : 0);
    audio.onerror = () => resolve(0);
    audio.src = url;
  });
}

function slug(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 40) || 'take';
}

// ── Collected files ──────────────────────────────────────────────────────

function TakeRow({ take, onRemove }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <button
        type="button"
        onClick={() => {
          const audio = audioRef.current;
          if (!audio) return;
          if (audio.paused) { audio.play(); setPlaying(true); } else { audio.pause(); setPlaying(false); }
        }}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-700 hover:bg-slate-200"
        aria-label={playing ? 'Pause' : 'Play'}
      >
        {playing ? <Pause size={14} /> : <Play size={14} />}
      </button>
      <audio ref={audioRef} src={take.url} onEnded={() => setPlaying(false)} preload="none" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-slate-800" title={take.label || take.file.name}>{take.label || take.file.name}</p>
        <p className="text-xs text-slate-500">
          {take.source === 'recorded' ? 'Recorded' : 'Uploaded'} · {formatDuration(take.duration)} · {formatBytes(take.file.size)}
          {take.levels?.tooQuiet && <span className="ml-1 text-amber-700">· very quiet</span>}
          {take.levels?.tooLoud && <span className="ml-1 text-amber-700">· clipped</span>}
        </p>
      </div>
      <button type="button" onClick={onRemove} className="shrink-0 rounded-lg p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600" aria-label={`Remove ${take.label || take.file.name}`}>
        <Trash2 size={15} />
      </button>
    </li>
  );
}

function PartChecklist({ partsDone }) {
  const rows = [['Part 1 · normal reading', partsDone[0]], ['Part 2 · medical terms', partsDone[1]]];
  return (
    <ul className="space-y-1.5 px-5 pb-1 pt-3" aria-label="Checklist">
      {rows.map(([text, done]) => (
        <li key={text} className="flex items-center gap-2.5 text-sm text-slate-700">
          <span className={cn('flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full', done ? 'bg-emerald-500 text-white' : 'border-2 border-slate-300')} aria-hidden="true">
            {done && <Check size={11} strokeWidth={3} />}
          </span>
          {text}<span className="sr-only">{done ? ' — done' : ' — not yet'}</span>
        </li>
      ))}
    </ul>
  );
}

function FilesPanel({ takes, setTakes, onSubmit, submitting, progress, partsDone, superuser = false, forPerson = null }) {
  const inputRef = useRef(null);
  const [settings, setSettings] = useState({ skipDenoise: true });
  const [dragging, setDragging] = useState(false);
  const [label, setLabel] = useState('My teaching voice');
  // Super users may upload for someone else: the voice goes to that person's account.
  // forPerson: prefilled by the console's "Upload audio" (stop 2) for that lecturer.
  const [forEmail, setForEmail] = useState(forPerson?.email || '');
  const [forName, setForName] = useState(forPerson?.name || '');
  const forValid = !forEmail.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(forEmail.trim());
  const [rejected, setRejected] = useState('');
  const totalSeconds = takes.reduce((sum, take) => sum + (take.duration || 0), 0);
  const minutes = totalSeconds / 60;

  const addFiles = useCallback(async (fileList) => {
    const files = Array.from(fileList || []);
    const good = files.filter((file) => AUDIO_EXT.test(file.name));
    setRejected(files.length > good.length ? `Skipped ${files.length - good.length} file(s): use WAV, MP3, M4A, FLAC or OGG.` : '');
    const added = await Promise.all(good.map(async (file) => {
      const url = URL.createObjectURL(file);
      return { file, url, duration: await audioDuration(url), source: 'upload', label: file.name };
    }));
    setTakes((current) => [...current, ...added]);
  }, [setTakes]);

  return (
    <Card className="flex flex-col">
      <div className="border-b border-slate-200 px-5 py-4">
        <h2 className="text-base font-semibold text-slate-900">Your audio</h2>
        <p className="mt-1 text-sm text-slate-600">Your recorded parts and any files you add. Lecture recordings are great too.</p>
      </div>

      <div
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); }}
        className={cn('m-4 flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-6 text-center transition', dragging ? 'border-primary bg-primary/5' : 'border-slate-300 bg-slate-50')}
      >
        <Upload size={22} className="text-slate-400" aria-hidden="true" />
        <p className="mt-2 text-sm font-medium text-slate-700"><span className="sm:hidden">Add audio files</span><span className="hidden sm:inline">Drop audio files here</span></p>
        <p className="text-xs text-slate-500">WAV, MP3, M4A, FLAC or OGG · several files at once is fine</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => inputRef.current?.click()} disabled={submitting}>
          <FileAudio size={14} /> Choose files
        </Button>
        <input ref={inputRef} type="file" accept={AUDIO_ACCEPT} multiple className="hidden" onChange={(event) => { addFiles(event.target.files); event.target.value = ''; }} />
      </div>
      {rejected && <Notice tone="warn" className="mx-4 mb-3">{rejected}</Notice>}

      <div className="px-5 pb-2">
        <div className="flex items-baseline justify-between text-sm">
          <span className="font-medium text-slate-700">{takes.length} file{takes.length === 1 ? '' : 's'} · {formatDuration(totalSeconds)}</span>
          <span className="text-xs text-slate-500">aim for {RECOMMENDED_MINUTES[0]}–{RECOMMENDED_MINUTES[1]} min</span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200">
          <div
            className={cn('h-full rounded-full', minutes >= RECOMMENDED_MINUTES[0] ? 'bg-emerald-500' : 'bg-amber-400')}
            style={{ width: `${Math.min(100, (minutes / RECOMMENDED_MINUTES[1]) * 100)}%` }}
          />
        </div>
      </div>

      <ul className="max-h-72 divide-y divide-slate-100 overflow-y-auto">
        {takes.map((take, index) => (
          <TakeRow key={take.url} take={take} onRemove={() => setTakes((current) => current.filter((_, i) => i !== index))} />
        ))}
        {takes.length === 0 && <li className="px-5 py-6 text-center text-sm text-slate-500">Nothing yet — record a part or add a file.</li>}
      </ul>
      <PartChecklist partsDone={partsDone} />

      <div className="mt-auto space-y-3 border-t border-slate-200 bg-slate-50 px-5 py-4">
        <label className="block text-xs font-semibold uppercase tracking-[0.08em] text-slate-500" htmlFor="set-label">Name this voice</label>
        <input
          id="set-label"
          value={label}
          maxLength={80}
          onChange={(event) => setLabel(event.target.value)}
          className="h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 sm:h-10"
        />
        {minutes > 0 && minutes < 5 && <p className="text-xs text-amber-700">Under 5 minutes usually gives a weak voice. You can still submit.</p>}
        {superuser && (
          <div className="space-y-2">
            <label className="block text-xs font-semibold uppercase tracking-[0.08em] text-slate-500" htmlFor="for-email">For someone else? (optional)</label>
            <input
              id="for-email"
              type="email"
              value={forEmail}
              disabled={submitting}
              placeholder="their email — leave empty for your own voice"
              onChange={(event) => setForEmail(event.target.value)}
              className={cn('h-11 w-full rounded-lg border bg-white px-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 sm:h-10', forValid ? 'border-slate-300' : 'border-rose-400')}
            />
            {forEmail.trim() && (
              <input
                value={forName}
                maxLength={80}
                disabled={submitting}
                placeholder="their name (optional)"
                onChange={(event) => setForName(event.target.value)}
                className="h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 sm:h-10"
              />
            )}
            {forEmail.trim() && forValid && <p className="text-xs text-slate-500">The voice goes to {forEmail.trim()}: they are emailed, and when they sign in they see its status and can test it.</p>}
          </div>
        )}
        {superuser && (
          <details className="rounded-lg border border-slate-200 bg-white px-3 py-2">
            <summary className="cursor-pointer text-xs font-semibold text-slate-600">Training settings (super users)</summary>
            <div className="mt-3"><TrainingSettings value={settings} onChange={setSettings} disabled={submitting} /></div>
          </details>
        )}
        {submitting ? (
          <div>
            <div className="mb-1 flex justify-between text-xs text-slate-600"><span>Uploading…</span><span>{Math.round(progress * 100)}%</span></div>
            <div className="h-2 overflow-hidden rounded-full bg-slate-200"><div className="h-full bg-primary transition-[width]" style={{ width: `${progress * 100}%` }} /></div>
          </div>
        ) : (
          <Button variant="primary" size="lg" className="w-full" disabled={takes.length === 0 || !forValid} onClick={() => onSubmit(label, superuser ? trainingSettingsPayload(settings) : null, superuser && forEmail.trim() ? { email: forEmail.trim().toLowerCase(), name: forName.trim() } : null)}>
            Submit for training
          </Button>
        )}
        <p className="flex gap-2 text-xs leading-5 text-slate-500">
          <Mail size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          After training, our team checks the quality. We email you once it passes, with a time slot to test your voice.
        </p>
      </div>
    </Card>
  );
}

// ── Status of earlier submissions ────────────────────────────────────────

function lecturerStatusLine(job, now) {
  const retrain = job.attempt > 1;
  if (job.status === 'queued' && retrain) {
    return job.estimate ? `Retraining to improve it (try ${job.attempt}) — should finish around ${formatSgt(job.estimate.finishAt)} SGT. Then it goes back to quality check.` : `Queued for retraining (try ${job.attempt}). Then it goes back to quality check.`;
  }
  if (job.status === 'training' && retrain) {
    return job.estimate ? `Retraining now (try ${job.attempt}) — should finish around ${formatSgt(job.estimate.finishAt)} SGT. Then it goes back to quality check.` : `Retraining now (try ${job.attempt}). Then it goes back to quality check.`;
  }
  if (job.status === 'queued') {
    return job.estimate ? `Queued (#${job.estimate.position}) — training should finish around ${formatSgt(job.estimate.finishAt)} SGT (${relativeFromNow(job.estimate.finishAt, now)}).` : 'Queued for training.';
  }
  if (job.status === 'training') {
    return job.estimate ? `Training now — should finish around ${formatSgt(job.estimate.finishAt)} SGT (${relativeFromNow(job.estimate.finishAt, now)}).` : 'Training now.';
  }
  if (job.status === 'quality-check') return 'Trained. Our team is checking the quality — we will email you when it passes.';
  if (job.status === 'ready') return 'Passed quality check! Open Voice Studio to see or pick your test time.';
  return '';
}

function MySubmissions({ me, onWithdraw }) {
  const now = Date.parse(me?.now || '') || Date.now();
  const jobs = (me?.jobs || []).filter((job) => job.status !== 'uploading');
  if (jobs.length === 0) return null;
  const studioUrl = String(import.meta.env.VITE_STUDIO_APP_URL || '').replace(/\/+$/u, '');
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 border-b border-slate-200 px-4 py-3 sm:px-5">
        <h2 className="text-base font-semibold text-slate-900">Your submissions</h2>
        <span className="text-xs text-slate-500">Training takes about {me.trainingMinutes} min per voice</span>
      </div>
      <ul className="divide-y divide-slate-100">
        {jobs.map((job) => (
          <li key={job.id} className="flex flex-wrap items-start gap-3 px-4 py-3 sm:px-5">
            <div className="min-w-0 flex-1 basis-56">
              <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 font-medium text-slate-900 [overflow-wrap:anywhere]">{job.label}{job.forEmail && <span className="ml-1 text-xs font-normal text-slate-500">· for {job.forName || job.forEmail}</span>}</p>
                <StatusPill status={job.status} />
              </div>
              <p className="mt-1 text-sm text-slate-600">{lecturerStatusLine(job, now)}</p>
              <p className="mt-0.5 text-xs text-slate-400">{job.files.length} file(s) · {formatBytes(job.totalBytes)} · submitted {formatSgt(job.queuedAt || job.createdAt)}</p>
            </div>
            {job.status === 'queued' && <Button variant="ghost" size="sm" onClick={() => onWithdraw(job.id)}>Withdraw</Button>}
            {job.status === 'ready' && studioUrl && (
              <a href={studioUrl} className="inline-flex h-8 items-center rounded-lg bg-emerald-600 px-3 text-xs font-semibold text-white hover:bg-emerald-700">Open Voice Studio</a>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function SubmittedDialog({ job, onClose }) {
  return (
    <div className="vs-root fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 backdrop-blur-sm sm:items-center sm:p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="submitted-title" className="max-h-[92dvh] w-full max-w-md overflow-y-auto overscroll-contain rounded-t-2xl bg-white p-5 shadow-2xl sm:rounded-2xl sm:p-6">
        <div className="flex items-start justify-between">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"><CheckCircle2 size={22} /></span>
          <button type="button" onClick={onClose} className="-m-1 rounded-lg p-2 text-slate-400 hover:bg-slate-100" aria-label="Close"><X size={18} /></button>
        </div>
        <h2 id="submitted-title" className="mt-4 text-xl font-semibold text-slate-900">Submitted — you are in the queue</h2>
        {job?.estimate && (
          <div className="mt-4 flex items-center gap-3 rounded-xl bg-slate-50 px-4 py-3">
            <Clock size={18} className="text-slate-500" />
            <div>
              <p className="text-xs uppercase tracking-[0.08em] text-slate-500">Estimated training finish</p>
              <p className="text-base font-semibold text-slate-900">{formatSgt(job.estimate.finishAt)} SGT</p>
              <p className="text-xs text-slate-500">Position {job.estimate.position || 'now'} in the queue · {relativeFromNow(job.estimate.finishAt)}</p>
            </div>
          </div>
        )}
        <ol className="mt-4 space-y-2 text-sm text-slate-700">
          <li>1. Your voice trains on our GPU (one voice at a time, in order).</li>
          <li>2. Our team listens and checks the quality — sometimes we retrain it to get it right.</li>
          <li>3. <strong>We email you</strong> once it passes, with your reserved time to test it.</li>
        </ol>
        <p className="mt-3 text-xs text-slate-500">We have emailed you this estimate. You can close this page; nothing else is needed from you.</p>
        <Button variant="dark" className="mt-5 w-full" onClick={onClose}>Got it</Button>
      </div>
    </div>
  );
}

function PageShell({ children }) {
  return (
    <div className="vs-root min-h-screen bg-slate-50">
      <Header product="Record your voice" />
      <main className="mx-auto max-w-7xl space-y-4 px-4 py-4 sm:space-y-5 sm:px-6 sm:py-6">{children}</main>
    </div>
  );
}

function EmbeddedShell({ children }) {
  return <div className="space-y-5">{children}</div>;
}

/**
 * The recording workspace: consent, guided script, recorder, uploads, submit.
 * Voice Studio embeds it during a lecturer's recording session (and for super
 * users); it is no longer a site of its own.
 */
export function RecordWorkspace({ embedded = false, sessionEnd = '', onSubmitted, forPerson = null } = {}) {
  const auth = useAuth();
  const [me, setMe] = useState(null);
  const [takes, setTakes] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(null);
  const [tipsOpen, setTipsOpen] = useState(true);
  // Part 1 (standard script) / Part 2 (specialty terms). Switching is locked mid-recording.
  const [part, setPart] = useState(1);
  const [readingLive, setReadingLive] = useState(false);
  const [specialty, setSpecialty] = useState('');
  const [termEntries, setTermEntries] = useState([]);
  const [termScript, setTermScript] = useState(null);
  const email = auth.user?.email || '';
  const [consent, setConsent] = useState(() => readStudioConsent(email));
  const [consentOpen, setConsentOpen] = useState(false);
  // Super users record reference voices; the lecturer consent is not theirs to sign.
  const needsConsent = Boolean(me) && me.role !== 'superuser';
  const consentMissing = needsConsent && !consent;
  useEffect(() => { if (consentMissing) setConsentOpen(true); }, [consentMissing]);

  const refresh = useCallback(() => getMe().then(setMe).catch((err) => setError(errorText(err, 'Could not load your submissions'))), []);
  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  // Leaving with unsent recordings loses them; ask first.
  useEffect(() => {
    if (takes.length === 0 || submitted) return undefined;
    const warn = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [takes.length, submitted]);

  async function submit(label, trainingConfig = null, forPerson = null) {
    setSubmitting(true);
    setError('');
    setProgress(0);
    try {
      if (consentMissing) { setConsentOpen(true); throw new Error('Please accept the consent form first.'); }
      const { jobId } = await createSubmission({
        label, name: auth.user?.name || '', specialty: specialty.trim(), consent: needsConsent ? consent : null, trainingConfig, forPerson,
      });
      const view = await uploadAndSubmit(jobId, takes, { onProgress: setProgress });
      setMe(view);
      setSubmitted(view.jobs.find((job) => job.id === jobId) || { id: jobId });
      onSubmitted?.(view);
      takes.forEach((take) => URL.revokeObjectURL(take.url));
      setTakes([]);
      setPart(1);
      setTermScript(null);
      setTermEntries([]);
    } catch (err) {
      setError(errorText(err, 'Upload failed. Your recordings are still here — try again.'));
    } finally {
      setSubmitting(false);
    }
  }

  async function withdraw(jobId) {
    try {
      setMe(await withdrawSubmission(jobId));
    } catch (err) {
      setError(errorText(err));
    }
  }

  const queueText = useMemo(() => {
    if (!me) return '';
    return me.queueLength > 0 ? `${me.queueLength} voice${me.queueLength === 1 ? '' : 's'} in the training queue right now` : 'The training queue is empty — yours would start straight away';
  }, [me]);

  const partsDone = [takes.some((take) => take.part === 1), takes.some((take) => take.part === 2)];
  const partCards = [
    {
      title: 'Normal reading',
      description: 'Read the standard script in your everyday lecturing voice.',
      meta: `${RECORDING_SCRIPT.length} sections · about ${RECORDING_SCRIPT_MINUTES} min`,
      done: partsDone[0],
      status: partsDone[0] ? 'Done' : part === 1 ? 'Start here' : 'Not started',
    },
    {
      title: 'Medical terms from your specialty',
      description: 'Read short sentences with the terms you use in your field.',
      meta: specialty.trim()
        ? `${specialty.trim()}${termEntries.length ? ` · ${termEntries.length} terms` : ''}`
        : '50 or 100 terms · about 7–14 min',
      done: partsDone[1],
      status: partsDone[1] ? 'Done' : part === 2 ? "You're here" : 'Next',
    },
  ];
  const readerDisabled = submitting || consentMissing || !me;
  const addTake = (take) => setTakes((current) => [...current, take]);
  const needConsent = consentMissing ? () => setConsentOpen(true) : null;

  const Shell = embedded ? EmbeddedShell : PageShell;
  return (
    <>
      <Shell>
        <section className="flex flex-wrap items-end justify-between gap-3 sm:gap-4">
          <div className="min-w-0 flex-1 basis-72">
            <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-3xl">Record your teaching voice</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-600">
              Two short parts: the standard script, then the medical terms from your specialty. Upload recordings you already have too. About 35–45 minutes in total gives the best voice.
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5 sm:flex-col sm:items-end sm:gap-1">
            {sessionEnd && <span className="rounded-xl bg-emerald-600 px-3 py-1 text-xs font-semibold text-white sm:rounded-full">Your recording session is open until {formatSgt(sessionEnd, { withDate: false })} SGT</span>}
            {queueText && <span className="rounded-xl bg-white px-3 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200 sm:rounded-full">{queueText}</span>}
          </div>
        </section>

        {tipsOpen && (
          <Notice tone="info" className="relative pr-10">
            <ul className="grid gap-1 sm:grid-cols-2">
              {SCRIPT_TIPS.map((tip) => <li key={tip}>• {tip}</li>)}
            </ul>
            <button type="button" onClick={() => setTipsOpen(false)} className="absolute right-1.5 top-1.5 rounded-lg p-2 text-blue-700 hover:bg-blue-100" aria-label="Hide tips"><X size={16} /></button>
          </Notice>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        {consentMissing && (
          <Notice tone="warn" className="flex flex-wrap items-center justify-between gap-3">
            <span>Please read and accept the consent form before recording or uploading.</span>
            <Button variant="dark" size="sm" onClick={() => setConsentOpen(true)}>Read the consent form</Button>
          </Notice>
        )}

        {/* Without consent the reader stays readable; its Start button opens the consent form instead. */}
        <PartSteps parts={partCards} current={part} onSelect={setPart} locked={readingLive} />

        {/* Both readers stay mounted (hidden when not shown), so a finished
            part keeps its state and the other part's recording is never cut off. */}
        <div className={cn('grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_380px]', !me && 'pointer-events-none opacity-50')} aria-disabled={!me}>
          <div className="min-w-0">
            <div className={cn(part !== 1 && 'hidden')}>
              <ScriptReader
                script={RECORDING_SCRIPT}
                totalMinutes={RECORDING_SCRIPT_MINUTES}
                partLabel="Part 1 of 2 · Normal reading"
                take={PART_ONE_TAKE}
                active={part === 1}
                onTake={addTake}
                onLiveChange={setReadingLive}
                disabled={readerDisabled}
                onNeedConsent={needConsent}
                next={{ label: 'Continue to Part 2', onClick: () => setPart(2) }}
              />
            </div>
            <div className={cn(part !== 2 && 'hidden')}>
              {termScript ? (
                <ScriptReader
                  script={termScript}
                  totalMinutes={sectionMinutes(termScript)}
                  partLabel="Part 2 of 2 · Medical terms"
                  take={PART_TWO_TAKE}
                  withKnownText
                  active={part === 2}
                  onTake={addTake}
                  onLiveChange={setReadingLive}
                  disabled={readerDisabled}
                  onNeedConsent={needConsent}
                  headerAction={(
                    <Button variant="ghost" size="sm" onClick={() => setTermScript(null)}>
                      <Pencil size={13} aria-hidden="true" /> Edit terms
                    </Button>
                  )}
                />
              ) : (
                <SpecialtyTermsPanel
                  specialty={specialty}
                  onSpecialtyChange={setSpecialty}
                  entries={termEntries}
                  onEntriesChange={setTermEntries}
                  onBuilt={setTermScript}
                  onSkip={() => setPart(1)}
                />
              )}
            </div>
          </div>
          <FilesPanel takes={takes} setTakes={setTakes} onSubmit={submit} submitting={submitting} progress={progress} partsDone={partsDone} superuser={me?.role === 'superuser'} forPerson={forPerson} />
        </div>

        {!embedded && <MySubmissions me={me} onWithdraw={withdraw} />}

        {!embedded && (
        <Card className="p-5 sm:p-6" id="faq">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-slate-900">Questions &amp; answers</h2>
            <div className="flex gap-3 text-sm">
              <button type="button" onClick={() => setConsentOpen(true)} className="font-medium text-primary hover:underline">
                Consent form{consent ? ` (accepted, v${CONSENT_VERSION})` : ''}
              </button>
              <a href="/faq" target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">Shareable FAQ page</a>
            </div>
          </div>
          <FaqList className="mt-4" />
        </Card>
        )}
      </Shell>
      {submitted && <SubmittedDialog job={submitted} onClose={() => setSubmitted(null)} />}
      {consentOpen && (
        <ConsentDialog
          email={email}
          onAccept={(record) => { setConsent(record); setConsentOpen(false); }}
          onDecline={() => setConsentOpen(false)}
        />
      )}
    </>
  );
}

// The recording site was merged into Voice Studio. Its old address now only
// forwards (keeping the path, e.g. /faq), so links already shared still work.
const STUDIO_HOME = String(import.meta.env.VITE_STUDIO_APP_URL || '').replace(/\/+$/u, '');

function ForwardToStudio() {
  useEffect(() => {
    if (STUDIO_HOME) window.location.replace(`${STUDIO_HOME}${window.location.pathname}${window.location.search}`);
  }, []);
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6 text-center text-sm text-slate-600">
      {STUDIO_HOME ? <p>Voice Studio has moved. Taking you to <a className="font-semibold text-primary underline" href={STUDIO_HOME}>{STUDIO_HOME}</a>…</p> : <p>Voice Studio has moved.</p>}
    </div>
  );
}

export default function RecordApp() {
  if (STUDIO_HOME) return <ForwardToStudio />;
  return <LegacyRecordApp />;
}

function LegacyRecordApp() {
  return (
    <TooltipProvider>
      <PostLoginRedirectHandler />
      <Routes>
        <Route path="/faq" element={<FaqPage />} />
        <Route
          path="/login"
          element={(
            <SignInScreen
              product="Record your voice"
              headline="Lend us your voice — about 30 minutes is all it takes."
              lines={[
                ['Record or upload', 'Read our guided script with mood cues, or upload lecture recordings you already have.'],
                ['We train it', 'Your voice joins a fair queue on our GPU; you see an estimated finish time.'],
                ['Quality check, then test', 'Our team checks it, then emails you a reserved time to try it out.'],
              ]}
            />
          )}
        />
        <Route path="*" element={<ProtectedRoute><RecordWorkspace /></ProtectedRoute>} />
      </Routes>
    </TooltipProvider>
  );
}
