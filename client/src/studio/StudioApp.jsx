// Voice Studio: one site, two very different experiences.
//  - Super users get a console laid out as a "train line" of six stops, in the
//    order they use it (superLine.js): book recording → recording (upload the
//    audio) → training → quality check (approve or retrain) → assign test slot
//    → testing & feedback. The sidebar is that line; home is the line map.
//  - Lecturers get one simple page: the recorder during their session, then
//    their voice's progress, then testing (in their slot, or any time with a
//    cold start) until they send feedback.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  CalendarClock, CheckCircle2, ChevronLeft, ChevronRight, Loader2, Mic2, RefreshCw, ShieldCheck,
  Star, ThumbsDown, ThumbsUp, Trash2, UserPlus, X,
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
  addDays, dayHours, formatDay, formatLength, formatMinutes, monthOf, sgtDayKey, sgtIso, sgtMinutes,
} from './slotCalendar.js';
import {
  addSlot, addSuperuser, cancelJob, sendTestEmail, deleteSlot, discardSlotChanges, editSlot, errorText, formatRange, formatSgt, getMe, getOverview,
  googleSignIn, publishSlots, relativeFromNow, removeSuperuser, renameSuperuser, resetPerson, retryJob, reviewJob,
  sendFeedback,
} from './studioApi.js';
import {
  Button, Card, Header, Notice, SignInScreen, StatusPill, formatBytes,
} from './StudioChrome.jsx';
import { buildLine } from './superLine.js';
import { addHosts, slotHosts } from './staffColors.js';
import {
  bookingAt, freeTimeTaken, openHours, overlapBands, overriddenFor, overriddenOthers, staffFreeAt,
} from './availability.js';
import { StaffChip, StaffField, knownStaff, rememberStaff } from './StaffField.jsx';
import { StaffAvailability } from './StaffAvailability.jsx';
import { CleanUp } from './CleanUp.jsx';
import { MobileLine, StageHeader, SuperSidebar } from './SuperLineChrome.jsx';
import { LineMap } from './LineMap.jsx';
import { PersonTrip, QualityList, RecordingStage, TestingNow, TrainingStage, VoiceFailures } from './LineStages.jsx';

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

// ── Super user: email check ──────────────────────────────────────────────

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
      <h3 className="font-semibold text-slate-900">Approve or retrain</h3>
      <p className="mt-1 text-sm text-slate-600">Your check before the lecturer hears it. Test the voice first, then decide.</p>
      {/* QC has exactly two outcomes (owner decision 2026-11-23): approve → assign test slot, or retrain on the same audio. */}
      <div className="mt-4 grid gap-2 sm:flex sm:flex-wrap">
        <Button variant="success" onClick={() => onAction(() => reviewJob(job.id, { decision: 'approve', notes }))}><ThumbsUp size={15} /> Good — approve</Button>
        <Button variant={mode === 'reject' ? 'danger' : 'outline'} aria-expanded={mode === 'reject'} onClick={() => setMode(mode === 'reject' ? '' : 'reject')}><ThumbsDown size={15} /> Not good — retrain</Button>
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
          {atLimit && <Notice tone="warn" className="text-xs">This is attempt {job.attempt} of {maxAttempts}. Another retrain rarely helps. You can still force it.</Notice>}
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
        : <p className="mt-1 text-sm text-slate-600">{who(job)} has no test time yet. Assign one (each person gets their own GPU), or they can test any time with a cold start.</p>}
      <Button variant="outline" size="sm" className="mt-3" onClick={() => navigate(`/schedule?person=${encodeURIComponent(job.ownerEmail)}`)}><CalendarClock size={13} /> Assign test slot</Button>
    </Card>
  );
}

function JobDetail({ overview, onAction, line }) {
  const { jobId } = useParams();
  const navigate = useNavigate();
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [withdrawEmail, setWithdrawEmail] = useState(false);
  const [withdrawNote, setWithdrawNote] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  const job = overview.jobs.find((item) => item.id === jobId);
  if (!job) return <Notice tone="warn">That recording set was not found. <button type="button" className="underline" onClick={() => navigate('/quality')}>Back</button></Notice>;
  const voices = trainedVoices(job);
  const rider = line?.riders.find((item) => item.email === String(job.ownerEmail).toLowerCase());

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-64">
          <h2 className="text-lg font-semibold text-slate-900 [overflow-wrap:anywhere] sm:text-xl">{who(job)} · {job.label}</h2>
          <p className="text-sm text-slate-500 [overflow-wrap:anywhere]">{job.ownerEmail} · attempt {job.attempt} · current voice {job.expName}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={job.status} />
          {job.status === 'failed' && <Button variant="dark" size="sm" onClick={() => onAction(() => retryJob(job.id))}><RefreshCw size={13} /> Retry training</Button>}
          {['approved', 'scheduled'].includes(job.status) && job.testingClosedAt && !job.recordingReopened && !confirmReset && <Button variant="outline" size="sm" onClick={() => { setConfirmReset(true); setConfirmWithdraw(false); }}><RefreshCw size={13} /> Reset for a new voice</Button>}
          {!['training', 'cancelled'].includes(job.status) && !confirmWithdraw && <Button variant="ghost" size="sm" onClick={() => { setConfirmWithdraw(true); setConfirmReset(false); }}><X size={13} /> Withdraw</Button>}
        </div>
      </div>

      {confirmReset && (
        <Notice tone="info" className="space-y-2">
          <p className="font-semibold [overflow-wrap:anywhere]">Reset {who(job)} for a new voice?</p>
          <ul className="list-disc space-y-0.5 pl-5 text-sm">
            <li>Their run is finished (approved and tested). Nothing is withdrawn: this voice stays testable in Quality check.</li>
            <li>Their page starts fresh at recording, so they (or you, uploading for them) can start one new run.</li>
          </ul>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={withdrawEmail} onChange={(event) => setWithdrawEmail(event.target.checked)} /> Email them to record again</label>
          {withdrawEmail && <textarea className="w-full rounded-lg border border-slate-200 p-2 text-sm" rows={2} placeholder="Note for them (optional)" value={withdrawNote} onChange={(event) => setWithdrawNote(event.target.value)} />}
          <div className="flex gap-2 pt-1">
            <Button variant="dark" size="sm" onClick={() => { setConfirmReset(false); onAction(() => resetPerson(job.id, { email: withdrawEmail, notes: withdrawEmail ? withdrawNote : '' })); }}>Reset</Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmReset(false)}>Keep</Button>
          </div>
        </Notice>
      )}

      {confirmWithdraw && (
        <Notice tone="warn" className="space-y-2">
          <p className="font-semibold [overflow-wrap:anywhere]">Withdraw {who(job)}'s voice? This cannot be undone.</p>
          <ul className="list-disc space-y-0.5 pl-5 text-sm">
            <li>Their set leaves the line (training, QC) and their upcoming test slots are cancelled.</li>
            <li>Their recording page opens again so they can send a new set. Booked recording sessions stay.</li>
            <li>Their recordings and trained voices stay in storage.</li>
          </ul>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={withdrawEmail} onChange={(event) => setWithdrawEmail(event.target.checked)} /> Email them to record again</label>
          {withdrawEmail && <textarea className="w-full rounded-lg border border-slate-200 p-2 text-sm" rows={2} placeholder="Note for them (optional)" value={withdrawNote} onChange={(event) => setWithdrawNote(event.target.value)} />}
          <div className="flex gap-2 pt-1">
            <Button variant="danger" size="sm" onClick={() => { setConfirmWithdraw(false); onAction(() => cancelJob(job.id, { email: withdrawEmail, notes: withdrawEmail ? withdrawNote : '' })).then((done) => { if (done) navigate('/quality'); }); }}>Withdraw</Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmWithdraw(false)}>Keep</Button>
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

const LENGTHS = [20, 30, 45, 60, 90, 120, 180, 240];
const DEFAULT_MINUTES = { test: 20, recording: 60 };
const START_STEPS = Array.from({ length: 96 }, (_, i) => i * 15);

function slotTone(slot, now) {
  // Recording sessions: green = free (nobody yet), red = booked for a lecturer;
  // a dashed outline means it is still a draft (owner 2026-11-23).
  if (slot.kind === 'recording') {
    if (slot.overriddenBy) return 'overridden';
    const base = slot.assigneeEmail ? 'reserved' : 'free';
    return slot.status === 'draft' ? `${base}Draft` : base;
  }
  if (Date.parse(slot.start) <= now && now < Date.parse(slot.end)) return 'live';
  if (slot.status === 'draft') return 'draft';
  return slot.assigneeEmail ? 'booked' : 'open';
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

const fieldClass = 'mt-1 block h-10 w-full rounded-lg border border-slate-300 px-3 text-sm';

// Recording session: optionally the lecturer it is booked for. Left blank, the
// session stays free (green); filled in, it is booked for them (red).
function RecordingPersonFields({ draft, setDraft }) {
  const email = String(draft.person || '').trim();
  const badEmail = Boolean(email) && !EMAIL_SHAPE.test(email);
  const booked = Boolean(email) && !badEmail;
  return (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-slate-600">Their email (optional)
        <input
          value={draft.person || ''}
          onChange={(event) => setDraft({ ...draft, person: event.target.value })}
          type="email"
          placeholder="name@gmail.com"
          aria-invalid={badEmail}
          className={cn(fieldClass, badEmail && 'border-rose-400')}
        />
      </label>
      {badEmail && <p className="text-[11px] font-medium text-rose-700">That email does not look right.</p>}
      <label className="block text-xs font-medium text-slate-600">Their name (optional)
        <input value={draft.name || ''} onChange={(event) => setDraft({ ...draft, name: event.target.value })} maxLength={80} placeholder="e.g. Dr Lim" className={fieldClass} />
      </label>
      <p className={cn('flex items-start gap-2 rounded-lg px-2.5 py-2 text-[11px] leading-snug', booked ? 'bg-rose-50 text-rose-900' : 'bg-emerald-50 text-emerald-900')}>
        <span aria-hidden="true" className={cn('mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full', booked ? 'bg-rose-500' : 'bg-emerald-500')} />
        {booked
          ? 'Booked for this lecturer. Publishing emails them, with reminders the day before and on the day.'
          : 'Free session: nobody is booked yet, so nobody is emailed. Fill in an email to book it.'}
      </p>
    </div>
  );
}

// Test slot: one or more people at the same time, each on a GPU of their own.
function TestPeopleField({ draft, setDraft, people }) {
  const editing = Boolean(draft.id);
  const chosen = editing ? [draft.person].filter(Boolean) : (draft.persons || []);
  const [typed, setTyped] = useState('');
  function toggle(email) {
    if (editing) { setDraft({ ...draft, person: email }); return; }
    setDraft({ ...draft, persons: chosen.includes(email) ? chosen.filter((item) => item !== email) : [...chosen, email] });
  }
  function addTyped() {
    const emails = typed.split(/[\s,;]+/u).map((value) => value.trim().toLowerCase()).filter((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value));
    if (emails.length === 0) return;
    if (editing) setDraft({ ...draft, person: emails[0] });
    else setDraft({ ...draft, persons: [...new Set([...chosen, ...emails])] });
    setTyped('');
  }
  const listed = [...people, ...chosen.filter((email) => !people.some((entry) => entry.email === email)).map((email) => ({ email, name: '', approvedVoices: [] }))];
  return (
    <div className="text-xs font-medium text-slate-600">
      {editing ? 'Who' : 'Who (pick one or more)'}
      <div className="mt-1 flex flex-wrap gap-1.5">
        {listed.map((entry) => {
          // Only people with an approved voice can be assigned a slot (the server refuses the rest).
          const blocked = !entry.approvedVoices.length && !chosen.includes(entry.email);
          return (
            <button key={entry.email} type="button" disabled={blocked} onClick={() => toggle(entry.email)} aria-pressed={chosen.includes(entry.email)} className={cn('min-h-8 rounded-full px-3 py-1 text-xs font-semibold', chosen.includes(entry.email) ? 'bg-slate-900 text-white' : 'bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-100', blocked && 'cursor-not-allowed opacity-50 hover:bg-white')} title={blocked ? `${entry.email}: approve their voice first` : entry.email}>
              {entry.name || entry.email}{entry.approvedVoices.length ? '' : ' · not approved yet'}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex gap-2">
        <input value={typed} onChange={(event) => setTyped(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addTyped(); } }} placeholder="or type an email" type="email" className="block h-9 min-w-0 flex-1 rounded-lg border border-slate-300 px-2 text-sm" />
        <Button size="sm" variant="outline" onClick={addTyped} disabled={!typed.trim()}>Add</Button>
      </div>
      <p className="mt-1 text-[11px] text-slate-500">Approve a person&apos;s voice first, then assign their test slot.</p>
      {!editing && chosen.length > 1 && <p className="mt-1 text-[11px] text-slate-500">{chosen.length} people: one slot and one GPU each, all warmed 30 min before.</p>}
    </div>
  );
}

const sgtTime = (value) => formatSgt(value, { withDate: false });

// Staff availability (recording only). Free time another booking took first
// cannot be booked; booking free time takes everyone else's overlapping free
// time, unless the session is handed to one of them.
function AvailabilityFields({ draft, setDraft, availability, me, onPickAnother }) {
  const { overriddenBy, freeStaff, taken } = availability;
  if (overriddenBy) {
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs leading-snug text-amber-950">
        <p className="font-semibold">This free time was taken</p>
        <p className="mt-1">{(overriddenBy.hostNames || []).join(', ') || 'Another staff member'} booked {overriddenBy.assigneeName || 'a lecturer'} for {sgtTime(overriddenBy.start)} – {sgtTime(overriddenBy.end)}. The first booking gets the time, so this cannot be booked. Move it, delete it, or pick another time.</p>
        <Button size="sm" variant="dark" className="mt-2" onClick={onPickAnother}>Pick another time</Button>
      </div>
    );
  }
  const email = String(draft.person || '').trim();
  const booked = Boolean(email) && EMAIL_SHAPE.test(email);
  // Free time over a booking is refused (the first booking has the time): say so here, with a way out.
  if (!booked && availability.clash) {
    const clash = availability.clash;
    const endMinutes = sgtMinutes(clash.end);
    return (
      <div className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2.5 text-xs leading-snug text-rose-950">
        <p className="font-semibold">This overlaps a booking</p>
        <p className="mt-1">{clash.assigneeName || clash.assigneeEmail} is booked {sgtTime(clash.start)} – {sgtTime(clash.end)}{slotHosts(clash).length ? ` with ${slotHosts(clash).join(', ')}` : ''}. The first booking gets the time, so free time cannot go over it.</p>
        <Button size="sm" variant="outline" className="mt-2" onClick={() => setDraft({ ...draft, start: endMinutes })}>Start at {formatMinutes(endMinutes)} instead</Button>
      </div>
    );
  }
  if (!booked || draft.originalPerson) {
    // Several staff on NEW free time: each gets a block of their own, so one can be overridden without the others.
    const hosts = draft.hosts || [];
    return !booked && !draft.id && hosts.length > 1
      ? <p className="rounded-lg bg-slate-100 px-2.5 py-2 text-[11px] leading-snug text-slate-700">Adds <b>{hosts.length} free blocks</b> side by side, one per staff member, so each person&apos;s time can be booked or overridden on its own.</p>
      : null;
  }
  const hosts = draft.hosts || [];
  const owners = draft.ownHosts?.length ? draft.ownHosts : hosts.slice(0, 1);
  const choices = addHosts(addHosts([], owners.join(','), 8), freeStaff.join(','), 8);
  const others = overriddenOthers(taken, hosts);
  return (
    <div className="space-y-2">
      {choices.length > 1 && (
        <div className="text-xs font-medium text-slate-600">
          Who runs it
          <div className="mt-1 space-y-1">
            {choices.map((name) => {
              const chosen = hosts.length === 1 && hosts[0].toLowerCase() === name.toLowerCase();
              return (
                <label key={name} className={cn('flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 ring-1', chosen ? 'bg-white ring-slate-900' : 'ring-slate-200 hover:bg-white')}>
                  <input type="radio" name="booking-host" checked={chosen} onChange={() => setDraft({ ...draft, hosts: [name] })} />
                  <StaffChip name={name} size="sm" />
                  <span className="text-[11px] font-normal text-slate-500">
                    {me && name.toLowerCase() === me.toLowerCase() ? 'you, since you are booking it' : owners.some((owner) => owner.toLowerCase() === name.toLowerCase()) ? 'owns this free time' : 'also free then: hand it to them'}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      )}
      {others.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-[11px] leading-snug text-amber-950">
          <p className="text-xs font-semibold">This overrides other availability</p>
          <ul className="mt-1.5 space-y-1">
            {others.map((slot) => (
              <li key={slot.id} className="flex flex-wrap items-center gap-1.5">
                {slotHosts(slot).map((name) => <StaffChip key={name} name={name} size="sm" />)}
                <span>{sgtTime(slot.start)} – {sgtTime(slot.end)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5">The first booking gets the time. They are emailed when you publish and asked to pick another time{choices.length > 1 ? ', or hand the session to one of them above' : ''}.</p>
        </div>
      )}
    </div>
  );
}

function SlotComposer({ kind, draft, setDraft, people, staffSuggestions, onSave, onDelete, onDiscard, onCancel, availability, me, onPickAnother }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const typedEmail = String(draft.person || '').trim();
  const taken = kind === 'recording' && Boolean(availability?.overriddenBy);
  const overriding = kind === 'recording' && !taken && typedEmail && EMAIL_SHAPE.test(typedEmail) && !draft.originalPerson
    ? overriddenOthers(availability?.taken || [], draft.hosts || []).length : 0;
  const freeBlocks = kind === 'recording' && !draft.id && !typedEmail ? Math.max(1, (draft.hosts || []).length) : 1;
  const canSave = kind === 'recording'
    ? (!typedEmail || EMAIL_SHAPE.test(typedEmail)) && !(availability?.clash && !typedEmail)
    : Boolean(draft.id ? draft.person : (draft.persons || []).length);
  const end = draft.start + draft.minutes;
  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
            {kind !== 'recording' ? `${draft.id ? 'Edit' : 'New'} test slot`
              : !draft.id ? (typedEmail ? 'Book a session' : 'Your availability')
                : draft.originalPerson ? 'Edit booked session' : taken ? 'Overridden availability' : 'Book this free time'}
          </p>
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
      {kind === 'recording' && !taken && <RecordingPersonFields draft={draft} setDraft={setDraft} />}
      {kind === 'test' && <TestPeopleField draft={draft} setDraft={setDraft} people={people} />}
      {kind === 'recording' && availability && <AvailabilityFields draft={draft} setDraft={setDraft} availability={availability} me={me} onPickAnother={onPickAnother} />}
      {kind === 'recording' && (
        <StaffField value={draft.hosts || []} onChange={(hosts) => setDraft({ ...draft, hosts })} suggestions={staffSuggestions} />
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        <Button variant={overriding ? 'danger' : 'dark'} disabled={!canSave} onClick={onSave}>
          {overriding ? `Book & override ${overriding} availabilit${overriding === 1 ? 'y' : 'ies'}` : draft.id ? 'Save changes' : kind === 'recording' ? (freeBlocks > 1 ? `Add ${freeBlocks} free blocks` : typedEmail ? 'Book session' : 'Add free time') : 'Add slot'}
        </Button>
        {draft.live && <Button variant="outline" onClick={onDiscard}>Discard changes</Button>}
        {draft.id && (confirmDelete
          ? <Button variant="danger" onClick={onDelete}>Confirm delete</Button>
          : <Button variant="ghost" onClick={() => setConfirmDelete(true)}><Trash2 size={14} /> Delete</Button>)}
      </div>
      {draft.live && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Not published yet. Until you press Publish, the slot stays at <b>{formatSgt(draft.live.start)} – {formatSgt(draft.live.end, { withDate: false })}</b>
          {draft.live.assigneeEmail !== draft.person ? <> for <b>{draft.live.assigneeName || draft.live.assigneeEmail}</b></> : ''} (their page, GPU and reminders follow that).
        </p>
      )}
      {draft.id && <p className="text-[11px] text-slate-500">{kind === 'recording' ? 'Saving a published one makes it a draft again until you publish.' : draft.published ? 'Changes to a published slot are saved as a draft. Nothing changes for the lecturer (time, GPU, page, emails) until you press Publish.' : 'A draft: nothing is sent and no GPU is kept for it until you press Publish.'}</p>}
    </div>
  );
}

// After free time was overridden: the hours still open that day, one tap each.
function OpenHours({ day, who, hours, onMarkFree, onClose }) {
  return (
    <div className="space-y-3 rounded-xl border border-indigo-200 bg-white p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-indigo-700">Pick another time</p>
          <p className="text-sm font-semibold text-slate-900">Open hours on {formatDay(day)}</p>
          <p className="mt-0.5 text-xs text-slate-500">Nobody is booked then{who ? <>; marks <b>{who}</b> as free</> : ''}. Free time is a draft until published.</p>
        </div>
        <button type="button" onClick={onClose} className="-m-1 shrink-0 rounded-lg p-2 text-slate-400 hover:bg-slate-100" aria-label="Close"><X size={16} /></button>
      </div>
      {hours.length === 0 ? <p className="text-sm text-slate-500">No open hours left that day. Pick another day on the calendar.</p> : (
        <ul className="space-y-1.5">
          {hours.slice(0, 8).map((range) => (
            <li key={range.start} className="flex items-center justify-between gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-950">
              <span>{sgtTime(range.start)} – {sgtTime(range.end)}</span>
              <Button size="sm" variant="outline" onClick={() => onMarkFree(range)}>Mark me free</Button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-slate-500">Or choose another day on the calendar and tap a time.</p>
    </div>
  );
}

const SCHEDULE_COPY = {
  recording: {
    title: 'Staff availability',
    help: 'Click a time to add when you are free (green). To book a lecturer, open free time and add their email. The first booking gets the time: other staff free then are overridden and emailed to pick another time, or you can hand the session to one of them.',
    footer: 'Only staff see this calendar. Publishing emails the lecturer (reminded the day before and on the day) and any staff whose free time was overridden. The lecturer\'s recording page opens only during their session.',
    list: 'Upcoming recording sessions',
    open: 'Available',
    tones: ['free', 'reserved', 'overridden'],
  },
  test: {
    title: 'Test slot calendar',
    help: 'Click a time, then pick the approved lecturers to assign it to. Each gets a GPU of their own.',
    footer: 'Publishing emails each person their time. Their GPU starts 30 minutes before with their voice loaded. Outside a slot they can still test with a cold start; sending feedback ends their testing.',
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
  // A published test slot with unpublished changes is drawn as its draft (the new
  // time/person); `live` keeps what is published and running until Publish.
  const slots = overview.slots
    .map((slot) => (slot.pending
      ? { ...slot, ...slot.pending, status: 'draft', live: { start: slot.start, end: slot.end, assigneeEmail: slot.assigneeEmail, assigneeName: slot.assigneeName } }
      : slot))
    .filter((slot) => (slot.kind === 'recording' ? 'recording' : 'test') === kind && Date.parse(slot.end) > nowMs);
  const [day, setDay] = useState(today);
  const [month, setMonth] = useState(monthOf(today));
  const minutesDefault = DEFAULT_MINUTES[kind];
  const blankDraft = (fields) => ({ minutes: minutesDefault, person: '', name: '', persons: kind === 'test' && prefill ? [prefill] : [], hosts: kind === 'recording' ? knownStaff().slice(0, 1) : [], ...fields });
  const [draft, setDraft] = useState(() => (prefill ? blankDraft({ day: today, start: 13 * 60 }) : null));
  const people = overview.people || [];
  // Staff to offer as one-tap chips: everyone already running a session, then this browser's recent names.
  const staffSuggestions = useMemo(
    () => addHosts([], [...overview.slots.flatMap((slot) => slotHosts(slot)), ...knownStaff()].join(','), 20),
    [overview.slots],
  );
  const drafts = overview.draftCount || 0;
  // Staff availability (recording): who is looking (their super-user name, else the
  // last staff name this browser used), free time a booking would take, open hours.
  const auth = useAuth();
  const recording = kind === 'recording';
  const me = useMemo(() => {
    const mine = (overview.superusers || []).find((user) => user.email === auth.user?.email?.toLowerCase());
    return mine?.name || knownStaff()[0] || '';
  }, [overview.superusers, auth.user?.email]);
  const [openHoursFor, setOpenHoursFor] = useState(null); // { day, who }
  const [lastBooking, setLastBooking] = useState(null); // { id, label, overridden, hosts } for Undo
  const [dismissed, setDismissed] = useState(() => {
    try { return JSON.parse(window.localStorage.getItem('voice-studio-dismissed-overrides') || '[]'); } catch { return []; }
  });
  const dismiss = (id) => {
    const next = [...dismissed, id].slice(-50);
    setDismissed(next);
    try { window.localStorage.setItem('voice-studio-dismissed-overrides', JSON.stringify(next)); } catch { /* per-viewer only */ }
  };
  const takenFromMe = recording ? overriddenFor(slots, me).filter((slot) => !dismissed.includes(slot.id)) : [];
  const draftRange = draft && recording
    ? { start: sgtIso(draft.day, draft.start), end: new Date(Date.parse(sgtIso(draft.day, draft.start)) + draft.minutes * 60_000).toISOString() }
    : null;
  const draftOriginal = draft?.id ? slots.find((slot) => slot.id === draft.id) : null;
  const availability = draftRange ? {
    overriddenBy: draftOriginal?.overriddenBy || null,
    taken: freeTimeTaken(slots, draftRange, draft.id || ''),
    freeStaff: staffFreeAt(slots, draftRange, draft.id || ''),
    // A booking this free time would sit on (refused by the server; warned in the form).
    clash: draftOriginal?.overriddenBy ? null : bookingAt(slots, draftRange, draft.id || ''),
  } : null;
  function pickAnotherTime(slot, who) {
    const key = sgtDayKey(slot.start);
    setDay(key);
    setMonth(monthOf(key));
    setDraft(null);
    setOpenHoursFor({ day: key, who: who || slotHosts(slot)[0] || me });
  }
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
    title: slot.overriddenBy ? 'Overridden' : slot.assigneeName || slot.assigneeEmail || copy.open,
    subtitle: slot.overriddenBy
      ? `Taken by ${(slot.overriddenBy.hostNames || []).join(', ') || 'a booking'}'s booking${slot.overriddenBy.assigneeName ? ` (${slot.overriddenBy.assigneeName})` : ''}`
      : `${formatSgt(slot.start, { withDate: false })} – ${formatSgt(slot.end, { withDate: false })}${slot.status === 'draft' ? ' · draft' : ''}${slot.assigneeEmail && slot.assigneeName ? ` · ${slot.assigneeEmail}` : ''}`,
    staff: slotHosts(slot),
  }));

  function selectDay(key) {
    setDay(key);
    setMonth(monthOf(key));
    if (draft && !draft.id) setDraft({ ...draft, day: key });
  }
  function edit(slot) {
    const original = slots.find((item) => item.id === slot.id);
    if (!original) return;
    const key = sgtDayKey(original.start);
    setDay(key);
    setMonth(monthOf(key));
    setOpenHoursFor(null);
    setDraft({
      id: original.id, day: key, start: sgtMinutes(original.start),
      minutes: Math.round((Date.parse(original.end) - Date.parse(original.start)) / 60000),
      person: original.assigneeEmail || '', originalPerson: original.assigneeEmail || '', name: original.assigneeName || '', hosts: slotHosts(original), ownHosts: slotHosts(original),
      published: original.kind !== 'recording' && (original.status === 'published' || Boolean(original.live)), live: original.live || null,
    });
  }
  async function markFree(range) {
    const who = openHoursFor?.who || me;
    if (who) rememberStaff([who]);
    await onAction(() => addSlot({ kind: 'recording', start: range.start, end: range.end, hostNames: who ? [who] : [] }));
  }
  async function save() {
    const start = sgtIso(draft.day, draft.start);
    const end = new Date(Date.parse(start) + draft.minutes * 60_000).toISOString();
    const nameOf = (email) => people.find((entry) => entry.email === email)?.name || '';
    const hostNames = kind === 'recording' ? (draft.hosts || []) : undefined;
    if (hostNames) rememberStaff(hostNames);
    let body;
    if (kind === 'recording') {
      body = { kind, start, end, assigneeEmail: String(draft.person || '').trim(), assigneeName: String(draft.name || '').trim(), hostNames };
    } else if (draft.id) {
      const email = String(draft.person || '').trim();
      body = { kind, start, end, assigneeEmail: email, assigneeName: email === draft.originalPerson ? draft.name : nameOf(email) };
    } else {
      body = { kind, start, end, assignees: (draft.persons || []).map((email) => ({ email, name: nameOf(email) })) };
    }
    // Booking free time: remember enough to Undo, and whose time it overrides.
    const booking = recording && draft.id && !draft.originalPerson && body.assigneeEmail && !availability?.overriddenBy
      ? { id: draft.id, label: `${body.assigneeName || body.assigneeEmail} · ${formatMinutes(draft.start)} – ${formatMinutes((draft.start + draft.minutes) % (24 * 60))}`, hosts: draft.ownHosts || [], runBy: hostNames || [], overridden: [...new Set(overriddenOthers(availability?.taken || [], hostNames || []).flatMap((slot) => slotHosts(slot)))] }
      : null;
    // New free time for several staff: one block each, so each person's time stands on its own.
    const perStaff = recording && !draft.id && !body.assigneeEmail && (hostNames || []).length > 1;
    const done = await onAction(async () => {
      if (draft.id) return editSlot(draft.id, body);
      if (!perStaff) return addSlot(body);
      let result;
      for (const host of hostNames) result = await addSlot({ ...body, hostNames: [host] });
      return result;
    });
    if (!done) return;
    setLastBooking(booking);
    // Adding a run of sessions: the composer moves on to the next free time.
    setDraft(draft.id ? null : blankDraft({ day: draft.day, start: Math.min(23 * 60 + 45, draft.start + draft.minutes), minutes: draft.minutes, hosts: draft.hosts }));
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
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
          <Legend tones={copy.tones} />
          {kind === 'recording' && <span className="inline-flex items-center gap-1.5 text-xs text-slate-600"><span aria-hidden="true" className="h-2.5 w-4 rounded-sm border border-dashed border-slate-500" /> Dashed = draft, not published yet</span>}
          {recording && me && <span className="ml-auto"><StaffChip name={me} size="sm" /> <span className="text-[11px] text-slate-500">is you on this browser</span></span>}
        </div>
      </Card>

      {/* What the overridden staff member sees: their free time was taken; pick another. */}
      {takenFromMe.map((slot) => (
        <div key={slot.id} role="status" className="flex flex-wrap items-center gap-3 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <CalendarClock size={18} className="shrink-0 text-amber-700" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">Your {sgtTime(slot.start)} – {sgtTime(slot.end)} on {formatDay(sgtDayKey(slot.start))} was taken.</p>
            <p className="text-xs">{(slot.overriddenBy.hostNames || []).join(', ') || 'Another staff member'} booked {slot.overriddenBy.assigneeName || 'a lecturer'} in that time, so your availability was overridden. Please pick another time.</p>
          </div>
          <Button size="sm" variant="dark" onClick={() => pickAnotherTime(slot, me)}>Pick another time</Button>
          <Button size="sm" variant="ghost" onClick={() => dismiss(slot.id)}>Dismiss</Button>
        </div>
      ))}

      {/* What the booker sees right after booking: who was overridden, with Undo. */}
      {lastBooking && (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-2xl bg-slate-900 px-4 py-3 text-sm text-white">
          <CheckCircle2 size={18} className="shrink-0 text-emerald-400" aria-hidden="true" />
          <p className="min-w-0 flex-1">
            Booked <b>{lastBooking.label}</b>{lastBooking.runBy.length ? ` with ${lastBooking.runBy.join(', ')}` : ''}.
            {lastBooking.overridden.length > 0 && ` ${lastBooking.overridden.join(', ')}'s availability at that time was overridden; they are emailed when you publish.`}
          </p>
          <Button size="sm" variant="outline" onClick={() => onAction(() => editSlot(lastBooking.id, { assigneeEmail: '', assigneeName: '', hostNames: lastBooking.hosts })).then((done) => { if (done) setLastBooking(null); })}>Undo</Button>
          <button type="button" onClick={() => setLastBooking(null)} className="rounded-lg p-1.5 text-slate-300 hover:bg-white/10" aria-label="Close"><X size={16} /></button>
        </div>
      )}

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
              staffSuggestions={staffSuggestions}
              onSave={save}
              onCancel={() => setDraft(null)}
              onDelete={() => onAction(() => deleteSlot(draft.id)).then((done) => { if (done) setDraft(null); })}
              onDiscard={() => onAction(() => discardSlotChanges(draft.id)).then((done) => { if (done) setDraft(null); })}
              availability={availability}
              me={me}
              onPickAnother={() => draftOriginal && pickAnotherTime(draftOriginal)}
            />
            </div>
          )}
          {recording && !draft && openHoursFor && (
            <OpenHours
              day={openHoursFor.day}
              who={openHoursFor.who}
              hours={openHours(slots, openHoursFor.day, { nowMs, who: openHoursFor.who })}
              onMarkFree={markFree}
              onClose={() => setOpenHoursFor(null)}
            />
          )}
        </div>
        <Card className="min-w-0 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold text-slate-900">{formatDay(day)}</h3>
            <div className="flex gap-2">
              {day !== today && <Button size="sm" variant="ghost" onClick={() => { setDay(today); setMonth(monthOf(today)); }}>Today</Button>}
              <Button size="sm" variant="outline" onClick={() => setDraft(blankDraft({ day, start: Math.max(hours.start, 9 * 60), minutes: draft?.minutes || minutesDefault, hosts: draft?.hosts ?? knownStaff().slice(0, 1) }))}><CalendarClock size={13} /> Add on this day</Button>
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
              onSlotDelete={(slot) => onAction(() => deleteSlot(slot.id)).then((done) => { if (done && draft?.id === slot.id) setDraft(null); })}
              onEmptyClick={(minutes) => setDraft(draft && !draft.id ? { ...draft, day, start: minutes } : blankDraft({ day, start: minutes, hosts: draft?.hosts ?? knownStaff().slice(0, 1) }))}
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
                      <span className="font-medium text-slate-800 sm:w-44 sm:shrink-0">
                        {formatSgt(slot.start)} – {formatSgt(slot.end, { withDate: false })}
                        {slot.live && <span className="block text-[11px] font-normal text-slate-500">published: {formatSgt(slot.live.start)} – {formatSgt(slot.live.end, { withDate: false })}</span>}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-slate-700" title={slot.assigneeEmail || undefined}>
                        {slot.assigneeEmail ? <>{slot.assigneeName || slot.assigneeEmail} <span className="text-xs text-slate-500">{slot.assigneeName ? slot.assigneeEmail : ''}</span></> : slot.overriddenBy ? <span className="font-medium text-slate-500">Overridden · taken by {(slot.overriddenBy.hostNames || []).join(', ') || 'a booking'}</span> : <span className="font-medium text-emerald-700">{slot.assigneeName ? `${slot.assigneeName} · ` : ''}{copy.open}</span>}
                        {slotHosts(slot).length > 0 && <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">{slotHosts(slot).map((name) => <StaffChip key={name} name={name} size="sm" />)}</span>}
                      </span>
                    </span>
                    <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold', slot.status === 'draft' ? 'bg-amber-100 text-amber-800' : tone === 'live' ? 'bg-rose-100 text-rose-800' : 'bg-emerald-100 text-emerald-800')}>
                      {slot.live ? 'Changes not published' : slot.status === 'draft' ? 'Draft' : tone === 'live' ? 'Now' : 'Published'}
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
  const items = overview.jobs.filter((job) => job.status !== 'cancelled').flatMap((job) => job.feedback.map((entry) => ({ ...entry, job }))).sort((a, b) => b.at.localeCompare(a.at));
  return (
    <Card>
      <div className="border-b border-slate-200 px-5 py-3"><h2 className="font-semibold text-slate-900">Feedback received</h2></div>
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
      {/* Email health lives here now that the old Overview is gone. */}
      {!overview.emailConfigured
        ? <Notice tone="warn">Email is not configured on the server yet, so nobody is emailed. Everything still shows on the line map.</Notice>
        : <TestEmail />}
      <Card className="p-5">
        <h2 className="font-semibold text-slate-900">Add a super user</h2>
        <p className="mt-1 text-sm text-slate-600">Super users review voices, assign test slots, see all feedback and manage this list. They are emailed when added.</p>
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

// ── Super user shell: the train line ─────────────────────────────────────

// Stop 4: the waiting list beside the voice being checked. /quality opens the
// oldest waiting voice, or says nothing is waiting.
// Quality check has two tabs (owner 2026-11-24): the sets to check, and testing any voice.
function QualityTabs() {
  const { pathname } = useLocation();
  const tab = ({ isActive }) => cn('inline-flex h-9 items-center rounded-lg px-3 text-sm font-semibold', isActive ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100');
  return (
    <nav aria-label="Quality check" className="flex gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm sm:w-fit">
      <NavLink to="/quality" end className={({ isActive }) => tab({ isActive: isActive || pathname.startsWith('/review/') })}>Sets to check</NavLink>
      <NavLink to="/quality/test" className={tab}>Test any voice</NavLink>
    </nav>
  );
}

function QualityCheck({ overview, onAction, line }) {
  const { jobId } = useParams();
  const now = Date.parse(overview.now) || Date.now();
  if (!jobId) {
    const first = overview.jobs.filter((job) => job.status === 'review' || job.status === 'failed')
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
    if (first) return <Navigate to={`/review/${encodeURIComponent(first.id)}`} replace />;
  }
  return (
    <>
    <QualityTabs />
    <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
      <QualityList jobs={overview.jobs} selectedId={jobId || ''} now={now} />
      {jobId ? <JobDetail overview={overview} onAction={onAction} line={line} /> : <Notice tone="success">Nothing is waiting for quality check. Use “Test any voice” above to try any trained voice.</Notice>}
    </div>
    </>
  );
}

// A stop's page: its header, then its content.
function Stage({ stopKey, children }) {
  return (
    <div className="space-y-5">
      <StageHeader stopKey={stopKey} />
      {children}
    </div>
  );
}

// The recorder, opened from stop 2's "Upload audio" with the lecturer prefilled.
function UploadForSomeone() {
  const [params] = useSearchParams();
  const email = params.get('for') || '';
  const forPerson = email ? { email, name: params.get('name') || '' } : null;
  const navigate = useNavigate();
  return (
    <Stage stopKey="record">
      {/* A way straight back to the list this page was opened from (owner 2026-11-24). */}
      <div className="sticky top-0 z-20 -mx-1 flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white/95 px-3 py-2 shadow-sm backdrop-blur lg:top-2">
        <Button variant="outline" size="sm" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/recording'))}>
          <ChevronLeft size={15} aria-hidden="true" /> Back to Recording
        </Button>
        <p className="min-w-0 text-sm text-slate-600">
          {forPerson ? <>Uploading for <b className="text-slate-900">{forPerson.name || forPerson.email}</b>{forPerson.name ? <span className="text-slate-500"> · {forPerson.email}</span> : null}</> : 'Upload for anyone'}
        </p>
      </div>
      <RecordWorkspace key={email} embedded forPerson={forPerson} />
    </Stage>
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

  const line = useMemo(() => (data ? buildLine(data) : null), [data]);
  const now = data ? Date.parse(data.now) || Date.now() : Date.now();
  return (
    <div className="flex min-h-screen bg-slate-100">
      <SuperSidebar line={line} email={auth.user?.email} onSignOut={() => auth.signOut()} />
      <div className="min-w-0 flex-1">
        <div className="sticky top-0 z-30 lg:hidden">
          <Header product="Voice Studio · Super user" />
          <MobileLine line={line} />
        </div>
        <main className="mx-auto max-w-[1680px] space-y-4 px-4 py-4 sm:px-6 sm:py-6 xl:px-8">
          {data && <VoiceFailures overview={data} />}
          {/* Busy: a thin bar across the top plus a clear, calm pill (owner 2026-11-24: more visible, not flashy). */}
          {busy && (
            <>
              <div aria-hidden="true" className="fixed inset-x-0 top-0 z-50 h-1 overflow-hidden bg-primary/15">
                <div className="h-full w-1/3 animate-[studio-busy_1.1s_ease-in-out_infinite] rounded-full bg-primary" />
              </div>
              <div role="status" className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2.5 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 shadow-xl lg:bottom-auto lg:left-auto lg:right-6 lg:top-5 lg:translate-x-0">
                <Loader2 size={18} className="animate-spin text-primary" aria-hidden="true" /> Updating…
              </div>
              <style>{'@keyframes studio-busy{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}'}</style>
            </>
          )}
          {/* Errors float at the bottom so they are seen wherever the page is scrolled. */}
          {error && (
            <div role="alert" className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-xl items-start gap-3 rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900 shadow-lg">
              <p className="min-w-0 flex-1">{error}</p>
              <button type="button" onClick={() => setError('')} className="-m-1 shrink-0 rounded-lg p-1.5 text-rose-500 hover:bg-rose-100" aria-label="Close"><X size={16} /></button>
            </div>
          )}
          {!data ? <div className="flex justify-center py-20"><Loader2 className="animate-spin text-slate-400" /></div> : (
            <Routes>
              <Route path="/" element={<LineMap line={line} now={now} />} />
              <Route path="/sessions" element={<Stage stopKey="book"><StaffAvailability overview={data} onAction={onAction} /></Stage>} />
              <Route path="/recording" element={<Stage stopKey="record"><RecordingStage overview={data} line={line} onAction={onAction} /></Stage>} />
              <Route path="/record" element={<UploadForSomeone />} />
              <Route path="/training" element={<Stage stopKey="train"><TrainingStage overview={data} onAction={onAction} /></Stage>} />
              <Route path="/quality" element={<Stage stopKey="qc"><QualityCheck overview={data} onAction={onAction} line={line} /></Stage>} />
              <Route path="/review/:jobId" element={<Stage stopKey="qc"><QualityCheck overview={data} onAction={onAction} line={line} /></Stage>} />
              <Route path="/schedule" element={<Stage stopKey="assign"><Schedule overview={data} onAction={onAction} kind="test" /></Stage>} />
              <Route
                path="/feedback"
                element={(
                  <Stage stopKey="test">
                    <TestingNow overview={data} />
                    <FeedbackList overview={data} />
                  </Stage>
                )}
              />
              <Route path="/quality/test" element={<Stage stopKey="qc"><QualityTabs /><SuperTest /></Stage>} />
              <Route path="/test" element={<Navigate to="/quality/test" replace />} />
              <Route path="/superusers" element={<Superusers overview={data} onAction={onAction} />} />
              <Route path="/cleanup" element={<CleanUp overview={data} onAction={onAction} />} />
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

function FeedbackForm({ job, onSent }) {
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
      const view = await sendFeedback(job.id, { rating, likeness, issues, words: wordsWanted ? words : '', comment });
      setState('saved');
      onSent?.(view);
    } catch (err) {
      setState(errorText(err));
    }
  }
  return (
    <Card className="p-4 sm:p-5">
      <h3 className="font-semibold text-slate-900">Done testing? Tell us how it sounds</h3>
      <p className="mt-1 text-sm text-slate-600">About a minute. You can keep testing after you send it, and send more feedback any time.</p>
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
        <Button type="submit" variant="dark" className="w-full sm:w-auto" disabled={!rating || state === 'saving' || state === 'saved'}>{rating ? 'Send feedback and finish testing' : 'Pick a star rating to send'}</Button>
        {state === 'saved' && <p className="text-sm text-emerald-700">Thank you — sent.</p>}
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

function VoiceJourney({ job, now, testSlot }) {
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
  } else if (job.status === 'ready' && job.testingClosedAt && !testSlot) {
    // Feedback never closes testing (owner 2026-11-27); training again goes through the team.
    const lastFeedback = (job.feedback || []).at(-1);
    title = 'Thank you for your feedback';
    body = (
      <>
        <p>We received your feedback on {formatSgt(lastFeedback?.at || job.testingClosedAt)} SGT. Our team reads it and emails you about next steps. You can keep testing your voice and send more feedback any time.</p>
        <p>Want another voice, or this one trained again with new recordings? Please ask our team; they reopen your recording page for you.</p>
      </>
    );
  } else if (job.status === 'ready' && testSlot) {
    // Feedback already sent in an earlier slot: thank them, then the next time.
    const lastFeedback = (job.feedback || []).at(-1);
    title = lastFeedback ? 'Thank you — your next test time is booked' : 'Your test time is booked';
    body = (
      <>
        {lastFeedback && <p>We received your feedback on {formatSgt(lastFeedback.at)} SGT.</p>}
        <p>{lastFeedback ? 'Your next test time: ' : ''}<b>{formatRange(testSlot.start, testSlot.end)}</b> ({relativeFromNow(testSlot.start, now)}). A GPU is warmed up just for you before it starts; we email you that morning.</p>
      </>
    );
  } else if (job.status === 'ready') {
    title = 'Passed quality control — awaiting your test time';
    body = <p>Our team is booking a time for you to test it, and emails it to you. You can also test now: a GPU starts just for you, which takes about 5–15 minutes.</p>;
  }
  return (
    <Card className="p-4 sm:p-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="min-w-0 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500 [overflow-wrap:anywhere]">{job.label}</p>
        {job.attempt > 1 && job.status !== 'ready' && <span className="text-xs text-slate-400">improving it (try {job.attempt})</span>}
      </div>
      <div className="mt-5"><JourneySteps step={job.status === 'ready' && job.testingClosedAt ? JOURNEY.length : step} retrain={retrain} /></div>
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

function LecturerHome({ me: initialMe, refresh }) {
  const now = useNow();
  const [me, setMe] = useState(initialMe);
  useEffect(() => setMe(initialMe), [initialMe]);
  const ready = me.jobs.filter((job) => job.status === 'ready');
  // Feedback never closes testing (owner 2026-11-27): every ready voice stays testable.
  const testable = ready.filter((job) => job.voiceName);
  const submitted = me.jobs.filter((job) => !['uploading', 'cancelled'].includes(job.status));
  // Sets still on their way; once every one is tested, the newest shows "session finished".
  const finished = (job) => job.status === 'ready' && Boolean(job.testingClosedAt);
  const journeys = submitted.some((job) => !finished(job)) ? submitted.filter((job) => !finished(job)) : submitted.slice(0, 1);
  const slot = me.activeSlot && Date.parse(me.activeSlot.end) > now ? me.activeSlot : null;
  const testSlot = me.mySlot && !slot ? me.mySlot : null;
  const recording = me.recording || {};
  // Recording is open whenever nothing of theirs is on the line (owner 2026-11-24).
  // Recording sessions are for staff and emails only: they never change this page.
  const recordingOpen = recording.reason === 'open';
  const [feedbackJob, setFeedbackJob] = useState('');
  const feedbackTarget = testable.find((job) => job.id === feedbackJob) || testable[0];
  // Outside a slot the GPU starts only when they ask (a cold start just for them).
  const [testNow, setTestNow] = useState(false);
  const testing = testable.length > 0 && (Boolean(slot) || testNow);

  // Re-read at test-slot boundaries so testing unlocks and locks on time.
  useEffect(() => {
    const times = [slot?.end, testSlot?.start].filter(Boolean).map((value) => Date.parse(value)).filter((value) => value > Date.now());
    if (times.length === 0) return undefined;
    const id = window.setTimeout(refresh, Math.max(1000, Math.min(...times) - Date.now() + 1500));
    return () => window.clearTimeout(id);
  }, [slot, testSlot, refresh]);
  useEffect(() => {
    if (testing) return undefined;
    const id = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(id);
  }, [refresh, testing]);

  // One stage at a time: testing → recording → the voice's journey → withdrawn → waiting for a session.
  let content;
  if (me.voiceFailed) {
    // Their voice could not be loaded on a GPU (owner 2026-11-25): say so plainly.
    content = (
      <Card className="border-rose-200 p-8 text-center sm:p-12">
        <h2 className="text-xl font-semibold text-slate-900">We could not load your voice</h2>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-600">
          Something is wrong with your trained voice, so it cannot be tested and your test time has been closed. The Voice Studio team has been told automatically and will contact you about the next step. You do not need to do anything.
        </p>
      </Card>
    );
  } else if (testing) {
    content = (
      <>
        <div className="rounded-2xl bg-emerald-600 px-4 py-4 text-white sm:px-5">
          <p className="text-base font-semibold sm:text-lg">{slot ? `Your test time — until ${formatSgt(slot.end, { withDate: false })} SGT` : 'Test your voice'}</p>
          <p className="text-sm text-white/85">Paste some text to hear it read in your voice, or chat with it. Fix any word it says wrongly in the Pronunciation panel. Send your feedback below whenever you like — you can keep testing after it.</p>
        </div>
        <TestBench voiceNames={testable.map((job) => job.voiceName)} canApply audience="lecturer" slotWarm={slot?.warm || null} />
        {feedbackTarget && (
          <div className="space-y-2">
            {testable.length > 1 && (
              <select value={feedbackTarget.id} onChange={(event) => setFeedbackJob(event.target.value)} className="h-10 w-full max-w-full rounded-lg border border-slate-300 bg-white px-2 text-sm sm:w-auto" aria-label="Feedback for which voice">
                {testable.map((job) => <option key={job.id} value={job.id}>{job.label}</option>)}
              </select>
            )}
            <FeedbackForm key={feedbackTarget.id} job={feedbackTarget} onSent={(view) => { if (view?.jobs) setMe(view); }} />
          </div>
        )}
      </>
    );
  } else if (recordingOpen) {
    content = (
      <RecordWorkspace embedded onSubmitted={(view) => setMe(view)} />
    );
  } else if (submitted.length > 0) {
    // Sent: only the status of what comes next, never the recording page again.
    content = (
      <>
        {journeys.map((job) => <VoiceJourney key={job.id} job={job} now={now} testSlot={job.status === 'ready' ? testSlot : null} />)}
        {/* Their test time is over but they have not sent feedback yet: ask for it
            here too, so the finished page is not a dead end (owner 2026-11-25). */}
        {me.testedSlot && !testSlot && feedbackTarget && !feedbackTarget.testingClosedAt && (
          <div className="space-y-2">
            <Card className="p-4 sm:p-5">
              <p className="font-semibold text-slate-900">Your test time is over</p>
              <p className="text-sm text-slate-600">Please tell us how your voice sounded. You can keep testing after you send it.</p>
            </Card>
            {testable.length > 1 && (
              <select value={feedbackTarget.id} onChange={(event) => setFeedbackJob(event.target.value)} className="h-10 w-full max-w-full rounded-lg border border-slate-300 bg-white px-2 text-sm sm:w-auto" aria-label="Feedback for which voice">
                {testable.map((job) => <option key={job.id} value={job.id}>{job.label}</option>)}
              </select>
            )}
            <FeedbackForm key={feedbackTarget.id} job={feedbackTarget} onSent={(view) => { if (view?.jobs) setMe(view); }} />
          </div>
        )}
        {testable.length > 0 && (
          <Card className="flex flex-wrap items-center gap-3 p-4 sm:p-5">
            <div className="min-w-0 flex-1 basis-64">
              <p className="font-semibold text-slate-900">{testSlot ? 'Want to try it before your test time?' : 'Want to test it now?'}</p>
              <p className="text-sm text-slate-600">A GPU starts just for you. The first time takes about 5–15 minutes; this page shows when it is ready.</p>
            </div>
            <Button variant="dark" className="w-full sm:w-auto" onClick={() => setTestNow(true)}>Start testing now</Button>
          </Card>
        )}
      </>
    );
  } else if (me.withdrawnOnly) {
    content = (
      <Card className="p-5 text-center sm:p-8">
        <CalendarClock size={30} className="mx-auto text-slate-400" />
        <h1 className="mt-3 text-xl font-semibold text-slate-900 sm:text-2xl">Your recordings were withdrawn</h1>
        <p className="mx-auto mt-2 max-w-md text-slate-600">Our team took your last set out of training. To record or train your voice again, please ask our team to reopen your recording page.</p>
      </Card>
    );
  } else {
    content = (
      <Card className="p-5 text-center sm:p-8">
        <CalendarClock size={30} className="mx-auto text-slate-400" />
        <h1 className="mt-3 text-xl font-semibold text-slate-900 sm:text-2xl">Nothing to do right now</h1>
        <p className="mt-2 text-slate-600">Your recordings are with our team. We email you as your voice moves along.</p>
      </Card>
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
  async function onGoogleSignIn(credential) {
    saveStudioSession(await googleSignIn(credential));
    await auth.refreshAuthState();
  }
  return (
    <SignInScreen
      product="Voice Studio"
      headline="Your teaching voice, recorded, trained and tested in one place."
      lines={[
        ['Record at your session', 'We agree a time with you; the recording page opens for you then.'],
        ['We train and check it', 'Follow its progress here; we email you when training is done and when it passes quality control.'],
        ['Test it, then tell us', 'A GPU of your own: chat, have it read text aloud, fix pronunciations, send feedback.'],
      ]}
      accent="from-[#052e2b] via-[#0f3d3a] to-[#1e1b4b]"
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
