// Part 2 set-up: the lecturer's specialty, then a term list built by any mix of
// AI generation, pasting and a spreadsheet upload; then a review of the list;
// then the reading script (AI scenarios around the terms) is written and handed
// to the reader.
import React, { useMemo, useRef, useState } from 'react';
import {
  ClipboardPaste, FileSpreadsheet, Loader2, Plus, Sparkles, Trash2, Upload,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button, Card, Notice } from './StudioChrome.jsx';
import { errorText, generateSpecialtyTerms, writeSpecialtyScenario } from './studioApi.js';
import {
  MAX_TERMS, TERM_COUNTS, TERMS_PER_SCENARIO, addEntries, chunk, ownSentenceSections, parseTermList,
  scenarioSections, termsAloneSections, termsMinutes,
} from './specialtyTerms.js';
import { TERM_FILE_ACCEPT, readTermsFile, termTemplateUrl } from './spreadsheetTerms.js';

const EXAMPLES = ['Gastroenterology — GI bleeding', 'Cardiology', 'Respiratory medicine', 'Paediatrics', 'Pharmacology'];
const MODES = [
  { id: 'generate', label: 'Generate with AI', Icon: Sparkles },
  { id: 'paste', label: 'Paste terms', Icon: ClipboardPaste },
  { id: 'upload', label: 'Upload Excel', Icon: FileSpreadsheet },
];
const SOURCE_LABELS = { ai: 'AI', pasted: 'Pasted', excel: 'Excel', added: 'Added' };
const PARALLEL_SCENARIOS = 3;

// Runs tasks a few at a time, reporting each one done.
async function inBatches(tasks, limit, onDone) {
  const results = new Array(tasks.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < tasks.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await tasks[index]();
      onDone();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

async function scenarioFor(specialty, terms) {
  try {
    return { ...(await writeSpecialtyScenario({ specialty, terms })), terms };
  } catch {
    try {
      return { ...(await writeSpecialtyScenario({ specialty, terms })), terms };
    } catch {
      return null; // read on their own instead
    }
  }
}

function SpecialtyField({ value, onChange, disabled }) {
  return (
    <div className="space-y-2">
      <label htmlFor="specialty" className="block text-sm font-semibold text-slate-900">Your specialty</label>
      <input
        id="specialty"
        value={value}
        maxLength={120}
        disabled={disabled}
        placeholder="e.g. Gastroenterology — upper and lower GI bleeding"
        onChange={(event) => onChange(event.target.value)}
        className="h-12 w-full rounded-lg border border-slate-300 bg-white px-3 text-base focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-slate-500">Examples:</span>
        {EXAMPLES.map((example) => (
          <button key={example} type="button" disabled={disabled} onClick={() => onChange(example)} className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-700 hover:border-slate-300 hover:bg-slate-50">
            {example}
          </button>
        ))}
      </div>
      <p className="text-xs text-slate-500">Saved with your voice, so our team knows which terms to check.</p>
    </div>
  );
}

function ModeTabs({ mode, onChange, disabled }) {
  return (
    <div role="tablist" aria-label="How to add terms" className="grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1">
      {MODES.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={mode === id}
          disabled={disabled}
          onClick={() => onChange(id)}
          className={cn('flex h-10 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-semibold sm:text-sm', mode === id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900')}
        >
          <Icon size={15} aria-hidden="true" className="hidden shrink-0 sm:block" /> {label}
        </button>
      ))}
    </div>
  );
}

function WrapToggle({ checked, onChange, label }) {
  return (
    <label className="flex items-start gap-2.5 text-sm text-slate-700">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{label} <span className="text-slate-500">(recommended — words read on their own sound flat)</span></span>
    </label>
  );
}

function TermRow({ entry, onRemove, disabled }) {
  return (
    <li className="flex items-start gap-3 px-4 py-2.5 sm:px-5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-slate-900 [overflow-wrap:anywhere]">{entry.term}</span>
          <span className="rounded-full border border-slate-200 px-2 py-px text-[11px] text-slate-600">{SOURCE_LABELS[entry.source] || entry.source}</span>
        </div>
        {entry.sentence && <p className="mt-0.5 text-sm text-slate-600">{entry.sentence}</p>}
      </div>
      <button type="button" onClick={onRemove} disabled={disabled} className="shrink-0 rounded-lg p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600" aria-label={`Remove ${entry.term}`}>
        <Trash2 size={15} />
      </button>
    </li>
  );
}

/**
 * specialty / onSpecialtyChange: the lecturer's specialty (saved with the set).
 * entries / onEntriesChange: [{ term, source, sentence }] — kept by the parent
 *   so the list survives moving between the parts.
 * onBuilt(sections): the reading script is ready.
 */
export function SpecialtyTermsPanel({ specialty, onSpecialtyChange, entries, onEntriesChange, onBuilt, onSkip }) {
  const [view, setView] = useState(entries.length ? 'review' : 'setup');
  const [mode, setMode] = useState('generate');
  const [focus, setFocus] = useState('');
  const [count, setCount] = useState(TERM_COUNTS[0]);
  const [pasted, setPasted] = useState('');
  const [wrap, setWrap] = useState(true);
  const [newTerm, setNewTerm] = useState('');
  const [busy, setBusy] = useState(null); // { label, done, total }
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const fileRef = useRef(null);
  const templateUrl = useMemo(() => termTemplateUrl(), []);
  const working = Boolean(busy);
  const needSpecialty = () => {
    if (specialty.trim()) return false;
    setError('Please enter your specialty first.');
    return true;
  };

  function added(incoming, source) {
    const next = addEntries(entries, incoming, source);
    const addedCount = next.length - entries.length;
    onEntriesChange(next);
    setNotice(addedCount ? `Added ${addedCount} term${addedCount === 1 ? '' : 's'}.` : 'Those terms are already in your list.');
    setView('review');
  }

  async function generate() {
    setError('');
    if (needSpecialty()) return;
    setBusy({ label: `Finding ${count} terms for ${specialty.trim()}…` });
    try {
      const terms = await generateSpecialtyTerms({ specialty: specialty.trim(), focus: focus.trim(), count });
      added(terms.map((term) => ({ term })), 'ai');
    } catch (err) {
      setError(errorText(err, 'Could not generate terms. Try again, or paste your own.'));
    } finally {
      setBusy(null);
    }
  }

  function addPasted() {
    setError('');
    const terms = parseTermList(pasted);
    if (terms.length === 0) { setError('Paste at least one term.'); return; }
    added(terms.map((term) => ({ term })), 'pasted');
    setPasted('');
  }

  async function addFile(file) {
    setError('');
    if (!file) return;
    setBusy({ label: `Reading ${file.name}…` });
    try {
      const rows = await readTermsFile(file);
      if (rows.length === 0) throw new Error('No terms found — put one term per row in column A.');
      added(rows, 'excel');
    } catch (err) {
      setError(err.message || 'Could not read that file.');
    } finally {
      setBusy(null);
    }
  }

  function addOne() {
    const terms = parseTermList(newTerm);
    if (terms.length) added(terms.map((term) => ({ term })), 'added');
    setNewTerm('');
  }

  async function build() {
    setError('');
    if (needSpecialty()) return;
    const ownSentences = entries.filter((entry) => entry.sentence);
    const bare = entries.filter((entry) => !entry.sentence).map((entry) => entry.term);
    const groups = wrap ? chunk(bare, TERMS_PER_SCENARIO) : [];
    let done = 0;
    setBusy({ label: 'Writing your reading script…', done, total: groups.length });
    try {
      const scenarios = await inBatches(
        groups.map((terms) => () => scenarioFor(specialty.trim(), terms)),
        PARALLEL_SCENARIOS,
        () => { done += 1; setBusy({ label: 'Writing your reading script…', done, total: groups.length }); },
      );
      const written = scenarios.filter(Boolean);
      const unwritten = groups.filter((_, index) => !scenarios[index]).flat();
      const plain = wrap ? unwritten : bare;
      const sections = [
        ...scenarioSections(written, 0),
        ...termsAloneSections(plain, written.length),
      ];
      const all = [...sections, ...ownSentenceSections(ownSentences, sections.length)];
      if (all.length === 0) { setError('Add some terms first.'); return; }
      if (wrap && unwritten.length) setNotice(`${unwritten.length} term(s) could not be put into a scenario, so they are listed on their own at the end.`);
      onBuilt(all);
    } catch (err) {
      setError(errorText(err, 'Could not write the reading script. Please try again.'));
    } finally {
      setBusy(null);
    }
  }

  const minutes = termsMinutes(entries.length);

  return (
    <Card className="flex min-h-0 flex-col overflow-hidden">
      <div className="border-b border-slate-200 px-4 py-4 sm:px-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Part 2 of 2 · Medical terms{view === 'review' ? ' · check your terms' : ''}</p>
        <h2 className="mt-1 text-base font-semibold text-slate-900 sm:text-lg">{view === 'review' ? (specialty.trim() || 'Your terms') : 'The words you say every day'}</h2>
        <p className="mt-1 text-sm text-slate-600">
          {view === 'review'
            ? `${entries.length} term${entries.length === 1 ? '' : 's'} · about ${minutes} min to read`
            : 'Reading the terms from your field, inside short sentences, helps your voice say them smoothly. It takes about 7–14 minutes.'}
        </p>
      </div>

      <div className="space-y-5 px-4 py-5 sm:px-5">
        {error && <Notice tone="error">{error}</Notice>}
        {notice && !error && <Notice tone="success">{notice}</Notice>}
        {busy && (
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3" role="status">
            <p className="flex items-center gap-2 text-sm font-medium text-slate-800"><Loader2 size={15} className="animate-spin" aria-hidden="true" /> {busy.label}</p>
            {busy.total > 0 && (
              <>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200"><div className="h-full bg-primary transition-[width]" style={{ width: `${(busy.done / busy.total) * 100}%` }} /></div>
                <p className="mt-1 text-xs text-slate-500">{busy.done} of {busy.total} scenarios</p>
              </>
            )}
          </div>
        )}

        {view === 'setup' && (
          <>
            <SpecialtyField value={specialty} onChange={onSpecialtyChange} disabled={working} />
            <div className="space-y-3">
              <p className="text-sm font-semibold text-slate-900">Get your term list</p>
              <ModeTabs mode={mode} onChange={(value) => { setMode(value); setError(''); }} disabled={working} />

              {mode === 'generate' && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <label htmlFor="focus" className="block text-sm font-semibold text-slate-700">Anything to focus on? <span className="font-normal text-slate-500">(optional)</span></label>
                    <input id="focus" value={focus} maxLength={200} disabled={working} onChange={(event) => setFocus(event.target.value)} placeholder="e.g. endoscopy, scoring systems, drug names" className="h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20" />
                  </div>
                  <fieldset className="space-y-2">
                    <legend className="text-sm font-semibold text-slate-700">How many terms</legend>
                    <div className="flex flex-wrap gap-2">
                      {TERM_COUNTS.map((value) => (
                        <button key={value} type="button" aria-pressed={count === value} disabled={working} onClick={() => setCount(value)} className={cn('h-11 rounded-lg px-4 text-sm', count === value ? 'border-2 border-slate-900 font-semibold text-slate-900' : 'border border-slate-200 text-slate-700 hover:bg-slate-50')}>
                          {value} terms · ~{termsMinutes(value)} min
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  <Button variant="dark" size="lg" onClick={generate} disabled={working}><Sparkles size={16} aria-hidden="true" /> Generate term list</Button>
                  <p className="text-xs text-slate-500">AI suggests the terms and later builds them into short clinical scenarios to read aloud. You check and edit every term before you read.</p>
                </div>
              )}

              {mode === 'paste' && (
                <div className="space-y-3">
                  <label htmlFor="paste-terms" className="block text-sm font-semibold text-slate-700">Paste your terms — one per line, or separated by commas</label>
                  <textarea id="paste-terms" rows={7} value={pasted} disabled={working} onChange={(event) => setPasted(event.target.value)} placeholder={'haematochezia\nmelaena\noesophageal varices'} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm leading-6 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20" />
                  <Button variant="dark" size="lg" onClick={addPasted} disabled={working || !pasted.trim()}>Add {parseTermList(pasted).length || ''} terms</Button>
                </div>
              )}

              {mode === 'upload' && (
                <div className="space-y-3">
                  <div className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center">
                    <Upload size={22} className="text-slate-400" aria-hidden="true" />
                    <p className="text-sm font-medium text-slate-700">Upload an Excel or CSV file</p>
                    <p className="text-xs text-slate-500">XLSX or CSV · column A = term, column B = your own sentence (optional)</p>
                    <Button variant="outline" size="sm" className="mt-1" disabled={working} onClick={() => fileRef.current?.click()}><FileSpreadsheet size={14} /> Choose file</Button>
                    <input ref={fileRef} type="file" accept={TERM_FILE_ACCEPT} className="hidden" onChange={(event) => { addFile(event.target.files?.[0]); event.target.value = ''; }} />
                  </div>
                  <a href={templateUrl} download="specialty-terms-template.csv" className="inline-block text-sm font-medium text-primary hover:underline">Download the template (.csv — opens in Excel)</a>
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
              {entries.length > 0
                ? <Button variant="outline" size="md" onClick={() => setView('review')} disabled={working}>Back to my {entries.length} terms</Button>
                : <button type="button" onClick={onSkip} className="text-sm text-slate-600 underline hover:text-slate-900">Skip Part 2 for now</button>}
              <span className="text-xs text-slate-500">You can mix all three — they add to the same list.</span>
            </div>
          </>
        )}

        {view === 'review' && (
          <>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="md" onClick={() => { setView('setup'); setNotice(''); }} disabled={working || entries.length >= MAX_TERMS}><Plus size={15} aria-hidden="true" /> Add more terms</Button>
              <Button variant="ghost" size="md" onClick={() => { onEntriesChange([]); setView('setup'); setNotice(''); }} disabled={working}>Start the list again</Button>
            </div>
            <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); addOne(); }}>
              <label htmlFor="add-term" className="sr-only">Add a term</label>
              <input id="add-term" value={newTerm} maxLength={80} disabled={working} onChange={(event) => setNewTerm(event.target.value)} placeholder="Add a term" className="h-10 min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20" />
              <Button type="submit" variant="outline" size="md" disabled={working || !newTerm.trim()}>Add</Button>
            </form>
          </>
        )}
      </div>

      {view === 'review' && (
        <>
          <ul className="max-h-[420px] divide-y divide-slate-100 overflow-y-auto border-y border-slate-100">
            {entries.map((entry) => (
              <TermRow key={entry.term.toLowerCase()} entry={entry} disabled={working} onRemove={() => onEntriesChange(entries.filter((other) => other !== entry))} />
            ))}
            {entries.length === 0 && <li className="px-5 py-6 text-center text-sm text-slate-500">No terms yet — add some above.</li>}
          </ul>
          <div className="mt-auto space-y-3 bg-slate-50 px-4 py-4 sm:px-5">
            <WrapToggle checked={wrap} onChange={setWrap} label="Build my terms into short scenarios to read" />
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="dark" size="lg" onClick={build} disabled={working || entries.length === 0}>
                {working ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : null} Write my reading script
              </Button>
              <span className="flex-1 basis-48 text-xs text-slate-500">About {TERMS_PER_SCENARIO} terms per scenario. Then you read it just like Part 1: one recording, Pause for a break.</span>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}
