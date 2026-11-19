import React, { useEffect, useRef, useState } from 'react';
import { BookOpenText, Check, Copy, X } from 'lucide-react';
import { READING_SCRIPT, READING_SCRIPT_TIPS, readingScriptText } from './readingScript.js';

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older/locked-down browsers: select a hidden textarea and copy.
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

// "Need something to read?" — a shining button that opens a script written to
// make good training audio. Full screen on a phone, a centred panel on desktop;
// the whole script copies in one tap.
export default function ReadingScriptButton() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState('');
  const closeRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function handleCopy() {
    const ok = await copyText(readingScriptText());
    setCopied(ok ? 'Copied' : 'Copy failed — select the text instead');
    window.setTimeout(() => setCopied(''), 2500);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group relative mt-4 inline-flex w-full items-center justify-center gap-2 overflow-hidden rounded-md border border-primary/30 bg-primary/5 px-4 py-2.5 text-sm font-semibold text-primary shadow-sm transition-colors hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary active:scale-[0.99]"
      >
        <span
          className="pointer-events-none absolute inset-y-0 left-0 w-1/3 -skew-x-12 bg-gradient-to-r from-transparent via-white/80 to-transparent animate-shine motion-reduce:hidden"
          aria-hidden="true"
        />
        <BookOpenText size={16} aria-hidden="true" />
        <span className="relative">No recording? Read our script</span>
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-[90] flex items-stretch justify-center bg-slate-950/50 backdrop-blur-sm sm:items-center sm:p-6"
          onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="reading-script-title"
            className="flex h-full w-full flex-col bg-white shadow-2xl sm:h-auto sm:max-h-[88vh] sm:max-w-2xl sm:rounded-2xl"
          >
            <header className="flex items-start gap-3 border-b border-slate-200 px-4 py-3 sm:px-6 sm:py-4">
              <div className="min-w-0 flex-1">
                <h2 id="reading-script-title" className="text-base font-semibold text-slate-900 sm:text-lg">
                  Reading script for your voice
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">Record yourself reading this aloud, then upload it.</p>
              </div>
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-semibold text-white hover:bg-primary/90"
              >
                {copied === 'Copied' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
                {copied === 'Copied' ? 'Copied' : 'Copy'}
              </button>
              <button
                ref={closeRef}
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </header>
            {copied && copied !== 'Copied' ? (
              <p className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 sm:px-6" role="status">{copied}</p>
            ) : <span className="sr-only" role="status">{copied}</span>}

            <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6 sm:py-5">
              <ul className="mb-5 space-y-1.5 rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-600 sm:text-sm">
                {READING_SCRIPT_TIPS.map((tip) => (
                  <li key={tip} className="flex gap-2">
                    <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                    {tip}
                  </li>
                ))}
              </ul>
              <article className="select-text space-y-6">
                {READING_SCRIPT.map((section) => (
                  <section key={section.title}>
                    <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">{section.title}</h3>
                    <div className="mt-2 space-y-3">
                      {section.paragraphs.map((paragraph) => (
                        <p key={paragraph.slice(0, 40)} className="text-[15px] leading-7 text-slate-800 sm:text-base sm:leading-8">
                          {paragraph}
                        </p>
                      ))}
                    </div>
                  </section>
                ))}
              </article>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
