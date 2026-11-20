// Voice Studio: one site, two very different experiences.
//  - Super users get a console: review trained voices, approve or send back
//    for a retrain, book the single GPU's test slots (clashes refused), test
//    any voice, read lecturer feedback and manage other super users.
//  - Lecturers get one simple page: their approved voice, usable only inside
//    the slot booked for them, with its own pronunciation list and feedback.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  CalendarClock, CheckCircle2, ClipboardCheck, Cpu, Loader2, MessageSquareText, Mic2, RefreshCw, ShieldCheck,
  Star, ThumbsDown, ThumbsUp, Trash2, UserPlus, Users, X,
} from 'lucide-react';
import { PostLoginRedirectHandler, ProtectedRoute } from '@/auth/AppAuthGate';
import { useAuth } from '@/auth/useAuth';
import { TooltipProvider } from '@/components/ui/tooltip';
import { GpuStatusProvider } from '@/lib/gpuStatus.jsx';
import { cn } from '@/lib/utils';
import LivePage from '@/pages/LivePage.jsx';
import PronunciationPanel from './PronunciationPanel.jsx';
import { RecordWorkspace } from './RecordApp.jsx';
import { FaqPage } from './ConsentAndFaq.jsx';
import {
  addSlot, addSuperuser, cancelJob, claimSlot, deleteSlot, editSlot, errorText, formatRange, formatSgt, getMe, getOverview,
  publishSlots, relativeFromNow, releaseSlot, removeSuperuser, renameSuperuser, requestRecordings, retryJob, reviewJob, runTick, sendFeedback, sgtToIso,
} from './studioApi.js';
import {
  Brand, Button, Card, Header, Notice, SignInScreen, StatusPill, formatBytes,
} from './StudioChrome.jsx';

const SGT_DATE = (value) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));

function who(job) {
  return job.ownerName || job.ownerEmail;
}

function trainedVoices(job) {
  return (job.attempts || []).filter((attempt) => attempt.result === 'trained').map((attempt) => attempt.expName);
}

// ── Super user: data hook ────────────────────────────────────────────────

function useOverview() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      setData(await getOverview());
      setError('');
    } catch (err) {
      setError(errorText(err, 'Could not load Voice Studio'));
    }
  }, []);
  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 20_000);
    return () => window.clearInterval(id);
  }, [refresh]);
  return { data, setData, error, setError, refresh };
}

// ── Super user: overview ─────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, tone = 'slate' }) {
  const tones = { slate: 'bg-slate-100 text-slate-700', amber: 'bg-amber-100 text-amber-700', blue: 'bg-blue-100 text-blue-700', violet: 'bg-violet-100 text-violet-700', emerald: 'bg-emerald-100 text-emerald-700' };
  return (
    <Card className="flex items-center gap-3 p-4">
      <span className={cn('flex h-10 w-10 items-center justify-center rounded-xl', tones[tone])}><Icon size={18} /></span>
      <div>
        <p className="text-2xl font-semibold text-slate-900">{value}</p>
        <p className="text-xs text-slate-500">{label}</p>
      </div>
    </Card>
  );
}

function Overview({ overview, onAction }) {
  const navigate = useNavigate();
  const jobs = overview.jobs;
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const review = jobs.filter((job) => job.status === 'review' || job.status === 'failed');
  const now = Date.parse(overview.now);
  const slotted = new Set(overview.slots.filter((slot) => slot.assigneeEmail && Date.parse(slot.end) > now).map((slot) => slot.assigneeEmail));
  const needSlot = jobs.filter((job) => job.status === 'approved' && !slotted.has(job.ownerEmail));
  const training = jobs.find((job) => job.status === 'training');
  const queue = overview.queue.map((id) => byId.get(id)).filter(Boolean);
  const [filter, setFilter] = useState('all');
  const listed = jobs.filter((job) => filter === 'all' || job.status === filter);

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={ClipboardCheck} label="Waiting for your review" value={review.length} tone="violet" />
        <StatCard icon={CalendarClock} label="Approved, need a slot" value={needSlot.length} tone="emerald" />
        <StatCard icon={Cpu} label={training ? `Training: ${who(training)}` : 'Training GPU idle'} value={training ? 1 : 0} tone="blue" />
        <StatCard icon={Users} label="In the training queue" value={queue.length} tone="amber" />
      </div>

      {!overview.emailConfigured && (
        <Notice tone="warn">Email is not configured on the server yet, so nobody is emailed. Everything still shows here — check this page for reviews.</Notice>
      )}
      {overview.currentSlot && (
        <Notice tone="info">
          Training waits while <b>{overview.currentSlot.assigneeName || overview.currentSlot.assigneeEmail}</b> tests until {formatSgt(overview.currentSlot.end, { withDate: false })} SGT.
        </Notice>
      )}

      <Card>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="font-semibold text-slate-900">Needs your review</h2>
          <span className="text-xs text-slate-500">Listen, then approve or send back</span>
        </div>
        {review.length === 0 ? <p className="px-5 py-6 text-sm text-slate-500">Nothing waiting. You will get an email when a voice finishes training.</p> : (
          <ul className="divide-y divide-slate-100">
            {review.map((job) => (
              <li key={job.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-slate-900">{who(job)}</p>
                    <StatusPill status={job.status} />
                    <span className="text-xs text-slate-500">attempt {job.attempt} · {job.expName}</span>
                  </div>
                  <p className="text-sm text-slate-600">{job.label}{job.error ? ` — ${job.error}` : ''}</p>
                </div>
                {job.status === 'review' && <Button variant="outline" size="sm" disabled={Boolean(overview.currentSlot)} title={overview.currentSlot ? 'Locked while a lecturer is testing' : ''} onClick={() => navigate(`/test?voice=${encodeURIComponent(job.expName)}`)}><Mic2 size={13} /> Test</Button>}
                <Button variant="dark" size="sm" onClick={() => navigate(`/review/${job.id}`)}>Open</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
            <h2 className="font-semibold text-slate-900">Training queue</h2>
            <Button variant="ghost" size="sm" onClick={() => onAction(runTick)}><RefreshCw size={13} /> Check now</Button>
          </div>
          <div className="px-5 py-2 text-xs text-slate-500">
            GPU trainer: {overview.worker.reachable ? `${overview.worker.status}${overview.worker.expName ? ` (${overview.worker.expName})` : ''}` : 'off or starting — it is started automatically when work is queued'}
            {' · '}~{overview.trainingMinutes} min per voice
          </div>
          <ol className="divide-y divide-slate-100">
            {[training, ...queue].filter(Boolean).map((job) => (
              <li key={job.id} className="flex items-center gap-3 px-5 py-2.5">
                <span className={cn('flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold', job.status === 'training' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600')}>
                  {job.status === 'training' ? <Loader2 size={13} className="animate-spin" /> : job.estimate?.position}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">{who(job)} <span className="font-normal text-slate-500">· {job.label}{job.attempt > 1 ? ` · retrain ${job.attempt}` : ''}</span></p>
                  {job.estimate && <p className="text-xs text-slate-500">{job.status === 'training' ? 'finishes' : 'starts'} {formatSgt(job.status === 'training' ? job.estimate.finishAt : job.estimate.startAt)} · done {relativeFromNow(job.estimate.finishAt)}</p>}
                  {job.error && job.status === 'queued' && <p className="text-xs text-amber-700">{job.error}</p>}
                </div>
                <button type="button" onClick={() => navigate(`/review/${job.id}`)} className="text-xs font-medium text-primary hover:underline">Details</button>
              </li>
            ))}
            {!training && queue.length === 0 && <li className="px-5 py-6 text-sm text-slate-500">The queue is empty.</li>}
          </ol>
        </Card>

        <Card>
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
            <h2 className="font-semibold text-slate-900">Approved — book a test slot</h2>
          </div>
          {needSlot.length === 0 ? <p className="px-5 py-6 text-sm text-slate-500">No approved voice is waiting for a slot.</p> : (
            <ul className="divide-y divide-slate-100">
              {needSlot.map((job) => (
                <li key={job.id} className="flex items-center gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-slate-900">{who(job)}</p>
                    <p className="text-xs text-slate-500">{job.label} · {job.approvedExpName}</p>
                  </div>
                  <Button variant="success" size="sm" onClick={() => navigate(`/schedule?person=${encodeURIComponent(job.ownerEmail)}`)}><CalendarClock size={13} /> Give a slot</Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-5 py-3">
          <h2 className="font-semibold text-slate-900">All recording sets</h2>
          <select value={filter} onChange={(event) => setFilter(event.target.value)} className="h-8 rounded-lg border border-slate-300 px-2 text-xs" aria-label="Filter by status">
            {['all', 'queued', 'training', 'review', 'approved', 'scheduled', 'failed', 'cancelled', 'uploading'].map((status) => <option key={status} value={status}>{status}</option>)}
          </select>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-[0.06em] text-slate-500">
              <tr><th className="px-5 py-2">Lecturer</th><th className="px-3 py-2">Voice</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Audio</th><th className="px-3 py-2">Submitted</th><th className="px-3 py-2" /></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {listed.map((job) => (
                <tr key={job.id} className="hover:bg-slate-50">
                  <td className="px-5 py-2.5"><p className="font-medium text-slate-800">{who(job)}</p><p className="text-xs text-slate-500">{job.ownerEmail}</p></td>
                  <td className="px-3 py-2.5"><p>{job.label}</p><p className="text-xs text-slate-500">{job.expName} · attempt {job.attempt}</p></td>
                  <td className="px-3 py-2.5"><StatusPill status={job.status} /></td>
                  <td className="px-3 py-2.5 text-xs text-slate-600">{job.files.length} files · {formatBytes(job.totalBytes)}</td>
                  <td className="px-3 py-2.5 text-xs text-slate-600">{formatSgt(job.queuedAt || job.createdAt)}</td>
                  <td className="px-3 py-2.5 text-right"><button type="button" onClick={() => navigate(`/review/${job.id}`)} className="text-xs font-medium text-primary hover:underline">Open</button></td>
                </tr>
              ))}
              {listed.length === 0 && <tr><td colSpan={6} className="px-5 py-6 text-center text-sm text-slate-500">Nothing here.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ── Super user: one job ──────────────────────────────────────────────────

function ReviewForm({ job, reasons, maxAttempts, onAction }) {
  const [mode, setMode] = useState('');
  const [picked, setPicked] = useState([]);
  const [notes, setNotes] = useState('');
  const [sovits, setSovits] = useState('');
  const [gpt, setGpt] = useState('');
  const atLimit = job.attempt >= maxAttempts;

  if (job.status !== 'review') return null;
  return (
    <Card className="p-5">
      <h3 className="font-semibold text-slate-900">Quality decision</h3>
      <p className="mt-1 text-sm text-slate-600">Test the voice first (chat or text-to-speech), then decide.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="success" onClick={() => onAction(() => reviewJob(job.id, { decision: 'approve', notes }))}><ThumbsUp size={15} /> Good — approve</Button>
        <Button variant={mode === 'reject' ? 'danger' : 'outline'} onClick={() => setMode(mode === 'reject' ? '' : 'reject')}><ThumbsDown size={15} /> Not good — retrain</Button>
        <Button variant="ghost" onClick={() => setMode(mode === 'recordings' ? '' : 'recordings')}>Ask for new recordings</Button>
      </div>
      <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} placeholder="Notes (optional, kept with the review)" className="mt-3 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
      {mode === 'reject' && (
        <div className="mt-3 space-y-3 rounded-xl bg-rose-50/60 p-4">
          <p className="text-sm font-medium text-slate-800">What is wrong? The retrain changes its recipe to match:</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {Object.entries(reasons).map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={picked.includes(key)} onChange={(event) => setPicked(event.target.checked ? [...picked, key] : picked.filter((item) => item !== key))} />
                {label}
              </label>
            ))}
          </div>
          <ul className="text-xs leading-5 text-slate-600">
            <li>• Not like the speaker → more SoVITS (timbre) training.</li>
            <li>• Mispronounces / robotic → more GPT (words and rhythm) training.</li>
            <li>• Noisy → forces denoising and trains a little less, so noise is not learned.</li>
            <li>• The retrain is a new voice version; this one is kept for comparison.</li>
          </ul>
          <details className="text-sm">
            <summary className="cursor-pointer text-xs font-medium text-slate-600">Advanced: set epochs yourself (now SoVITS {job.trainingConfig?.sovitsEpochs}, GPT {job.trainingConfig?.gptEpochs})</summary>
            <div className="mt-2 flex gap-2">
              <input value={sovits} onChange={(event) => setSovits(event.target.value)} placeholder="SoVITS epochs" inputMode="numeric" className="h-9 w-36 rounded-lg border border-slate-300 px-2 text-sm" />
              <input value={gpt} onChange={(event) => setGpt(event.target.value)} placeholder="GPT epochs" inputMode="numeric" className="h-9 w-36 rounded-lg border border-slate-300 px-2 text-sm" />
            </div>
          </details>
          {atLimit && <Notice tone="warn" className="text-xs">This is attempt {job.attempt} of {maxAttempts}. Another retrain rarely helps — consider asking for new recordings. You can still force it.</Notice>}
          <Button
            variant="danger"
            onClick={() => onAction(() => reviewJob(job.id, {
              decision: 'reject',
              reasons: picked,
              notes,
              overrides: { ...(sovits ? { sovitsEpochs: Number(sovits) } : {}), ...(gpt ? { gptEpochs: Number(gpt) } : {}), ...(atLimit ? { force: true } : {}) },
            }))}
          >
            Send back for retraining
          </Button>
        </div>
      )}
      {mode === 'recordings' && (
        <div className="mt-3 rounded-xl bg-amber-50 p-4 text-sm">
          <p>This closes the set and emails the lecturer asking them to record again (your notes are included).</p>
          <Button variant="dark" size="sm" className="mt-2" onClick={() => onAction(() => requestRecordings(job.id, notes))}>Email the lecturer</Button>
        </div>
      )}
    </Card>
  );
}

function SlotHint({ job, overview }) {
  const navigate = useNavigate();
  if (job.status !== 'approved') return null;
  const now = Date.parse(overview.now);
  const slot = overview.slots.find((item) => item.assigneeEmail === job.ownerEmail && Date.parse(item.end) > now);
  return (
    <Card className="p-5">
      <h3 className="font-semibold text-slate-900">Test time</h3>
      {slot
        ? <p className="mt-1 text-sm text-slate-600">{who(job)} has {formatRange(slot.start, slot.end)} ({slot.status}). In it they can use all their approved voices.</p>
        : <p className="mt-1 text-sm text-slate-600">{who(job)} has no slot yet. They can pick an open published time, or you can give them one.</p>}
      <Button variant="outline" size="sm" className="mt-3" onClick={() => navigate(`/schedule?person=${encodeURIComponent(job.ownerEmail)}`)}><CalendarClock size={13} /> Open the schedule</Button>
    </Card>
  );
}

function JobDetail({ overview, onAction }) {
  const { jobId } = useParams();
  const navigate = useNavigate();
  const job = overview.jobs.find((item) => item.id === jobId);
  if (!job) return <Notice tone="warn">That recording set was not found. <button type="button" className="underline" onClick={() => navigate('/')}>Back</button></Notice>;
  const voices = trainedVoices(job);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <button type="button" onClick={() => navigate('/')} className="text-xs font-medium text-primary hover:underline">← Overview</button>
          <h2 className="mt-1 text-xl font-semibold text-slate-900">{who(job)} · {job.label}</h2>
          <p className="text-sm text-slate-500">{job.ownerEmail} · attempt {job.attempt} · current voice {job.expName}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={job.status} />
          {job.status === 'failed' && <Button variant="dark" size="sm" onClick={() => onAction(() => retryJob(job.id))}><RefreshCw size={13} /> Retry training</Button>}
          {!['training', 'cancelled'].includes(job.status) && <Button variant="ghost" size="sm" onClick={() => onAction(() => cancelJob(job.id))}><X size={13} /> Cancel set</Button>}
        </div>
      </div>

      {job.estimate && ['queued', 'training'].includes(job.status) && (
        <Notice tone="info">Estimated finish {formatSgt(job.estimate.finishAt)} SGT ({relativeFromNow(job.estimate.finishAt)}).</Notice>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-5">
          {voices.length > 0 && (
            <Card className="p-5">
              <h3 className="font-semibold text-slate-900">Trained versions</h3>
              <div className="mt-3 flex flex-wrap gap-2">
                {voices.map((name) => (
                  <Button key={name} variant={name === job.expName ? 'dark' : 'outline'} size="sm" disabled={Boolean(overview.currentSlot)} onClick={() => navigate(`/test?voice=${encodeURIComponent(name)}`)}>
                    <Mic2 size={13} /> Test {name}
                  </Button>
                ))}
              </div>
            </Card>
          )}
          <ReviewForm job={job} reasons={overview.rejectReasons} maxAttempts={overview.maxAttempts} onAction={onAction} />
          <SlotHint job={job} overview={overview} />
          <Card className="p-5">
            <h3 className="font-semibold text-slate-900">Lecturer feedback</h3>
            {job.feedback.length === 0 ? <p className="mt-2 text-sm text-slate-500">No feedback yet.</p> : (
              <ul className="mt-2 space-y-2">
                {job.feedback.map((entry) => (
                  <li key={entry.at} className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
                    <Stars value={entry.rating} /> <span className="text-xs text-slate-500">{formatSgt(entry.at)}</span>
                    {entry.comment && <p className="mt-1 text-slate-700">{entry.comment}</p>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className="space-y-5">
          <Card className="p-5 text-sm">
            <h3 className="font-semibold text-slate-900">History</h3>
            <ul className="mt-2 space-y-2 text-slate-700">
              {job.attempts.map((attempt) => (
                <li key={`${attempt.attempt}-${attempt.expName}`} className="rounded-lg bg-slate-50 px-3 py-2">
                  <p className="font-medium">Attempt {attempt.attempt}: {attempt.result} <span className="text-xs text-slate-500">({attempt.expName})</span></p>
                  <p className="text-xs text-slate-500">SoVITS {attempt.config?.sovitsEpochs} · GPT {attempt.config?.gptEpochs} epochs · denoise {attempt.config?.skipDenoise ? 'off' : 'on'} · {formatSgt(attempt.finishedAt)}</p>
                  {attempt.error && <p className="text-xs text-rose-600">{attempt.error}</p>}
                </li>
              ))}
              {job.reviews.map((entry) => (
                <li key={entry.at} className="rounded-lg border border-slate-200 px-3 py-2">
                  <p className="font-medium">{entry.decision} by {entry.reviewer}</p>
                  {entry.reasons?.length > 0 && <p className="text-xs text-slate-500">{entry.reasons.map((reason) => overview.rejectReasons[reason] || reason).join(', ')}</p>}
                  {entry.notes && <p className="text-xs text-slate-600">“{entry.notes}”</p>}
                </li>
              ))}
              {job.attempts.length === 0 && job.reviews.length === 0 && <li className="text-slate-500">Not trained yet.</li>}
            </ul>
          </Card>
          <Card className="p-5 text-sm">
            <h3 className="font-semibold text-slate-900">Audio</h3>
            <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto text-xs text-slate-600">
              {job.files.map((file) => <li key={file.name}>{file.source === 'recorded' ? '🎙' : '📁'} {file.name} · {formatBytes(file.bytes)}</li>)}
            </ul>
          </Card>
          {job.notifications?.length > 0 && (
            <Card className="p-5 text-xs text-slate-600">
              <h3 className="text-sm font-semibold text-slate-900">Emails</h3>
              <ul className="mt-2 space-y-1">{job.notifications.map((note) => <li key={`${note.at}-${note.kind}`}>{formatSgt(note.at)} · {note.kind} → {note.status}{note.error ? ` (${note.error})` : ''}</li>)}</ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Super user: schedule (draft → edit → Publish) ────────────────────────

const LENGTHS = [30, 45, 60, 90, 120, 180, 240];

function timeOf(value) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}

function SlotEditor({ kind = 'test', initial, people, onSave, onCancel, saveLabel }) {
  const [date, setDate] = useState(initial?.start ? SGT_DATE(initial.start) : SGT_DATE(Date.now() + 24 * 3600_000));
  const [time, setTime] = useState(initial?.start ? timeOf(initial.start) : '13:00');
  const [minutes, setMinutes] = useState(initial ? Math.round((Date.parse(initial.end) - Date.parse(initial.start)) / 60000) : 60);
  const [person, setPerson] = useState(initial?.assigneeEmail || '');
  const [name, setName] = useState(initial?.assigneeName || '');
  const known = people.find((entry) => entry.email === person);
  const start = sgtToIso(date, time);
  const end = start ? new Date(Date.parse(start) + minutes * 60_000).toISOString() : '';
  return (
    <form
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[auto_auto_auto_minmax(0,1fr)_auto]"
      onSubmit={(event) => { event.preventDefault(); onSave({ kind, start, end, assigneeEmail: person.trim(), assigneeName: (known?.name || name).trim() }); }}
    >
      <label className="text-xs font-medium text-slate-600">Date (SGT)
        <input type="date" required value={date} onChange={(event) => setDate(event.target.value)} className="mt-1 block h-10 w-full rounded-lg border border-slate-300 px-2 text-sm" />
      </label>
      <label className="text-xs font-medium text-slate-600">Start
        <input type="time" required step={900} value={time} onChange={(event) => setTime(event.target.value)} className="mt-1 block h-10 w-full rounded-lg border border-slate-300 px-2 text-sm" />
      </label>
      <label className="text-xs font-medium text-slate-600">Length
        <select value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} className="mt-1 block h-10 w-full rounded-lg border border-slate-300 px-2 text-sm">
          {[...new Set([...LENGTHS, minutes])].sort((a, b) => a - b).map((value) => <option key={value} value={value}>{value >= 60 ? `${value / 60} h` : `${value} min`}</option>)}
        </select>
      </label>
      <div className="text-xs font-medium text-slate-600">
        Name
        <div className="mt-1 flex gap-2">
          <select value={known ? person : person ? '__typed' : ''} onChange={(event) => { const value = event.target.value; if (value !== '__typed') { setPerson(value); setName(''); } else setPerson(' '); }} className="h-10 min-w-0 flex-1 rounded-lg border border-slate-300 px-2 text-sm">
            <option value="">{kind === 'recording' ? 'Open — a lecturer picks it' : 'Choose a person…'}</option>
            {people.map((entry) => (
              <option key={entry.email} value={entry.email}>{entry.name || entry.email}{entry.approvedVoices.length ? ` · ${entry.approvedVoices.length} approved voice(s)` : ' · not approved yet'}</option>
            ))}
            <option value="__typed">Someone else (type email)…</option>
          </select>
          {!known && person && (
            <input value={person.trim()} onChange={(event) => setPerson(event.target.value)} placeholder="email" type="email" className="h-10 w-44 rounded-lg border border-slate-300 px-2 text-sm" />
          )}
        </div>
      </div>
      <div className="flex items-end gap-2">
        <Button type="submit" variant="dark" disabled={!start || (kind === 'test' && !person.trim())}>{saveLabel}</Button>
        {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  );
}

const SCHEDULE_COPY = {
  recording: {
    title: 'Add a recording session',
    help: 'In-person sessions (no GPU). Leave the name open so a lecturer can pick it, or put someone in it. Sessions may run in parallel. New and edited sessions stay drafts until you publish.',
    footer: 'Lecturers sign in and pick one open session each. The recording page unlocks for them only during it.',
    list: 'Upcoming recording sessions',
    open: 'Open — lecturers can pick',
  },
  test: {
    title: 'Allocate a GPU test slot',
    help: 'After QC, give a lecturer GPU time to test their voices. One person per slot, never overlapping. New and edited slots stay drafts until you publish.',
    footer: 'Publishing emails the person their time. The GPU starts 15 minutes before, loads their voice and emails them that it starts soon.',
    list: 'Upcoming test slots',
    open: '—',
  },
};

function Schedule({ overview, onAction, kind = 'test' }) {
  const copy = SCHEDULE_COPY[kind];
  const [params] = useSearchParams();
  const [editing, setEditing] = useState('');
  const [confirmDelete, setConfirmDelete] = useState('');
  const now = Date.parse(overview.now);
  const prefill = params.get('person') || '';
  const slots = overview.slots.filter((slot) => (slot.kind === 'recording' ? 'recording' : 'test') === kind && Date.parse(slot.end) > now);
  const days = [...new Set(slots.map((slot) => SGT_DATE(slot.start)))];
  const drafts = overview.draftCount || 0;

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold text-slate-900">{copy.title}</h2>
            <p className="mt-1 text-sm text-slate-600">{copy.help}</p>
          </div>
          <Button variant={drafts ? 'success' : 'outline'} size="lg" disabled={!drafts} onClick={() => onAction(publishSlots)}>
            Publish {drafts ? `${drafts} change${drafts === 1 ? '' : 's'}` : '(nothing to publish)'}
          </Button>
        </div>
        <div className="mt-4">
          <SlotEditor
            key={`${kind}-${prefill}`}
            kind={kind}
            initial={prefill ? { assigneeEmail: prefill } : null}
            people={overview.people || []}
            saveLabel={kind === 'recording' ? 'Add session' : 'Add slot'}
            onSave={(slot) => onAction(() => addSlot(slot))}
          />
        </div>
        <p className="mt-3 text-xs text-slate-500">{copy.footer}</p>
      </Card>

      <Card>
        <div className="border-b border-slate-200 px-5 py-3">
          <h2 className="font-semibold text-slate-900">{copy.list}</h2>
        </div>
        {days.length === 0 ? <p className="px-5 py-6 text-sm text-slate-500">No upcoming slots yet.</p> : days.map((day) => {
          const daySlots = slots.filter((slot) => SGT_DATE(slot.start) === day);
          return (
            <div key={day} className="border-b border-slate-100 px-5 py-4 last:border-0">
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">{formatSgt(`${day}T12:00:00+08:00`).split(',')[0]} · {day}</p>
              <div className="relative mt-2 h-8 rounded-lg bg-slate-100" aria-hidden="true">
                {daySlots.map((slot) => {
                  const dayStart = Date.parse(`${day}T00:00:00+08:00`);
                  const span = 24 * 3600_000;
                  const left = ((Date.parse(slot.start) - dayStart) / span) * 100;
                  const width = Math.max(1.5, ((Date.parse(slot.end) - Date.parse(slot.start)) / span) * 100);
                  const live = Date.parse(slot.start) <= now && now < Date.parse(slot.end);
                  return <span key={slot.id} className={cn('absolute top-1 h-6 rounded', live ? 'bg-emerald-500' : slot.status === 'draft' ? 'bg-amber-400' : slot.assigneeEmail ? 'bg-primary/80' : 'bg-sky-300')} style={{ left: `${left}%`, width: `${width}%` }} />;
                })}
              </div>
              <div className="mt-1 flex justify-between text-[10px] text-slate-400"><span>12 am</span><span>6 am</span><span>12 pm</span><span>6 pm</span><span>12 am</span></div>
              <ul className="mt-3 space-y-2">
                {daySlots.map((slot) => (
                  <li key={slot.id} className="rounded-xl border border-slate-200 px-3 py-2">
                    {editing === slot.id ? (
                      <SlotEditor
                        kind={kind}
                        initial={slot}
                        people={overview.people || []}
                        saveLabel="Save"
                        onCancel={() => setEditing('')}
                        onSave={(changes) => onAction(() => editSlot(slot.id, changes)).then((done) => { if (done) setEditing(''); })}
                      />
                    ) : (
                      <div className="flex flex-wrap items-center gap-3 text-sm">
                        <span className="w-36 font-medium text-slate-800">{formatSgt(slot.start, { withDate: false })} – {formatSgt(slot.end, { withDate: false })}</span>
                        <span className="min-w-0 flex-1 text-slate-700">
                          {slot.assigneeEmail ? <>{slot.assigneeName || slot.assigneeEmail} <span className="text-xs text-slate-400">{slot.assigneeEmail}</span></> : <span className="text-sky-700">{copy.open}</span>}
                        </span>
                        <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', slot.status === 'draft' ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800')}>
                          {slot.status === 'draft' ? 'Draft' : 'Published'}
                        </span>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(slot.id)}>Edit</Button>
                        {confirmDelete === slot.id
                          ? <Button size="sm" variant="danger" onClick={() => onAction(() => deleteSlot(slot.id)).then(() => setConfirmDelete(''))}>Confirm delete</Button>
                          : <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(slot.id)} aria-label="Delete slot"><Trash2 size={14} /></Button>}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </Card>
    </div>
  );
}

// ── Testing (both roles) ─────────────────────────────────────────────────

// Chat with the voice, or type text for it to read aloud once (Text to Speech).
function VoiceTester() {
  const [mode, setMode] = useState('chat');
  return (
    <div className="flex h-full min-h-[640px] flex-col">
      <div className="flex gap-1 border-b border-slate-200 bg-slate-50 px-3 py-2" role="tablist" aria-label="How to test">
        {[['chat', 'Chat with your voice'], ['tts', 'Read text aloud']].map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => setMode(value)}
            className={cn('rounded-lg px-3 py-1.5 text-sm font-semibold', mode === value ? 'bg-white text-slate-900 shadow' : 'text-slate-500 hover:text-slate-800')}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        <LivePage key={mode} replyMode="phrases" mode={mode} variant="voice-test" voiceScope="studio" />
      </div>
    </div>
  );
}

function TestBench({ voiceNames, canApply, header }) {
  const [params, setParams] = useSearchParams();
  const requested = params.get('voice') || '';
  const voice = voiceNames.includes(requested) ? requested : voiceNames[0] || '';
  return (
    <div className="space-y-4">
      {header}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-h-[640px] overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <VoiceTester />
        </div>
        <div className="space-y-3">
          {voiceNames.length > 1 && (
            <label className="block text-xs font-medium text-slate-600">Pronunciation list for
              <select value={voice} onChange={(event) => setParams({ voice: event.target.value })} className="mt-1 block h-9 w-full rounded-lg border border-slate-300 px-2 text-sm">
                {voiceNames.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
          )}
          {voice ? <PronunciationPanel voiceName={voice} canApply={canApply} /> : null}
        </div>
      </div>
    </div>
  );
}

function SuperTest({ overview }) {
  const voices = [...new Set(overview.jobs.flatMap(trainedVoices))];
  if (overview.currentSlot) {
    return <Notice tone="warn">Locked: {overview.currentSlot.assigneeName || overview.currentSlot.assigneeEmail} is using the GPU until {formatSgt(overview.currentSlot.end, { withDate: false })} SGT. Testing opens again after that.</Notice>;
  }
  if (voices.length === 0) return <Notice tone="info">No trained voices yet.</Notice>;
  return (
    <TestBench
      voiceNames={voices}
      canApply
      header={<p className="text-sm text-slate-600">Pick a voice in the chat panel. Every trained version is listed, including earlier attempts.</p>}
    />
  );
}

// ── Feedback & super users ───────────────────────────────────────────────

function Stars({ value }) {
  return (
    <span className="inline-flex" aria-label={`${value} of 5`}>
      {[1, 2, 3, 4, 5].map((n) => <Star key={n} size={13} className={n <= value ? 'fill-amber-400 text-amber-400' : 'text-slate-300'} />)}
    </span>
  );
}

function FeedbackList({ overview }) {
  const navigate = useNavigate();
  const items = overview.jobs.flatMap((job) => job.feedback.map((entry) => ({ ...entry, job }))).sort((a, b) => b.at.localeCompare(a.at));
  return (
    <Card>
      <div className="border-b border-slate-200 px-5 py-3"><h2 className="font-semibold text-slate-900">Lecturer feedback</h2></div>
      {items.length === 0 ? <p className="px-5 py-6 text-sm text-slate-500">No feedback yet.</p> : (
        <ul className="divide-y divide-slate-100">
          {items.map((item) => (
            <li key={`${item.job.id}-${item.at}`} className="px-5 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Stars value={item.rating} />
                <span className="font-medium text-slate-800">{who(item.job)}</span>
                <span className="text-xs text-slate-500">{item.job.label} · {formatSgt(item.at)}</span>
                <button type="button" onClick={() => navigate(`/review/${item.job.id}`)} className="ml-auto text-xs font-medium text-primary hover:underline">Open</button>
              </div>
              {item.comment && <p className="mt-1 text-sm text-slate-700">{item.comment}</p>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Superusers({ overview, onAction }) {
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [editing, setEditing] = useState('');
  const [editName, setEditName] = useState('');
  const [confirm, setConfirm] = useState('');
  return (
    <div className="space-y-5">
      <Card className="p-5">
        <h2 className="font-semibold text-slate-900">Add a super user</h2>
        <p className="mt-1 text-sm text-slate-600">Super users review voices, book GPU slots, see all feedback and manage this list. They are emailed when added.</p>
        <form
          className="mt-3 flex flex-wrap gap-2"
          onSubmit={(event) => { event.preventDefault(); onAction(() => addSuperuser(email, name)).then((done) => { if (done) { setEmail(''); setName(''); } }); }}
        >
          <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" required placeholder="name@ntu.edu.sg" aria-label="Email" className="h-10 min-w-[240px] flex-1 rounded-lg border border-slate-300 px-3 text-sm" />
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Name (optional)" aria-label="Name" className="h-10 w-48 rounded-lg border border-slate-300 px-3 text-sm" />
          <Button type="submit" variant="dark"><UserPlus size={15} /> Add</Button>
        </form>
      </Card>
      <Card>
        <ul className="divide-y divide-slate-100">
          {overview.superusers.map((user) => (
            <li key={user.email} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">{(user.name || user.email).slice(0, 2).toUpperCase()}</span>
              <div className="min-w-0 flex-1">
                {editing === user.email ? (
                  <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); onAction(() => renameSuperuser(user.email, editName)).then(() => setEditing('')); }}>
                    <input value={editName} onChange={(event) => setEditName(event.target.value)} aria-label="Name" className="h-8 w-56 rounded-lg border border-slate-300 px-2 text-sm" autoFocus />
                    <Button type="submit" size="sm" variant="dark">Save</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing('')}>Cancel</Button>
                  </form>
                ) : (
                  <>
                    <p className="font-medium text-slate-800">{user.name || user.email} {user.email === auth.user?.email?.toLowerCase() && <span className="text-xs font-normal text-slate-500">(you)</span>}</p>
                    <p className="text-xs text-slate-500">{user.email}{user.locked ? ' · set in server configuration' : user.addedBy ? ` · added by ${user.addedBy}` : ''}</p>
                  </>
                )}
              </div>
              {!user.locked && editing !== user.email && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => { setEditing(user.email); setEditName(user.name || ''); }}>Edit</Button>
                  {confirm === user.email ? (
                    <Button size="sm" variant="danger" onClick={() => onAction(() => removeSuperuser(user.email)).then(() => setConfirm(''))}>Confirm remove</Button>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => setConfirm(user.email)} aria-label={`Remove ${user.email}`}><Trash2 size={14} /></Button>
                  )}
                </>
              )}
              {user.locked && <ShieldCheck size={16} className="text-slate-400" aria-label="Locked" />}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

// ── Super user shell ─────────────────────────────────────────────────────

const SUPER_NAV = [
  ['/', 'Overview', ClipboardCheck],
  ['/sessions', 'Recording sessions', CalendarClock],
  ['/schedule', 'Test slots', CalendarClock],
  ['/record', 'Record a voice', Mic2],
  ['/test', 'Test voices', Mic2],
  ['/feedback', 'Feedback', MessageSquareText],
  ['/superusers', 'Super users', Users],
];

function SuperuserConsole() {
  const auth = useAuth();
  const { data, setData, error, setError } = useOverview();
  const [busy, setBusy] = useState(false);

  // Runs an admin action; the API answers with the fresh overview.
  const onAction = useCallback(async (call) => {
    setBusy(true);
    setError('');
    try {
      const result = await call();
      if (result?.jobs) setData(result);
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, [setData, setError]);

  const reviewCount = data ? data.jobs.filter((job) => job.status === 'review' || job.status === 'failed').length : 0;
  return (
    <div className="flex min-h-screen bg-slate-100">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col bg-slate-950 px-3 py-5 text-white lg:flex">
        <div className="px-2"><Brand product="Voice Studio" tone="dark" /></div>
        <span className="mx-2 mt-4 inline-flex w-fit items-center gap-1 rounded-full bg-amber-400/15 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-amber-300"><ShieldCheck size={12} /> Super user</span>
        <nav className="mt-6 space-y-1">
          {SUPER_NAV.map(([to, label, Icon]) => (
            <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => cn('flex items-center gap-3 rounded-lg px-3 py-2 text-sm', isActive ? 'bg-white/10 font-semibold text-white' : 'text-white/70 hover:bg-white/5 hover:text-white')}>
              <Icon size={16} /> {label}
              {to === '/' && reviewCount > 0 && <span className="ml-auto rounded-full bg-violet-500 px-2 text-[11px] font-semibold">{reviewCount}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto px-2 text-xs text-white/50">
          <p className="truncate">{auth.user?.email}</p>
          <button type="button" onClick={() => auth.signOut()} className="mt-2 text-white/70 hover:text-white">Sign out</button>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <div className="lg:hidden">
          <Header product="Voice Studio · Super user" />
          <nav className="flex gap-1 overflow-x-auto bg-slate-950 px-3 py-2">
            {SUPER_NAV.map(([to, label]) => (
              <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => cn('shrink-0 rounded-md px-3 py-1.5 text-xs', isActive ? 'bg-white/15 text-white' : 'text-white/70')}>{label}</NavLink>
            ))}
          </nav>
        </div>
        <main className="mx-auto max-w-7xl space-y-4 px-4 py-6 sm:px-6">
          {busy && <div className="fixed right-4 top-4 z-50 flex items-center gap-2 rounded-full bg-slate-900 px-3 py-1.5 text-xs text-white shadow"><Loader2 size={13} className="animate-spin" /> Working…</div>}
          {error && <Notice tone="error">{error}</Notice>}
          {data?.currentSlot && (
            <Notice tone="warn" className="flex items-center gap-2">
              <ShieldCheck size={16} className="shrink-0" />
              <span><b>{data.currentSlot.assigneeName || data.currentSlot.assigneeEmail}</b> is testing their voice until {formatSgt(data.currentSlot.end, { withDate: false })} SGT. The GPU is theirs, so voice testing is locked for super users until then. Reviews, scheduling and admin still work.</span>
            </Notice>
          )}
          {!data ? <div className="flex justify-center py-20"><Loader2 className="animate-spin text-slate-400" /></div> : (
            <Routes>
              <Route path="/" element={<Overview overview={data} onAction={onAction} />} />
              <Route path="/review/:jobId" element={<JobDetail overview={data} onAction={onAction} />} />
              <Route path="/schedule" element={<Schedule overview={data} onAction={onAction} kind="test" />} />
              <Route path="/sessions" element={<Schedule key="recording" overview={data} onAction={onAction} kind="recording" />} />
              <Route path="/record" element={<RecordWorkspace embedded />} />
              <Route path="/test" element={<SuperTest overview={data} />} />
              <Route path="/feedback" element={<FeedbackList overview={data} />} />
              <Route path="/superusers" element={<Superusers overview={data} onAction={onAction} />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          )}
        </main>
      </div>
    </div>
  );
}

// ── Lecturer ─────────────────────────────────────────────────────────────

function FeedbackForm({ job }) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [state, setState] = useState('');
  async function submit(event) {
    event.preventDefault();
    setState('saving');
    try {
      await sendFeedback(job.id, rating, comment);
      setState('saved');
      setComment('');
    } catch (err) {
      setState(errorText(err));
    }
  }
  return (
    <Card className="p-5">
      <h3 className="font-semibold text-slate-900">How does it sound?</h3>
      <p className="mt-1 text-sm text-slate-600">Your feedback goes to the Voice Studio team.</p>
      <form onSubmit={submit} className="mt-3 space-y-3">
        <div className="flex gap-1" role="radiogroup" aria-label="Rating">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} star${n > 1 ? 's' : ''}`} onClick={() => setRating(n)} className="rounded p-0.5">
              <Star size={26} className={n <= rating ? 'fill-amber-400 text-amber-400' : 'text-slate-300'} />
            </button>
          ))}
        </div>
        <textarea value={comment} onChange={(event) => setComment(event.target.value)} rows={3} maxLength={2000} placeholder="What sounds right or wrong? Any words it says oddly?" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        <Button type="submit" variant="dark" disabled={!rating || state === 'saving'}>Send feedback</Button>
        {state === 'saved' && <p className="text-sm text-emerald-700">Thank you — sent.</p>}
        {state && !['saving', 'saved'].includes(state) && <p className="text-sm text-rose-600">{state}</p>}
      </form>
    </Card>
  );
}

function useNow(intervalMs = 15_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

function lecturerLine(job, now) {
  if (job.status === 'queued') return job.estimate ? `Queued (#${job.estimate.position}) — training should finish ${formatSgt(job.estimate.finishAt)} SGT (${relativeFromNow(job.estimate.finishAt, now)}).` : 'Queued for training.';
  if (job.status === 'training') return job.estimate ? `Training now — should finish ${formatSgt(job.estimate.finishAt)} SGT (${relativeFromNow(job.estimate.finishAt, now)}).` : 'Training now.';
  if (job.status === 'quality-check') return 'Trained — our team is checking the quality.';
  if (job.status === 'ready') return 'Passed quality check — ready to test in your slot.';
  return '';
}

function MyVoicesStatus({ jobs, now }) {
  const shown = jobs.filter((job) => !['uploading', 'cancelled'].includes(job.status));
  return (
    <Card>
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
        <h2 className="font-semibold text-slate-900">Your voices</h2>
        <span className="text-xs text-slate-500">To record another, book a recording session.</span>
      </div>
      {shown.length === 0 ? <p className="px-5 py-6 text-sm text-slate-500">Nothing submitted yet.</p> : (
        <ul className="divide-y divide-slate-100">
          {shown.map((job) => (
            <li key={job.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><p className="font-medium text-slate-900">{job.label}</p><StatusPill status={job.status} /></div>
                <p className="mt-0.5 text-sm text-slate-600">{lecturerLine(job, now)}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function SessionTable({ me, onChanged }) {
  const auth = useAuth();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [day, setDay] = useState('all');
  const [picking, setPicking] = useState('');
  const [name, setName] = useState(auth.user?.name || '');
  const sessions = me.sessions || [];
  const days = [...new Set(sessions.map((slot) => SGT_DATE(slot.start)))];
  const rows = sessions.filter((slot) => day === 'all' || SGT_DATE(slot.start) === day);
  const hasBooking = sessions.some((slot) => slot.mine);
  async function act(id, call) {
    setBusy(id);
    setError('');
    try {
      onChanged(await call());
      setPicking('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy('');
    }
  }
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-5 py-3">
        <div>
          <h2 className="font-semibold text-slate-900">Recording sessions</h2>
          <p className="text-xs text-slate-500">Pick one open session. The recording page opens for you during it.</p>
        </div>
        <select value={day} onChange={(event) => setDay(event.target.value)} className="h-9 rounded-lg border border-slate-300 px-2 text-sm" aria-label="Filter by date">
          <option value="all">All dates</option>
          {days.map((value) => <option key={value} value={value}>{formatSgt(`${value}T12:00:00+08:00`).split(',')[0]} {value}</option>)}
        </select>
      </div>
      {error && <Notice tone="error" className="mx-5 mt-3">{error}</Notice>}
      {rows.length === 0 ? <p className="px-5 py-6 text-sm text-slate-500">No sessions are published yet — please check back soon.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-[0.06em] text-slate-500">
              <tr><th className="px-5 py-2">Date</th><th className="px-3 py-2">Time (SGT)</th><th className="px-3 py-2">Name</th><th className="px-3 py-2" /></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((slot) => (
                <React.Fragment key={slot.id}>
                  <tr className={slot.mine ? 'bg-emerald-50' : ''}>
                    <td className="px-5 py-2.5 font-medium text-slate-800">{formatSgt(slot.start).split(',')[0]} {SGT_DATE(slot.start)}</td>
                    <td className="px-3 py-2.5">{formatSgt(slot.start, { withDate: false })} – {formatSgt(slot.end, { withDate: false })}</td>
                    <td className="px-3 py-2.5">{slot.mine ? <b className="text-emerald-700">You</b> : slot.open ? <span className="text-sky-700">Open</span> : slot.name}</td>
                    <td className="px-3 py-2.5 text-right">
                      {slot.open && !hasBooking && <Button size="sm" variant="dark" onClick={() => setPicking(picking === slot.id ? '' : slot.id)}>Pick</Button>}
                      {slot.mine && Date.parse(slot.start) > Date.now() && <Button size="sm" variant="ghost" disabled={busy === slot.id} onClick={() => act(slot.id, () => releaseSlot(slot.id))}>Release</Button>}
                    </td>
                  </tr>
                  {picking === slot.id && (
                    <tr className="bg-slate-50">
                      <td colSpan={4} className="px-5 py-3">
                        <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); act(slot.id, () => claimSlot(slot.id, name.trim())); }}>
                          <label className="text-xs font-medium text-slate-600">Your name
                            <input required value={name} onChange={(event) => setName(event.target.value)} maxLength={80} className="mt-1 block h-9 w-56 rounded-lg border border-slate-300 px-2 text-sm" />
                          </label>
                          <label className="text-xs font-medium text-slate-600">Email (your sign-in)
                            <input value={auth.user?.email || me.email} readOnly className="mt-1 block h-9 w-64 rounded-lg border border-slate-200 bg-slate-100 px-2 text-sm text-slate-600" />
                          </label>
                          <Button type="submit" variant="success" disabled={busy === slot.id || !name.trim()}>Confirm this session</Button>
                          <Button variant="ghost" onClick={() => setPicking('')}>Cancel</Button>
                        </form>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function LecturerHome({ me: initialMe, refresh }) {
  const now = useNow();
  const [me, setMe] = useState(initialMe);
  useEffect(() => setMe(initialMe), [initialMe]);
  const ready = me.jobs.filter((job) => job.status === 'ready');
  const submitted = me.jobs.filter((job) => !['uploading', 'cancelled'].includes(job.status));
  const testing = me.activeSlot && Date.parse(me.activeSlot.end) > now ? me.activeSlot : null;
  const testSlot = me.mySlot && !testing ? me.mySlot : null;
  const recording = me.recording || {};
  const recordingOpen = recording.allowed && recording.reason === 'in-session';
  const booked = recording.slot && Date.parse(recording.slot.end) > now ? recording.slot : null;
  const voiceNames = ready.map((job) => job.voiceName).filter(Boolean);
  const [feedbackJob, setFeedbackJob] = useState('');
  const feedbackTarget = ready.find((job) => job.id === feedbackJob) || ready[0];

  // Re-read at session/slot boundaries so pages unlock and lock on time.
  useEffect(() => {
    const times = [testing?.end, testSlot?.start, booked?.start, booked?.end].filter(Boolean).map((value) => Date.parse(value)).filter((value) => value > Date.now());
    if (times.length === 0) return undefined;
    const id = window.setTimeout(refresh, Math.max(1000, Math.min(...times) - Date.now() + 1500));
    return () => window.clearTimeout(id);
  }, [testing, testSlot, booked, refresh]);
  useEffect(() => {
    const id = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  let hero = null;
  if (testing) {
    hero = (
      <>
        <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-gradient-to-r from-emerald-600 to-teal-600 px-5 py-4 text-white">
          <CheckCircle2 size={22} />
          <div className="flex-1">
            <p className="text-lg font-semibold">The GPU is yours until {formatSgt(testing.end, { withDate: false })} SGT</p>
            <p className="text-sm text-white/85">
              {voiceNames.length > 1 ? 'Switch between your voices — the GPU loads the one you pick straight away. ' : ''}
              Chat with your voice, or switch to “Read text aloud” and type anything for it to say.
            </p>
          </div>
        </div>
        {voiceNames.length === 0
          ? <Notice tone="warn">None of your voices has passed the quality check yet, so there is nothing to test in this slot.</Notice>
          : <TestBench voiceNames={voiceNames} canApply header={null} />}
      </>
    );
  } else if (recordingOpen) {
    hero = <RecordWorkspace embedded sessionEnd={recording.slot?.end} onSubmitted={(view) => setMe(view)} />;
  } else {
    let title = '';
    let body = null;
    if (testSlot) {
      title = 'Your voice is ready — your test time is booked';
      body = <><p className="mt-2 text-slate-600"><b>{formatRange(testSlot.start, testSlot.end)}</b> ({relativeFromNow(testSlot.start, now)}).</p><p className="mt-1 text-sm text-slate-500">We email you just before it starts; the GPU warms up with your voice and this page opens the tester automatically.</p></>;
    } else if (ready.length > 0) {
      title = 'Your voice passed quality control';
      body = <p className="mt-2 text-slate-600">Our team will allocate your test time and email you. It will show here too.</p>;
    } else if (submitted.length > 0) {
      title = 'Your voice is on its way';
      body = <p className="mt-2 text-slate-600">Follow its training below. We email you when it passes the quality check, with your test time.</p>;
    } else if (booked) {
      title = 'Your recording session is booked';
      body = <><p className="mt-2 text-slate-600"><b>{formatRange(booked.start, booked.end)}</b> ({relativeFromNow(booked.start, now)}).</p><p className="mt-1 text-sm text-slate-500">The recording page unlocks here when it starts. Meanwhile, read the FAQ and consent form.</p></>;
    } else {
      title = 'Book a recording session';
      body = <p className="mt-2 text-slate-600">Pick an open time below. During your session this page becomes your recording studio.</p>;
    }
    hero = (
      <Card className="p-6 text-center sm:p-8">
        <CalendarClock size={30} className="mx-auto text-slate-400" />
        <h1 className="mt-3 text-2xl font-semibold text-slate-900">{title}</h1>
        {body}
        <a href="/faq" target="_blank" rel="noreferrer" className="mt-4 inline-block text-sm font-semibold text-primary hover:underline">Read the FAQ and consent form</a>
      </Card>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <Header product="Voice Studio" />
      <main className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:px-6">
        {hero}
        <div className={cn('grid gap-5', submitted.length > 0 && 'xl:grid-cols-2')}>
          {submitted.length > 0 && <MyVoicesStatus jobs={me.jobs} now={now} />}
          {!recordingOpen && !testing && <SessionTable me={me} onChanged={setMe} />}
        </div>
        {feedbackTarget && (
          <div className="space-y-2">
            {ready.length > 1 && (
              <select value={feedbackTarget.id} onChange={(event) => setFeedbackJob(event.target.value)} className="h-9 rounded-lg border border-slate-300 px-2 text-sm" aria-label="Feedback for which voice">
                {ready.map((job) => <option key={job.id} value={job.id}>{job.label}</option>)}
              </select>
            )}
            <FeedbackForm key={feedbackTarget.id} job={feedbackTarget} />
          </div>
        )}
      </main>
    </div>
  );
}

// ── Entry ────────────────────────────────────────────────────────────────

function StudioHome() {
  const [me, setMe] = useState(null);
  const [error, setError] = useState('');
  const refresh = useCallback(() => getMe().then(setMe).catch((err) => setError(errorText(err, 'Could not load Voice Studio'))), []);
  useEffect(() => { refresh(); }, [refresh]);
  const role = me?.role;
  const content = useMemo(() => {
    if (!me) return null;
    return role === 'superuser' ? <SuperuserConsole /> : <LecturerHome me={me} refresh={refresh} />;
  }, [me, role, refresh]);

  if (error && !me) return <div className="mx-auto max-w-lg p-8"><Notice tone="error">{error}</Notice></div>;
  if (!me) return <div className="flex min-h-screen items-center justify-center"><Loader2 className="animate-spin text-slate-400" /></div>;
  return content;
}

export default function StudioApp() {
  return (
    <TooltipProvider>
      <PostLoginRedirectHandler />
      <Routes>
        <Route path="/faq" element={<FaqPage />} />
        <Route
          path="/login"
          element={(
            <SignInScreen
              product="Voice Studio"
              headline="Your teaching voice, recorded, trained and tested in one place."
              lines={[
                ['Book a recording session', 'Pick a time; the recording page opens for you then.'],
                ['We train and check it', 'Follow its progress here; we email you when it passes quality control.'],
                ['Test it in your slot', 'The GPU is yours: chat, have it read text aloud, fix pronunciations.'],
              ]}
              accent="from-[#052e2b] via-[#0f3d3a] to-[#1e1b4b]"
            />
          )}
        />
        <Route
          path="*"
          element={(
            <ProtectedRoute>
              <GpuStatusProvider autoStart={false}>
                <StudioHome />
              </GpuStatusProvider>
            </ProtectedRoute>
          )}
        />
      </Routes>
    </TooltipProvider>
  );
}
