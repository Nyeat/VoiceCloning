// Recording portal: a lecturer records against the guided script and/or
// uploads their own audio files, then submits the set. Submission queues
// training on the GPU; super users are emailed when it is ready for quality
// control, and the lecturer is emailed (with a test time) once it passes.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import {
  CheckCircle2, ChevronLeft, ChevronRight, Clock, FileAudio, Loader2, Mail, Mic, Pause, Play, ShieldCheck, Square, Trash2, Upload, X,
} from 'lucide-react';
import { useAuth } from '@/auth/useAuth';
import { PostLoginRedirectHandler, ProtectedRoute } from '@/auth/AppAuthGate';
import { TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { RECORDING_SCRIPT, RECORDING_SCRIPT_MINUTES, SCRIPT_TIPS } from './recordingScript.js';
import { createContinuousRecorder, microphoneSupported } from './wavRecorder.js';
import {
  createSubmission, errorText, formatSgt, getMe, relativeFromNow, uploadAndSubmit, withdrawSubmission,
} from './studioApi.js';
import {
  Button, Card, Header, Notice, SignInScreen, StatusPill, formatBytes, formatDuration,
} from './StudioChrome.jsx';
import { ConsentDialog, FaqList, FaqPage, readStudioConsent } from './ConsentAndFaq.jsx';
import { CONSENT_VERSION } from './faqContent.js';

const AUDIO_ACCEPT = '.wav,.mp3,.m4a,.flac,.ogg,audio/wav,audio/mpeg,audio/mp4,audio/flac,audio/ogg';
const AUDIO_EXT = /\.(wav|mp3|m4a|flac|ogg)$/iu;
const RECOMMENDED_MINUTES = [10, 30];

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

// ── Script reader + section recorder ─────────────────────────────────────

function LevelMeter({ level }) {
  const percent = Math.min(100, Math.round(level * 140));
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200" aria-hidden="true">
      <div
        className={cn('h-full transition-[width] duration-75', level > 0.95 ? 'bg-rose-500' : level > 0.05 ? 'bg-emerald-500' : 'bg-slate-400')}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

// One continuous recording for the whole script. Moving between sections
// (swipe, the arrow buttons, the section chips or the ← → keys) never stops it;
// Pause is for a break. Finish saves ONE file, which is what training gets —
// not a pile of fragments.
function ScriptReader({ onTake, disabled, onNeedConsent = null }) {
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState('idle'); // idle | recording | paused | saving
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState('');
  const [fontSize, setFontSize] = useState(20);
  const [visited, setVisited] = useState(() => new Set());
  const [parts, setParts] = useState(0);
  const recorderRef = useRef(null);
  const touchRef = useRef(null);
  const section = RECORDING_SCRIPT[index];
  const live = phase === 'recording' || phase === 'paused';
  const last = RECORDING_SCRIPT.length - 1;

  const go = useCallback((next) => {
    setIndex((current) => Math.max(0, Math.min(last, typeof next === 'function' ? next(current) : next)));
  }, [last]);

  // Sections read while the microphone was on.
  useEffect(() => {
    if (phase === 'recording') setVisited((current) => (current.has(section.id) ? current : new Set([...current, section.id])));
  }, [phase, section.id]);

  useEffect(() => {
    if (!live) return undefined;
    const id = window.setInterval(() => setElapsed(recorderRef.current?.seconds() || 0), 250);
    return () => window.clearInterval(id);
  }, [live]);

  // ← / → move between sections (not while typing in a field).
  useEffect(() => {
    function onKey(event) {
      if (event.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key === 'ArrowRight') go((current) => current + 1);
      if (event.key === 'ArrowLeft') go((current) => current - 1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);

  // Leaving mid-recording would lose it.
  useEffect(() => {
    if (!live) return undefined;
    const warn = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [live]);

  useEffect(() => () => recorderRef.current?.cancel(), []);

  async function start() {
    setError('');
    try {
      recorderRef.current = createContinuousRecorder({ onLevel: setLevel });
      await recorderRef.current.start();
      setElapsed(0);
      setVisited(new Set());
      setPhase('recording');
    } catch (err) {
      recorderRef.current = null;
      setError(err?.name === 'NotAllowedError'
        ? 'Microphone access was blocked. Allow the microphone in your browser\'s address bar, then try again.'
        : `Could not start the microphone: ${err.message}`);
    }
  }

  function togglePause() {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (phase === 'recording') { recorder.pause(); setPhase('paused'); } else { recorder.resume(); setPhase('recording'); }
  }

  async function finish() {
    const recorder = recorderRef.current;
    if (!recorder) return;
    setPhase('saving');
    setLevel(0);
    try {
      const take = await recorder.finish(`guided-reading-${Date.now().toString(36)}.wav`);
      const read = RECORDING_SCRIPT.filter((item) => visited.has(item.id)).map((item) => RECORDING_SCRIPT.indexOf(item) + 1);
      const span = read.length ? (read.length === 1 ? `section ${read[0]}` : `sections ${read[0]}–${read[read.length - 1]}`) : 'script';
      const part = parts + 1;
      setParts(part);
      onTake({ ...take, sectionId: `reading-${part}`, label: `Guided reading${part > 1 ? ` (part ${part})` : ''} · ${span}`, source: 'recorded' });
      if (take.levels.tooQuiet) setError('That recording was very quiet — check the microphone is close and not muted.');
      else if (take.levels.tooLoud) setError('Parts of that recording clipped (too loud) — move back a little next time.');
    } catch (err) {
      setError(`Could not save the recording: ${err.message}`);
    } finally {
      recorderRef.current = null;
      setPhase('idle');
    }
  }

  function onTouchStart(event) {
    const touch = event.touches[0];
    touchRef.current = { x: touch.clientX, y: touch.clientY };
  }
  function onTouchEnd(event) {
    const startTouch = touchRef.current;
    touchRef.current = null;
    if (!startTouch) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - startTouch.x;
    const dy = touch.clientY - startTouch.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go((current) => current + (dx < 0 ? 1 : -1));
  }

  return (
    <Card className="flex min-h-0 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Reading script · section {index + 1} of {RECORDING_SCRIPT.length} · about {RECORDING_SCRIPT_MINUTES} min in total
          </p>
          <h2 className="text-lg font-semibold text-slate-900">{section.title}</h2>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => setFontSize((size) => Math.max(16, size - 2))} aria-label="Smaller text">A−</Button>
          <Button variant="ghost" size="sm" onClick={() => setFontSize((size) => Math.min(30, size + 2))} aria-label="Larger text">A+</Button>
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-slate-100 px-5 py-2" role="tablist" aria-label="Script sections">
        {RECORDING_SCRIPT.map((item, itemIndex) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={itemIndex === index}
            onClick={() => go(itemIndex)}
            title={`${item.title} (${item.mood})`}
            className={cn(
              'flex h-7 min-w-7 shrink-0 items-center justify-center rounded-md px-2 text-xs font-semibold',
              itemIndex === index ? 'bg-slate-900 text-white' : visited.has(item.id) ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
            )}
          >
            {visited.has(item.id) && itemIndex !== index ? <CheckCircle2 size={13} aria-label="read" /> : itemIndex + 1}
          </button>
        ))}
      </div>

      <div className="mx-5 mt-4 flex flex-wrap items-center gap-2 rounded-xl bg-gradient-to-r from-violet-50 to-blue-50 px-4 py-3">
        <span className="rounded-full bg-violet-600 px-2.5 py-0.5 text-xs font-semibold text-white">{section.mood}</span>
        <p className="text-sm text-slate-700">{section.cue}</p>
        <span className="ml-auto text-xs text-slate-500">≈ {section.minutes} min</span>
      </div>

      <div className="relative flex min-h-[260px] flex-1 items-stretch">
        <button type="button" onClick={() => go(index - 1)} disabled={index === 0} aria-label="Previous section" className="hidden w-10 shrink-0 items-center justify-center text-slate-400 hover:bg-slate-50 hover:text-slate-700 disabled:opacity-20 sm:flex">
          <ChevronLeft size={26} />
        </button>
        <div
          className="min-w-0 flex-1 touch-pan-y overflow-y-auto px-5 py-5 sm:px-4"
          style={{ fontSize: `${fontSize}px` }}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
        >
          {section.paragraphs.map((paragraph) => (
            <p key={paragraph.slice(0, 32)} className="mb-5 leading-[1.75] text-slate-800">{paragraph}</p>
          ))}
          {index < last && <p className="text-center text-xs text-slate-400 sm:hidden">Swipe left for the next section →</p>}
        </div>
        <button type="button" onClick={() => go(index + 1)} disabled={index === last} aria-label="Next section" className="hidden w-10 shrink-0 items-center justify-center text-slate-400 hover:bg-slate-50 hover:text-slate-700 disabled:opacity-20 sm:flex">
          <ChevronRight size={26} />
        </button>
      </div>

      <div className={cn('border-t px-5 py-4', phase === 'recording' ? 'border-rose-200 bg-rose-50' : phase === 'paused' ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-slate-50')}>
        {error && <Notice tone="warn" className="mb-3">{error}</Notice>}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="md" disabled={index === 0} onClick={() => go(index - 1)} aria-label="Previous section">
            <ChevronLeft size={16} />
          </Button>
          {phase === 'idle' && onNeedConsent && (
            <Button variant="primary" size="lg" onClick={onNeedConsent} className="min-w-[190px]">
              <ShieldCheck size={16} aria-hidden="true" /> Accept the consent form to start
            </Button>
          )}
          {phase === 'idle' && !onNeedConsent && (
            <Button variant="dark" size="lg" onClick={start} disabled={disabled || !microphoneSupported()} className="min-w-[190px]">
              <Mic size={16} aria-hidden="true" /> {parts ? 'Record another part' : 'Start reading'}
            </Button>
          )}
          {live && (
            <>
              <Button variant={phase === 'paused' ? 'success' : 'outline'} size="lg" onClick={togglePause} className="min-w-[130px]">
                {phase === 'paused' ? <><Play size={16} /> Resume</> : <><Pause size={16} /> Pause</>}
              </Button>
              <Button variant="danger" size="lg" onClick={finish} className="min-w-[150px]">
                <Square size={16} aria-hidden="true" /> Finish · {formatDuration(elapsed)}
              </Button>
            </>
          )}
          {phase === 'saving' && <Button variant="dark" size="lg" disabled className="min-w-[190px]"><Loader2 size={16} className="animate-spin" /> Saving…</Button>}
          <Button variant="outline" size="md" disabled={index === last} onClick={() => go(index + 1)} aria-label="Next section">
            <ChevronRight size={16} />
          </Button>
          <div className="min-w-[160px] flex-1">
            {live ? (
              <div>
                <p className={cn('mb-1 flex items-center gap-1.5 text-xs font-semibold', phase === 'paused' ? 'text-amber-800' : 'text-rose-700')}>
                  <span className={cn('h-2 w-2 rounded-full', phase === 'paused' ? 'bg-amber-500' : 'animate-pulse bg-rose-600')} />
                  {phase === 'paused' ? 'Paused — take a break, then Resume' : 'Recording — keep going, turn the page any time'}
                </p>
                <LevelMeter level={level} />
              </div>
            ) : (
              <p className="text-xs text-slate-500">
                {microphoneSupported()
                  ? 'One recording for the whole script: swipe, use the arrows or ← → to turn sections, Pause for a break, Finish at the end.'
                  : 'This browser cannot record — use Chrome or Edge, or upload files instead.'}
              </p>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
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
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-700 hover:bg-slate-200"
        aria-label={playing ? 'Pause' : 'Play'}
      >
        {playing ? <Pause size={14} /> : <Play size={14} />}
      </button>
      <audio ref={audioRef} src={take.url} onEnded={() => setPlaying(false)} preload="none" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-slate-800">{take.label || take.file.name}</p>
        <p className="text-xs text-slate-500">
          {take.source === 'recorded' ? 'Recorded' : 'Uploaded'} · {formatDuration(take.duration)} · {formatBytes(take.file.size)}
          {take.levels?.tooQuiet && <span className="ml-1 text-amber-700">· very quiet</span>}
          {take.levels?.tooLoud && <span className="ml-1 text-amber-700">· clipped</span>}
        </p>
      </div>
      <button type="button" onClick={onRemove} className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" aria-label={`Remove ${take.label || take.file.name}`}>
        <Trash2 size={15} />
      </button>
    </li>
  );
}

function FilesPanel({ takes, setTakes, onSubmit, submitting, progress }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [label, setLabel] = useState('My teaching voice');
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
        <p className="mt-1 text-sm text-slate-600">Recorded sections and any files you add. Lecture recordings are great too.</p>
      </div>

      <div
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); }}
        className={cn('m-4 flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-6 text-center transition', dragging ? 'border-primary bg-primary/5' : 'border-slate-300 bg-slate-50')}
      >
        <Upload size={22} className="text-slate-400" aria-hidden="true" />
        <p className="mt-2 text-sm font-medium text-slate-700">Drop audio files here</p>
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
        {takes.length === 0 && <li className="px-5 py-6 text-center text-sm text-slate-500">Nothing yet — record a section or add a file.</li>}
      </ul>

      <div className="mt-auto space-y-3 border-t border-slate-200 bg-slate-50 px-5 py-4">
        <label className="block text-xs font-semibold uppercase tracking-[0.08em] text-slate-500" htmlFor="set-label">Name this voice</label>
        <input
          id="set-label"
          value={label}
          maxLength={80}
          onChange={(event) => setLabel(event.target.value)}
          className="h-10 w-full rounded-lg border border-slate-300 px-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
        {minutes > 0 && minutes < 5 && <p className="text-xs text-amber-700">Under 5 minutes usually gives a weak voice. You can still submit.</p>}
        {submitting ? (
          <div>
            <div className="mb-1 flex justify-between text-xs text-slate-600"><span>Uploading…</span><span>{Math.round(progress * 100)}%</span></div>
            <div className="h-2 overflow-hidden rounded-full bg-slate-200"><div className="h-full bg-primary transition-[width]" style={{ width: `${progress * 100}%` }} /></div>
          </div>
        ) : (
          <Button variant="primary" size="lg" className="w-full" disabled={takes.length === 0} onClick={() => onSubmit(label)}>
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
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
        <h2 className="text-base font-semibold text-slate-900">Your submissions</h2>
        <span className="text-xs text-slate-500">Training takes about {me.trainingMinutes} min per voice</span>
      </div>
      <ul className="divide-y divide-slate-100">
        {jobs.map((job) => (
          <li key={job.id} className="flex flex-wrap items-start gap-3 px-5 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium text-slate-900">{job.label}</p>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm">
      <div role="dialog" aria-modal="true" aria-labelledby="submitted-title" className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"><CheckCircle2 size={22} /></span>
          <button type="button" onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100" aria-label="Close"><X size={18} /></button>
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
    <div className="min-h-screen bg-slate-50">
      <Header product="Record your voice" />
      <main className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:px-6">{children}</main>
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
export function RecordWorkspace({ embedded = false, sessionEnd = '', onSubmitted } = {}) {
  const auth = useAuth();
  const [me, setMe] = useState(null);
  const [takes, setTakes] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(null);
  const [tipsOpen, setTipsOpen] = useState(true);
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

  async function submit(label) {
    setSubmitting(true);
    setError('');
    setProgress(0);
    try {
      if (consentMissing) { setConsentOpen(true); throw new Error('Please accept the consent form first.'); }
      const { jobId } = await createSubmission({ label, name: auth.user?.name || '', consent: needsConsent ? consent : null });
      const view = await uploadAndSubmit(jobId, takes, { onProgress: setProgress });
      setMe(view);
      setSubmitted(view.jobs.find((job) => job.id === jobId) || { id: jobId });
      onSubmitted?.(view);
      takes.forEach((take) => URL.revokeObjectURL(take.url));
      setTakes([]);
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

  const Shell = embedded ? EmbeddedShell : PageShell;
  return (
    <>
      <Shell>
        <section className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">Record your teaching voice</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-600">
              Read the whole script in one go (pause whenever you need a break), upload recordings you already have, or both. About 30 minutes of clear speech gives the best voice.
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            {sessionEnd && <span className="rounded-full bg-emerald-600 px-3 py-1 text-xs font-semibold text-white">Your recording session is open until {formatSgt(sessionEnd, { withDate: false })} SGT</span>}
            {queueText && <span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200">{queueText}</span>}
          </div>
        </section>

        {tipsOpen && (
          <Notice tone="info" className="relative pr-10">
            <ul className="grid gap-1 sm:grid-cols-2">
              {SCRIPT_TIPS.map((tip) => <li key={tip}>• {tip}</li>)}
            </ul>
            <button type="button" onClick={() => setTipsOpen(false)} className="absolute right-3 top-3 rounded p-1 text-blue-700 hover:bg-blue-100" aria-label="Hide tips"><X size={16} /></button>
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
        <div className={cn('grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]', !me && 'pointer-events-none opacity-50')} aria-disabled={!me}>
          <ScriptReader
            onTake={(take) => setTakes((current) => [...current, take])}
            disabled={submitting || consentMissing || !me}
            onNeedConsent={consentMissing ? () => setConsentOpen(true) : null}
          />
          <FilesPanel takes={takes} setTakes={setTakes} onSubmit={submit} submitting={submitting} progress={progress} />
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
