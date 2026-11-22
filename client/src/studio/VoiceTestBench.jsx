// Voice Studio tester: one voice picker drives everything on the page.
//   Chat       — talk to the voice (the Live chat panel, unchanged).
//   Read aloud — paste text, hear it in the voice (Live Fast, sentence by
//                sentence), and scan it for words the dictionary does not know.
//   Right      — the one pronunciation dictionary for the picked voice.
// Picking a voice gets the GPU ready with it (on this site: one GPU, switched
// to the picked voice at once).
import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  CheckCircle2, Download, Loader2, MessageCircle, Mic, Play, ScanSearch, Send, Square, Volume2,
} from 'lucide-react';
import { createLiveChatSocket } from '@/services/liveChatSocket.js';
import { acquireApiToken, shouldAttachApiToken } from '@/auth/msalClient.js';
import {
  ensureVoiceProfile, prepareVoiceCapacity, scanOovWords, startInstance, synthesizeSentence,
} from '@/services/api';
import { runSynthesisWithRetry } from '@/lib/synthesisRetry';
import { voiceCapacityWait } from '@/lib/voiceCapacity';
import GpuWaitDialog from '@/components/GpuWaitDialog.jsx';
import { buildVoiceProfileId } from '@/lib/voiceIdentity';
import { recordTestActivity } from './studioApi.js';
import { cn } from '@/lib/utils';
import PronunciationPanel from './PronunciationPanel.jsx';
import { Button, Card } from './StudioChrome.jsx';

const MAX_TEXT = 3000;

// Super users' testing keeps the chat service (fixed GPU) on until 30 min after
// their last use, and starts it when it is off. Reported at most once a minute.
let reportActivity = false;
let lastReportedAt = 0;
function noteTestActivity() {
  if (!reportActivity || Date.now() - lastReportedAt < 60_000) return;
  lastReportedAt = Date.now();
  recordTestActivity().catch(() => {});
}

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

// The same popup every other site shows while a GPU starts or switches. Its
// clock is the coordinator's real start (waitStartedAt), kept across polls,
// reopening and reloads, so it never restarts at 0s.
function useVoiceWait(voiceName, gpu) {
  const previous = useRef(null);
  const wait = gpu.status === 'starting' && gpu.capacity
    ? voiceCapacityWait(gpu.capacity, previous.current, voiceName)
    : null;
  useEffect(() => { previous.current = wait; });
  return wait;
}

// Lecturer: no GPU detail, just when to come back.
function readyEstimate(gpu, slotWarm) {
  const fromSlot = slotWarm?.estimatedReadyAt ? Date.parse(slotWarm.estimatedReadyAt) : 0;
  const capacity = gpu.capacity;
  const started = Number(capacity?.waitStartedAt) || 0;
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

// Joins the sentence clips into one WAV (all from the same voice, so one PCM
// format). Returns null if any clip is not a plain PCM WAV.
async function joinWavBlobs(blobs) {
  const parts = [];
  let format = null;
  for (const blob of blobs) {
    const view = new DataView(await blob.arrayBuffer());
    if (view.byteLength < 12 || view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645) return null;
    let offset = 12;
    let fmt = null;
    let data = null;
    while (offset + 8 <= view.byteLength) {
      const id = view.getUint32(offset, false);
      const size = view.getUint32(offset + 4, true);
      if (id === 0x666d7420) fmt = new Uint8Array(view.buffer, offset + 8, size); // "fmt "
      if (id === 0x64617461) { data = new Uint8Array(view.buffer, offset + 8, Math.min(size, view.byteLength - offset - 8)); break; } // "data"
      offset += 8 + size + (size % 2);
    }
    if (!fmt || !data) return null;
    if (format && format.join(',') !== Array.from(fmt).join(',')) return null;
    format = format || Array.from(fmt);
    parts.push(data);
  }
  if (!format) return null;
  const dataBytes = parts.reduce((sum, part) => sum + part.length, 0);
  const header = new DataView(new ArrayBuffer(12 + 8 + format.length + 8));
  const writeId = (at, text) => { for (let i = 0; i < 4; i += 1) header.setUint8(at + i, text.charCodeAt(i)); };
  writeId(0, 'RIFF');
  header.setUint32(4, 4 + 8 + format.length + 8 + dataBytes, true);
  writeId(8, 'WAVE');
  writeId(12, 'fmt ');
  header.setUint32(16, format.length, true);
  format.forEach((byte, i) => header.setUint8(20 + i, byte));
  writeId(20 + format.length, 'data');
  header.setUint32(24 + format.length, dataBytes, true);
  return new Blob([header.buffer, ...parts], { type: 'audio/wav' });
}

// Speaks text in the voice, sentence by sentence (Live Fast), fetching the next
// sentence while the current one plays. progress: { done, total, phase } where
// phase is 'generating' (waiting for the first audio of a sentence) or 'playing'.
function useSpeaker(voiceName) {
  const [speaking, setSpeaking] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, phase: '' });
  const [waiting, setWaiting] = useState(false);
  const [download, setDownload] = useState(null); // { url, name } of the last complete reading
  const stopRef = useRef(false);
  const audioRef = useRef(null);

  useEffect(() => () => { stopRef.current = true; audioRef.current?.pause(); }, []);
  useEffect(() => () => { if (download?.url) URL.revokeObjectURL(download.url); }, [download]);

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
    noteTestActivity();
    stopRef.current = false;
    setSpeaking(true);
    setDownload(null);
    setProgress({ done: 0, total: sentences.length, phase: 'generating' });
    const clips = [];
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
        clips.push(blob);
        next = index + 1 < sentences.length ? fetchClip(sentences[index + 1]) : null;
        next?.catch(() => {});
        setProgress({ done: index, total: sentences.length, phase: 'playing' });
        await play(blob);
        if (stopRef.current) break;
      }
      setProgress((current) => ({ ...current, done: current.total, phase: '' }));
      // The whole reading, once every sentence was made.
      if (!stopRef.current && clips.length === sentences.length) {
        const joined = await joinWavBlobs(clips);
        if (joined) setDownload({ url: URL.createObjectURL(joined), name: `${voiceName}-reading.wav` });
      }
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

  return { speak, stop, speaking, progress, waiting, download };
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
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 sm:p-4">
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value.slice(0, MAX_TEXT))}
        placeholder="Paste or type anything — a lecture paragraph works well."
        className="min-h-[180px] flex-1 resize-none rounded-xl border border-slate-200 p-4 text-[15px] leading-7 text-slate-800 placeholder:text-slate-400 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15"
      />
      <SpeakProgress speaker={speaker} />
      <div className="flex flex-wrap items-center gap-2">
        {speaker.speaking
          ? <Button variant="danger" size="lg" className="flex-1 sm:flex-none" onClick={speaker.stop}><Square size={15} /> Stop</Button>
          : <Button variant="dark" size="lg" className="flex-1 sm:flex-none" disabled={!text.trim() || !ready} onClick={readAloud}><Play size={15} /> Read aloud</Button>}
        <Button variant="outline" size="lg" className="flex-1 sm:flex-none" disabled={!text.trim() || scanning} onClick={scanText}>
          {scanning ? <Loader2 size={15} className="animate-spin" /> : <ScanSearch size={15} />} Scan text
        </Button>
        {speaker.download && !speaker.speaking && (
          <a href={speaker.download.url} download={speaker.download.name} className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 sm:w-auto sm:px-5 sm:text-base">
            <Download size={15} /> Download audio
          </a>
        )}
        <span className="order-first w-full text-right text-xs tabular-nums text-slate-500 sm:order-none sm:ml-auto sm:w-auto">{text.length}/{MAX_TEXT}</span>
      </div>
      {scan && (
        <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm">
          {scan.length === 0
            ? <p className="flex items-center gap-2 text-emerald-700"><CheckCircle2 size={15} /> Every word is in the dictionary.</p>
            : (
              <>
                <p className="text-slate-600">These words may be said wrongly. Tap one to fix it in the Pronunciation panel.</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {scan.map((word) => (
                    <button key={word} type="button" onClick={() => onPickWord(word)} className="max-w-full rounded-full bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-900 [overflow-wrap:anywhere] hover:bg-amber-200">{word}</button>
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

const SpeechRecognition = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

function VoiceChat({ voiceName, ready }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState('connecting'); // connecting | starting | ready | thinking | error
  // The chat service runs on the fixed GPU machine, which turns itself off when
  // idle: a failed connection starts it, then the chat reconnects until it is up.
  const [attempt, setAttempt] = useState(0);
  const startedServiceRef = useRef(false);
  const [error, setError] = useState('');
  const socketRef = useRef(null);
  const replyRef = useRef('');
  const listRef = useRef(null);
  const speaker = useSpeaker(voiceName);
  const speakRef = useRef(speaker.speak);
  speakRef.current = speaker.speak;
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef(null);
  const sendTextRef = useRef(null);

  useEffect(() => () => recognitionRef.current?.abort(), []);

  function toggleMic() {
    if (listening) { recognitionRef.current?.stop(); return; }
    if (!SpeechRecognition) { setError('This browser cannot listen. Please use Chrome or Edge, or type instead.'); return; }
    speaker.stop();
    noteTestActivity();
    const recognition = new SpeechRecognition();
    recognition.lang = 'en-SG';
    recognition.interimResults = true;
    recognition.continuous = false;
    let finalText = '';
    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        if (event.results[i].isFinal) finalText += event.results[i][0].transcript;
        else interim += event.results[i][0].transcript;
      }
      setDraft((finalText + interim).trim());
    };
    recognition.onerror = (event) => {
      if (event.error === 'not-allowed') setError('Microphone access was blocked. Allow it in the address bar, then try again.');
      else if (event.error !== 'no-speech' && event.error !== 'aborted') setError(`Could not hear you: ${event.error}`);
    };
    recognition.onend = () => {
      setListening(false);
      if (finalText.trim()) sendTextRef.current?.(finalText.trim());
    };
    recognitionRef.current = recognition;
    setError('');
    setListening(true);
    recognition.start();
  }

  useEffect(() => {
    let closed = false;
    let ready = false;
    let retryTimer = null;
    function retryLater() {
      if (closed || ready || retryTimer) return;
      if (!startedServiceRef.current) {
        startedServiceRef.current = true;
        startInstance().catch(() => {});
      }
      setStatus('starting');
      setError('');
      retryTimer = window.setTimeout(() => setAttempt((count) => count + 1), 15_000);
    }
    const socket = createLiveChatSocket({
      language: 'en',
      systemPrompt: CHAT_PROMPT,
      getAuthToken: shouldAttachApiToken() ? acquireApiToken : null,
      onMessage: (event) => {
        if (closed) return;
        if (event?.type === 'session.ready') { ready = true; setStatus('ready'); setError(''); }
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
      onError: (err) => {
        if (closed) return;
        // Not connected yet: the service is most likely off — start it and retry.
        if (!ready && attempt < 40) retryLater();
        else { setStatus('error'); setError(err.message); }
      },
      onClose: () => {
        if (closed) return;
        if (!ready && attempt < 40) retryLater();
        else setStatus('error');
      },
    });
    socketRef.current = socket;
    return () => { closed = true; window.clearTimeout(retryTimer); socket.close(); };
  }, [attempt]);

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }); }, [messages]);

  function send(event) {
    event.preventDefault();
    sendText(draft.trim());
  }

  function sendText(text) {
    if (!text || status !== 'ready') return;
    noteTestActivity();
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
  sendTextRef.current = sendText;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3 sm:p-4">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center py-16 text-center">
            <MessageCircle size={28} className="text-slate-300" />
            <p className="mt-3 text-sm font-semibold text-slate-800">Ask anything</p>
            <p className="mt-1 max-w-xs text-xs text-slate-500">The answer is spoken in this voice, so you hear it in different sentences and tones.</p>
          </div>
        )}
        {messages.map((message, index) => (
          <div key={index} className={cn('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}>
            <p className={cn('max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-6 [overflow-wrap:anywhere] sm:max-w-[80%]', message.role === 'user' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-800')}>{message.text}</p>
          </div>
        ))}
        {status === 'thinking' && <p className="flex items-center gap-1.5 text-xs text-slate-500"><Loader2 size={12} className="animate-spin" /> Thinking…</p>}
        {status === 'starting' && (
          <p className="flex items-center justify-center gap-1.5 text-xs text-amber-700"><Loader2 size={12} className="animate-spin" /> Starting the chat service — this usually takes 3–5 minutes. It connects by itself; Read aloud works meanwhile.</p>
        )}
      </div>
      <div className="space-y-2 border-t border-slate-100 p-3 sm:p-4">
        <SpeakProgress speaker={speaker} />
        <form onSubmit={send} className="flex gap-2">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={status === 'connecting' ? 'Connecting…' : status === 'starting' ? 'Starting the chat service…' : listening ? 'Listening… speak now' : 'Ask a question, or tap the mic'}
            disabled={status === 'connecting' || status === 'error' || !ready}
            enterKeyHint="send"
            className="h-11 min-w-0 flex-1 rounded-full border border-slate-300 px-4 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15 disabled:bg-slate-50"
          />
          <button
            type="button"
            onClick={toggleMic}
            disabled={status !== 'ready' || !ready}
            aria-label={listening ? 'Stop listening' : 'Speak your question'}
            className={cn('relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full border disabled:opacity-40', listening ? 'border-rose-500 bg-rose-500 text-white' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50')}
          >
            {listening && <span className="absolute inset-0 animate-ping rounded-full bg-rose-400/40" aria-hidden="true" />}
            <Mic size={16} />
          </button>
          {speaker.speaking
            ? <Button variant="danger" className="h-11 shrink-0 rounded-full px-3 sm:px-4" onClick={speaker.stop} aria-label="Stop"><Square size={14} /> <span className="hidden sm:inline">Stop</span></Button>
            : <Button type="submit" variant="dark" className="h-11 shrink-0 rounded-full px-3 sm:px-4" disabled={!draft.trim() || status !== 'ready' || !ready} aria-label="Send"><Send size={14} /> <span className="hidden sm:inline">Send</span></Button>}
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
  const wait = useVoiceWait(voice, gpu);
  const ready = gpu.status === 'ready';
  useEffect(() => {
    reportActivity = audience === 'superuser';
    noteTestActivity();
    return () => { reportActivity = false; };
  }, [audience]);

  function chooseVoice(name) {
    const next = new URLSearchParams(params);
    next.set('voice', name);
    setParams(next, { replace: true });
  }

  return (
    <div className="space-y-4">
      {header}
      <Card className="flex flex-wrap items-center gap-3 px-3 py-3 sm:px-4">
        <label className="flex w-full min-w-0 items-center gap-2 text-sm font-medium text-slate-700 sm:w-auto">
          Voice
          {voiceNames.length > 1 ? (
            <select value={voice} onChange={(event) => chooseVoice(event.target.value)} className="h-10 min-w-0 flex-1 truncate rounded-lg border border-slate-300 bg-white px-2 text-sm sm:h-9 sm:w-auto sm:min-w-[220px] sm:max-w-md sm:flex-none">
              {voiceNames.map((name) => <option key={name} value={name}>{voiceLabels[name] ? `${voiceLabels[name]} (${name})` : name}</option>)}
            </select>
          ) : (
            <span className="min-w-0 truncate font-semibold text-slate-900" title={voice}>{voiceLabels[voice] || voice}</span>
          )}
        </label>
        <span className={cn('inline-flex max-w-full items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold', ready ? 'bg-emerald-50 text-emerald-700' : gpu.status === 'error' ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-800')}>
          {ready ? <CheckCircle2 size={13} /> : gpu.status === 'error' ? null : <Loader2 size={13} className="animate-spin" />}
          {ready ? 'Ready' : gpu.status === 'error' ? 'This voice cannot be used' : audience === 'lecturer' ? 'Getting your voice ready' : (gpu.capacity?.state === 'STARTING' ? 'Starting a GPU with this voice' : 'Getting this voice ready')}
        </span>
        <div className="flex w-full gap-1 rounded-lg bg-slate-100 p-1 sm:ml-auto sm:w-auto" role="tablist" aria-label="How to test">
          {[['chat', 'Chat', MessageCircle], ['read', 'Read aloud', Volume2]].map(([value, label, Icon]) => (
            <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}
              className={cn('inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-semibold sm:flex-none sm:py-1.5', tab === value ? 'bg-white text-slate-900 shadow' : 'text-slate-500 hover:text-slate-800')}>
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>
      </Card>
      {audience === 'superuser' && <GpuWaitDialog wait={wait} />}
      {gpu.status === 'error' && <p className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{gpu.error}</p>}
      {gpu.status !== 'error' && gpu.error && audience === 'superuser' && <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">Still trying: {gpu.error}</p>}
      {audience === 'lecturer' && !ready ? <WarmingCard gpu={gpu} slotWarm={slotWarm} /> : (
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        {/* A bounded height so the chat scrolls inside and its input stays on screen. */}
        <Card className="flex h-[72dvh] min-h-[440px] max-h-[760px] min-w-0 flex-col overflow-hidden xl:h-[680px]">
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
