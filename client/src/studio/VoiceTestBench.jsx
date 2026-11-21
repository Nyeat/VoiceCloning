// Voice Studio tester: one voice picker drives everything on the page.
//   Chat       — talk to the voice (the Live chat panel, unchanged).
//   Read aloud — paste text, hear it in the voice (Live Fast, sentence by
//                sentence), and scan it for words the dictionary does not know.
//   Right      — the one pronunciation dictionary for the picked voice.
// Picking a voice gets the GPU ready with it (on this site: one GPU, switched
// to the picked voice at once).
import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle2, Loader2, MessageCircle, Play, ScanSearch, Send, Square, Volume2 } from 'lucide-react';
import { createLiveChatSocket } from '@/services/liveChatSocket.js';
import { acquireApiToken, shouldAttachApiToken } from '@/auth/msalClient.js';
import { ensureVoiceProfile, prepareVoiceCapacity, scanOovWords, synthesizeSentence } from '@/services/api';
import { runSynthesisWithRetry } from '@/lib/synthesisRetry';
import { voiceCapacityNotice } from '@/lib/voiceCapacity';
import GpuWaitDialog from '@/components/GpuWaitDialog.jsx';
import { buildVoiceProfileId } from '@/lib/voiceIdentity';
import { cn } from '@/lib/utils';
import PronunciationPanel from './PronunciationPanel.jsx';
import { Button, Card } from './StudioChrome.jsx';

const MAX_TEXT = 3000;

function splitSentences(text) {
  return (text.match(/[^.!?。\n]+[.!?。]*/gu) || []).map((part) => part.trim()).filter(Boolean);
}

// Gets the GPU ready with this voice; polls until it can speak.
// status: 'checking' | 'starting' | 'ready' | 'error'. capacity: the
// coordinator's answer (state, startedAt, message). error: why it cannot.
function useVoiceReady(voiceName) {
  const [state, setState] = useState({ status: 'checking', capacity: null, error: '' });
  useEffect(() => {
    if (!voiceName) return undefined;
    let cancelled = false;
    let timer = null;
    const voiceProfileId = buildVoiceProfileId(voiceName);
    let ensured = false;
    async function check() {
      try {
        if (!ensured) {
          // A trained voice needs its saved record before it can be prepared.
          try {
            await ensureVoiceProfile(voiceName);
          } catch (err) {
            if (err?.response?.status !== 409 || !/exist/iu.test(err?.response?.data?.error || '')) throw err;
          }
          ensured = true; // retried on every poll until the voice record exists
        }
        const { data } = await prepareVoiceCapacity(voiceProfileId);
        if (cancelled) return;
        if (data?.canStartConversation) {
          setState({ status: 'ready', capacity: data, error: '' });
          return;
        }
        setState({ status: 'starting', capacity: data, error: '' });
      } catch (err) {
        if (cancelled) return;
        const status = err?.response?.status;
        const message = err?.response?.data?.error || err?.message || 'Could not get this voice ready';
        // 4xx: this voice cannot be prepared (no reference audio, not allowed now…) — say so, stop polling.
        if (status && status < 500) {
          setState({ status: 'error', capacity: null, error: message });
          return;
        }
        setState((current) => ({ ...current, status: current.status === 'ready' ? 'ready' : 'starting', error: message }));
      }
      timer = window.setTimeout(check, 10_000);
    }
    setState({ status: 'checking', capacity: null, error: '' });
    check();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [voiceName]);
  return state;
}

const BOOT_MINUTES = 15;
const SWITCH_MINUTES = 2;

// The same popup the training site shows while a GPU starts or switches.
function waitFor(voiceName, gpu) {
  const capacity = gpu.capacity;
  if (gpu.status !== 'starting' || !capacity) return null;
  const booting = capacity.state === 'STARTING';
  return {
    key: `studio-${voiceName}-${capacity.state}-${capacity.startedAt || ''}`,
    title: booting ? 'Starting a GPU with this voice' : 'Switching the GPU to this voice',
    message: voiceCapacityNotice(capacity) || capacity.message || 'Getting this voice ready…',
    estimateSeconds: (booting ? BOOT_MINUTES : SWITCH_MINUTES) * 60,
    maxSeconds: (booting ? 20 : 3) * 60,
    startedAt: Number(capacity.startedAt) || Date.now(),
  };
}

// Lecturer: no GPU detail, just when to come back.
function readyEstimate(gpu, slotWarm) {
  const fromSlot = slotWarm?.estimatedReadyAt ? Date.parse(slotWarm.estimatedReadyAt) : 0;
  const capacity = gpu.capacity;
  const started = Number(capacity?.startedAt) || 0;
  const fromCapacity = started ? started + (capacity?.state === 'STARTING' ? BOOT_MINUTES : SWITCH_MINUTES) * 60_000 : 0;
  return Math.max(fromSlot, fromCapacity) || 0;
}

function WarmingCard({ gpu, slotWarm }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, []);
  const eta = readyEstimate(gpu, slotWarm);
  const late = eta && now > eta;
  const time = eta ? new Intl.DateTimeFormat('en-SG', { timeZone: 'Asia/Singapore', hour: 'numeric', minute: '2-digit' }).format(new Date(eta)) : '';
  return (
    <Card className="p-8 text-center sm:p-12">
      <span className="relative mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Loader2 size={26} className="animate-spin" />
      </span>
      <h2 className="mt-5 text-xl font-semibold text-slate-900">Your voice is getting ready</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-600">
        {late
          ? 'It is taking a little longer than usual. Please check back in a few minutes — this page opens your voice by itself when it is ready.'
          : time
            ? <>It should be ready at about <b>{time}</b>{eta - now > 60_000 ? ` (in about ${Math.ceil((eta - now) / 60_000)} min)` : ''}. You can leave this page open — it opens your voice by itself — or come back then.</>
            : 'This usually takes a few minutes. You can leave this page open — it opens your voice by itself when it is ready.'}
      </p>
      {gpu.error && gpu.status === 'error' && <p className="mx-auto mt-4 max-w-md rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{gpu.error}</p>}
    </Card>
  );
}

// Speaks text in the voice, sentence by sentence (Live Fast), fetching the next
// sentence while the current one plays. progress: { done, total, phase } where
// phase is 'generating' (waiting for the first audio of a sentence) or 'playing'.
function useSpeaker(voiceName) {
  const [speaking, setSpeaking] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, phase: '' });
  const [waiting, setWaiting] = useState(false);
  const stopRef = useRef(false);
  const audioRef = useRef(null);

  useEffect(() => () => { stopRef.current = true; audioRef.current?.pause(); }, []);

  function play(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      const done = () => { URL.revokeObjectURL(url); resolve(); };
      audio.onended = done;
      audio.onerror = done;
      audio.play().catch(done);
    });
  }

  async function speak(text) {
    const sentences = splitSentences(text);
    if (sentences.length === 0) return;
    stopRef.current = false;
    setSpeaking(true);
    setProgress({ done: 0, total: sentences.length, phase: 'generating' });
    const voiceProfileId = buildVoiceProfileId(voiceName);
    const fetchClip = (sentence) => runSynthesisWithRetry(
      () => synthesizeSentence({ voiceProfileId, text: sentence, text_lang: 'en' }),
      { isCancelled: () => stopRef.current, onCapacityWait: () => setWaiting(true), maxCapacityWaitMs: 5_000 },
    );
    try {
      let next = fetchClip(sentences[0]);
      for (let index = 0; index < sentences.length; index += 1) {
        setProgress({ done: index, total: sentences.length, phase: 'generating' });
        const { blob } = await next;
        setWaiting(false);
        if (stopRef.current) break;
        next = index + 1 < sentences.length ? fetchClip(sentences[index + 1]) : null;
        next?.catch(() => {});
        setProgress({ done: index, total: sentences.length, phase: 'playing' });
        await play(blob);
        if (stopRef.current) break;
      }
      setProgress((current) => ({ ...current, done: current.total, phase: '' }));
    } finally {
      setSpeaking(false);
      setWaiting(false);
    }
  }

  function stop() {
    stopRef.current = true;
    audioRef.current?.pause();
    setSpeaking(false);
  }

  return { speak, stop, speaking, progress, waiting };
}

function SpeakProgress({ speaker }) {
  const { progress, waiting, speaking } = speaker;
  if (!speaking || !progress.total) return null;
  // Each sentence counts half when its audio is being made, full once played.
  const fraction = Math.min(1, (progress.done + (progress.phase === 'playing' ? 0.5 : 0.15)) / progress.total);
  const label = waiting
    ? 'Getting the voice ready…'
    : progress.phase === 'generating'
      ? `Making sentence ${progress.done + 1} of ${progress.total}…`
      : `Speaking sentence ${progress.done + 1} of ${progress.total}`;
  return (
    <div className="space-y-1.5">
      <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
        <div className={cn('h-full rounded-full bg-primary transition-all duration-500', progress.phase === 'generating' && 'animate-pulse')} style={{ width: `${Math.max(4, fraction * 100)}%` }} />
      </div>
      <p className="flex items-center gap-1.5 text-xs text-slate-500">
        {progress.phase === 'generating' ? <Loader2 size={12} className="animate-spin" /> : <Volume2 size={12} />} {label}
      </p>
    </div>
  );
}

function ReadAloud({ voiceName, ready, onPickWord }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [scan, setScan] = useState(null);
  const [scanning, setScanning] = useState(false);
  const speaker = useSpeaker(voiceName);

  useEffect(() => { setScan(null); }, [text]);

  async function readAloud() {
    setError('');
    try {
      await speaker.speak(text);
    } catch (err) {
      setError(err?.message || 'Could not read the text aloud');
    }
  }

  async function scanText() {
    setScanning(true);
    try {
      const { data } = await scanOovWords(text);
      setScan(Array.isArray(data?.flagged) ? data.flagged : []);
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Scan failed');
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value.slice(0, MAX_TEXT))}
        placeholder="Paste or type anything — a lecture paragraph works well."
        className="min-h-[260px] flex-1 resize-none rounded-xl border border-slate-200 p-4 text-[15px] leading-7 text-slate-800 placeholder:text-slate-400 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15"
      />
      <SpeakProgress speaker={speaker} />
      <div className="flex flex-wrap items-center gap-2">
        {speaker.speaking
          ? <Button variant="danger" size="lg" onClick={speaker.stop}><Square size={15} /> Stop</Button>
          : <Button variant="dark" size="lg" disabled={!text.trim() || !ready} onClick={readAloud}><Play size={15} /> Read aloud</Button>}
        <Button variant="outline" size="lg" disabled={!text.trim() || scanning} onClick={scanText}>
          {scanning ? <Loader2 size={15} className="animate-spin" /> : <ScanSearch size={15} />} Scan text
        </Button>
        <span className="ml-auto text-xs text-slate-500">{text.length}/{MAX_TEXT}</span>
      </div>
      {scan && (
        <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm">
          {scan.length === 0
            ? <p className="flex items-center gap-2 text-emerald-700"><CheckCircle2 size={15} /> Every word is in the dictionary.</p>
            : (
              <>
                <p className="text-slate-600">These words may be said wrongly. Tap one to fix it on the right.</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {scan.map((word) => (
                    <button key={word} type="button" onClick={() => onPickWord(word)} className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-900 hover:bg-amber-200">{word}</button>
                  ))}
                </div>
              </>
            )}
        </div>
      )}
      {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
    </div>
  );
}

// Chat with the voice: type a question, the assistant answers in a few
// sentences, and the answer is spoken in the picked voice (Live Fast).
const CHAT_PROMPT = 'You are a friendly assistant helping a lecturer hear how their cloned voice sounds. '
  + 'Reply naturally in two or three short, clear sentences. Vary sentence length and include the occasional '
  + 'question so the voice can be heard in different intonations. Always respond only in English.';

function VoiceChat({ voiceName, ready }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState('connecting'); // connecting | ready | thinking | error
  const [error, setError] = useState('');
  const socketRef = useRef(null);
  const replyRef = useRef('');
  const listRef = useRef(null);
  const speaker = useSpeaker(voiceName);
  const speakRef = useRef(speaker.speak);
  speakRef.current = speaker.speak;

  useEffect(() => {
    let closed = false;
    const socket = createLiveChatSocket({
      language: 'en',
      systemPrompt: CHAT_PROMPT,
      getAuthToken: shouldAttachApiToken() ? acquireApiToken : null,
      onMessage: (event) => {
        if (closed) return;
        if (event?.type === 'session.ready') setStatus('ready');
        if (event?.type === 'assistant.text.delta') {
          replyRef.current += event.text || '';
          setMessages((list) => {
            const last = list[list.length - 1];
            if (last?.role === 'assistant' && last.streaming) return [...list.slice(0, -1), { ...last, text: replyRef.current }];
            return [...list, { role: 'assistant', text: replyRef.current, streaming: true }];
          });
        }
        if (event?.type === 'assistant.text.done') {
          const text = String(event.text || replyRef.current).trim();
          replyRef.current = '';
          setMessages((list) => {
            const last = list[list.length - 1];
            const rest = last?.role === 'assistant' && last.streaming ? list.slice(0, -1) : list;
            return [...rest, { role: 'assistant', text }];
          });
          setStatus('ready');
          if (text) speakRef.current(text).catch((err) => setError(err?.message || 'Could not speak the reply'));
        }
        if (event?.type === 'error' || event?.type === 'session.auth.failed') {
          setStatus('error');
          setError(event.message || 'The chat could not start.');
        }
      },
      onError: (err) => { if (!closed) { setStatus('error'); setError(err.message); } },
      onClose: () => { if (!closed) setStatus((current) => (current === 'error' ? current : 'error')); },
    });
    socketRef.current = socket;
    return () => { closed = true; socket.close(); };
  }, []);

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }); }, [messages]);

  function send(event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || status !== 'ready') return;
    speaker.stop();
    replyRef.current = '';
    if (!socketRef.current?.send({ type: 'user.text', text })) {
      setError('The chat connection dropped. Reload the page to reconnect.');
      return;
    }
    setMessages((list) => [...list, { role: 'user', text }]);
    setDraft('');
    setStatus('thinking');
  }

  return (
    <div className="flex h-full min-h-[520px] flex-col">
      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center py-16 text-center">
            <MessageCircle size={28} className="text-slate-300" />
            <p className="mt-3 text-sm font-semibold text-slate-800">Ask anything</p>
            <p className="mt-1 max-w-xs text-xs text-slate-500">The answer is spoken in this voice, so you hear it in different sentences and tones.</p>
          </div>
        )}
        {messages.map((message, index) => (
          <div key={index} className={cn('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}>
            <p className={cn('max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-6', message.role === 'user' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-800')}>{message.text}</p>
          </div>
        ))}
        {status === 'thinking' && <p className="flex items-center gap-1.5 text-xs text-slate-500"><Loader2 size={12} className="animate-spin" /> Thinking…</p>}
      </div>
      <div className="space-y-2 border-t border-slate-100 p-4">
        <SpeakProgress speaker={speaker} />
        <form onSubmit={send} className="flex gap-2">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={status === 'connecting' ? 'Connecting…' : 'Ask a question…'}
            disabled={status === 'connecting' || status === 'error' || !ready}
            className="h-11 flex-1 rounded-full border border-slate-300 px-4 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15 disabled:bg-slate-50"
          />
          {speaker.speaking
            ? <Button variant="danger" onClick={speaker.stop}><Square size={14} /> Stop</Button>
            : <Button type="submit" variant="dark" disabled={!draft.trim() || status !== 'ready' || !ready}><Send size={14} /> Send</Button>}
        </form>
        {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
      </div>
    </div>
  );
}

// audience: 'superuser' (GPU popup, details) or 'lecturer' (tester hidden until
// the voice is ready; slotWarm = the slot's warm-up state for the estimate).
export default function VoiceTestBench({
  voiceNames, canApply = true, voiceLabels = {}, header = null, audience = 'superuser', slotWarm = null,
}) {
  const [params, setParams] = useSearchParams();
  const requested = params.get('voice') || '';
  const voice = voiceNames.includes(requested) ? requested : voiceNames[0] || '';
  const [tab, setTab] = useState('chat');
  const [pick, setPick] = useState(null);
  const gpu = useVoiceReady(voice);
  const ready = gpu.status === 'ready';

  function chooseVoice(name) {
    const next = new URLSearchParams(params);
    next.set('voice', name);
    setParams(next, { replace: true });
  }

  return (
    <div className="space-y-4">
      {header}
      <Card className="flex flex-wrap items-center gap-3 px-4 py-3">
        <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
          Voice
          <select value={voice} onChange={(event) => chooseVoice(event.target.value)} className="h-9 min-w-[220px] rounded-lg border border-slate-300 px-2 text-sm">
            {voiceNames.map((name) => <option key={name} value={name}>{voiceLabels[name] ? `${voiceLabels[name]} (${name})` : name}</option>)}
          </select>
        </label>
        <span className={cn('inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold', ready ? 'bg-emerald-50 text-emerald-700' : gpu.status === 'error' ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-800')}>
          {ready ? <CheckCircle2 size={13} /> : gpu.status === 'error' ? null : <Loader2 size={13} className="animate-spin" />}
          {ready ? 'Ready' : gpu.status === 'error' ? 'This voice cannot be used' : audience === 'lecturer' ? 'Getting your voice ready' : (gpu.capacity?.state === 'STARTING' ? 'Starting a GPU with this voice' : 'Getting this voice ready')}
        </span>
        <div className="ml-auto flex gap-1 rounded-lg bg-slate-100 p-1" role="tablist" aria-label="How to test">
          {[['chat', 'Chat', MessageCircle], ['read', 'Read aloud', Volume2]].map(([value, label, Icon]) => (
            <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}
              className={cn('inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold', tab === value ? 'bg-white text-slate-900 shadow' : 'text-slate-500 hover:text-slate-800')}>
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>
      </Card>
      {audience === 'superuser' && <GpuWaitDialog wait={waitFor(voice, gpu)} />}
      {gpu.status === 'error' && <p className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{gpu.error}</p>}
      {gpu.status !== 'error' && gpu.error && audience === 'superuser' && <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">Still trying: {gpu.error}</p>}
      {audience === 'lecturer' && !ready ? <WarmingCard gpu={gpu} slotWarm={slotWarm} /> : (
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="min-h-[560px] overflow-hidden">
          {tab === 'read'
            ? <ReadAloud key={voice} voiceName={voice} ready={ready} onPickWord={(word) => setPick({ word, at: Date.now() })} />
            : <VoiceChat key={voice} voiceName={voice} ready={ready} />}
        </Card>
        <div>{voice ? <PronunciationPanel voiceName={voice} canApply={canApply} prefill={pick} /> : null}</div>
      </div>
      )}
    </div>
  );
}
