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
import {
  addSuperuser, bookSlot, cancelJob, cancelSlot, errorText, formatRange, formatSgt, getMe, getOverview,
  relativeFromNow, removeSuperuser, renameSuperuser, requestRecordings, retryJob, reviewJob, runTick, sendFeedback, sgtToIso,
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
  const needSlot = jobs.filter((job) => job.status === 'approved');
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
          The GPU is reserved for <b>{overview.currentSlot.ownerEmail}</b> ({overview.currentSlot.voiceName}) until {formatSgt(overview.currentSlot.end, { withDate: false })} SGT. Training and other tests wait until then.
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
                {job.status === 'review' && <Button variant="outline" size="sm" onClick={() => navigate(`/test?voice=${encodeURIComponent(job.expName)}`)}><Mic2 size={13} /> Test</Button>}
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
                  <Button variant="success" size="sm" onClick={() => navigate(`/review/${job.id}#slot`)}><CalendarClock size={13} /> Book</Button>
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

function SlotForm({ job, overview, onAction }) {
  const slot = overview.slots.find((item) => item.jobId === job.id);
  const [date, setDate] = useState(() => SGT_DATE(Date.now() + 24 * 3600_000));
  const [time, setTime] = useState('13:00');
  const [minutes, setMinutes] = useState(60);
  if (!['approved', 'scheduled'].includes(job.status)) return null;
  const start = sgtToIso(date, time);
  const end = start ? new Date(Date.parse(start) + minutes * 60_000).toISOString() : '';
  const clash = start && overview.slots.find((item) => item.jobId !== job.id && Date.parse(item.start) < Date.parse(end) && Date.parse(start) < Date.parse(item.end));
  const sameDay = overview.slots.filter((item) => SGT_DATE(item.start) === date).sort((a, b) => a.start.localeCompare(b.start));

  return (
    <Card className="p-5" id="slot">
      <h3 className="font-semibold text-slate-900">Test slot on the GPU</h3>
      {slot ? (
        <div className="mt-2 flex flex-wrap items-center gap-3 rounded-xl bg-emerald-50 px-4 py-3">
          <CheckCircle2 size={18} className="text-emerald-600" />
          <p className="flex-1 text-sm text-emerald-900">Booked: <b>{formatRange(slot.start, slot.end)}</b>. The lecturer was emailed.</p>
          <Button variant="ghost" size="sm" onClick={() => onAction(() => cancelSlot(job.id))}>Cancel slot</Button>
        </div>
      ) : <p className="mt-1 text-sm text-slate-600">Booking emails the lecturer a link and their time. Only one voice can use the GPU at a time.</p>}
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-xs font-medium text-slate-600">Date (SGT)<input type="date" value={date} onChange={(event) => setDate(event.target.value)} className="mt-1 block h-9 rounded-lg border border-slate-300 px-2 text-sm" /></label>
        <label className="text-xs font-medium text-slate-600">Start<input type="time" step={900} value={time} onChange={(event) => setTime(event.target.value)} className="mt-1 block h-9 rounded-lg border border-slate-300 px-2 text-sm" /></label>
        <label className="text-xs font-medium text-slate-600">Length
          <select value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} className="mt-1 block h-9 rounded-lg border border-slate-300 px-2 text-sm">
            {[30, 45, 60, 90, 120, 180, 240].map((value) => <option key={value} value={value}>{value >= 60 ? `${value / 60} h` : `${value} min`}</option>)}
          </select>
        </label>
        <Button variant="success" disabled={!start || Boolean(clash)} onClick={() => onAction(() => bookSlot(job.id, start, end))}>
          <CalendarClock size={15} /> {slot ? 'Move slot' : 'Book & email lecturer'}
        </Button>
      </div>
      {clash && <Notice tone="error" className="mt-3 text-xs">Clashes with {clash.ownerEmail} ({formatRange(clash.start, clash.end)}). Pick another time.</Notice>}
      {sameDay.length > 0 && (
        <div className="mt-3 text-xs text-slate-600">
          <p className="font-medium">Already booked that day:</p>
          <ul className="mt-1 space-y-0.5">{sameDay.map((item) => <li key={item.id}>• {formatSgt(item.start, { withDate: false })}–{formatSgt(item.end, { withDate: false })} · {item.ownerEmail}</li>)}</ul>
        </div>
      )}
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
                  <Button key={name} variant={name === job.expName ? 'dark' : 'outline'} size="sm" onClick={() => navigate(`/test?voice=${encodeURIComponent(name)}`)}>
                    <Mic2 size={13} /> Test {name}
                  </Button>
                ))}
              </div>
            </Card>
          )}
          <ReviewForm job={job} reasons={overview.rejectReasons} maxAttempts={overview.maxAttempts} onAction={onAction} />
          <SlotForm job={job} overview={overview} onAction={onAction} />
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

// ── Super user: schedule ─────────────────────────────────────────────────

function Schedule({ overview }) {
  const navigate = useNavigate();
  const now = Date.parse(overview.now);
  const upcoming = overview.slots.filter((slot) => Date.parse(slot.end) > now).sort((a, b) => a.start.localeCompare(b.start));
  const days = [...new Set(upcoming.map((slot) => SGT_DATE(slot.start)))];
  const jobsById = new Map(overview.jobs.map((job) => [job.id, job]));
  return (
    <Card>
      <div className="border-b border-slate-200 px-5 py-3">
        <h2 className="font-semibold text-slate-900">GPU test schedule</h2>
        <p className="text-xs text-slate-500">One voice per slot. Book from a voice's page (Overview → Approved).</p>
      </div>
      {days.length === 0 ? <p className="px-5 py-6 text-sm text-slate-500">No upcoming slots.</p> : days.map((day) => (
        <div key={day} className="border-b border-slate-100 px-5 py-3 last:border-0">
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">{formatSgt(`${day}T12:00:00+08:00`).split(',')[0]} {day}</p>
          <div className="relative mt-2 h-10 rounded-lg bg-slate-100" aria-hidden="true">
            {upcoming.filter((slot) => SGT_DATE(slot.start) === day).map((slot) => {
              const dayStart = Date.parse(`${day}T07:00:00+08:00`);
              const span = 14 * 3600_000; // 07:00–21:00
              const left = Math.max(0, (Date.parse(slot.start) - dayStart) / span) * 100;
              const width = Math.max(2, ((Date.parse(slot.end) - Date.parse(slot.start)) / span) * 100);
              const live = Date.parse(slot.start) <= now && now < Date.parse(slot.end);
              return <span key={slot.id} className={cn('absolute top-1 h-8 rounded-md', live ? 'bg-emerald-500' : 'bg-primary/70')} style={{ left: `${left}%`, width: `${width}%` }} />;
            })}
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-slate-400"><span>7 am</span><span>2 pm</span><span>9 pm</span></div>
          <ul className="mt-2 space-y-1">
            {upcoming.filter((slot) => SGT_DATE(slot.start) === day).map((slot) => {
              const job = jobsById.get(slot.jobId);
              return (
                <li key={slot.id} className="flex items-center gap-3 text-sm">
                  <span className="w-36 text-slate-600">{formatSgt(slot.start, { withDate: false })} – {formatSgt(slot.end, { withDate: false })}</span>
                  <span className="flex-1 font-medium text-slate-800">{job ? who(job) : slot.ownerEmail} <span className="font-normal text-slate-500">· {slot.voiceName}</span></span>
                  <button type="button" onClick={() => navigate(`/review/${slot.jobId}`)} className="text-xs font-medium text-primary hover:underline">Open</button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </Card>
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
    return <Notice tone="warn">The GPU is reserved for {overview.currentSlot.ownerEmail} until {formatSgt(overview.currentSlot.end, { withDate: false })} SGT. Testing other voices opens after that.</Notice>;
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
  ['/schedule', 'Schedule', CalendarClock],
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
          {!data ? <div className="flex justify-center py-20"><Loader2 className="animate-spin text-slate-400" /></div> : (
            <Routes>
              <Route path="/" element={<Overview overview={data} onAction={onAction} />} />
              <Route path="/review/:jobId" element={<JobDetail overview={data} onAction={onAction} />} />
              <Route path="/schedule" element={<Schedule overview={data} />} />
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

function LecturerHome({ me, refresh }) {
  const now = useNow();
  const ready = me.jobs.filter((job) => job.status === 'scheduled' && job.slot);
  const active = ready.find((job) => Date.parse(job.slot.start) <= now && now < Date.parse(job.slot.end));
  const upcoming = ready.filter((job) => Date.parse(job.slot.start) > now).sort((a, b) => a.slot.start.localeCompare(b.slot.start));
  const pending = me.jobs.filter((job) => ['queued', 'training', 'quality-check'].includes(job.status));
  const recordUrl = String(import.meta.env.VITE_RECORD_APP_URL || '').replace(/\/+$/u, '');

  // Re-read at the slot boundary so the chat opens/closes on time.
  useEffect(() => {
    const boundary = active ? Date.parse(active.slot.end) : upcoming[0] ? Date.parse(upcoming[0].slot.start) : 0;
    if (!boundary) return undefined;
    const id = window.setTimeout(refresh, Math.max(1000, boundary - Date.now() + 1500));
    return () => window.clearTimeout(id);
  }, [active, upcoming, refresh]);

  return (
    <div className="min-h-screen bg-slate-50">
      <Header product="Voice Studio" />
      <main className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:px-6">
        {active ? (
          <>
            <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-gradient-to-r from-emerald-600 to-teal-600 px-5 py-4 text-white">
              <CheckCircle2 size={22} />
              <div className="flex-1">
                <p className="text-lg font-semibold">Your voice is live — the GPU is yours until {formatSgt(active.slot.end, { withDate: false })} SGT</p>
                <p className="text-sm text-white/85">Chat with it, or switch to “Read text aloud” and type anything for it to say. Fix any word it says oddly on the right.</p>
              </div>
            </div>
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
              <div className="min-h-[640px] overflow-hidden rounded-2xl border border-slate-200 bg-white">
                <VoiceTester />
              </div>
              <div className="space-y-4">
                <PronunciationPanel voiceName={active.voiceName} canApply />
                <FeedbackForm job={active} />
              </div>
            </div>
          </>
        ) : (
          <Card className="p-8 text-center">
            <Mic2 size={30} className="mx-auto text-slate-400" />
            {upcoming[0] ? (
              <>
                <h1 className="mt-3 text-2xl font-semibold text-slate-900">Your voice is ready to test</h1>
                <p className="mt-2 text-slate-600">Your reserved time is <b>{formatRange(upcoming[0].slot.start, upcoming[0].slot.end)}</b> ({relativeFromNow(upcoming[0].slot.start, now)}).</p>
                <p className="mt-1 text-sm text-slate-500">Come back then — this page opens the chat automatically when your time starts.</p>
              </>
            ) : pending.length > 0 ? (
              <>
                <h1 className="mt-3 text-2xl font-semibold text-slate-900">Your voice is on its way</h1>
                <p className="mt-2 text-slate-600">
                  {pending.some((job) => job.status === 'quality-check') ? 'It has trained and our team is checking the quality.' : 'It is in the training queue.'}
                  {' '}We will email you with a time to test it.
                </p>
              </>
            ) : (
              <>
                <h1 className="mt-3 text-2xl font-semibold text-slate-900">No voice to test yet</h1>
                <p className="mt-2 text-slate-600">Record or upload your voice first. We email you when it is ready.</p>
                {recordUrl && <a href={recordUrl} className="mt-4 inline-flex h-10 items-center rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white">Record your voice</a>}
              </>
            )}
          </Card>
        )}

        {ready.filter((job) => job !== active).length > 0 && (
          <Card>
            <div className="border-b border-slate-200 px-5 py-3"><h2 className="font-semibold text-slate-900">Your voices</h2></div>
            <ul className="divide-y divide-slate-100">
              {ready.filter((job) => job !== active).map((job) => (
                <li key={job.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                  <span className="flex-1 font-medium text-slate-800">{job.label}</span>
                  <span className="text-slate-600">{formatRange(job.slot.start, job.slot.end)}</span>
                  {Date.parse(job.slot.end) <= now && <span className="text-xs text-slate-400">ended</span>}
                </li>
              ))}
            </ul>
          </Card>
        )}
        {!active && ready.some((job) => Date.parse(job.slot.end) <= now) && <FeedbackForm job={ready.find((job) => Date.parse(job.slot.end) <= now)} />}
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
        <Route
          path="/login"
          element={(
            <SignInScreen
              product="Voice Studio"
              headline="Hear your cloned voice, and shape how it speaks."
              lines={[
                ['Your reserved time', 'During your booked slot the GPU runs only your voice.'],
                ['Talk and listen', 'Chat with your voice or have it read text aloud.'],
                ['Tune it', 'Fix how it says any word, then tell us what you think.'],
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
