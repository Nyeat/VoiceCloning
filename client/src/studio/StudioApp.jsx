// Voice Studio: one site, two very different experiences.
//  - Super users get a console: review trained voices, approve or send back
//    for a retrain, book the single GPU's test slots (clashes refused), test
//    any voice, read lecturer feedback and manage other super users.
//  - Lecturers get one simple page: their approved voice, usable only inside
//    the slot booked for them, with its own pronunciation list and feedback.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  CalendarCheck, CalendarClock, CheckCircle2, ChevronDown, ClipboardCheck, Cpu, Loader2, MessageSquareText, Mic2, RefreshCw, ShieldCheck,
  Star, ThumbsDown, ThumbsUp, Trash2, UserPlus, Users, X,
} from 'lucide-react';
import { PostLoginRedirectHandler, ProtectedRoute } from '@/auth/AppAuthGate';
import { useAuth } from '@/auth/useAuth';
import { TooltipProvider } from '@/components/ui/tooltip';
import { GpuStatusProvider } from '@/lib/gpuStatus.jsx';
import { cn } from '@/lib/utils';
import { getMyVoiceProfiles } from '@/services/api';
import VoiceTestBench from './VoiceTestBench.jsx';
import { RecordWorkspace } from './RecordApp.jsx';
import { TrainingSettings, trainingSettingsPayload } from './TrainingSettings.jsx';
import { FaqList, FaqPage } from './ConsentAndFaq.jsx';
import { saveStudioSession } from '@/auth/studioSession.js';
import { DayTimeline, Legend, MonthCalendar, TONES } from './SlotCalendar.jsx';
import {
  dayHours, formatDay, formatLength, formatMinutes, monthOf, sgtDayKey, sgtIso, sgtMinutes,
} from './slotCalendar.js';
import {
  addSlot, addSuperuser, cancelJob, claimSlot, completeSlot, restoreJob, sendTestEmail, deleteSlot, editSlot, errorText, formatRange, formatSgt, getMe, getOverview,
  googleSignIn, moveSlot, passwordSignIn, publishSlots, relativeFromNow, releaseSlot, removeSuperuser, renameSuperuser, requestRecordings, retryJob, reviewJob,
  runTick, sendFeedback,
} from './studioApi.js';
import {
  Brand, Button, Card, Header, Notice, SignInScreen, StatusPill, formatBytes,
} from './StudioChrome.jsx';

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
    <Card className="flex min-w-0 items-center gap-3 p-3 sm:p-4">
      <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl sm:h-10 sm:w-10', tones[tone])}><Icon size={18} /></span>
      <div className="min-w-0">
        <p className="text-xl font-semibold text-slate-900 sm:text-2xl">{value}</p>
        <p className="line-clamp-3 text-xs leading-4 text-slate-500" title={label}>{label}</p>
      </div>
    </Card>
  );
}

// Sends a test email to the signed-in super user and says what happened.
function TestEmail() {
  const [state, setState] = useState(null);
  async function send() {
    setState({ busy: true });
    try {
      const result = await sendTestEmail();
      setState(result.status === 'sent' ? { ok: `Sent to ${result.to}. Check the inbox (and spam).` } : { error: `Not sent: ${result.error || result.status}` });
    } catch (err) {
      setState({ error: errorText(err) });
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <Button variant="outline" size="sm" disabled={state?.busy} onClick={send}>{state?.busy ? <Loader2 size={13} className="animate-spin" /> : null} Send me a test email</Button>
      {state?.ok && <span className="text-emerald-700">{state.ok}</span>}
      {state?.error && <span className="text-rose-700">{state.error}</span>}
    </div>
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
  const recordingSlots = overview.slots.filter((slot) => slot.kind === 'recording' && Date.parse(slot.end) > now);
  const recordingBooked = recordingSlots.filter((slot) => slot.assigneeEmail).sort((a, b) => a.start.localeCompare(b.start));
  const recordingOpen = recordingSlots.filter((slot) => !slot.assigneeEmail && slot.status === 'published').length;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-2 sm:gap-3 xl:grid-cols-5 [&>*:last-child:nth-child(odd)]:col-span-2 xl:[&>*:last-child:nth-child(odd)]:col-span-1">
        <StatCard icon={CalendarCheck} label="Recording sessions booked" value={recordingBooked.length} tone="slate" />
        <StatCard icon={ClipboardCheck} label="Waiting for your review" value={review.length} tone="violet" />
        <StatCard icon={CalendarClock} label="Approved, need a slot" value={needSlot.length} tone="emerald" />
        <StatCard icon={Cpu} label={training ? `Training: ${who(training)}` : 'Training GPU idle'} value={training ? 1 : 0} tone="blue" />
        <StatCard icon={Users} label="In the training queue" value={queue.length} tone="amber" />
      </div>

      {!overview.emailConfigured && (
        <Notice tone="warn">Email is not configured on the server yet, so nobody is emailed. Everything still shows here — check this page for reviews.</Notice>
      )}
      {overview.emailConfigured && <TestEmail />}
      {overview.currentSlot && (
        <Notice tone="info">
          Training waits while <b>{overview.currentSlot.assigneeName || overview.currentSlot.assigneeEmail}</b> tests until {formatSgt(overview.currentSlot.end, { withDate: false })} SGT.
        </Notice>
      )}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 border-b border-slate-200 px-4 py-3 sm:px-5">
          <h2 className="font-semibold text-slate-900">Needs your review</h2>
          <span className="text-xs text-slate-500">Listen, then approve or send back</span>
        </div>
        {review.length === 0 ? <p className="px-4 py-6 text-sm text-slate-500 sm:px-5">Nothing waiting. You will get an email when a voice finishes training.</p> : (
          <ul className="divide-y divide-slate-100">
            {review.map((job) => (
              <li key={job.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-5">
                <div className="min-w-0 flex-1 basis-56">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p className="min-w-0 font-medium text-slate-900 [overflow-wrap:anywhere]">{who(job)}</p>
                    <StatusPill status={job.status} />
                  </div>
                  <p className="text-sm text-slate-600 [overflow-wrap:anywhere]">{job.label}{job.error ? ` — ${job.error}` : ''}</p>
                  <p className="text-xs text-slate-500 [overflow-wrap:anywhere]">attempt {job.attempt} · {job.expName}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {job.status === 'review' && <Button variant="outline" size="sm" onClick={() => navigate(`/test?voice=${encodeURIComponent(job.expName)}`)}><Mic2 size={13} /> Test</Button>}
                  <Button variant="dark" size="sm" onClick={() => navigate(`/review/${job.id}`)}>Open</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <h2 className="font-semibold text-slate-900">Booked recording sessions</h2>
            <p className="text-xs text-slate-500">{recordingOpen} open session{recordingOpen === 1 ? '' : 's'} not picked yet</p>
          </div>
          <Button variant="dark" size="sm" onClick={() => navigate('/sessions')}><CalendarClock size={13} /> Add &amp; publish</Button>
        </div>
        {recordingBooked.length === 0 ? <p className="px-4 py-6 text-sm text-slate-500 sm:px-5">Nobody has a recording session booked yet.</p> : (
          <ul className="divide-y divide-slate-100">
            {recordingBooked.map((slot) => {
              const live = Date.parse(slot.start) <= now;
              return (
                <li key={slot.id} className="flex items-start gap-3 px-4 py-2.5 text-sm sm:items-center sm:px-5">
                  <span className={cn('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full sm:mt-0', live ? 'bg-rose-500' : 'bg-indigo-500')} />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
                    <span className="font-medium text-slate-800 sm:w-48 sm:shrink-0">{formatSgt(slot.start)} – {formatSgt(slot.end, { withDate: false })}</span>
                    <span className="min-w-0 flex-1 truncate" title={slot.assigneeEmail}>{slot.assigneeName || slot.assigneeEmail} {slot.assigneeName && <span className="text-xs text-slate-400">{slot.assigneeEmail}</span>}</span>
                    <span className="text-xs text-slate-500 sm:text-right">{live ? 'recording now' : relativeFromNow(slot.start, now)}{slot.claimedAt ? ' · picked by them' : ' · assigned'}{slot.hostName ? ` · run by ${slot.hostName}` : ''}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Card>
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
            <h2 className="font-semibold text-slate-900">Training queue</h2>
            <Button variant="ghost" size="sm" onClick={() => onAction(runTick)}><RefreshCw size={13} /> Check now</Button>
          </div>
          <div className="px-4 py-2 text-xs text-slate-500 [overflow-wrap:anywhere] sm:px-5">
            GPU trainer: {overview.worker.reachable ? `${overview.worker.status}${overview.worker.expName ? ` (${overview.worker.expName})` : ''}` : 'off or starting — it is started automatically when work is queued'}
            {' · '}~{overview.trainingMinutes} min per voice
          </div>
          <ol className="divide-y divide-slate-100">
            {[training, ...queue].filter(Boolean).map((job) => (
              <li key={job.id} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
                <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold', job.status === 'training' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600')}>
                  {job.status === 'training' ? <Loader2 size={13} className="animate-spin" /> : job.estimate?.position}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">{who(job)} <span className="font-normal text-slate-500">· {job.label}{job.attempt > 1 ? ` · retrain ${job.attempt}` : ''}</span></p>
                  {job.estimate && <p className="text-xs text-slate-500">{job.status === 'training' ? 'finishes' : 'starts'} {formatSgt(job.status === 'training' ? job.estimate.finishAt : job.estimate.startAt)} · done {relativeFromNow(job.estimate.finishAt)}</p>}
                  {job.error && job.status === 'queued' && <p className="text-xs text-amber-700">{job.error}</p>}
                </div>
                <button type="button" onClick={() => navigate(`/review/${job.id}`)} className="shrink-0 rounded-lg px-2 py-2 text-xs font-medium text-primary hover:underline">Details</button>
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
                <li key={job.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-5">
                  <div className="min-w-0 flex-1 basis-40">
                    <p className="font-medium text-slate-900 [overflow-wrap:anywhere]">{who(job)}</p>
                    <p className="text-xs text-slate-500 [overflow-wrap:anywhere]">{job.label} · {job.approvedExpName}</p>
                  </div>
                  <Button variant="success" size="sm" onClick={() => navigate(`/schedule?person=${encodeURIComponent(job.ownerEmail)}`)}><CalendarClock size={13} /> Give a slot</Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <VoicesByStage jobs={jobs} />
    </div>
  );
}

// Every voice, grouped by where it is. Each stage is collapsible; the ones
// that need someone (waiting to train, quality check) are open and marked.
const STAGES = [
  { key: 'queued', title: 'Waiting to train', statuses: ['queued'], tone: 'amber', open: true },
  { key: 'training', title: 'Training now', statuses: ['training'], tone: 'blue', open: true },
  { key: 'qc', title: 'Quality check', statuses: ['review', 'failed'], tone: 'violet', open: true },
  { key: 'approved', title: 'Approved — needs a test slot', statuses: ['approved'], tone: 'emerald', open: false },
  { key: 'scheduled', title: 'Test slot booked', statuses: ['scheduled'], tone: 'emerald', open: false },
  { key: 'uploading', title: 'Not submitted yet', statuses: ['uploading'], tone: 'slate', open: false },
  { key: 'cancelled', title: 'Withdrawn', statuses: ['cancelled'], tone: 'slate', open: false },
];
const STAGE_TONES = {
  amber: 'border-amber-300 bg-amber-50/70', blue: 'border-blue-200 bg-blue-50/50', violet: 'border-violet-200 bg-violet-50/50',
  emerald: 'border-slate-200 bg-white', slate: 'border-slate-200 bg-white',
};
const STAGE_DOTS = { amber: 'bg-amber-500', blue: 'bg-blue-500', violet: 'bg-violet-500', emerald: 'bg-emerald-500', slate: 'bg-slate-300' };

function VoicesByStage({ jobs }) {
  const navigate = useNavigate();
  return (
    <Card>
      <div className="border-b border-slate-200 px-5 py-3">
        <h2 className="font-semibold text-slate-900">Voices by stage</h2>
        <p className="text-xs text-slate-500">Each lecturer's submitted recordings, from waiting to train through to testing.</p>
      </div>
      <div className="space-y-2 p-3">
        {STAGES.map((stage) => {
          const items = jobs.filter((job) => stage.statuses.includes(job.status))
            .sort((a, b) => String(a.queuedAt || a.createdAt).localeCompare(String(b.queuedAt || b.createdAt)));
          if (items.length === 0 && !stage.open) return null;
          const highlight = stage.key === 'queued' && items.length > 0;
          return (
            <details key={stage.key} open={stage.open && items.length > 0} className={cn('group rounded-xl border', highlight ? STAGE_TONES.amber : STAGE_TONES[stage.tone])}>
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 px-4 py-2.5 [&::-webkit-details-marker]:hidden">
                <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', STAGE_DOTS[stage.tone])} />
                <span className={cn('min-w-0 text-sm font-semibold', highlight ? 'text-amber-900' : 'text-slate-800')}>{stage.title}</span>
                <span className={cn('shrink-0 rounded-full px-2 text-xs font-semibold', highlight ? 'bg-amber-500 text-white' : 'bg-slate-100 text-slate-600')}>{items.length}</span>
                <ChevronDown size={15} className="ml-auto shrink-0 text-slate-400 transition group-open:rotate-180" />
              </summary>
              {items.length === 0 ? <p className="px-4 pb-3 text-xs text-slate-500">None.</p> : (
                <ul className="divide-y divide-slate-100 border-t border-slate-100 bg-white/70">
                  {items.map((job) => (
                    <li key={job.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                      <div className="min-w-0 flex-1 basis-56">
                        <p className="font-medium text-slate-800 [overflow-wrap:anywhere]">{who(job)} <span className="font-normal text-slate-500">· {job.label}</span></p>
                        <p className="text-xs text-slate-500 [overflow-wrap:anywhere]">
                          {job.ownerEmail} · {job.expName}{job.attempt > 1 ? ` · attempt ${job.attempt}` : ''} · {job.files.length} files, {formatBytes(job.totalBytes)}
                          {job.estimate?.finishAt ? ` · done ${relativeFromNow(job.estimate.finishAt)}` : ''}
                        </p>
                      </div>
                      <span className="text-xs text-slate-500">{formatSgt(job.queuedAt || job.createdAt)}</span>
                      <button type="button" onClick={() => navigate(`/review/${job.id}`)} className="ml-auto rounded-lg px-2 py-1.5 text-xs font-medium text-primary hover:underline">Open</button>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          );
        })}
      </div>
    </Card>
  );
}

// ── Super user: one job ──────────────────────────────────────────────────

function ReviewForm({ job, reasons, maxAttempts, onAction }) {
  const [mode, setMode] = useState('');
  const [picked, setPicked] = useState([]);
  const [notes, setNotes] = useState('');
  // Noise removal follows the recipe ("Noisy" turns it on) until the reviewer sets it.
  const [settings, setSettings] = useState({});
  const effective = { ...settings, skipDenoise: settings.skipDenoise ?? !picked.includes('noisy') };
  const atLimit = job.attempt >= maxAttempts;

  if (job.status !== 'review') return null;
  return (
    <Card className="p-4 sm:p-5">
      <h3 className="font-semibold text-slate-900">Quality decision</h3>
      <p className="mt-1 text-sm text-slate-600">Test the voice first (chat or text-to-speech), then decide.</p>
      <div className="mt-4 grid gap-2 sm:flex sm:flex-wrap">
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
              <label key={key} className="flex min-h-9 items-center gap-2.5 text-sm text-slate-700">
                <input type="checkbox" className="h-4 w-4 shrink-0" checked={picked.includes(key)} onChange={(event) => setPicked(event.target.checked ? [...picked, key] : picked.filter((item) => item !== key))} />
                {label}
              </label>
            ))}
          </div>
          <ul className="text-xs leading-5 text-slate-600">
            <li>• Not like the speaker → more SoVITS (timbre) training.</li>
            <li>• Mispronounces / robotic → more GPT (words and rhythm) training.</li>
            <li>• Noisy → turns noise removal on and trains a little less, so noise is not learned. Otherwise noise removal stays off.</li>
            <li>• The retrain is a new voice version; this one is kept for comparison.</li>
          </ul>
          <details className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm" open>
            <summary className="cursor-pointer py-1 text-xs font-semibold text-slate-600">Retrain settings (last run: SoVITS {job.trainingConfig?.sovitsEpochs}, GPT {job.trainingConfig?.gptEpochs}, batch {job.trainingConfig?.batchSize ?? 'default'}, noise removal {job.trainingConfig?.skipDenoise ? 'off' : 'on'})</summary>
            <p className="mt-1 text-xs text-slate-500">Blank numbers follow the recipe above.</p>
            <div className="mt-2"><TrainingSettings
              value={effective}
              current={job.trainingConfig}
              onChange={(next) => setSettings((prev) => ({ ...prev, ...next, skipDenoise: next.skipDenoise === effective.skipDenoise ? prev.skipDenoise : next.skipDenoise }))}
            /></div>
          </details>
          {atLimit && <Notice tone="warn" className="text-xs">This is attempt {job.attempt} of {maxAttempts}. Another retrain rarely helps — consider asking for new recordings. You can still force it.</Notice>}
          <Button
            variant="danger"
            onClick={() => onAction(() => reviewJob(job.id, {
              decision: 'reject',
              reasons: picked,
              notes,
              overrides: { ...trainingSettingsPayload(effective), ...(atLimit ? { force: true } : {}) },
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
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const job = overview.jobs.find((item) => item.id === jobId);
  if (!job) return <Notice tone="warn">That recording set was not found. <button type="button" className="underline" onClick={() => navigate('/')}>Back</button></Notice>;
  const voices = trainedVoices(job);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-64">
          <button type="button" onClick={() => navigate('/')} className="-ml-1 rounded-lg px-1 py-1.5 text-xs font-medium text-primary hover:underline">← Overview</button>
          <h2 className="mt-0.5 text-lg font-semibold text-slate-900 [overflow-wrap:anywhere] sm:text-xl">{who(job)} · {job.label}</h2>
          <p className="text-sm text-slate-500 [overflow-wrap:anywhere]">{job.ownerEmail} · attempt {job.attempt} · current voice {job.expName}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={job.status} />
          {job.status === 'failed' && <Button variant="dark" size="sm" onClick={() => onAction(() => retryJob(job.id))}><RefreshCw size={13} /> Retry training</Button>}
          {!['training', 'cancelled'].includes(job.status) && !confirmWithdraw && <Button variant="ghost" size="sm" onClick={() => setConfirmWithdraw(true)}><X size={13} /> Withdraw set</Button>}
          {job.status === 'cancelled' && <Button variant="dark" size="sm" onClick={() => onAction(() => restoreJob(job.id))}><RefreshCw size={13} /> Restore set</Button>}
        </div>
      </div>

      {confirmWithdraw && (
        <Notice tone="warn" className="space-y-2">
          <p className="font-semibold [overflow-wrap:anywhere]">Withdraw {who(job)}'s set "{job.label}"?</p>
          <ul className="list-disc space-y-0.5 pl-5 text-sm">
            <li>It leaves {job.status === 'queued' ? 'the training queue' : job.status === 'review' || job.status === 'failed' ? 'quality check' : 'its current stage'} and moves to "Withdrawn"; it will not train or be tested.</li>
            <li>{who(job)} is not emailed, and may book a new recording session.</li>
            <li>Nothing is deleted: the recordings and trained voices are kept, and "Restore set" puts it back where it was.</li>
          </ul>
          <div className="flex gap-2 pt-1">
            <Button variant="danger" size="sm" onClick={() => { setConfirmWithdraw(false); onAction(() => cancelJob(job.id)); }}>Withdraw set</Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmWithdraw(false)}>Keep it</Button>
          </div>
        </Notice>
      )}

      {job.estimate && ['queued', 'training'].includes(job.status) && (
        <Notice tone="info">Estimated finish {formatSgt(job.estimate.finishAt)} SGT ({relativeFromNow(job.estimate.finishAt)}).</Notice>
      )}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-5">
          {voices.length > 0 && (
            <Card className="p-5">
              <h3 className="font-semibold text-slate-900">Trained versions</h3>
              <div className="mt-3 flex flex-wrap gap-2">
                {voices.map((name) => (
                  <Button key={name} variant={name === job.expName ? 'dark' : 'outline'} size="sm" title={name} onClick={() => navigate(`/test?voice=${encodeURIComponent(name)}`)}>
                    <Mic2 size={13} className="shrink-0" /> <span className="truncate">Test {name}</span>
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
                    <p className="mb-1 text-xs text-slate-500">{formatSgt(entry.at)}</p>
                    <FeedbackEntry entry={entry} overview={overview} />
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
                  <p className="font-medium [overflow-wrap:anywhere]">Attempt {attempt.attempt}: {attempt.result} <span className="text-xs text-slate-500">({attempt.expName})</span></p>
                  <p className="text-xs text-slate-500">SoVITS {attempt.config?.sovitsEpochs} · GPT {attempt.config?.gptEpochs} epochs · denoise {attempt.config?.skipDenoise ? 'off' : 'on'} · {formatSgt(attempt.finishedAt)}</p>
                  {attempt.error && <p className="text-xs text-rose-600">{attempt.error}</p>}
                </li>
              ))}
              {job.reviews.map((entry) => (
                <li key={entry.at} className="rounded-lg border border-slate-200 px-3 py-2">
                  <p className="font-medium [overflow-wrap:anywhere]">{entry.decision} by {entry.reviewer}</p>
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
              {job.files.map((file) => <li key={file.name} className="[overflow-wrap:anywhere]">{file.source === 'recorded' ? '🎙' : '📁'} {file.name} · {formatBytes(file.bytes)}</li>)}
            </ul>
          </Card>
          {job.notifications?.length > 0 && (
            <Card className="p-5 text-xs text-slate-600">
              <h3 className="text-sm font-semibold text-slate-900">Emails</h3>
              <ul className="mt-2 space-y-1">{job.notifications.map((note) => <li key={`${note.at}-${note.kind}`} className="[overflow-wrap:anywhere]">{formatSgt(note.at)} · {note.kind} → {note.status}{note.error ? ` (${note.error})` : ''}</li>)}</ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Super user: schedule (calendar; draft → edit → Publish) ───────────────

const LENGTHS = [30, 45, 60, 90, 120, 180, 240];
const START_STEPS = Array.from({ length: 96 }, (_, i) => i * 15);

function slotTone(slot, now) {
  if (Date.parse(slot.start) <= now && now < Date.parse(slot.end)) return 'live';
  if (slot.status === 'draft') return 'draft';
  return slot.assigneeEmail ? 'booked' : 'open';
}

function PersonField({ kind, people, person, onPerson }) {
  const known = people.find((entry) => entry.email === person);
  const typing = !known && person !== '';
  return (
    <div className="text-xs font-medium text-slate-600">
      {kind === 'recording' ? 'Who (optional)' : 'Who'}
      <select
        value={known ? person : typing ? '__typed' : ''}
        onChange={(event) => { const value = event.target.value; onPerson(value === '__typed' ? ' ' : value); }}
        className="mt-1 block h-10 w-full rounded-lg border border-slate-300 px-2 text-sm"
      >
        <option value="">{kind === 'recording' ? 'Open — a lecturer picks it' : 'Choose a person…'}</option>
        {people.map((entry) => (
          <option key={entry.email} value={entry.email}>{entry.name || entry.email}{entry.approvedVoices.length ? ` · ${entry.approvedVoices.length} approved voice(s)` : ' · not approved yet'}</option>
        ))}
        <option value="__typed">Someone else (type email)…</option>
      </select>
      {typing && (
        <input value={person.trim()} onChange={(event) => onPerson(event.target.value || ' ')} placeholder="their email" type="email" autoFocus className="mt-2 block h-10 w-full rounded-lg border border-slate-300 px-2 text-sm" />
      )}
    </div>
  );
}

const HOST_KEY = 'voice-studio-host-name';
function rememberedHost() {
  try { return window.localStorage.getItem(HOST_KEY) || ''; } catch { return ''; }
}
function rememberHost(name) {
  try { if (name) window.localStorage.setItem(HOST_KEY, name); } catch { /* private mode */ }
}

function SlotComposer({ kind, draft, setDraft, people, onSave, onDelete, onCancel }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const person = draft.person || '';
  const canSave = kind !== 'test' || person.trim();
  const end = draft.start + draft.minutes;
  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">{draft.id ? 'Edit' : 'New'} {kind === 'recording' ? 'recording session' : 'test slot'}</p>
          <p className="text-sm font-semibold text-slate-900">{formatDay(draft.day)} · {formatMinutes(draft.start)} – {formatMinutes(end % (24 * 60))}</p>
        </div>
        <button type="button" onClick={onCancel} className="-m-1 shrink-0 rounded-lg p-2 text-slate-400 hover:bg-slate-200" aria-label="Close"><X size={16} /></button>
      </div>
      <label className="block text-xs font-medium text-slate-600">Starts
        <select value={draft.start} onChange={(event) => setDraft({ ...draft, start: Number(event.target.value) })} className="mt-1 block h-10 w-full rounded-lg border border-slate-300 px-2 text-sm">
          {START_STEPS.map((minutes) => <option key={minutes} value={minutes}>{formatMinutes(minutes)}</option>)}
        </select>
      </label>
      <div className="text-xs font-medium text-slate-600">Length
        <div className="mt-1 flex flex-wrap gap-1.5">
          {[...new Set([...LENGTHS, draft.minutes])].sort((a, b) => a - b).map((value) => (
            <button key={value} type="button" onClick={() => setDraft({ ...draft, minutes: value })} className={cn('h-9 rounded-full px-3 sm:h-8 text-xs font-semibold', draft.minutes === value ? 'bg-slate-900 text-white' : 'bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-100')}>
              {formatLength(value)}
            </button>
          ))}
        </div>
      </div>
      <PersonField kind={kind} people={people} person={person} onPerson={(value) => setDraft({ ...draft, person: value })} />
      {kind === 'recording' && (
        <label className="block text-xs font-medium text-slate-600">Run by (staff name)
          <input
            value={draft.hostName ?? ''}
            onChange={(event) => setDraft({ ...draft, hostName: event.target.value })}
            maxLength={80}
            placeholder="Who runs this session, e.g. Dr Tan"
            className="mt-1 block h-10 w-full rounded-lg border border-slate-300 px-3 text-sm"
          />
        </label>
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        <Button variant="dark" disabled={!canSave} onClick={onSave}>{draft.id ? 'Save changes' : kind === 'recording' ? 'Add session' : 'Add slot'}</Button>
        {draft.id && (confirmDelete
          ? <Button variant="danger" onClick={onDelete}>Confirm delete</Button>
          : <Button variant="ghost" onClick={() => setConfirmDelete(true)}><Trash2 size={14} /> Delete</Button>)}
      </div>
      {draft.id && <p className="text-[11px] text-slate-500">Saving a published one makes it a draft again until you publish.</p>}
    </div>
  );
}

const SCHEDULE_COPY = {
  recording: {
    title: 'Recording sessions',
    help: 'In-person sessions (no GPU). Click a time on the day to add one; leave "Who" open so a lecturer can pick it. Sessions may run in parallel. New and edited sessions stay drafts until you publish.',
    footer: 'Lecturers sign in and pick one open session each (they can change it before it starts). The recording page unlocks for them only during it.',
    list: 'Upcoming recording sessions',
    open: 'Open — lecturers can pick',
    tones: ['open', 'booked', 'draft', 'live'],
  },
  test: {
    title: 'GPU test slots',
    help: 'After QC, give a lecturer GPU time to test their voices. Click a time on the day to add one. One person per slot, never overlapping. New and edited slots stay drafts until you publish.',
    footer: 'Publishing emails the person their time. The GPU starts 15 minutes before, loads their voice and emails them that it starts soon.',
    list: 'Upcoming test slots',
    open: '—',
    tones: ['booked', 'draft', 'live'],
  },
};

function Schedule({ overview, onAction, kind = 'test' }) {
  const copy = SCHEDULE_COPY[kind];
  const [params] = useSearchParams();
  const prefill = params.get('person') || '';
  const nowMs = Date.parse(overview.now) || Date.now();
  const today = sgtDayKey(nowMs);
  const slots = overview.slots.filter((slot) => (slot.kind === 'recording' ? 'recording' : 'test') === kind && Date.parse(slot.end) > nowMs);
  const [day, setDay] = useState(today);
  const [month, setMonth] = useState(monthOf(today));
  const [draft, setDraft] = useState(() => (prefill ? { day: today, start: 13 * 60, minutes: 60, person: prefill, hostName: rememberedHost() } : null));
  const people = overview.people || [];
  const drafts = overview.draftCount || 0;
  // Stacked layout (phones, tablets): the composer sits above the day timeline,
  // so tapping a time down there would open it out of sight — bring it into view.
  const composerRef = useRef(null);
  const draftOpen = Boolean(draft);
  useEffect(() => {
    if (!draftOpen || !window.matchMedia?.('(max-width: 1023px)').matches) return;
    composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [draftOpen, draft?.id, draft?.day, draft?.start]);

  const marks = useMemo(() => {
    const map = new Map();
    for (const slot of slots) {
      const key = sgtDayKey(slot.start);
      map.set(key, [...(map.get(key) || []), slotTone(slot, nowMs)]);
    }
    return map;
  }, [slots, nowMs]);
  const daySlots = slots.filter((slot) => sgtDayKey(slot.start) === day || sgtDayKey(slot.end) === day);
  const hours = dayHours(daySlots, { nowMinutes: day === today ? sgtMinutes(nowMs) : null });
  const blocks = daySlots.map((slot) => ({
    id: slot.id,
    start: slot.start,
    end: slot.end,
    tone: slotTone(slot, nowMs),
    title: slot.assigneeEmail ? (slot.assigneeName || slot.assigneeEmail) : copy.open,
    subtitle: `${formatSgt(slot.start, { withDate: false })} – ${formatSgt(slot.end, { withDate: false })}${slot.status === 'draft' ? ' · draft' : ''}${slot.hostName ? ` · run by ${slot.hostName}` : ''}${slot.assigneeEmail && slot.assigneeName ? ` · ${slot.assigneeEmail}` : ''}`,
  }));

  function selectDay(key) {
    setDay(key);
    if (draft && !draft.id) setDraft({ ...draft, day: key });
  }
  function edit(slot) {
    const original = slots.find((item) => item.id === slot.id);
    if (!original) return;
    const key = sgtDayKey(original.start);
    setDay(key);
    setMonth(monthOf(key));
    setDraft({
      id: original.id, day: key, start: sgtMinutes(original.start),
      minutes: Math.round((Date.parse(original.end) - Date.parse(original.start)) / 60000),
      person: original.assigneeEmail || '', name: original.assigneeName || '', hostName: original.hostName || '',
    });
  }
  async function save() {
    const start = sgtIso(draft.day, draft.start);
    const end = new Date(Date.parse(start) + draft.minutes * 60_000).toISOString();
    const email = (draft.person || '').trim();
    const known = people.find((entry) => entry.email === email);
    const hostName = kind === 'recording' ? String(draft.hostName || '').trim() : undefined;
    if (hostName) rememberHost(hostName);
    const body = { kind, start, end, assigneeEmail: email, assigneeName: (known?.name || (email === draft.person ? draft.name : '') || '').trim(), ...(hostName !== undefined ? { hostName } : {}) };
    const done = await onAction(() => (draft.id ? editSlot(draft.id, body) : addSlot(body)));
    if (!done) return;
    // Adding a run of sessions: the composer moves on to the next free time.
    setDraft(draft.id ? null : { day: draft.day, start: Math.min(23 * 60 + 45, draft.start + draft.minutes), minutes: draft.minutes, person: kind === 'test' ? draft.person : '', hostName: draft.hostName });
  }

  const upcomingDays = [...new Set(slots.map((slot) => sgtDayKey(slot.start)))].sort();
  return (
    <div className="space-y-5">
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-2xl">
            <h2 className="font-semibold text-slate-900">{copy.title}</h2>
            <p className="mt-1 text-sm text-slate-600">{copy.help}</p>
          </div>
          <Button variant={drafts ? 'success' : 'outline'} size="lg" disabled={!drafts} className="w-full sm:w-auto" onClick={() => onAction(publishSlots)}>
            Publish {drafts ? `${drafts} change${drafts === 1 ? '' : 's'}` : '(nothing to publish)'}
          </Button>
        </div>
        <div className="mt-3"><Legend tones={copy.tones} /></div>
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="space-y-5">
          <Card className="p-4">
            <MonthCalendar month={month} onMonth={setMonth} selected={day} onSelect={selectDay} marks={marks} today={today} />
          </Card>
          {draft && (
            <div ref={composerRef} className="scroll-mt-32">
            <SlotComposer
              key={draft.id || 'new'}
              kind={kind}
              draft={draft}
              setDraft={setDraft}
              people={people}
              onSave={save}
              onCancel={() => setDraft(null)}
              onDelete={() => onAction(() => deleteSlot(draft.id)).then((done) => { if (done) setDraft(null); })}
            />
            </div>
          )}
        </div>
        <Card className="min-w-0 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold text-slate-900">{formatDay(day)}</h3>
            <div className="flex gap-2">
              {day !== today && <Button size="sm" variant="ghost" onClick={() => { setDay(today); setMonth(monthOf(today)); }}>Today</Button>}
              <Button size="sm" variant="outline" onClick={() => setDraft({ day, start: Math.max(hours.start, 9 * 60), minutes: draft?.minutes || 60, person: kind === 'test' ? prefill : '', hostName: draft?.hostName ?? rememberedHost() })}><CalendarClock size={13} /> Add on this day</Button>
            </div>
          </div>
          <p className="mb-2 text-xs text-slate-500">Tap an empty time to add {kind === 'recording' ? 'a session' : 'a slot'} there; tap a block to edit it.</p>
          <div className="max-h-[min(620px,65dvh)] overflow-y-auto overscroll-contain pr-1 pt-2">
            <DayTimeline
              day={day}
              hours={hours}
              slots={blocks}
              nowMs={nowMs}
              selectedId={draft?.id}
              pending={draft && !draft.id && draft.day === day ? { start: draft.start, minutes: draft.minutes } : null}
              onSlotClick={edit}
              onEmptyClick={(minutes) => setDraft({ day, start: minutes, minutes: draft?.minutes || 60, person: draft && !draft.id ? draft.person : (kind === 'test' ? prefill : ''), hostName: draft?.hostName ?? rememberedHost() })}
            />
          </div>
        </Card>
      </div>

      <Card>
        <div className="border-b border-slate-200 px-5 py-3"><h2 className="font-semibold text-slate-900">{copy.list}</h2></div>
        {upcomingDays.length === 0 ? <p className="px-5 py-6 text-sm text-slate-500">Nothing upcoming yet — pick a day above and click a time.</p> : (
          <ul className="divide-y divide-slate-100">
            {upcomingDays.map((key) => slots.filter((slot) => sgtDayKey(slot.start) === key).sort((a, b) => a.start.localeCompare(b.start)).map((slot) => {
              const tone = slotTone(slot, nowMs);
              return (
                <li key={slot.id}>
                  <button type="button" onClick={() => edit(slot)} className="flex w-full items-start gap-3 px-4 py-3 text-left text-sm hover:bg-slate-50 sm:items-center sm:px-5 sm:py-2.5">
                    <span className={cn('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full sm:mt-0', TONES[tone].dot)} />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
                      <span className="font-medium text-slate-800 sm:w-44 sm:shrink-0">{formatSgt(slot.start)} – {formatSgt(slot.end, { withDate: false })}</span>
                      <span className="min-w-0 flex-1 truncate text-slate-700" title={slot.assigneeEmail || undefined}>
                        {slot.assigneeEmail ? <>{slot.assigneeName || slot.assigneeEmail} <span className="text-xs text-slate-400">{slot.assigneeName ? slot.assigneeEmail : ''}{slot.claimedAt ? ' · picked it themselves' : ''}</span></> : <span className="text-sky-700">{copy.open}</span>}
                      </span>
                    </span>
                    <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold', tone === 'draft' ? 'bg-amber-100 text-amber-800' : tone === 'live' ? 'bg-rose-100 text-rose-800' : 'bg-emerald-100 text-emerald-800')}>
                      {tone === 'draft' ? 'Draft' : tone === 'live' ? 'Now' : 'Published'}
                    </span>
                  </button>
                </li>
              );
            }))}
          </ul>
        )}
        <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">{copy.footer}</p>
      </Card>
    </div>
  );
}

// ── Testing (both roles) ─────────────────────────────────────────────────

function TestBench(props) {
  return <VoiceTestBench {...props} />;
}

// Super users test any trained voice of any user, any time, on their own QC
// GPU (a lecturer's test slot has a separate GPU, so neither waits on the other).
function SuperTest() {
  const [voices, setVoices] = useState(null);
  const [labels, setLabels] = useState({});
  const [error, setError] = useState('');
  useEffect(() => {
    getMyVoiceProfiles('studio')
      .then(({ data }) => {
        const list = (data?.voices || []).map((voice) => voice.displayName).filter(Boolean);
        setVoices(list);
        setLabels(Object.fromEntries((data?.voices || []).filter((voice) => voice.studioLabel || voice.label).map((voice) => [voice.displayName, voice.studioLabel || voice.label])));
      })
      .catch((err) => setError(errorText(err, 'Could not load the voices')));
  }, []);
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!voices) return <div className="flex justify-center py-16"><Loader2 className="animate-spin text-slate-400" /></div>;
  if (voices.length === 0) return <Notice tone="info">No trained voices yet.</Notice>;
  return <TestBench voiceNames={voices} voiceLabels={labels} canApply />;
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
              <div className="mb-1 flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <span className="font-medium text-slate-800 [overflow-wrap:anywhere]">{who(item.job)}</span>{' '}
                  <span className="text-xs text-slate-500 [overflow-wrap:anywhere]">{item.job.label} · {formatSgt(item.at)}</span>
                </div>
                <button type="button" onClick={() => navigate(`/review/${item.job.id}`)} className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-primary hover:underline">Open</button>
              </div>
              <FeedbackEntry entry={item} overview={overview} />
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
          className="mt-3 grid gap-2 sm:flex sm:flex-wrap"
          onSubmit={(event) => { event.preventDefault(); onAction(() => addSuperuser(email, name)).then((done) => { if (done) { setEmail(''); setName(''); } }); }}
        >
          <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" required placeholder="name@ntu.edu.sg" aria-label="Email" autoComplete="off" className="h-10 w-full min-w-0 rounded-lg border border-slate-300 px-3 text-sm sm:min-w-[240px] sm:flex-1" />
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Name (optional)" aria-label="Name" maxLength={80} className="h-10 w-full min-w-0 rounded-lg border border-slate-300 px-3 text-sm sm:w-48" />
          <Button type="submit" variant="dark"><UserPlus size={15} /> Add</Button>
        </form>
      </Card>
      <Card>
        <ul className="divide-y divide-slate-100">
          {overview.superusers.map((user) => (
            <li key={user.email} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">{(user.name || user.email).slice(0, 2).toUpperCase()}</span>
              <div className={cn('min-w-0 flex-1', editing === user.email && 'basis-full sm:basis-0')}>
                {editing === user.email ? (
                  <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); onAction(() => renameSuperuser(user.email, editName)).then(() => setEditing('')); }}>
                    <input value={editName} onChange={(event) => setEditName(event.target.value)} aria-label="Name" maxLength={80} className="h-9 min-w-0 flex-1 basis-40 rounded-lg border border-slate-300 px-2 text-sm sm:max-w-xs" autoFocus />
                    <Button type="submit" size="sm" variant="dark">Save</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing('')}>Cancel</Button>
                  </form>
                ) : (
                  <>
                    <p className="font-medium text-slate-800 [overflow-wrap:anywhere]">{user.name || user.email} {user.email === auth.user?.email?.toLowerCase() && <span className="text-xs font-normal text-slate-500">(you)</span>}</p>
                    <p className="text-xs text-slate-500 [overflow-wrap:anywhere]">{user.email}{user.locked ? ' · set in server configuration' : user.addedBy ? ` · added by ${user.addedBy}` : ''}</p>
                  </>
                )}
              </div>
              {!user.locked && editing !== user.email && (
                <div className="flex shrink-0 items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => { setEditing(user.email); setEditName(user.name || ''); }}>Edit</Button>
                  {confirm === user.email ? (
                    <Button size="sm" variant="danger" onClick={() => onAction(() => removeSuperuser(user.email)).then(() => setConfirm(''))}>Confirm remove</Button>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => setConfirm(user.email)} aria-label={`Remove ${user.email}`}><Trash2 size={14} /></Button>
                  )}
                </div>
              )}
              {user.locked && <ShieldCheck size={16} className="text-slate-400" aria-label="Locked" />}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

// The GPU is held for a lecturer's test slot: who, when, and how the warm-up
// is going — flagged when it runs past its estimate.
function SlotHoldBanner({ slot, now }) {
  const who = slot.assigneeName || slot.assigneeEmail;
  const warm = slot.warm || null;
  const ready = warm?.state === 'READY';
  const late = warm && !ready && warm.estimatedReadyAt && now > Date.parse(warm.estimatedReadyAt);
  const until = formatSgt(slot.end, { withDate: false });
  let line;
  if (slot.phase === 'slot') line = <><b>{who}</b> is testing their voice until {until} SGT.</>;
  else if (slot.phase === 'bridge') line = <>The GPU stays on for <b>{who}</b>'s test at {formatSgt(slot.start, { withDate: false })} SGT (less than an hour after the last one).</>;
  else line = <>The GPU is warming up for <b>{who}</b>'s test at {formatSgt(slot.start, { withDate: false })} SGT.</>;
  return (
    <div className="space-y-2">
      <Notice tone="warn" className="flex items-center gap-2">
        <ShieldCheck size={16} className="shrink-0" />
        <span>
          {line} It runs on its own GPU; your voice testing uses a separate one, so nothing here is locked.
          {warm && !ready && !late && warm.estimatedReadyAt && <> Their voice should be ready at about {formatSgt(warm.estimatedReadyAt, { withDate: false })}.</>}
          {ready && <> Their voice is loaded.</>}
        </span>
      </Notice>
      {late && (
        <Notice tone="error">
          Warm-up is taking longer than expected: estimated ready at {formatSgt(warm.estimatedReadyAt, { withDate: false })}, still {String(warm.state || '').toLowerCase()} (last checked {formatSgt(warm.checkedAt, { withDate: false })}).
          {warm.message ? ` ${warm.message}` : ''} {who} sees a "come back shortly" message meanwhile.
        </Notice>
      )}
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

// Phones and tablets: the sections as a swipeable strip under the header. The
// current one is kept in view, and the review count shows like on the sidebar.
function MobileNav({ reviewCount }) {
  const location = useLocation();
  const navRef = useRef(null);
  useEffect(() => {
    navRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [location.pathname]);
  return (
    <nav ref={navRef} aria-label="Sections" className="flex gap-1 overflow-x-auto overscroll-x-contain bg-slate-950 px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {SUPER_NAV.map(([to, label, Icon]) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/'}
          className={({ isActive }) => cn('inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-xs font-medium', isActive ? 'bg-white/15 text-white' : 'text-white/70 active:bg-white/10')}
        >
          <Icon size={14} aria-hidden="true" /> {label}
          {to === '/' && reviewCount > 0 && <span className="rounded-full bg-violet-500 px-1.5 text-[11px] font-semibold text-white">{reviewCount}</span>}
        </NavLink>
      ))}
    </nav>
  );
}

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
        <div className="sticky top-0 z-30 lg:hidden">
          <Header product="Voice Studio · Super user" />
          <MobileNav reviewCount={reviewCount} />
        </div>
        <main className="mx-auto max-w-7xl space-y-4 px-4 py-4 sm:px-6 sm:py-6">
          {busy && <div role="status" className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full bg-slate-900 px-3 py-1.5 text-xs text-white shadow-lg lg:bottom-auto lg:left-auto lg:right-4 lg:top-4 lg:translate-x-0"><Loader2 size={13} className="animate-spin" /> Working…</div>}
          {error && <Notice tone="error">{error}</Notice>}
          {data?.currentSlot && <SlotHoldBanner slot={data.currentSlot} now={Date.parse(data.now) || Date.now()} />}
          {!data ? <div className="flex justify-center py-20"><Loader2 className="animate-spin text-slate-400" /></div> : (
            <Routes>
              <Route path="/" element={<Overview overview={data} onAction={onAction} />} />
              <Route path="/review/:jobId" element={<JobDetail overview={data} onAction={onAction} />} />
              <Route path="/schedule" element={<Schedule overview={data} onAction={onAction} kind="test" />} />
              <Route path="/sessions" element={<Schedule key="recording" overview={data} onAction={onAction} kind="recording" />} />
              <Route path="/record" element={<RecordWorkspace embedded />} />
              <Route path="/test" element={<SuperTest />} />
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

// Lecturer feedback: a few taps, the words it got wrong, then free text.
// Kept short on purpose — the aim is useful detail without a questionnaire.
const FEEDBACK_ISSUES = {
  'wrong-words': 'Says some words wrongly',
  'skips-words': 'Skips or repeats words',
  robotic: 'Sounds flat or robotic',
  pace: 'Too fast or too slow',
  'not-like-me': 'Does not sound like me',
  noise: 'Buzz, hiss or glitches',
};
const FEEDBACK_LIKENESS = { yes: 'Sounds like me', mostly: 'Mostly', no: 'Not really' };

function Chip({ active, onClick, children }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} className={cn('min-h-9 rounded-full px-3 py-1.5 text-xs font-semibold transition sm:min-h-0', active ? 'bg-slate-900 text-white' : 'bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-100')}>
      {children}
    </button>
  );
}

function FeedbackForm({ job }) {
  const [rating, setRating] = useState(0);
  const [likeness, setLikeness] = useState('');
  const [issues, setIssues] = useState([]);
  const [words, setWords] = useState('');
  const [comment, setComment] = useState('');
  const [state, setState] = useState('');
  const wordsWanted = issues.includes('wrong-words') || issues.includes('skips-words');
  async function submit(event) {
    event.preventDefault();
    setState('saving');
    try {
      await sendFeedback(job.id, { rating, likeness, issues, words: wordsWanted ? words : '', comment });
      setState('saved');
      setRating(0); setLikeness(''); setIssues([]); setWords(''); setComment('');
    } catch (err) {
      setState(errorText(err));
    }
  }
  return (
    <Card className="p-4 sm:p-5">
      <h3 className="font-semibold text-slate-900">How does it sound?</h3>
      <p className="mt-1 text-sm text-slate-600">About a minute. It goes straight to the Voice Studio team, who use it to retrain your voice.</p>
      <form onSubmit={submit} className="mt-4 space-y-4">
        <div>
          <p className="text-xs font-semibold text-slate-700">Overall</p>
          <div className="mt-1 flex gap-1" role="radiogroup" aria-label="Rating">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} star${n > 1 ? 's' : ''}`} onClick={() => setRating(n)} className="rounded-lg p-1">
                <Star size={26} className={n <= rating ? 'fill-amber-400 text-amber-400' : 'text-slate-300'} />
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="text-xs font-semibold text-slate-700">Does it sound like you?</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {Object.entries(FEEDBACK_LIKENESS).map(([key, label]) => <Chip key={key} active={likeness === key} onClick={() => setLikeness(likeness === key ? '' : key)}>{label}</Chip>)}
          </div>
        </div>
        <div>
          <p className="text-xs font-semibold text-slate-700">Anything off? <span className="font-normal text-slate-500">(tick any)</span></p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {Object.entries(FEEDBACK_ISSUES).map(([key, label]) => (
              <Chip key={key} active={issues.includes(key)} onClick={() => setIssues(issues.includes(key) ? issues.filter((item) => item !== key) : [...issues, key])}>{label}</Chip>
            ))}
          </div>
        </div>
        {wordsWanted && (
          <label className="block text-xs font-semibold text-slate-700">Which words? <span className="font-normal text-slate-500">(separate with commas — names and medical terms especially)</span>
            <input value={words} onChange={(event) => setWords(event.target.value)} maxLength={500} placeholder="e.g. cohesin, apoptosis, Nanyang" className="mt-1 block h-10 w-full rounded-lg border border-slate-300 px-3 text-sm font-normal" />
          </label>
        )}
        <label className="block text-xs font-semibold text-slate-700">Anything else? <span className="font-normal text-slate-500">(optional)</span>
          <textarea value={comment} onChange={(event) => setComment(event.target.value)} rows={3} maxLength={2000} placeholder="What you liked, what felt wrong, where it happened…" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal" />
        </label>
        <Button type="submit" variant="dark" className="w-full sm:w-auto" disabled={!rating || state === 'saving'}>{rating ? 'Send feedback' : 'Pick a star rating to send'}</Button>
        {state === 'saved' && <p className="text-sm text-emerald-700">Thank you — sent. You can send more any time.</p>}
        {state && !['saving', 'saved'].includes(state) && <p className="text-sm text-rose-600">{state}</p>}
      </form>
    </Card>
  );
}

function FeedbackEntry({ entry, overview }) {
  const issues = overview?.feedbackIssues || FEEDBACK_ISSUES;
  const likeness = overview?.feedbackLikeness || FEEDBACK_LIKENESS;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <Stars value={entry.rating} />
        {entry.likeness && <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', entry.likeness === 'yes' ? 'bg-emerald-100 text-emerald-800' : entry.likeness === 'no' ? 'bg-rose-100 text-rose-800' : 'bg-amber-100 text-amber-800')}>{likeness[entry.likeness] || entry.likeness}</span>}
        {(entry.issues || []).map((issue) => <span key={issue} className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-700">{issues[issue] || issue}</span>)}
      </div>
      {entry.words && <p className="text-sm text-slate-700 [overflow-wrap:anywhere]"><span className="font-semibold">Words:</span> {entry.words}</p>}
      {entry.comment && <p className="whitespace-pre-line text-sm text-slate-700 [overflow-wrap:anywhere]">{entry.comment}</p>}
    </div>
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

// A lecturer's voice, step by step: recorded → training → quality check → test.
const JOURNEY = [
  ['recorded', 'Recorded'],
  ['training', 'Training'],
  ['quality-check', 'Quality check'],
  ['test', 'Test your voice'],
];

function journeyStep(status) {
  if (status === 'queued' || status === 'training') return 1;
  if (status === 'quality-check') return 2;
  if (status === 'ready') return 3;
  return 0;
}

function JourneySteps({ step, retrain = false }) {
  return (
    // Each step is an equal column: circle on the line, label underneath that may
    // wrap to two lines, so all four fit even on a narrow phone.
    <ol className="grid grid-cols-4">
      {JOURNEY.map(([key, baseLabel], index) => {
        const label = retrain && key === 'training' ? 'Retraining' : baseLabel;
        const done = index < step;
        const current = index === step;
        return (
          <li key={key} className="relative flex flex-col items-center gap-1.5 text-center" aria-current={current ? 'step' : undefined}>
            {index > 0 && <span className={cn('absolute right-1/2 top-4 h-0.5 w-full -translate-y-1/2 sm:top-[18px]', index <= step ? 'bg-emerald-400' : 'bg-slate-200')} aria-hidden="true" />}
            <span className={cn(
              'relative z-10 flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold sm:h-9 sm:w-9',
              done ? 'bg-emerald-500 text-white' : current ? 'bg-primary text-white ring-4 ring-primary/15' : 'bg-slate-100 text-slate-400',
            )}>
              {done ? <CheckCircle2 size={18} /> : index + 1}
              {current && <span className="absolute inset-0 animate-ping rounded-full bg-primary/25" aria-hidden="true" />}
            </span>
            <span className={cn('px-0.5 text-[11px] font-semibold leading-tight sm:text-xs', current ? 'text-slate-900' : done ? 'text-emerald-700' : 'text-slate-400')}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function VoiceJourney({ job, now, testSlot, testedSlot = null }) {
  const step = journeyStep(job.status);
  const estimate = job.estimate;
  // A retrain after quality check goes round again: retraining → quality check → test.
  const retrain = job.attempt > 1 && (job.status === 'queued' || job.status === 'training');
  let title = '';
  let body = null;
  if (job.status === 'queued') {
    const ahead = Math.max(0, (estimate?.position || 1) - 1);
    const verb = retrain ? 'retrain' : 'train';
    title = ahead > 0 ? `Waiting to ${verb} — ${ahead} voice${ahead === 1 ? '' : 's'} ahead of yours` : `Waiting to ${verb} — yours is next`;
    body = estimate
      ? <p>Training should start {formatSgt(estimate.startAt)} and finish around <b>{formatSgt(estimate.finishAt)}</b> ({relativeFromNow(estimate.finishAt, now)}).</p>
      : <p>Your voice starts training as soon as the GPU is free.</p>;
  } else if (job.status === 'training') {
    const start = Date.parse(estimate?.startAt || job.queuedAt || '') || now;
    const finish = Date.parse(estimate?.finishAt || '') || 0;
    const pct = finish > start ? Math.max(4, Math.min(96, Math.round(((now - start) / (finish - start)) * 100))) : 50;
    title = retrain ? 'Retraining your voice now' : 'Training your voice now';
    body = (
      <>
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-200"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} /></div>
        {estimate?.finishAt && <p className="mt-2">Should finish around <b>{formatSgt(estimate.finishAt)}</b> ({relativeFromNow(estimate.finishAt, now)}).</p>}
      </>
    );
  } else if (job.status === 'quality-check') {
    title = 'Our team is listening to your voice';
    body = <p>Training is done. Quality control is done by people, so it can take longer than training — sometimes we retrain to get it right. We email you when it passes.</p>;
  } else if (job.status === 'ready' && testSlot) {
    title = 'Your test time is booked';
    body = <p><b>{formatRange(testSlot.start, testSlot.end)}</b> ({relativeFromNow(testSlot.start, now)}). We email you that morning; when it starts, this page opens your voice for you to test.</p>;
  } else if (job.status === 'ready' && testedSlot) {
    title = 'You have tested your voice — thank you';
    body = <p>Your test on {formatSgt(testedSlot.completedAt || testedSlot.end)} SGT is finished. Our team reads your feedback and emails you about next steps.</p>;
  } else if (job.status === 'ready') {
    title = 'Passed quality control — awaiting your test slot';
    body = <p>Our team is choosing a time for you to test it. We email you the time, and it shows here too.</p>;
  }
  return (
    <Card className="p-4 sm:p-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="min-w-0 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500 [overflow-wrap:anywhere]">{job.label}</p>
        {job.attempt > 1 && job.status !== 'ready' && <span className="text-xs text-slate-400">improving it (try {job.attempt})</span>}
      </div>
      <div className="mt-5"><JourneySteps step={step} retrain={retrain} /></div>
      <div className="mt-5 rounded-2xl bg-slate-50 px-4 py-4 sm:mt-6 sm:px-5">
        <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
        <div className="mt-1 space-y-1 text-sm leading-6 text-slate-600">
          {retrain && <p>Our quality check found your voice could sound better, so we are training it again from the same recordings (try {job.attempt}). You do not need to do anything.</p>}
          {body}
          {(job.status === 'queued' || job.status === 'training') && <p className="text-slate-500">{retrain ? 'After retraining it goes back to quality control, then you can test it.' : 'After training comes quality control, which usually takes longer than training.'}</p>}
        </div>
      </div>
    </Card>
  );
}

// Lecturer: pick ONE recording session on a calendar. Once booked, other
// times can only be used to Change (move) it — never to book a second one.
function SessionPicker({ me, onChanged }) {
  const auth = useAuth();
  const nowMs = Date.now();
  const today = sgtDayKey(nowMs);
  const sessions = me.sessions || [];
  const mine = sessions.find((slot) => slot.mine) || null;
  const mineStarted = mine ? Date.parse(mine.start) <= nowMs : false;
  const firstOpen = sessions.find((slot) => slot.open);
  const startDay = mine ? sgtDayKey(mine.start) : firstOpen ? sgtDayKey(firstOpen.start) : today;
  const [day, setDay] = useState(startDay);
  const [month, setMonth] = useState(monthOf(startDay));
  const [confirming, setConfirming] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [name, setName] = useState(auth.user?.name && auth.user.name !== auth.user.email ? auth.user.name : '');

  const marks = new Map();
  for (const slot of sessions) {
    const key = sgtDayKey(slot.start);
    marks.set(key, [...(marks.get(key) || []), slot.mine ? 'mine' : slot.open ? 'open' : 'taken']);
  }
  const daySessions = sessions.filter((slot) => sgtDayKey(slot.start) === day);
  // Phones: the day's times are under the calendar — show them after a tap.
  const timesRef = useRef(null);
  function pickDay(key) {
    setDay(key);
    setConfirming('');
    if (window.matchMedia?.('(max-width: 767px)').matches) {
      window.requestAnimationFrame(() => timesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
    }
  }

  async function act(id, call) {
    setBusy(id);
    setError('');
    try {
      onChanged(await call());
      setConfirming('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy('');
    }
  }

  return (
    <Card>
      <div className="border-b border-slate-200 px-4 py-3 sm:px-5">
        <h2 className="font-semibold text-slate-900">{mine ? 'Your recording session' : 'Book a recording session'}</h2>
        <p className="text-xs text-slate-500">
          {mine
            ? (mineStarted ? 'Your session is on now.' : 'You have one session. To move it, pick another open time and choose "Change to this time".')
            : 'Pick a day, then an open time. You book one session; you can change it later.'}
        </p>
      </div>
      {mine && (
        <div className="mx-4 mt-4 flex flex-wrap items-center gap-3 rounded-xl bg-emerald-50 px-4 py-3 ring-1 ring-emerald-200 sm:mx-5">
          <CheckCircle2 size={20} className="shrink-0 text-emerald-600" />
          <div className="min-w-0 flex-1 basis-40">
            <p className="font-semibold text-emerald-900">{formatRange(mine.start, mine.end)}</p>
            <p className="text-xs text-emerald-800">{mineStarted ? 'Happening now' : relativeFromNow(mine.start, nowMs)}</p>
          </div>
          {!mineStarted && (
            confirming === `release-${mine.id}`
              ? <Button size="sm" variant="danger" disabled={busy === mine.id} onClick={() => act(mine.id, () => releaseSlot(mine.id))}>Confirm cancel</Button>
              : <Button size="sm" variant="ghost" onClick={() => setConfirming(`release-${mine.id}`)}>Cancel booking</Button>
          )}
        </div>
      )}
      {error && <Notice tone="error" className="mx-4 mt-3 sm:mx-5">{error}</Notice>}
      {sessions.length === 0 ? <p className="px-4 py-6 text-sm text-slate-500 sm:px-5">No sessions are published yet — please check back soon.</p> : (
        <div className="grid grid-cols-1 gap-5 p-4 sm:p-5 md:grid-cols-[300px_minmax(0,1fr)]">
          <div>
            <MonthCalendar month={month} onMonth={setMonth} selected={day} onSelect={pickDay} marks={marks} today={today} />
            <div className="mt-3"><Legend tones={['open', 'mine', 'taken']} /></div>
          </div>
          <div ref={timesRef} className="min-w-0 scroll-mt-20 border-t border-slate-100 pt-4 md:border-0 md:pt-0">
            <p className="text-sm font-semibold text-slate-900">{formatDay(day)}</p>
            {!mine && (
              <label className="mt-3 block text-xs font-medium text-slate-600">Your name (shown to the Voice Studio team)
                <input required value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoComplete="name" className="mt-1 block h-10 w-full rounded-lg border border-slate-300 px-3 text-sm sm:max-w-xs" />
              </label>
            )}
            {daySessions.length === 0 ? <p className="mt-3 text-sm text-slate-500">No sessions on this day. Days with a blue dot have open times.</p> : (
              <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                {daySessions.map((slot) => {
                  const length = Math.round((Date.parse(slot.end) - Date.parse(slot.start)) / 60000);
                  const isConfirming = confirming === slot.id;
                  return (
                    <li key={slot.id} className={cn('rounded-xl border p-3', slot.mine ? 'border-emerald-300 bg-emerald-50' : slot.open ? 'border-sky-200 bg-white' : 'border-slate-200 bg-slate-50')}>
                      <p className="font-semibold text-slate-900">{formatSgt(slot.start, { withDate: false })} – {formatSgt(slot.end, { withDate: false })}</p>
                      <p className="text-xs text-slate-500">{formatLength(length)} · {slot.mine ? 'your session' : slot.open ? 'open' : 'taken'}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {slot.mine && <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700"><CheckCircle2 size={13} /> Booked for you</span>}
                        {slot.open && !mine && (isConfirming
                          ? <>
                            <Button size="sm" variant="success" className="flex-1 sm:flex-none" disabled={busy === slot.id || !name.trim()} onClick={() => act(slot.id, () => claimSlot(slot.id, name.trim()))}>{busy === slot.id ? <Loader2 size={13} className="animate-spin" /> : null}{name.trim() ? 'Confirm booking' : 'Enter your name first'}</Button>
                            <Button size="sm" variant="ghost" onClick={() => setConfirming('')}>Back</Button>
                          </>
                          : <Button size="sm" variant="dark" className="flex-1 sm:flex-none" onClick={() => setConfirming(slot.id)}>Book this time</Button>)}
                        {slot.open && mine && !mineStarted && (isConfirming
                          ? <>
                            <Button size="sm" variant="success" className="flex-1 sm:flex-none" disabled={busy === slot.id} onClick={() => act(slot.id, () => moveSlot(slot.id))}>{busy === slot.id ? <Loader2 size={13} className="animate-spin" /> : null}Confirm change</Button>
                            <Button size="sm" variant="ghost" onClick={() => setConfirming('')}>Back</Button>
                          </>
                          : <Button size="sm" variant="outline" className="flex-1 sm:flex-none" onClick={() => setConfirming(slot.id)}>Change to this time</Button>)}
                        {!slot.open && !slot.mine && <span className="text-xs text-slate-400">Not available</span>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
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
  // "I'm done": ends the test slot now so its GPU shuts down instead of idling.
  const [finishing, setFinishing] = useState('');
  const [finishError, setFinishError] = useState('');
  async function finishTesting() {
    setFinishing('busy');
    setFinishError('');
    try {
      setMe(await completeSlot(testing.id));
      setFinishing('');
    } catch (err) {
      setFinishError(errorText(err, 'Could not end your test slot'));
      setFinishing('confirm');
    }
  }

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

  // One stage at a time: testing → recording → the voice's journey → booking.
  let content;
  if (testing) {
    content = (
      <>
        <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-emerald-600 px-4 py-4 text-white sm:px-5">
          <CheckCircle2 size={22} className="hidden shrink-0 sm:block" />
          <div className="min-w-0 flex-1 basis-60">
            <p className="text-base font-semibold sm:text-lg">Your test time — until {formatSgt(testing.end, { withDate: false })} SGT</p>
            <p className="text-sm text-white/85">Paste some text to hear it read in your voice, or chat with it. Fix any word it says wrongly in the Pronunciation panel.</p>
          </div>
          {finishing === '' && (
            <Button variant="outline" size="sm" className="w-full border-white/60 bg-white/10 text-white hover:bg-white/20 sm:w-auto" onClick={() => setFinishing('confirm')}>
              I'm done testing
            </Button>
          )}
        </div>
        {finishing && (
          <Notice tone="info" className="flex flex-wrap items-center justify-between gap-3">
            <span className="min-w-0 flex-1 basis-64">End your test slot now? Please leave feedback below first if you have not. Your voice cannot be tested again in this slot afterwards.</span>
            <span className="flex flex-wrap gap-2">
              <Button variant="ghost" size="sm" disabled={finishing === 'busy'} onClick={() => { setFinishing(''); setFinishError(''); }}>Keep testing</Button>
              <Button variant="dark" size="sm" disabled={finishing === 'busy'} onClick={finishTesting}>
                {finishing === 'busy' ? <Loader2 size={13} className="animate-spin" /> : null} End my test
              </Button>
            </span>
          </Notice>
        )}
        {finishError && <Notice tone="error">{finishError}</Notice>}
        {voiceNames.length === 0
          ? <Notice tone="warn">None of your voices has passed the quality check yet, so there is nothing to test in this slot.</Notice>
          : <TestBench voiceNames={voiceNames} canApply audience="lecturer" slotWarm={testing.warm || null} />}
        {feedbackTarget && (
          <div className="space-y-2">
            {ready.length > 1 && (
              <select value={feedbackTarget.id} onChange={(event) => setFeedbackJob(event.target.value)} className="h-10 w-full max-w-full rounded-lg border border-slate-300 bg-white px-2 text-sm sm:w-auto" aria-label="Feedback for which voice">
                {ready.map((job) => <option key={job.id} value={job.id}>{job.label}</option>)}
              </select>
            )}
            <FeedbackForm key={feedbackTarget.id} job={feedbackTarget} />
          </div>
        )}
      </>
    );
  } else if (submitted.length > 0) {
    // Submitted (even while their session is still open): only what comes next.
    content = submitted.map((job) => <VoiceJourney key={job.id} job={job} now={now} testSlot={job.status === 'ready' ? testSlot : null} testedSlot={job.status === 'ready' && !testSlot ? me.testedSlot : null} />);
  } else if (recordingOpen) {
    content = <RecordWorkspace embedded sessionEnd={recording.slot?.end} onSubmitted={(view) => setMe(view)} />;
  } else {
    content = (
      <>
        <Card className="p-5 text-center sm:p-8">
          <CalendarClock size={30} className="mx-auto text-slate-400" />
          <h1 className="mt-3 text-xl font-semibold text-slate-900 sm:text-2xl">{booked ? 'Your recording session is booked' : 'Book a recording session'}</h1>
          {booked
            ? <><p className="mt-2 text-slate-600"><b>{formatRange(booked.start, booked.end)}</b> ({relativeFromNow(booked.start, now)}).</p><p className="mt-1 text-sm text-slate-500">We email you the day before and again just before it starts. The recording page opens here then.</p></>
            : <p className="mt-2 text-slate-600">Pick an open time below. During your session this page becomes your recording studio.</p>}
        </Card>
        <SessionPicker me={me} onChanged={setMe} />
      </>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <Header product="Voice Studio" />
      <main className="mx-auto max-w-5xl space-y-4 px-4 py-4 sm:space-y-5 sm:px-6 sm:py-6">{content}</main>
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

function StudioSignIn() {
  const auth = useAuth();
  async function onPasswordSignIn(mode, fields) {
    const session = await passwordSignIn(mode, fields);
    saveStudioSession(session);
    await auth.refreshAuthState();
  }
  async function onGoogleSignIn(credential) {
    saveStudioSession(await googleSignIn(credential));
    await auth.refreshAuthState();
  }
  return (
    <SignInScreen
      product="Voice Studio"
      headline="Your teaching voice, recorded, trained and tested in one place."
      lines={[
        ['Book a recording session', 'Pick a time on the calendar; the recording page opens for you then.'],
        ['We train and check it', 'Follow its progress here; we email you when it passes quality control.'],
        ['Test it in your slot', 'The GPU is yours: chat, have it read text aloud, fix pronunciations.'],
      ]}
      accent="from-[#052e2b] via-[#0f3d3a] to-[#1e1b4b]"
      onPasswordSignIn={onPasswordSignIn}
      onGoogleSignIn={onGoogleSignIn}
      faq={<FaqList />}
    />
  );
}

export default function StudioApp() {
  return (
    <TooltipProvider>
      <PostLoginRedirectHandler />
      <div className="vs-root">
        <Routes>
          <Route path="/faq" element={<FaqPage />} />
          <Route path="/login" element={<StudioSignIn />} />
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
      </div>
    </TooltipProvider>
  );
}
