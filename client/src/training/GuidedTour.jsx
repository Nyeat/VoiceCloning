import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, X } from 'lucide-react';

// A spotlight walkthrough of the training site. Each step names the route it
// lives on and a CSS selector; the tour navigates there, waits for the element,
// scrolls it into view and cuts a highlighted hole around it. A step whose
// element never appears (e.g. no voices yet) is shown centred instead.
export const TOUR_STEPS = [
  {
    route: '/', selector: '[data-tour="nav-tabs"]',
    title: 'Two places to work',
    body: 'Train a voice is where you upload recordings and start training. Test your voice is where you try the result.',
  },
  {
    route: '/', selector: '[data-tour="upload"]',
    title: '1 · Add your recordings',
    body: 'Drop in 10–30 minutes of you speaking. WAV or FLAC is best; several files are fine — they are combined.',
  },
  {
    route: '/', selector: '[data-tour="start-training"]',
    title: '2 · Start training',
    body: 'Press Start training. It takes about 30–60 minutes and you can close the page — we email you when it is ready.',
  },
  {
    route: '/', selector: '[data-tour="your-voices"]',
    title: 'Your voices',
    body: 'Every run adds a new version (name_2, name_3 …). Older versions are kept so you can compare them.',
  },
  {
    route: '/', selector: '[data-tour="gpu"]',
    title: 'GPU status',
    body: 'Training and testing run on a GPU. It starts automatically when you are here and switches off after 30 idle minutes.',
  },
  {
    route: '/test-voice', selector: '[data-tour="voice-picker"]',
    title: '3 · Pick a voice to test',
    body: 'Choose one of your trained voices. Only you can see them.',
  },
  {
    route: '/test-voice', selector: 'textarea[placeholder^="Ask a question"], input[placeholder^="Ask a question"]',
    title: 'Ask it something',
    body: 'Type a question or press the microphone. The answer is spoken back in your cloned voice.',
  },
  {
    route: '/test-voice', selector: '[data-tour="help"]',
    title: 'Need this again?',
    body: 'Press the question mark any time to replay this tour or read the full guide.',
  },
];

const PAD = 8;
const CARD_W = 340;

function useTargetRect(selector, active, stepKey) {
  const [rect, setRect] = useState(null);
  const [missing, setMissing] = useState(false);

  useLayoutEffect(() => {
    if (!active) return undefined;
    setRect(null);
    setMissing(false);
    let frame = 0;
    let tries = 0;
    let el = null;
    let cancelled = false;

    const measure = () => {
      if (!el || !el.isConnected) return;
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    const find = () => {
      if (cancelled) return;
      el = document.querySelector(selector);
      if (el && el.getBoundingClientRect().width > 0) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        window.setTimeout(measure, 350);
        measure();
        return;
      }
      tries += 1;
      if (tries > 40) { setMissing(true); return; } // ~2 s
      frame = window.setTimeout(find, 50);
    };
    find();

    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      cancelled = true;
      window.clearTimeout(frame);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [selector, active, stepKey]);

  return { rect, missing };
}

function cardPosition(rect) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(CARD_W, vw - 32);
  if (!rect) return { top: vh / 2, left: vw / 2, width, transform: 'translate(-50%, -50%)' };
  const below = rect.top + rect.height + PAD + 12;
  const spaceBelow = vh - below;
  const left = Math.min(Math.max(16, rect.left + rect.width / 2 - width / 2), vw - width - 16);
  if (spaceBelow > 200) return { top: below, left, width };
  const above = rect.top - PAD - 12;
  if (above > 200) return { top: above, left, width, transform: 'translateY(-100%)' };
  // Tall target: sit the card inside the viewport bottom.
  return { top: vh - 16, left, width, transform: 'translateY(-100%)' };
}

export default function GuidedTour({ open, onClose, onOpenGuide }) {
  const [index, setIndex] = useState(0);
  const navigate = useNavigate();
  const location = useLocation();
  const step = TOUR_STEPS[index];
  const onRoute = location.pathname === step.route;
  const { rect, missing } = useTargetRect(step.selector, open && onRoute, index);

  useEffect(() => { if (open) setIndex(0); }, [open]);
  useEffect(() => {
    if (open && !onRoute) navigate(step.route);
  }, [open, onRoute, step.route, navigate]);

  const next = useCallback(() => {
    if (index >= TOUR_STEPS.length - 1) onClose();
    else setIndex((i) => i + 1);
  }, [index, onClose]);
  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
      else if (event.key === 'ArrowRight') next();
      else if (event.key === 'ArrowLeft') back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, next, back]);

  if (!open) return null;
  const showRect = rect && !missing;
  const pos = cardPosition(showRect ? rect : null);
  const last = index === TOUR_STEPS.length - 1;

  return (
    <div className="fixed inset-0 z-[110]" aria-live="polite">
      {/* Click-catcher; the dimming comes from the spotlight's huge shadow. */}
      <div className={showRect ? 'absolute inset-0' : 'absolute inset-0 bg-slate-950/60'} onClick={onClose} />
      {showRect ? (
        <div
          className="pointer-events-none absolute rounded-xl ring-2 ring-white transition-all duration-300 ease-out"
          style={{
            top: rect.top - PAD,
            left: rect.left - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            boxShadow: '0 0 0 9999px rgba(2, 6, 23, 0.62)',
          }}
          aria-hidden="true"
        />
      ) : null}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        className="absolute rounded-xl bg-white p-5 shadow-2xl transition-all duration-300 ease-out"
        style={pos}
      >
        <div className="flex items-start justify-between gap-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
            Step {index + 1} of {TOUR_STEPS.length}
          </p>
          <button type="button" onClick={onClose} className="-m-1 rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="End tour">
            <X size={16} />
          </button>
        </div>
        <h2 id="tour-title" className="mt-1 text-base font-semibold text-slate-900">{step.title}</h2>
        <p className="mt-1.5 text-sm leading-6 text-slate-600">{step.body}</p>
        <div className="mt-4 flex items-center gap-1.5" aria-hidden="true">
          {TOUR_STEPS.map((s, i) => (
            <span key={s.title} className={i === index ? 'h-1.5 w-5 rounded-full bg-primary' : 'h-1.5 w-1.5 rounded-full bg-slate-200'} />
          ))}
        </div>
        <div className="mt-4 flex items-center gap-2">
          {last ? (
            <button type="button" onClick={() => { onClose(); onOpenGuide?.(); }} className="mr-auto text-xs font-medium text-primary hover:underline">
              Read the full guide
            </button>
          ) : (
            <button type="button" onClick={onClose} className="mr-auto text-xs font-medium text-slate-500 hover:text-slate-800">
              Skip tour
            </button>
          )}
          {index > 0 ? (
            <button type="button" onClick={back} className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 px-3 text-xs font-medium text-slate-700 hover:bg-slate-50">
              <ArrowLeft size={14} /> Back
            </button>
          ) : null}
          <button type="button" onClick={next} className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-xs font-semibold text-white hover:bg-primary/90">
            {last ? 'Done' : <>Next <ArrowRight size={14} /></>}
          </button>
        </div>
      </div>
    </div>
  );
}
