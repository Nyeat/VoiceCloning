// Per-voice pronunciation library: add, edit and remove how this voice says a
// word. Two ways to describe a sound, simplest first:
//   "Sounds like" — type it the way it is said ("koh hee sin"). Works at once.
//   "Exact sounds" — ARPAbet phonemes, with a dictionary lookup to start from.
//                    Applied to the voice with "Apply to voice" (reloads the engine).
import React, { useCallback, useEffect, useState } from 'react';
import { BookOpen, Loader2, Pencil, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { arpabetToReadable, fetchDatamuseArpabet } from '@/lib/arpabet';
import { cn } from '@/lib/utils';
import {
  applyPronunciations, deletePronunciation, errorText, getPronunciations, savePronunciation,
} from './studioApi.js';
import { Button, Notice } from './StudioChrome.jsx';

const PHONEME_HELP = [
  ['AA', 'odd'], ['AE', 'at'], ['AH', 'hut'], ['AO', 'ought'], ['AW', 'cow'], ['AY', 'hide'], ['EH', 'Ed'],
  ['ER', 'hurt'], ['EY', 'ate'], ['IH', 'it'], ['IY', 'eat'], ['OW', 'oat'], ['OY', 'toy'], ['UH', 'hood'],
  ['UW', 'two'], ['CH', 'cheese'], ['DH', 'thee'], ['HH', 'he'], ['JH', 'gee'], ['NG', 'ping'], ['SH', 'she'],
  ['TH', 'theta'], ['ZH', 'seizure'], ['Y', 'yield'],
];

const EMPTY = { word: '', mode: 'soundsLike', soundsLike: '', arpabet: '', notes: '' };

export default function PronunciationPanel({ voiceName, canApply = true, compact = false }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState('');
  const [busy, setBusy] = useState(false);
  const [lookup, setLookup] = useState('');
  const [message, setMessage] = useState(null);
  const [pendingApply, setPendingApply] = useState(false);
  const [filter, setFilter] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);

  const load = useCallback(async () => {
    if (!voiceName) return;
    setLoading(true);
    try {
      setEntries((await getPronunciations(voiceName)).entries || []);
    } catch (err) {
      setMessage({ tone: 'error', text: errorText(err, 'Could not load the pronunciation library') });
    } finally {
      setLoading(false);
    }
  }, [voiceName]);

  useEffect(() => { setForm(EMPTY); setEditing(''); setPendingApply(false); setMessage(null); load(); }, [load]);

  function edit(entry) {
    setEditing(entry.word);
    setForm({
      word: entry.word,
      mode: entry.arpabet && !entry.soundsLike ? 'arpabet' : 'soundsLike',
      soundsLike: entry.soundsLike || '',
      arpabet: entry.arpabet || '',
      notes: entry.notes || '',
    });
  }

  async function lookUp() {
    const word = form.word.trim();
    if (!word) return;
    setLookup('loading');
    try {
      const arpabet = await fetchDatamuseArpabet(word);
      if (arpabet) {
        setForm((current) => ({ ...current, arpabet, mode: 'arpabet' }));
        setLookup('');
      } else setLookup(`No dictionary entry for "${word}" — type the sounds yourself.`);
    } catch {
      setLookup('The dictionary lookup is unavailable right now.');
    }
  }

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      if (editing && editing.toLowerCase() !== form.word.trim().toLowerCase()) await deletePronunciation(voiceName, editing);
      const payload = {
        word: form.word,
        notes: form.notes,
        ...(form.mode === 'soundsLike' ? { soundsLike: form.soundsLike } : { arpabet: form.arpabet }),
      };
      const result = await savePronunciation(voiceName, payload);
      setEntries(result.entries || []);
      if (form.mode === 'arpabet') setPendingApply(true);
      setMessage({ tone: 'success', text: form.mode === 'arpabet' ? `Saved "${form.word}". Press "Apply to voice" to load the new sounds.` : `Saved "${form.word}" — it applies to the next thing you hear.` });
      setForm(EMPTY);
      setEditing('');
    } catch (err) {
      setMessage({ tone: 'error', text: errorText(err, 'Could not save') });
    } finally {
      setBusy(false);
    }
  }

  async function remove(word) {
    setBusy(true);
    try {
      const result = await deletePronunciation(voiceName, word);
      const removed = entries.find((entry) => entry.word === word);
      setEntries(result.entries || []);
      if (removed?.arpabet && !removed?.soundsLike) setPendingApply(true);
      if (editing === word) { setEditing(''); setForm(EMPTY); }
    } catch (err) {
      setMessage({ tone: 'error', text: errorText(err, 'Could not remove') });
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    setBusy(true);
    setMessage({ tone: 'info', text: 'Applying… the voice engine may reload (up to a minute).' });
    try {
      const result = await applyPronunciations(voiceName);
      setPendingApply(false);
      setMessage({ tone: 'success', text: result.restarted ? 'Applied — the voice engine reloaded with the new sounds.' : 'Applied — nothing needed reloading.' });
    } catch (err) {
      setMessage({ tone: 'error', text: errorText(err, 'Could not apply') });
    } finally {
      setBusy(false);
    }
  }

  const shown = entries.filter((entry) => !filter || entry.word.toLowerCase().includes(filter.toLowerCase()));
  const readable = form.mode === 'arpabet' && form.arpabet ? arpabetToReadable(form.arpabet) : '';

  return (
    <section className={cn('flex flex-col rounded-2xl border border-slate-200 bg-white', compact ? '' : 'shadow-sm')}>
      <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900"><BookOpen size={15} /> Pronunciation</h3>
          <p className="text-xs text-slate-500">Only affects <span className="font-medium text-slate-700">{voiceName || 'this voice'}</span>.</p>
        </div>
        {canApply && pendingApply && (
          <Button variant="dark" size="sm" onClick={apply} disabled={busy}><RefreshCw size={13} /> Apply to voice</Button>
        )}
      </div>

      <form onSubmit={save} className="space-y-3 border-b border-slate-100 px-4 py-3">
        <div className="flex gap-2">
          <input
            value={form.word}
            onChange={(event) => setForm({ ...form, word: event.target.value })}
            placeholder="Word, e.g. cohesin"
            aria-label="Word"
            className="h-9 min-w-0 flex-1 rounded-lg border border-slate-300 px-3 text-sm focus:border-primary focus:outline-none"
          />
          {editing && <Button variant="ghost" size="sm" onClick={() => { setEditing(''); setForm(EMPTY); }} aria-label="Cancel edit"><X size={14} /></Button>}
        </div>
        <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-xs font-semibold" role="radiogroup" aria-label="How to describe it">
          {[['soundsLike', 'Sounds like'], ['arpabet', 'Exact sounds (ARPAbet)']].map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={form.mode === value}
              onClick={() => setForm({ ...form, mode: value })}
              className={cn('rounded-md px-3 py-1.5', form.mode === value ? 'bg-white text-slate-900 shadow' : 'text-slate-500')}
            >
              {label}
            </button>
          ))}
        </div>
        {form.mode === 'soundsLike' ? (
          <div>
            <input
              value={form.soundsLike}
              onChange={(event) => setForm({ ...form, soundsLike: event.target.value })}
              placeholder="Spell it how it sounds, e.g. koh hee sin"
              aria-label="Sounds like"
              className="h-9 w-full rounded-lg border border-slate-300 px-3 text-sm focus:border-primary focus:outline-none"
            />
            <p className="mt-1 text-xs text-slate-500">Letters and spaces only. Split syllables with spaces to slow a word down.</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            <div className="flex gap-2">
              <input
                value={form.arpabet}
                onChange={(event) => setForm({ ...form, arpabet: event.target.value.toUpperCase() })}
                placeholder="K OW0 HH IY1 S IH0 N"
                aria-label="ARPAbet sounds"
                className="h-9 min-w-0 flex-1 rounded-lg border border-slate-300 px-3 font-mono text-sm focus:border-primary focus:outline-none"
              />
              <Button variant="outline" size="sm" onClick={lookUp} disabled={!form.word.trim() || lookup === 'loading'}>
                {lookup === 'loading' ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />} Look up
              </Button>
            </div>
            {readable && <p className="text-xs text-slate-600">Reads as: <span className="font-semibold">{readable}</span> <span className="text-slate-400">(capitals = stressed)</span></p>}
            {lookup && lookup !== 'loading' && <p className="text-xs text-amber-700">{lookup}</p>}
            <button type="button" onClick={() => setHelpOpen(!helpOpen)} className="text-xs font-medium text-primary hover:underline">
              {helpOpen ? 'Hide' : 'Show'} sound guide
            </button>
            {helpOpen && (
              <div className="grid grid-cols-3 gap-x-3 gap-y-0.5 rounded-lg bg-slate-50 p-2 font-mono text-[11px] text-slate-600 sm:grid-cols-4">
                {PHONEME_HELP.map(([code, example]) => <span key={code}><b>{code}</b> {example}</span>)}
                <span className="col-span-full mt-1 font-sans">Add 1 to the stressed vowel (IY1), 0 to unstressed ones. Other letters (B, D, K, S…) are as written.</span>
              </div>
            )}
          </div>
        )}
        <Button type="submit" variant="primary" size="sm" disabled={busy || !form.word.trim() || !(form.mode === 'soundsLike' ? form.soundsLike.trim() : form.arpabet.trim())}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} {editing ? 'Save changes' : 'Add word'}
        </Button>
      </form>

      {message && <Notice tone={message.tone} className="mx-4 mt-3 text-xs">{message.text}</Notice>}

      <div className="px-4 pt-3">
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={`Search ${entries.length} word${entries.length === 1 ? '' : 's'}`}
          aria-label="Search words"
          className="h-8 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 text-xs focus:outline-none"
        />
      </div>
      <ul className="max-h-72 flex-1 divide-y divide-slate-100 overflow-y-auto px-2 py-2">
        {loading && <li className="flex justify-center py-4"><Loader2 size={16} className="animate-spin text-slate-400" /></li>}
        {!loading && shown.length === 0 && <li className="px-2 py-4 text-center text-xs text-slate-500">No custom words yet.</li>}
        {shown.map((entry) => (
          <li key={entry.word} className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-slate-50">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-800">{entry.word}</p>
              <p className="truncate text-xs text-slate-500">
                {entry.soundsLike ? `sounds like "${entry.soundsLike}"` : `${entry.arpabet} · ${arpabetToReadable(entry.arpabet)}`}
              </p>
            </div>
            <button type="button" onClick={() => edit(entry)} className="rounded p-1.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700" aria-label={`Edit ${entry.word}`}><Pencil size={13} /></button>
            <button type="button" onClick={() => remove(entry.word)} disabled={busy} className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" aria-label={`Remove ${entry.word}`}><Trash2 size={13} /></button>
          </li>
        ))}
      </ul>
    </section>
  );
}
