import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  CONSENT_CHECKS, CONSENT_INTRO, CONSENT_SECTIONS, CONSENT_VERSION, CONTACT_LINE, FAQ,
} from './faqContent.js';
import { Brand, Button } from './StudioChrome.jsx';

const storageKey = (email) => `voice-studio-consent:${String(email || '').toLowerCase()}`;

export function readStudioConsent(email) {
  try {
    const saved = JSON.parse(window.localStorage.getItem(storageKey(email)) || 'null');
    return saved?.version === CONSENT_VERSION ? saved : null;
  } catch {
    return null;
  }
}

function saveStudioConsent(email) {
  const record = { version: CONSENT_VERSION, accepted: true, acceptedAt: new Date().toISOString() };
  try { window.localStorage.setItem(storageKey(email), JSON.stringify(record)); } catch { /* private mode: asked again next time */ }
  return record;
}

/** Full-screen consent. Accept is enabled only after scrolling to the end and ticking every box. */
export function ConsentDialog({ email, onAccept, onDecline }) {
  const [checked, setChecked] = useState(CONSENT_CHECKS.map(() => false));
  const [readToEnd, setReadToEnd] = useState(false);
  const bodyRef = useRef(null);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, []);

  function onScroll() {
    const el = bodyRef.current;
    if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 24) setReadToEnd(true);
  }

  const allChecked = checked.every(Boolean);
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/60 p-3 backdrop-blur-sm sm:p-6">
      <div role="dialog" aria-modal="true" aria-labelledby="consent-title" className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="border-b border-slate-200 px-6 py-5">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><ShieldCheck size={20} /></span>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">Consent · version {CONSENT_VERSION}</p>
              <h2 id="consent-title" className="text-lg font-semibold text-slate-900">Your voice, your consent</h2>
            </div>
          </div>
          <p className="mt-3 text-sm leading-6 text-slate-600">{CONSENT_INTRO}</p>
        </div>
        <div ref={bodyRef} onScroll={onScroll} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {CONSENT_SECTIONS.map((section, index) => (
            <section key={section.title}>
              <h3 className="text-sm font-semibold text-slate-900">{index + 1}. {section.title}</h3>
              <ul className="mt-2 space-y-1.5 text-sm leading-6 text-slate-700">
                {section.points.map((point) => <li key={point} className="flex gap-2"><span className="text-slate-400">•</span><span>{point}</span></li>)}
              </ul>
            </section>
          ))}
          <section className="rounded-xl bg-slate-50 p-4">
            <h3 className="text-sm font-semibold text-slate-900">Please confirm</h3>
            <div className="mt-2 space-y-2">
              {CONSENT_CHECKS.map((text, index) => (
                <label key={text} className="flex gap-3 text-sm leading-6 text-slate-700">
                  <input
                    type="checkbox"
                    className="mt-1.5"
                    checked={checked[index]}
                    onChange={(event) => setChecked(checked.map((value, i) => (i === index ? event.target.checked : value)))}
                  />
                  {text}
                </label>
              ))}
            </div>
            <p className="mt-3 text-xs text-slate-500">{CONTACT_LINE} Signed in as {email}.</p>
          </section>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-6 py-4">
          <p className="text-xs text-slate-500">{readToEnd ? (allChecked ? 'Thank you.' : 'Tick every box to continue.') : 'Scroll to the end to continue.'}</p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onDecline}>Not now</Button>
            <Button variant="primary" disabled={!readToEnd || !allChecked} onClick={() => onAccept(saveStudioConsent(email))}>I agree</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function FaqList({ className }) {
  const [open, setOpen] = useState('');
  return (
    <div className={cn('space-y-6', className)}>
      {FAQ.map((group) => (
        <section key={group.group}>
          <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">{group.group}</h3>
          <div className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
            {group.items.map(([question, answer]) => {
              const isOpen = open === question;
              return (
                <div key={question}>
                  <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? '' : question)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-medium text-slate-800 hover:bg-slate-50">
                    {question}
                    <ChevronDown size={16} className={cn('shrink-0 text-slate-400 transition', isOpen && 'rotate-180')} />
                  </button>
                  {isOpen && <p className="px-4 pb-4 text-sm leading-6 text-slate-600">{answer}</p>}
                </div>
              );
            })}
          </div>
        </section>
      ))}
      <p className="text-sm text-slate-600">{CONTACT_LINE}</p>
    </div>
  );
}

/** Public page (no sign-in): /faq on the recording site. */
export function FaqPage() {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-4 sm:px-6">
          <Brand product="Voice Studio" />
          <a href="/" className="text-sm font-semibold text-primary hover:underline">Record your voice →</a>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Frequently asked questions</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">Voice Studio: your voice for LKCMedicine teaching</h1>
        <p className="mt-3 max-w-2xl text-slate-600">{CONSENT_INTRO}</p>
        <FaqList className="mt-8" />
        <details className="mt-10 rounded-xl border border-slate-200 bg-white p-5">
          <summary className="cursor-pointer text-sm font-semibold text-slate-900">Read the full consent form (version {CONSENT_VERSION})</summary>
          <div className="mt-4 space-y-4">
            {CONSENT_SECTIONS.map((section) => (
              <section key={section.title}>
                <h3 className="text-sm font-semibold text-slate-900">{section.title}</h3>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-sm leading-6 text-slate-700">{section.points.map((point) => <li key={point}>{point}</li>)}</ul>
              </section>
            ))}
          </div>
        </details>
      </main>
    </div>
  );
}
