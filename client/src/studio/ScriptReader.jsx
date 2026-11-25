// The guided reader used by both recording parts: Part 1 (the standard script)
// and Part 2 (the specialty-term scenarios).
//
// One continuous recording per read-through. Moving between sections (swipe,
// the arrow buttons, the section chips or the ← → keys) never stops it; Pause
// is for a break. Finish saves ONE file, which is what training gets — not a
// pile of fragments.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight, CheckCircle2, ChevronLeft, ChevronRight, Loader2, Mic, Pause, Play, ShieldCheck, Square,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  createContinuousRecorder, listMicrophones, microphoneErrorText, microphoneSupported,
} from './wavRecorder.js';
import { Button, Card, Notice, formatDuration } from './StudioChrome.jsx';
import { highlightParts, knownTextOf } from './specialtyTerms.js';

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

function Paragraph({ text, terms }) {
  if (!terms?.length) return <p className="mb-5 leading-[1.75] text-slate-800">{text}</p>;
  return (
    <p className="mb-5 leading-[1.75] text-slate-800">
      {highlightParts(text, terms).map((part, index) => (part.isTerm
        // eslint-disable-next-line react/no-array-index-key -- parts of one fixed paragraph
        ? <mark key={index} className="rounded bg-violet-50 px-1 font-semibold text-violet-900">{part.text}</mark>
        // eslint-disable-next-line react/no-array-index-key -- parts of one fixed paragraph
        : <React.Fragment key={index}>{part.text}</React.Fragment>))}
    </p>
  );
}

/**
 * script: [{ id, title, mood, cue, minutes, paragraphs, terms? }]
 * partLabel: shown above the section title ("Part 1 of 2 · Normal reading").
 * take: { name, label } for the saved file and its row in "Your audio".
 * withKnownText: attach the text of the sections read (Part 2), so training
 *   labels those clips with it.
 * active: only the visible reader answers the ← → keys.
 * onLiveChange(live): true while recording or paused (the parent locks the part switch).
 * next: { label, onClick } offered once a take is saved ("Continue to Part 2").
 */
export function ScriptReader({
  script, totalMinutes, partLabel, take, withKnownText = false, active = true,
  onTake, onLiveChange = null, disabled, onNeedConsent = null, next = null, headerAction = null,
}) {
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
  const [mics, setMics] = useState([]);
  const [micId, setMicId] = useState('');
  const refreshMics = useCallback(() => { listMicrophones().then(setMics).catch(() => setMics([])); }, []);
  useEffect(() => {
    refreshMics();
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshMics);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refreshMics);
  }, [refreshMics]);
  const last = script.length - 1;
  const section = script[Math.min(index, last)];
  const live = phase === 'recording' || phase === 'paused';

  useEffect(() => { onLiveChange?.(live); }, [live, onLiveChange]);

  const go = useCallback((target) => {
    setIndex((current) => Math.max(0, Math.min(last, typeof target === 'function' ? target(current) : target)));
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
    if (!active) return undefined;
    function onKey(event) {
      if (event.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key === 'ArrowRight') go((current) => current + 1);
      if (event.key === 'ArrowLeft') go((current) => current - 1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, active]);

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
      recorderRef.current = createContinuousRecorder({
        onLevel: setLevel,
        deviceId: micId,
        onDeviceLost: () => {
          setPhase('paused');
          setError('The microphone was disconnected. Your recording so far is kept — reconnect it and press Finish, then Start again for the rest.');
        },
      });
      await recorderRef.current.start();
      refreshMics(); // labels appear once permission is given
      setElapsed(0);
      setVisited(new Set());
      setPhase('recording');
    } catch (err) {
      recorderRef.current = null;
      setError(microphoneErrorText(err));
      refreshMics();
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
      const saved = await recorder.finish(`${take.name}-${Date.now().toString(36)}.wav`);
      const read = script.filter((item) => visited.has(item.id)).map((item) => script.indexOf(item) + 1);
      const span = read.length ? (read.length === 1 ? `section ${read[0]}` : `sections ${read[0]}–${read[read.length - 1]}`) : 'script';
      const part = parts + 1;
      setParts(part);
      const knownText = withKnownText ? knownTextOf(script, visited) : '';
      onTake({
        ...saved,
        sectionId: `${take.name}-${part}`,
        label: `${take.label}${part > 1 ? ` (part ${part})` : ''} · ${span}`,
        source: 'recorded',
        part: take.part,
        ...(knownText ? { knownText } : {}),
      });
      if (saved.levels.tooQuiet) setError('That recording was very quiet — check the microphone is close and not muted.');
      else if (saved.levels.tooLoud) setError('Parts of that recording clipped (too loud) — move back a little next time.');
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

  const idleHint = microphoneSupported()
    ? 'One recording for the whole script: swipe, use the arrows or ← → to turn sections, Pause for a break, Finish at the end.'
    : 'This browser cannot record — use Chrome or Edge, or upload files instead.';

  return (
    <Card className="flex min-h-0 flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            <span className="hidden sm:inline">{partLabel} · </span>Section {index + 1} of {script.length}<span className="hidden sm:inline"> · about {totalMinutes} min in total</span>
          </p>
          <h2 className="text-base font-semibold text-slate-900 sm:text-lg">{section.title}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!live && headerAction}
          <Button variant="ghost" size="sm" onClick={() => setFontSize((size) => Math.max(16, size - 2))} aria-label="Smaller text">A−</Button>
          <Button variant="ghost" size="sm" onClick={() => setFontSize((size) => Math.min(30, size + 2))} aria-label="Larger text">A+</Button>
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto overscroll-x-contain border-b border-slate-100 px-4 py-2 [scrollbar-width:none] sm:px-5 [&::-webkit-scrollbar]:hidden" role="tablist" aria-label="Script sections">
        {script.map((item, itemIndex) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={itemIndex === index}
            onClick={() => go(itemIndex)}
            title={`${item.title} (${item.mood})`}
            className={cn(
              'flex h-8 min-w-8 shrink-0 items-center justify-center rounded-md px-2 text-xs font-semibold sm:h-7 sm:min-w-7',
              itemIndex === index ? 'bg-slate-900 text-white' : visited.has(item.id) ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
            )}
          >
            {visited.has(item.id) && itemIndex !== index ? <CheckCircle2 size={13} aria-label="read" /> : itemIndex + 1}
          </button>
        ))}
      </div>

      <div className="mx-4 mt-4 flex flex-wrap items-center gap-2 rounded-xl bg-gradient-to-r from-violet-50 to-blue-50 px-3 py-2.5 sm:mx-5 sm:px-4 sm:py-3">
        <span className="shrink-0 rounded-full bg-violet-600 px-2.5 py-0.5 text-xs font-semibold text-white">{section.mood}</span>
        <p className="min-w-0 text-sm text-slate-700">{section.cue}</p>
        <span className="ml-auto text-xs text-slate-500">≈ {section.minutes} min</span>
      </div>

      <div className="relative flex min-h-[260px] flex-1 items-stretch">
        <button type="button" onClick={() => go(index - 1)} disabled={index === 0} aria-label="Previous section" className="hidden w-10 shrink-0 items-center justify-center text-slate-400 hover:bg-slate-50 hover:text-slate-700 disabled:opacity-20 sm:flex">
          <ChevronLeft size={26} />
        </button>
        <div
          className="min-w-0 flex-1 touch-pan-y overflow-y-auto px-4 py-4 sm:py-5"
          style={{ fontSize: `${fontSize}px` }}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
        >
          {section.paragraphs.map((paragraph) => <Paragraph key={paragraph.slice(0, 32)} text={paragraph} terms={section.terms} />)}
          {index < last && <p className="text-center text-xs text-slate-400 sm:hidden">Swipe left for the next section →</p>}
        </div>
        <button type="button" onClick={() => go(index + 1)} disabled={index === last} aria-label="Next section" className="hidden w-10 shrink-0 items-center justify-center text-slate-400 hover:bg-slate-50 hover:text-slate-700 disabled:opacity-20 sm:flex">
          <ChevronRight size={26} />
        </button>
      </div>

      <div className={cn('border-t px-4 py-3 sm:px-5 sm:py-4', phase === 'recording' ? 'border-rose-200 bg-rose-50' : phase === 'paused' ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-slate-50')}>
        {error && <Notice tone="warn" className="mb-3">{error}</Notice>}
        {phase === 'idle' && parts > 0 && next && (
          <Notice tone="success" className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <span>Saved — it is in “Your audio”.</span>
            <Button variant="dark" size="sm" onClick={next.onClick}>{next.label} <ArrowRight size={14} aria-hidden="true" /></Button>
          </Notice>
        )}
        {phase === 'idle' && mics.length > 1 && (
          <label className="mb-3 flex flex-wrap items-center gap-2 text-xs font-medium text-slate-600">
            <Mic size={13} aria-hidden="true" /> Microphone
            <select value={micId} onChange={(event) => setMicId(event.target.value)} className="h-9 w-full min-w-0 max-w-full truncate rounded-lg border border-slate-300 bg-white px-2 text-xs sm:h-8 sm:w-auto sm:min-w-[220px]">
              <option value="">Default microphone</option>
              {mics.filter((mic) => mic.deviceId !== 'default').map((mic, i) => <option key={mic.deviceId} value={mic.deviceId}>{mic.label || `Microphone ${i + 1}`}</option>)}
            </select>
          </label>
        )}
        {/* Phones: ‹ status › on one row, the big buttons full width underneath
            (within thumb reach). Wider screens: ‹ buttons › status in one row. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
          <Button variant="outline" size="md" disabled={index === 0} onClick={() => go(index - 1)} aria-label="Previous section" className="order-1 shrink-0 px-3">
            <ChevronLeft size={16} />
          </Button>
          <div className="order-4 flex w-full gap-2 sm:order-2 sm:w-auto sm:gap-3">
            {phase === 'idle' && onNeedConsent && (
              <Button variant="primary" size="lg" onClick={onNeedConsent} className="flex-1 sm:min-w-[190px] sm:flex-none">
                <ShieldCheck size={16} className="shrink-0" aria-hidden="true" /> Accept the consent form to start
              </Button>
            )}
            {phase === 'idle' && !onNeedConsent && (
              <Button variant="dark" size="lg" onClick={start} disabled={disabled || !microphoneSupported()} className="flex-1 sm:min-w-[190px] sm:flex-none">
                <Mic size={16} aria-hidden="true" /> {parts ? 'Record another part' : 'Start reading'}
              </Button>
            )}
            {live && (
              <>
                <Button variant={phase === 'paused' ? 'success' : 'outline'} size="lg" onClick={togglePause} className="flex-1 sm:min-w-[130px] sm:flex-none">
                  {phase === 'paused' ? <><Play size={16} /> Resume</> : <><Pause size={16} /> Pause</>}
                </Button>
                <Button variant="danger" size="lg" onClick={finish} className="flex-1 tabular-nums sm:min-w-[150px] sm:flex-none">
                  <Square size={16} aria-hidden="true" /> Finish · {formatDuration(elapsed)}
                </Button>
              </>
            )}
            {phase === 'saving' && <Button variant="dark" size="lg" disabled className="flex-1 sm:min-w-[190px] sm:flex-none"><Loader2 size={16} className="animate-spin" /> Saving…</Button>}
          </div>
          <Button variant="outline" size="md" disabled={index === last} onClick={() => go(index + 1)} aria-label="Next section" className="order-3 shrink-0 px-3 sm:order-3">
            <ChevronRight size={16} />
          </Button>
          <div className="order-2 min-w-0 flex-1 sm:order-4 sm:min-w-[160px]">
            {live ? (
              <div>
                <p className={cn('mb-1 flex items-center gap-1.5 text-xs font-semibold', phase === 'paused' ? 'text-amber-800' : 'text-rose-700')}>
                  <span className={cn('h-2 w-2 rounded-full', phase === 'paused' ? 'bg-amber-500' : 'animate-pulse bg-rose-600')} />
                  {phase === 'paused' ? 'Paused — take a break, then Resume' : 'Recording — keep going, turn the page any time'}
                </p>
                <LevelMeter level={level} />
              </div>
            ) : (
              <p className="text-xs text-slate-500">{idleHint}</p>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
