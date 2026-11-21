// Voice Studio tester: one voice picker drives everything on the page.
//   Chat       — talk to the voice (the Live chat panel, unchanged).
//   Read aloud — paste text, hear it in the voice (Live Fast, sentence by
//                sentence), and scan it for words the dictionary does not know.
//   Right      — the one pronunciation dictionary for the picked voice.
// Picking a voice gets the GPU ready with it (on this site: one GPU, switched
// to the picked voice at once).
import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle2, Loader2, MessageCircle, Play, ScanSearch, Square, Volume2 } from 'lucide-react';
import LivePage from '@/pages/LivePage.jsx';
import { ensureVoiceProfile, prepareVoiceCapacity, scanOovWords, synthesizeSentence } from '@/services/api';
import { runSynthesisWithRetry } from '@/lib/synthesisRetry';
import { buildVoiceProfileId } from '@/lib/voiceIdentity';
import { cn } from '@/lib/utils';
import PronunciationPanel from './PronunciationPanel.jsx';
import { Button, Card } from './StudioChrome.jsx';

const MAX_TEXT = 3000;

function splitSentences(text) {
  return (text.match(/[^.!?。\n]+[.!?。]*/gu) || []).map((part) => part.trim()).filter(Boolean);
}

// Gets the GPU ready with this voice; polls until it can speak.
function useVoiceReady(voiceName) {
  const [state, setState] = useState({ status: 'idle', message: '' });
  useEffect(() => {
    if (!voiceName) return undefined;
    let cancelled = false;
    let timer = null;
    const voiceProfileId = buildVoiceProfileId(voiceName);
    async function check(first) {
      try {
        if (first) await ensureVoiceProfile(voiceName).catch(() => {});
        const { data } = await prepareVoiceCapacity(voiceProfileId);
        if (cancelled) return;
        if (data?.canStartConversation) {
          setState({ status: 'ready', message: '' });
          return;
        }
        setState({ status: 'starting', message: data?.message || '' });
      } catch (err) {
        if (cancelled) return;
        setState({ status: 'starting', message: err?.response?.data?.error || '' });
      }
      timer = window.setTimeout(() => check(false), 10_000);
    }
    setState({ status: 'starting', message: '' });
    check(true);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [voiceName]);
  return state;
}

function ReadAloud({ voiceName, ready, onPickWord }) {
  const [text, setText] = useState('');
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState('');
  const [scan, setScan] = useState(null);
  const [scanning, setScanning] = useState(false);
  const stopRef = useRef(false);
  const audioRef = useRef(null);

  useEffect(() => () => { stopRef.current = true; audioRef.current?.pause(); }, []);
  useEffect(() => { setScan(null); }, [text]);

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

  async function readAloud() {
    const sentences = splitSentences(text);
    if (sentences.length === 0) return;
    stopRef.current = false;
    setPlaying(true);
    setError('');
    setProgress({ done: 0, total: sentences.length });
    const voiceProfileId = buildVoiceProfileId(voiceName);
    const fetchClip = (sentence) => runSynthesisWithRetry(
      () => synthesizeSentence({ voiceProfileId, text: sentence, text_lang: 'en' }),
      { isCancelled: () => stopRef.current, onCapacityWait: () => setWaiting(true), maxCapacityWaitMs: 5_000 },
    );
    try {
      // Fetch the next sentence while the current one plays.
      let next = fetchClip(sentences[0]);
      for (let index = 0; index < sentences.length; index += 1) {
        const { blob } = await next;
        setWaiting(false);
        if (stopRef.current) break;
        next = index + 1 < sentences.length ? fetchClip(sentences[index + 1]) : null;
        next?.catch(() => {});
        await play(blob);
        setProgress({ done: index + 1, total: sentences.length });
        if (stopRef.current) break;
      }
    } catch (err) {
      if (!stopRef.current) setError(err?.message || 'Could not read the text aloud');
    } finally {
      setPlaying(false);
      setWaiting(false);
    }
  }

  function stop() {
    stopRef.current = true;
    audioRef.current?.pause();
    setPlaying(false);
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
      <div className="flex flex-wrap items-center gap-2">
        {playing
          ? <Button variant="danger" size="lg" onClick={stop}><Square size={15} /> Stop</Button>
          : <Button variant="dark" size="lg" disabled={!text.trim() || !ready} onClick={readAloud}><Play size={15} /> Read aloud</Button>}
        <Button variant="outline" size="lg" disabled={!text.trim() || scanning} onClick={scanText}>
          {scanning ? <Loader2 size={15} className="animate-spin" /> : <ScanSearch size={15} />} Scan text
        </Button>
        <span className="ml-auto text-xs text-slate-500">
          {playing ? (waiting ? 'Getting the voice ready…' : `Sentence ${Math.min(progress.done + 1, progress.total)} of ${progress.total}`) : `${text.length}/${MAX_TEXT}`}
        </span>
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

export default function VoiceTestBench({ voiceNames, canApply = true, voiceLabels = {}, header = null }) {
  const [params, setParams] = useSearchParams();
  const requested = params.get('voice') || '';
  const voice = voiceNames.includes(requested) ? requested : voiceNames[0] || '';
  const [tab, setTab] = useState('read');
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
        <span className={cn('inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold', ready ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800')}>
          {ready ? <CheckCircle2 size={13} /> : <Loader2 size={13} className="animate-spin" />}
          {ready ? 'Ready' : 'Getting the GPU ready with this voice — a cold start takes a few minutes'}
        </span>
        <div className="ml-auto flex gap-1 rounded-lg bg-slate-100 p-1" role="tablist" aria-label="How to test">
          {[['read', 'Read aloud', Volume2], ['chat', 'Chat', MessageCircle]].map(([value, label, Icon]) => (
            <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}
              className={cn('inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold', tab === value ? 'bg-white text-slate-900 shadow' : 'text-slate-500 hover:text-slate-800')}>
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>
      </Card>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="min-h-[560px] overflow-hidden">
          {tab === 'read'
            ? <ReadAloud key={voice} voiceName={voice} ready={ready} onPickWord={(word) => setPick({ word, at: Date.now() })} />
            : <LivePage key={voice} replyMode="phrases" mode="chat" variant="voice-test" voiceScope="studio" />}
        </Card>
        <div>{voice ? <PronunciationPanel voiceName={voice} canApply={canApply} prefill={pick} /> : null}</div>
      </div>
    </div>
  );
}
