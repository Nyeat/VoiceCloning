// The super-user pages for the line's stops that are new with the train-line
// console: Recording (stop 2), Training (stop 3), the quality-check list
// (stop 4) and who is testing (stop 6). Stops 1 and 5 reuse the schedule.
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Clock, Cpu, Loader2, RefreshCw, Trash2, Upload } from 'lucide-react';
import { cn } from '@/lib/utils';
import { STOPS } from './superLine.js';
import { cancelJob, formatSgt, relativeFromNow, runTick } from './studioApi.js';
import { Button, Card } from './StudioChrome.jsx';
import { riderNote } from './LineMap.jsx';

const STOP_LABEL = Object.fromEntries(STOPS.map((stop) => [stop.key, stop.label]));
const WEEK_MS = 7 * 24 * 3600_000;
const who = (job) => job.ownerName || job.ownerEmail;
// Only a finished session with nothing uploaded needs "Upload audio"; a draft at stop 1 also waits on you, but for publishing.
const needsUpload = (rider) => rider.stop === 'record' && rider.alert;

function ListCard({ title, subtitle, children, empty, action = null }) {
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3.5">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-slate-900">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-slate-600">{subtitle}</p>}
        </div>
        {action}
      </div>
      {empty ? <p className="px-5 py-6 text-sm text-slate-600">{empty}</p> : <ul className="divide-y divide-slate-100">{children}</ul>}
    </Card>
  );
}

function latestRecordingSlot(slots, email) {
  return slots
    .filter((slot) => slot.kind === 'recording' && String(slot.assigneeEmail || '').toLowerCase() === email)
    .sort((a, b) => b.start.localeCompare(a.start))[0] || null;
}

/**
 * Delete a stale upload (click, then confirm). It withdraws the set: it leaves
 * every list and never trains, but the audio stays on S3 and "Restore set" on
 * its review page brings it back. A set already on the GPU cannot be deleted.
 */
function DeleteSet({ job, onAction }) {
  const [confirming, setConfirming] = useState(false);
  if (!onAction || !job || ['training', 'cancelled'].includes(job.status)) return null;
  return confirming ? (
    <span className="inline-flex items-center gap-1">
      <Button size="sm" variant="danger" onClick={() => onAction(() => cancelJob(job.id)).then(() => setConfirming(false))}>Delete?</Button>
      <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Keep</Button>
    </span>
  ) : (
    <Button size="sm" variant="ghost" onClick={() => setConfirming(true)} aria-label={`Delete ${who(job)}'s upload`} title="Delete this upload">
      <Trash2 size={14} aria-hidden="true" /> Delete
    </Button>
  );
}

/** Stop 2: who is booked to record (upload once they have), and what has gone on to training. */
export function RecordingStage({ overview, line, onAction }) {
  const now = Date.parse(overview.now) || Date.now();
  const toRecord = [...line.stops.record.people, ...line.stops.book.people]
    .map((rider) => ({ rider, slot: latestRecordingSlot(overview.slots, rider.email) }))
    .sort((a, b) => Number(needsUpload(b.rider)) - Number(needsUpload(a.rider)) || String(a.slot?.start).localeCompare(String(b.slot?.start)));
  const submitted = overview.jobs
    .filter((job) => job.queuedAt && !['uploading', 'cancelled'].includes(job.status) && now - Date.parse(job.queuedAt) < WEEK_MS)
    .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt));
  const riderOf = new Map(line.riders.map((rider) => [rider.email, rider]));
  // A half-finished upload in "To record" can be deleted too.
  const uploadingOf = (email) => overview.jobs.find((job) => job.status === 'uploading' && String(job.ownerEmail).toLowerCase() === email);
  return (
    <div className="space-y-5">
      {/* Owner 2026-11-23: audio can be uploaded for anyone at any time, not only after a session. */}
      <ListCard
        title="To record"
        subtitle="Upload audio for anyone at any time: the people below, or anybody else by email."
        empty={toRecord.length === 0 ? 'Nobody is booked to record. Upload for anyone above, or book a session in step 1.' : ''}
        action={(
          <Link to="/record" className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-primary px-3.5 text-[13px] font-bold text-white hover:bg-primary/90">
            <Upload size={15} aria-hidden="true" /> Upload for anyone
          </Link>
        )}
      >
        {toRecord.map(({ rider, slot }) => {
          const upload = `/record?for=${encodeURIComponent(rider.email)}&name=${encodeURIComponent(rider.name === rider.email ? '' : rider.name)}`;
          return (
            <li key={rider.email} className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 text-sm', needsUpload(rider) && 'bg-amber-50')}>
              <span className="w-40 shrink-0 font-semibold text-slate-900">{slot ? formatSgt(slot.start) : ''}</span>
              <span className="min-w-0 flex-[1_1_200px]">
                <span className="text-slate-900">{rider.name}</span>
                {needsUpload(rider) && <span className="text-xs font-semibold text-amber-800"> · recorded</span>}
                {rider.note === 'Recording now' && <span className="text-xs font-semibold text-rose-700"> · recording now</span>}
                {rider.note === 'Uploading' && <span className="text-xs text-slate-600"> · upload in progress</span>}
              </span>
              {!needsUpload(rider) && slot?.status === 'draft' && <Link to="/sessions" className="text-xs font-bold text-amber-800 hover:underline">Draft · publish in step 1</Link>}
              {!needsUpload(rider) && slot?.status !== 'draft' && slot?.hostName && <span className="text-xs text-slate-600">run by {slot.hostName}</span>}
              {/* Every row can upload, session or not; recorded ones are highlighted. */}
              <Link
                to={upload}
                className={cn(
                  'inline-flex min-h-10 items-center gap-2 rounded-lg px-3.5 text-[13px] font-bold',
                  needsUpload(rider) ? 'bg-primary text-white hover:bg-primary/90' : 'bg-white text-primary ring-1 ring-primary/40 hover:bg-primary/5',
                )}
              >
                <Upload size={15} aria-hidden="true" /> Upload audio
              </Link>
              <DeleteSet job={uploadingOf(rider.email)} onAction={onAction} />
            </li>
          );
        })}
      </ListCard>
      <ListCard title="Submitted, moving on to training" subtitle="Last 7 days" empty={submitted.length === 0 ? 'Nothing uploaded in the last 7 days.' : ''}>
        {submitted.map((job) => {
          const rider = riderOf.get(String(job.ownerEmail).toLowerCase());
          return (
            <li key={job.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-sm">
              <CheckCircle2 size={18} className="shrink-0 text-emerald-600" aria-hidden="true" />
              <span className="min-w-0 flex-[1_1_200px]">
                <b className="font-semibold text-slate-900">{who(job)}</b>{' '}
                <span className="text-xs text-slate-600">· uploaded {formatSgt(job.queuedAt)} · {job.files.length} file{job.files.length === 1 ? '' : 's'}</span>
              </span>
              {rider && <Link to={rider.href} className="text-[13px] font-semibold text-primary hover:underline">{STOP_LABEL[rider.stop]}</Link>}
              <DeleteSet job={job} onAction={onAction} />
            </li>
          );
        })}
      </ListCard>
    </div>
  );
}

function progressOf(estimate, now) {
  const start = Date.parse(estimate?.startAt || '');
  const finish = Date.parse(estimate?.finishAt || '');
  if (!start || !finish || finish <= start) return null;
  return Math.min(100, Math.max(0, Math.round(((now - start) / (finish - start)) * 100)));
}

/** Stop 3: runs by itself. Shows what is on the GPU, what waits, and what just finished. */
export function TrainingStage({ overview, onAction }) {
  const now = Date.parse(overview.now) || Date.now();
  const byId = new Map(overview.jobs.map((job) => [job.id, job]));
  const training = overview.jobs.find((job) => job.status === 'training');
  const queue = overview.queue.map((id) => byId.get(id)).filter(Boolean);
  const finished = overview.jobs.filter((job) => job.status === 'review' || job.status === 'failed');
  const testers = (overview.currentSlots || []).filter((slot) => slot.phase === 'slot').map((slot) => slot.assigneeName || slot.assigneeEmail);
  const percent = training ? progressOf(training.estimate, now) : null;
  const worker = overview.worker || {};
  return (
    <div className="space-y-5">
      <p className="flex flex-wrap items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3.5 text-sm leading-normal text-emerald-950">
        <CheckCircle2 size={18} className="shrink-0 text-emerald-700" aria-hidden="true" />
        <span><b>Nothing for you to do at this stop.</b> You are emailed when a voice reaches quality check.</span>
      </p>
      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-100 text-primary"><Cpu size={22} aria-hidden="true" /></span>
            <div className="min-w-0">
              <h2 className="text-lg font-bold text-slate-900">{training ? `On the GPU: ${who(training)}` : 'The training GPU is idle'}</h2>
              <p className="text-[13px] text-slate-600">
                {training ? `${training.label}${training.attempt > 1 ? ` · retrain ${training.attempt}` : ''} · ` : ''}
                about {overview.trainingMinutes} min per voice · trainer {worker.reachable ? worker.status : 'off (starts by itself when work is queued)'}
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => onAction(runTick)}><RefreshCw size={13} /> Check now</Button>
        </div>
        {training && percent !== null && (
          <div>
            <div className="mb-1.5 flex justify-between text-xs text-slate-600">
              <span>Started {formatSgt(training.estimate.startAt, { withDate: false })}</span>
              <span>Done about <b className="text-slate-900">{formatSgt(training.estimate.finishAt, { withDate: false })}</b></span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-blue-100"><div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} /></div>
          </div>
        )}
        {testers.length > 0 && (
          <p className="flex items-center gap-2.5 rounded-xl bg-amber-50 px-3.5 py-3 text-[13px] text-amber-900">
            <Clock size={16} className="shrink-0" aria-hidden="true" /> Training waits while {testers.join(', ')} test{testers.length === 1 ? 's' : ''}, so finish times may move.
          </p>
        )}
      </Card>
      <ListCard title="Waiting their turn" subtitle="One voice trains at a time, in the order the sets arrived." empty={queue.length === 0 ? 'The queue is empty.' : ''}>
        {queue.map((job, index) => (
          <li key={job.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3.5 text-sm">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 font-mono text-[13px] font-semibold text-slate-700">{job.estimate?.position || index + 1}</span>
            <span className="min-w-0 flex-[1_1_200px]">
              <b className="font-semibold text-slate-900">{who(job)}</b> <span className="text-slate-600">· {job.label}{job.attempt > 1 ? ` · retrain ${job.attempt}` : ''}</span>
              {job.estimate && <span className="block text-xs text-slate-600">Starts about {formatSgt(job.estimate.startAt, { withDate: false })} · done {relativeFromNow(job.estimate.finishAt, now)}</span>}
              {job.error && <span className="block text-xs text-amber-800">{job.error}</span>}
            </span>
          </li>
        ))}
      </ListCard>
      <ListCard title="Finished, sent on to quality check" empty={finished.length === 0 ? 'Nothing is waiting for quality check.' : ''}>
        {finished.map((job) => (
          <li key={job.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 text-sm">
            <span className="min-w-0 flex-[1_1_200px]"><b className="font-semibold text-slate-900">{who(job)}</b> <span className="text-slate-600">· {job.status === 'failed' ? 'training failed' : `attempt ${job.attempt}`}</span></span>
            <Link to={`/review/${encodeURIComponent(job.id)}`} className="inline-flex min-h-9 items-center rounded-lg bg-primary px-3 text-[13px] font-semibold text-white hover:bg-primary/90">Review in step 4</Link>
          </li>
        ))}
      </ListCard>
    </div>
  );
}

/** Stop 4's list: every voice waiting for a super user, oldest first. */
export function QualityList({ jobs, selectedId = '', now }) {
  const waiting = jobs.filter((job) => job.status === 'review' || job.status === 'failed')
    .sort((a, b) => String(a.finishedAt || a.updatedAt || a.createdAt).localeCompare(String(b.finishedAt || b.updatedAt || b.createdAt)));
  return (
    <Card className="overflow-hidden">
      <h2 className="border-b border-slate-200 px-4 py-3.5 text-sm font-bold text-slate-900">Waiting for you · {waiting.length}</h2>
      {waiting.length === 0 ? <p className="px-4 py-5 text-sm text-slate-600">Nothing to check. You are emailed when a voice finishes training.</p> : (
        <ul className="space-y-1 p-1.5">
          {waiting.map((job) => {
            const selected = job.id === selectedId;
            const last = job.attempts?.[job.attempts.length - 1];
            const since = last?.finishedAt ? Math.round((now - Date.parse(last.finishedAt)) / 60000) : null;
            return (
              <li key={job.id}>
                <Link to={`/review/${encodeURIComponent(job.id)}`} aria-current={selected ? 'true' : undefined} className={cn('block rounded-xl p-3', selected ? 'bg-blue-50 ring-2 ring-primary' : 'hover:bg-slate-50')}>
                  <span className="flex justify-between gap-2">
                    <b className="truncate text-sm text-slate-900">{who(job)}</b>
                    {since !== null && since >= 0 && (
                      <span className={cn('shrink-0 rounded-full px-2 text-[11px] font-bold', since >= 60 ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600')}>
                        {since >= 60 ? `${Math.floor(since / 60)} h` : `${since} min`}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-600">{job.status === 'failed' ? 'Training failed' : job.attempt > 1 ? `Retrain ${job.attempt}` : 'Attempt 1'} · {job.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/** One lecturer's trip on the line so far, for the review page. */
export function PersonTrip({ rider }) {
  if (!rider) return null;
  const at = STOPS.findIndex((stop) => stop.key === rider.stop);
  return (
    <div>
      <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-600">Trip so far</p>
      <ol className="grid grid-cols-6">
        {STOPS.map((stop, i) => {
          const passed = i < at;
          const here = i === at;
          return (
            <li key={stop.key} className="relative flex flex-col items-center gap-1.5 text-center" aria-current={here ? 'step' : undefined}>
              {i > 0 && <span aria-hidden="true" className={cn('absolute right-1/2 top-3 h-1 w-full', i <= at ? 'bg-primary' : 'bg-slate-200')} />}
              <span className={cn(
                'relative z-10 flex h-7 w-7 items-center justify-center rounded-full font-mono text-xs font-semibold',
                passed ? 'bg-blue-200 text-blue-900' : here ? 'bg-primary text-white ring-[5px] ring-primary/20' : 'border-2 border-slate-300 bg-white text-slate-600',
              )}>{passed ? '✓' : stop.n}</span>
              <span className={cn('px-0.5 text-[11px] leading-tight sm:text-xs', here ? 'font-bold text-slate-900' : passed ? 'font-semibold text-slate-800' : 'font-medium text-slate-600')}>{stop.label}</span>
              {here && <span className="text-[11px] text-slate-600">{riderNote(rider)}</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Stop 6: who is testing now and whose slot is next. Feedback is listed below it. */
export function TestingNow({ overview }) {
  const now = Date.parse(overview.now) || Date.now();
  const current = overview.currentSlots || [];
  const holding = new Set(current.map((slot) => slot.id));
  const upcoming = overview.slots
    .filter((slot) => slot.kind !== 'recording' && slot.assigneeEmail && slot.status !== 'draft' && Date.parse(slot.start) > now && !holding.has(slot.id))
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, 4);
  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
      <Card className="space-y-2 p-5">
        <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-emerald-800">
          <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-emerald-500 ring-4 ring-emerald-500/20" /> Testing now
        </p>
        {current.length === 0 ? <p className="text-sm text-slate-600">Nobody is testing right now.</p> : current.map((slot) => {
          const warm = slot.warm || null;
          const ready = warm?.state === 'READY';
          const late = warm && !ready && warm.estimatedReadyAt && now > Date.parse(warm.estimatedReadyAt);
          return (
            <div key={slot.id}>
              <h2 className="text-lg font-bold text-slate-900">{slot.assigneeName || slot.assigneeEmail}</h2>
              <p className="flex items-center gap-1.5 text-sm text-slate-600">
                {slot.phase === 'slot' ? `${formatSgt(slot.start, { withDate: false })} to ${formatSgt(slot.end, { withDate: false })} · own GPU` : `GPU warming up for ${formatSgt(slot.start, { withDate: false })}`}
                {slot.phase !== 'slot' && !ready && !late && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
                {ready && ' · voice loaded'}
              </p>
              {late && (
                <p className="mt-1 rounded-lg bg-rose-50 px-3 py-2 text-[13px] text-rose-800">
                  Warm-up is running late: expected ready at {formatSgt(warm.estimatedReadyAt, { withDate: false })}, still {String(warm.state || '').toLowerCase()}.{warm.message ? ` ${warm.message}` : ''} They see a &ldquo;come back shortly&rdquo; message meanwhile.
                </p>
              )}
            </div>
          );
        })}
      </Card>
      <Card className="space-y-2 p-5">
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-600">Next slots</p>
        {upcoming.length === 0 ? <p className="text-sm text-slate-600">No test slots coming up.</p> : (
          <ul className="space-y-1.5">
            {upcoming.map((slot) => (
              <li key={slot.id} className="flex flex-wrap justify-between gap-x-3 text-sm">
                <span className="font-semibold text-slate-900">{slot.assigneeName || slot.assigneeEmail}</span>
                <span className="text-slate-600">{formatSgt(slot.start)}</span>
              </li>
            ))}
          </ul>
        )}
        <Link to="/schedule" className="inline-block text-[13px] font-semibold text-primary hover:underline">Change in step 5</Link>
      </Card>
    </div>
  );
}
