import React, { useEffect, useRef, useState } from 'react';
import { useLiveSpeech } from '../hooks/useLiveSpeech.js';
import { MC_INSTRUCTIONS_MAX, MC_SYSTEM_PROMPT, NOISE_LEVELS, PAUSE_RANGE, mcMicConstraints, mcSessionOptions, mcSessionStatus, mcTranscriptEntries, normalizeCaptureSettings, normalizeSavedInstructions, sameCaptureSettings } from '../lib/mcSession.js';
import { nextAudioErrorAction } from '../hooks/liveConversation.js';
import ntuLogo from '../assets/ntu-logo.png';
import { Maximize2, Mic, MicOff, Minimize2, Phone, PhoneOff } from 'lucide-react';

const REFERENCE_PARAMS = {};
const CAPTURE_STORAGE_KEY = 'mc-capture-settings-v2';
const INSTRUCTIONS_STORAGE_KEY = 'mc-instructions-v1';
const CONSOLE_TABS = [['transcript', 'Transcript'], ['capture', 'Voice capture'], ['instructions', 'Instructions']];

function loadCaptureSettings() {
  try {
    return normalizeCaptureSettings(JSON.parse(window.localStorage.getItem(CAPTURE_STORAGE_KEY) || 'null'));
  } catch {
    return normalizeCaptureSettings(null);
  }
}

function loadSavedInstructions() {
  try {
    return normalizeSavedInstructions(window.localStorage.getItem(INSTRUCTIONS_STORAGE_KEY));
  } catch {
    return MC_SYSTEM_PROMPT;
  }
}

export default function McSessionPage() {
  const [savedInstructions, setSavedInstructions] = useState(loadSavedInstructions);
  const [instructions, setInstructions] = useState(savedInstructions);
  const [saveError, setSaveError] = useState('');
  const instructionsUnsaved = instructions !== savedInstructions;
  function saveInstructions() {
    try {
      window.localStorage.setItem(INSTRUCTIONS_STORAGE_KEY, instructions);
      setSavedInstructions(instructions);
      setSaveError('');
    } catch {
      setSaveError('This browser blocked saving. The text still applies to sessions in this tab.');
    }
  }
  const [listeningMode, setListeningMode] = useState('turns');
  const [captureSettings, setCaptureSettings] = useState(loadCaptureSettings);
  function updateCaptureSettings(change) {
    const next = normalizeCaptureSettings({ ...captureSettings, ...change });
    setCaptureSettings(next);
    try { window.localStorage.setItem(CAPTURE_STORAGE_KEY, JSON.stringify(next)); } catch { /* per-browser convenience only */ }
  }
  // The running session keeps the mode and capture settings it started with;
  // changes made meanwhile wait for the next session.
  const [applied, setApplied] = useState(null);
  const sessionMode = applied ? applied.mode : listeningMode;
  const sessionCapture = applied ? applied.capture : captureSettings;
  const [consoleTab, setConsoleTab] = useState('transcript');
  const [playbackError, setPlaybackError] = useState('');
  const [fullscreen, setFullscreen] = useState(false);
  // Browsers that refuse element fullscreen (iOS Safari, embedded views) get the
  // same stage pinned over the window instead of an error.
  const [windowFill, setWindowFill] = useState(false);
  const immersive = fullscreen || windowFill;
  const stageRef = useRef(null);
  const stageTranscriptRef = useRef(null);
  const audioRef = useRef(null);
  const audioRetryRef = useRef({ src: '', retried: false });
  const transcriptRef = useRef(null);
  const live = useLiveSpeech({
    refParams: REFERENCE_PARAMS,
    voiceProfileId: 'deanvoice-v1',
    engine: 'fast', replyMode: 'phrases', language: 'en',
    systemPrompt: instructions, listeningMode: sessionMode, autoReconnect: true, noiseGate: false, fullDuplex: true,
    sessionOptions: mcSessionOptions(sessionCapture), micConstraints: mcMicConstraints(sessionCapture),
  });
  const active = live.isConversationActive;
  const pendingChanges = active && applied
    && (applied.mode !== listeningMode || !sameCaptureSettings(applied.capture, captureSettings));
  // Clears the started-with settings when a session ends on its own (errors,
  // dropped connection); the End button clears them itself so an immediate
  // restart never inherits them.
  useEffect(() => { if (!active) setApplied(null); }, [active]);
  const status = mcSessionStatus({ phase: live.phase, micEnabled: live.isMicInputEnabled, listeningMode: sessionMode, reconnecting: live.isReconnecting, userSpeaking: live.isUserSpeaking, replyAudible: Boolean(live.selectedReplyId && live.audioSrc) });

  useEffect(() => { document.title = 'Live MC | NTU Singapore'; }, []);
  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);
  useEffect(() => {
    if (!windowFill) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') setWindowFill(false); };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', onKey); };
  }, [windowFill]);
  useEffect(() => {
    const audio = audioRef.current;
    if (!live.shouldPlayAudio || !live.audioSrc) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      setPlaybackError('');
      return;
    }
    let cancelled = false;
    audio.src = live.audioSrc;
    audio.load();
    setPlaybackError('');
    audio.play().catch(() => {
      if (!cancelled) setPlaybackError('Your browser paused audio. Press Play reply to continue.');
    });
    return () => { cancelled = true; audio.pause(); };
  }, [live.audioSrc, live.selectedReplyId, live.shouldPlayAudio]);

  useEffect(() => {
    for (const transcript of [transcriptRef.current, stageTranscriptRef.current]) {
      if (transcript) transcript.scrollTop = transcript.scrollHeight;
    }
  }, [live.messages, live.interimTranscript, immersive, consoleTab]);

  // Arrow keys move between console tabs, per the WAI-ARIA tabs pattern.
  function onConsoleTabKeyDown(event) {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const index = CONSOLE_TABS.findIndex(([id]) => id === consoleTab);
    const [next] = CONSOLE_TABS[(index + step + CONSOLE_TABS.length) % CONSOLE_TABS.length];
    setConsoleTab(next);
    document.getElementById(`mc-tab-${next}`)?.focus();
  }

  async function toggleFullscreen() {
    if (document.fullscreenElement === stageRef.current) await document.exitFullscreen().catch(() => {});
    if (immersive) { setWindowFill(false); return; }
    // A refused or never-settling request (embedded views, iOS) pins the stage
    // over the window instead, so the button always does something.
    const request = stageRef.current.requestFullscreen?.() ?? Promise.reject();
    const outcome = await Promise.race([
      request.then(() => 'native', () => 'fill'),
      new Promise((resolve) => setTimeout(() => resolve('fill'), 1500)),
    ]);
    if (outcome === 'fill' && document.fullscreenElement !== stageRef.current) setWindowFill(true);
  }

  function transcriptContent() {
    if (live.messages.length === 0) {
      return <p className="text-sm leading-6 text-slate-500">Your conversation will appear here when the session begins.</p>;
    }
    // Placeholder text from the shared hook becomes a typing indicator; the
    // status line already says what is happening.
    return mcTranscriptEntries(live.messages).map((entry) => (
      <div key={entry.id} className={`flex ${entry.role === 'user' ? 'justify-end' : 'justify-start'}`}>
        <div className={`rounded-2xl ${entry.role === 'user' ? 'max-w-[85%] rounded-br-md bg-[#eef0f8] px-4 py-3 text-[#1d2240]' : 'max-w-[94%] rounded-bl-md bg-[#f4f3f0] px-5 py-4'}`}>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{entry.role === 'user' ? 'You' : 'AI MC'}</p>
          {/* The AI's replies are what the room follows along with, so they read larger than the host's lines. */}
          {entry.text && <p className={`whitespace-pre-wrap break-words ${entry.role === 'user' ? 'text-sm leading-6' : 'text-lg leading-8'}`}>{entry.text}{entry.interrupted && <span className="ml-1 text-slate-400">…</span>}</p>}
          {entry.interrupted && <p className="mt-1 text-[11px] font-medium uppercase tracking-wide text-amber-700">Interrupted</p>}
          {entry.pending && <p aria-label={entry.role === 'user' ? 'Hearing you' : 'Preparing a reply'} className="flex h-6 items-center gap-1">{[0, 1, 2].map((dot) => <span key={dot} className="h-1.5 w-1.5 rounded-full bg-slate-400" style={{ animation: `mc-dot 1.2s ease-in-out ${dot * 0.18}s infinite` }} />)}</p>}
        </div>
      </div>
    ));
  }

  function onAudioError() {
    if (!live.shouldPlayAudio) return;
    const { action, retryState } = nextAudioErrorAction(audioRetryRef.current, live.audioSrc);
    audioRetryRef.current = retryState;
    if (action === 'retry') {
      audioRef.current.load();
      audioRef.current.play().catch(() => setPlaybackError('Audio could not play. Press Play reply to retry.'));
    } else if (action === 'skip') {
      setPlaybackError('One audio segment could not play. The transcript is available below.');
      live.onAudioEnded();
    }
  }

  return (
    <div className="min-h-[100dvh] bg-[#faf9f7] text-[#252b3a]">
      <header className="border-b border-[#e5e3df] bg-white">
        <div className="mx-auto flex max-w-[110rem] items-center justify-between gap-4 px-6 py-4 sm:px-10">
          <img src={ntuLogo} alt="Nanyang Technological University Singapore" className="h-auto w-40 sm:w-44" />
          <div className="flex items-center gap-3">
            {active && <span className="inline-flex items-center gap-2 rounded-full bg-[#fdf1f2] px-3 py-1.5 text-xs font-semibold text-[#a6192e]"><span className="h-2 w-2 animate-pulse rounded-full bg-[#a6192e]" />Live</span>}
            <span className="text-xs font-medium tracking-[0.16em] text-slate-500">LIVE SESSION</span>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[110rem] px-6 pb-12 pt-8 sm:px-10 sm:pt-10">
        <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#a6192e]">A conversation on stage</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-[2.5rem] sm:leading-tight">Meet your AI co-host.</h1>
          </div>
          <p className="max-w-md text-[15px] leading-7 text-slate-600">You lead the moment. Your AI MC joins the conversation, speaking with the Dean voice.</p>
        </div>

        <div className="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(22rem,26rem)]">
        <section aria-label="Session controls" className="min-w-0 rounded-3xl border border-[#e5e3df] bg-white p-3 sm:p-4">
          <style>{'@keyframes mc-wave{0%,100%{transform:scaleY(.25)}50%{transform:scaleY(1)}}@keyframes mc-dot{0%,80%,100%{opacity:.25}40%{opacity:1}}'}</style>
          <div ref={stageRef} className={immersive ? `${windowFill ? 'fixed inset-0 z-50' : 'relative'} grid h-[100dvh] w-full grid-rows-[minmax(0,1fr)_minmax(12rem,0.6fr)] bg-white text-[#252b3a] md:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)] md:grid-rows-1` : 'relative'}>
            {/* On wide screens the stage takes the window height left after the header,
                heading and controls (~30rem) rather than a fixed 16:9, so it fills the screen. */}
            <div className={`relative isolate flex min-h-0 min-w-0 items-center justify-center overflow-hidden bg-[radial-gradient(ellipse_at_center,#2b3157_0%,#151a33_70%)] ${immersive ? '' : 'aspect-[4/3] rounded-2xl sm:aspect-video xl:aspect-auto xl:h-[clamp(26rem,calc(100dvh_-_30rem),60rem)]'}`}>
              {/* Avatar slot: the future avatar video/image goes here with object-contain, centred and never stretched. */}
              <div role="img" aria-label="AI avatar placeholder" className="flex flex-col items-center text-center">
                <div className={`flex items-center justify-center rounded-full border border-white/15 bg-white/5 font-semibold tracking-wide text-white/80 transition-shadow ${immersive ? 'h-40 w-40 text-4xl' : 'h-24 w-24 text-2xl sm:h-32 sm:w-32 sm:text-3xl lg:h-40 lg:w-40 lg:text-4xl'} ${live.phase === 'speaking' ? 'ring-4 ring-[#a6192e]/70' : ''}`}>AI</div>
                <p className={`mt-5 font-medium text-white/85 ${immersive ? 'text-xl' : 'text-base sm:text-lg lg:text-xl'}`}>AI MC</p>
                <p className="mt-1 text-xs text-white/50">Avatar coming soon</p>
              </div>
              <p className="absolute left-4 top-4 inline-flex items-center gap-2 rounded-full bg-black/45 px-3 py-1.5 text-xs font-medium text-white backdrop-blur sm:left-5 sm:top-5">
                <span className={`h-2 w-2 rounded-full ${active ? 'animate-pulse bg-emerald-400' : 'bg-white/40'}`} />{active ? 'Live' : 'Offline'}
              </p>
              <button type="button" aria-label={immersive ? 'Exit fullscreen' : 'Open fullscreen stage'} title={immersive ? 'Exit fullscreen (Esc)' : 'Fullscreen'} onClick={toggleFullscreen} className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur transition-colors hover:bg-black/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white sm:right-5 sm:top-5">
                {immersive ? <Minimize2 size={17} strokeWidth={1.75} /> : <Maximize2 size={17} strokeWidth={1.75} />}
              </button>
              <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3 whitespace-nowrap rounded-2xl bg-black/55 p-2 text-white shadow-lg backdrop-blur sm:bottom-6 sm:gap-4 sm:px-3">
                {active && <button type="button" aria-label={live.isMicInputEnabled ? 'Mute microphone' : 'Unmute microphone'} title={live.isMicInputEnabled ? 'Mute' : 'Unmute'} disabled={live.phase === 'connecting'} onClick={live.toggle} className={`flex h-11 w-11 items-center justify-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-white disabled:opacity-50 ${live.isMicInputEnabled ? 'bg-white/10 hover:bg-white/20' : 'bg-white text-[#151a33]'}`}>
                  {live.isMicInputEnabled ? <Mic size={19} /> : <MicOff size={19} />}
                </button>}
                <div className="hidden h-8 items-center gap-[3px] sm:flex" aria-hidden="true">
                  {Array.from({ length: 22 }, (_, index) => {
                    const shape = 0.35 + 0.65 * Math.sin(index * 1.3) ** 2;
                    const speaking = live.phase === 'speaking';
                    // Flat whenever the mic is not actually being sent (muted, or turn-based while the AI has the floor).
                    const sending = active && live.isMicInputEnabled && (live.phase === 'listening' || (sessionMode !== 'turns' && live.phase === 'thinking'));
                    const level = sending ? Math.min(1, 0.12 + live.audioLevel * 1.6 * shape) : 0.12;
                    return <span key={index} className="h-full w-[3px] rounded-full bg-white/85" style={speaking ? { animation: `mc-wave ${0.7 + (index % 5) * 0.12}s ease-in-out ${index * 0.04}s infinite` } : { transform: `scaleY(${level})`, transition: 'transform 120ms ease-out' }} />;
                  })}
                </div>
                <button type="button" aria-label={active ? 'End session' : 'Start session'} onClick={() => { if (active) { setApplied(null); live.stop(); return; } setApplied({ mode: listeningMode, capture: captureSettings }); live.start(); }} disabled={!active && (!instructions.trim() || !live.speechApiAvailable)} className={`flex h-11 items-center justify-center gap-2 rounded-full text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-white disabled:cursor-not-allowed disabled:opacity-50 ${active ? 'w-11 bg-red-500 hover:bg-red-600' : 'bg-[#a6192e] px-5 hover:bg-[#861426]'}`}>
                  {active ? <PhoneOff size={19} /> : <><Phone size={17} />Start session</>}
                </button>
              </div>
            </div>
            {immersive && <aside className="flex min-h-0 flex-col border-t border-[#e5e3df] bg-white md:border-l md:border-t-0" aria-label="Live conversation">
              <div className="flex shrink-0 items-center gap-3 border-b border-[#efeee9] px-6 py-5">
                <div className="relative flex h-11 w-11 items-center justify-center rounded-full bg-[#151a33] text-sm font-semibold text-white">AI<span className={`absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-white ${active ? 'bg-emerald-400' : 'bg-slate-300'}`} /></div>
                <div className="min-w-0 flex-1"><p className="font-semibold leading-5">AI MC</p><p role="status" className="truncate text-xs text-slate-500">{status}</p></div>
                <img src={ntuLogo} alt="NTU Singapore" className="h-auto w-24" />
              </div>
              <div ref={stageTranscriptRef} role="log" aria-label="Live conversation transcript" className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">{transcriptContent()}</div>
              {(live.error || playbackError) && <p role="alert" className="mx-6 mb-3 text-sm text-red-800">{live.error || playbackError}</p>}
              <p className="shrink-0 border-t border-[#efeee9] px-6 py-3 text-xs text-slate-400">AI-generated · Cloned Dean voice</p>
            </aside>}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-2 pt-4">
            <div className="flex items-center gap-3" role="status" aria-live="polite">
              <span className={`h-2.5 w-2.5 rounded-full ${active ? 'bg-[#a6192e]' : 'bg-slate-300'}`} />
              <span className="text-sm font-medium">{status}</span>
            </div>
            <fieldset className="flex w-full gap-1 rounded-full border border-[#e5e3df] bg-[#f6f5f2] p-1 sm:w-auto">
              <legend className="sr-only">Listening mode</legend>
              {[['turns', 'Turn-based'], ['continuous', 'Continuous listening']].map(([value, label]) => (
                <label key={value} className={`flex min-h-9 flex-1 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-full px-3 text-xs transition-colors sm:flex-none sm:px-4 sm:text-[13px] focus-within:outline focus-within:outline-2 focus-within:outline-[#a6192e] ${listeningMode === value ? 'bg-white font-semibold shadow-sm' : 'text-slate-600 hover:text-[#252b3a]'}`}><input type="radio" name="listening-mode" value={value} checked={listeningMode === value} onChange={() => setListeningMode(value)} className="m-0 accent-[#a6192e]" />{label}</label>
              ))}
            </fieldset>
          </div>
          <div className="px-2 pb-1">
            <p className="mt-3 text-xs leading-5 text-slate-500">{listeningMode === 'turns'
              ? 'Speak, then pause: the AI MC replies when you finish and always completes its reply. Your mic closes while it replies and reopens after. Mute any time; muting mid-sentence sends what you said.'
              : 'Hands-free: the mic stays open, and talking over the AI MC interrupts it. Keep its speaker away from your mic, or use headphones.'}</p>
          </div>
          {pendingChanges && <p role="status" className="mx-3 mt-4 rounded-xl bg-amber-50 px-4 py-3 text-center text-sm text-amber-900">Changes apply to the next session. End the session to switch to them.</p>}
          {!live.speechApiAvailable && <p role="alert" className="mx-3 mt-5 text-sm text-red-800">This browser does not support microphone audio. Use a current Chrome, Edge, or Safari browser.</p>}
          {live.error && <p role="alert" className="mx-3 mt-5 text-sm leading-6 text-red-800">{live.error}</p>}
          {playbackError && <div role="alert" className="mx-3 mt-5 text-sm text-red-800"><p>{playbackError}</p>{live.shouldPlayAudio && <button className="mt-2 underline" onClick={() => audioRef.current.play().then(() => setPlaybackError('')).catch(() => setPlaybackError('Audio is still unavailable. Check your audio output and retry.'))}>Play reply</button>}</div>}
        </section>

        {/* On wide screens the console is pinned to the stage column's height
            (absolute inner box) so a long transcript or prompt scrolls inside it
            instead of stretching the row. */}
        <aside aria-label="Session console" className="relative flex min-h-[16rem] min-w-0 flex-col xl:min-h-[24rem] overflow-hidden rounded-3xl border border-[#e5e3df] bg-white">
          <div className="flex min-h-0 flex-1 flex-col xl:absolute xl:inset-0">
          <div role="tablist" aria-label="Session console" className="flex shrink-0 gap-1 overflow-x-auto border-b border-[#efeee9] px-3 pt-2">
            {CONSOLE_TABS.map(([id, label]) => (
              <button key={id} id={`mc-tab-${id}`} type="button" role="tab" aria-selected={consoleTab === id} aria-controls={`mc-panel-${id}`} tabIndex={consoleTab === id ? 0 : -1} onClick={() => setConsoleTab(id)} onKeyDown={onConsoleTabKeyDown} className={`-mb-px min-h-11 whitespace-nowrap border-b-2 px-3.5 text-[13px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#a6192e] ${consoleTab === id ? 'border-[#a6192e] font-semibold text-[#252b3a]' : 'border-transparent text-slate-500 hover:text-[#252b3a]'}`}>
                {label}{id === 'transcript' && live.messages.length > 0 && ` · ${live.messages.length}`}
              </button>
            ))}
          </div>
          {consoleTab === 'transcript' && <div id="mc-panel-transcript" role="tabpanel" aria-labelledby="mc-tab-transcript" className="flex min-h-0 flex-1 flex-col">
            <div ref={transcriptRef} className="max-h-[28rem] min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5 xl:max-h-none" role="log" aria-label="Conversation transcript">
              {transcriptContent()}
            </div>
          </div>}
          {consoleTab === 'capture' && <div id="mc-panel-capture" role="tabpanel" aria-labelledby="mc-tab-capture" className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <div className="grid gap-8 sm:grid-cols-2 xl:grid-cols-1">
            <div>
              <label htmlFor="mc-noise" className="flex items-baseline justify-between text-sm text-slate-600">Background noise filter<span className="font-medium text-[#252b3a]">{NOISE_LEVELS[captureSettings.noiseLevel].label}</span></label>
              <input id="mc-noise" type="range" min={0} max={NOISE_LEVELS.length - 1} step={1} value={captureSettings.noiseLevel} onChange={(event) => updateCaptureSettings({ noiseLevel: Number(event.target.value) })} aria-valuetext={NOISE_LEVELS[captureSettings.noiseLevel].label} className="mt-3 w-full accent-[#a6192e]" />
              <div className="mt-1 flex justify-between text-[11px] text-slate-400" aria-hidden="true">{NOISE_LEVELS.map((level) => <span key={level.label}>{level.label}</span>)}</div>
              <p className="mt-2 text-xs leading-5 text-slate-500">{NOISE_LEVELS[captureSettings.noiseLevel].hint}</p>
            </div>
            <div>
              <label htmlFor="mc-pause" className="flex items-baseline justify-between text-sm text-slate-600">Pause before the AI replies<span className="font-medium text-[#252b3a]">{(captureSettings.pauseMs / 1000).toFixed(1)} s</span></label>
              <input id="mc-pause" type="range" min={PAUSE_RANGE.min} max={PAUSE_RANGE.max} step={PAUSE_RANGE.step} value={captureSettings.pauseMs} onChange={(event) => updateCaptureSettings({ pauseMs: Number(event.target.value) })} aria-valuetext={`${(captureSettings.pauseMs / 1000).toFixed(1)} seconds`} className="mt-3 w-full accent-[#a6192e]" />
              <div className="mt-1 flex justify-between text-[11px] text-slate-400" aria-hidden="true"><span>Faster</span><span>Recommended 0.7 s</span><span>Patient</span></div>
              <p className="mt-2 text-xs leading-5 text-slate-500">Silence that ends your turn. The AI starts replying about {((captureSettings.pauseMs + 600) / 1000).toFixed(1)} s after you stop; a hesitation longer than {(captureSettings.pauseMs / 1000).toFixed(1)} s ends your turn early.</p>
            </div>
          </div>
          <p className="mt-6 text-xs leading-5 text-slate-500">Saved in this browser. Applied when a session starts{active ? '; this session keeps the settings it started with.' : '.'}</p>
          </div>}
          {consoleTab === 'instructions' && <div id="mc-panel-instructions" role="tabpanel" aria-labelledby="mc-tab-instructions" className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-5">
            <label htmlFor="mc-instructions" className="block text-sm text-slate-600">Guide your AI co-host</label>
            <textarea id="mc-instructions" rows={10} maxLength={MC_INSTRUCTIONS_MAX} value={instructions} disabled={active} onChange={(event) => setInstructions(event.target.value)} className="mt-2 min-h-[10rem] w-full flex-1 resize-y rounded-xl border border-slate-300 bg-white p-4 text-sm leading-6 focus:outline-[#a6192e] disabled:bg-slate-50 xl:resize-none" />
            <div className="mt-3 flex shrink-0 flex-wrap items-center gap-2">
              <button type="button" onClick={saveInstructions} disabled={active || !instructionsUnsaved || !instructions.trim()} className="rounded-full bg-[#a6192e] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#861426] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#a6192e] disabled:cursor-not-allowed disabled:opacity-50">Save</button>
              <button type="button" onClick={() => setInstructions(MC_SYSTEM_PROMPT)} disabled={active || instructions === MC_SYSTEM_PROMPT} className="rounded-full border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#a6192e] disabled:cursor-not-allowed disabled:opacity-50">Restore default</button>
              <span role="status" className="text-xs text-slate-500">{instructionsUnsaved ? 'Unsaved changes' : 'Saved in this browser'}</span>
            </div>
            {saveError && <p role="alert" className="mt-2 shrink-0 text-xs text-red-600">{saveError}</p>}
            <p className="mt-2 shrink-0 text-xs text-slate-500">{active ? 'End the session to edit. Changes apply to the next session.' : 'The next session uses this text. Save keeps it for future visits in this browser.'}</p>
          </div>}
          </div>
        </aside>
        </div>
        <p className="mt-8 text-xs leading-5 text-slate-500">AI-generated conversation · Cloned Dean voice · Microphone audio is sent during the session. End session disconnects the microphone and conversation.</p>
      </main>
      <audio ref={audioRef} onEnded={live.onAudioEnded} onError={onAudioError} />
    </div>
  );
}
