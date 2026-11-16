import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import {
  AudioWaveform, ChevronDown, CircleHelp, Headphones, Loader2, Lock, LogOut, Mic, ShieldCheck, X,
} from 'lucide-react';
import ntuLogo from '@/assets/ntu-logo.png';
import { useAuth } from '@/auth/useAuth';
import { config } from '@/config';
import { PostLoginRedirectHandler, ProtectedRoute, SignInRecorder } from '@/auth/AppAuthGate';
import GpuInstanceControl from '@/components/GpuInstanceControl.jsx';
import { TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import TrainingPage from '@/pages/TrainingPage.jsx';
import LivePage from '@/pages/LivePage.jsx';
import { getCurrentTraining } from '@/services/api.js';
import GuidedTour from './GuidedTour.jsx';
import { hasSeenHelp, markHelpSeen, readConsent, saveConsent } from './consent.js';

// Dev runs training and inference on the same GPU; staging trains on its own
// GPU, so a running training job only slows replies where this is true.
const TRAINING_SHARES_INFERENCE_GPU = import.meta.env.VITE_TRAINING_SHARES_INFERENCE_GPU === 'true';

const PRIVACY_POINTS = [
  ['What we collect', 'The recordings you upload, the voice model trained from them, and your NTU account email.'],
  ['What it is used for', 'Only to build a synthetic copy of your voice for LKCMedicine teaching tools you choose to use it in.'],
  ['Who can use it', 'Only you can see, test and select your voices. Project administrators can access them for support and safety.'],
  ['Where it is kept', 'In LKCMedicine-controlled cloud storage in Singapore and Seoul. It is never sold or shared with third parties for their own use.'],
  ['Your control', 'You can ask for your recordings and voices to be deleted at any time by contacting the project team.'],
];

function BrandMark({ inverted = false }) {
  return (
    <div className="flex items-center gap-3">
      <img src={ntuLogo} alt="Nanyang Technological University" className="h-8 w-auto" />
      <span className={cn('h-7 w-px', inverted ? 'bg-white/30' : 'bg-slate-300')} aria-hidden="true" />
      <div className="leading-tight">
        <p className={cn('text-[11px] font-semibold uppercase tracking-[0.16em]', inverted ? 'text-white/70' : 'text-slate-500')}>
          LKCMedicine
        </p>
        <p className={cn('text-sm font-semibold', inverted ? 'text-white' : 'text-slate-900')}>Voice Cloning</p>
      </div>
    </div>
  );
}

function initials(nameOrEmail) {
  const base = String(nameOrEmail || '').split('@')[0].replace(/^cs-/i, '');
  const parts = base.split(/[\s._-]+/u).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

const LOGIN_STEPS = [
  [Mic, 'Upload your recordings', '10–30 minutes of you speaking — a recorded lecture works well.'],
  [AudioWaveform, 'We train your voice', 'About 30–60 minutes on our GPU. We email you when it is ready.'],
  [Headphones, 'Test it privately', 'Ask questions and hear the answers in your own voice.'],
];

function TrainingLogin() {
  const location = useLocation();
  const auth = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function signIn() {
    setBusy(true);
    setError('');
    try {
      const from = typeof location.state?.from === 'string' ? location.state.from : '/';
      await auth.signIn(from);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : 'Microsoft sign-in could not be started.');
    }
  }

  if (auth.isAuthenticated) return <Navigate to="/" replace />;
  const visibleError = error || auth.error;
  const working = busy || auth.isLoading;

  return (
    <div className="grid min-h-screen bg-slate-50 lg:grid-cols-[1.05fr_1fr]">
      {/* Story panel */}
      <section className="relative overflow-hidden bg-[#0f1b3d] px-6 py-10 text-white sm:px-12 lg:py-14">
        <div className="absolute inset-x-0 top-0 h-1 bg-[#d71440]" aria-hidden="true" />
        <div
          className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-[#d71440]/20 blur-3xl"
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute -bottom-32 -left-20 h-96 w-96 rounded-full bg-indigo-400/20 blur-3xl"
          aria-hidden="true"
        />
        <div className="relative flex h-full max-w-xl flex-col">
          <div className="inline-flex w-fit rounded-md bg-white px-3 py-2">
            <BrandMark />
          </div>
          <p className="mt-12 text-xs font-semibold uppercase tracking-[0.2em] text-white/60">For LKCMedicine faculty</p>
          <h1 className="mt-3 text-3xl font-semibold leading-tight tracking-tight sm:text-[2.6rem]">
            Your teaching voice, ready whenever students ask.
          </h1>
          <p className="mt-5 max-w-md text-base leading-7 text-white/75">
            Train a private voice model from your own recordings. It can read lecture answers aloud in your voice
            — and nothing is used until you have tested it here.
          </p>
          <ol className="mt-10 space-y-5">
            {LOGIN_STEPS.map(([Icon, title, detail], index) => (
              <li key={title} className="flex gap-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/20 bg-white/10">
                  <Icon size={18} aria-hidden="true" />
                </span>
                <div>
                  <p className="text-sm font-semibold">
                    <span className="mr-2 text-white/50">{index + 1}</span>
                    {title}
                  </p>
                  <p className="mt-0.5 text-sm leading-6 text-white/65">{detail}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-auto pt-12 text-xs text-white/50">
            Lee Kong Chian School of Medicine · Nanyang Technological University
          </p>
        </div>
      </section>

      {/* Sign-in panel */}
      <section className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-md">
          <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-xl shadow-slate-900/5">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Lock size={22} aria-hidden="true" />
            </div>
            <h2 className="mt-5 text-2xl font-semibold tracking-tight text-slate-900">Sign in</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Use your NTU staff account. Your recordings and voices stay private to you.
            </p>
            <button
              type="button"
              onClick={signIn}
              disabled={working}
              className="mt-7 flex h-12 w-full items-center justify-center gap-3 rounded-lg bg-primary px-5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-primary/90 disabled:opacity-60"
            >
              {working ? <Loader2 size={18} className="animate-spin" /> : <MicrosoftMark />}
              {working ? 'Opening Microsoft…' : 'Sign in with Microsoft'}
            </button>
            <p className="mt-3 text-center text-xs text-slate-500">
              staff.main.ntu.edu.sg and assoc.main.ntu.edu.sg accounts only
            </p>
            {visibleError ? (
              <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{visibleError}</p>
            ) : null}
          </div>

          <details className="group mt-5 rounded-xl border border-slate-200 bg-white">
            <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-sm font-medium text-slate-800">
              <span className="flex items-center gap-2">
                <ShieldCheck size={16} className="text-primary" aria-hidden="true" />
                Your voice and your privacy
              </span>
              <ChevronDown size={16} className="text-slate-400 transition-transform group-open:rotate-180" aria-hidden="true" />
            </summary>
            <dl className="divide-y divide-slate-100 border-t border-slate-100">
              {PRIVACY_POINTS.map(([term, detail]) => (
                <div key={term} className="px-5 py-3">
                  <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">{term}</dt>
                  <dd className="mt-1 text-sm leading-6 text-slate-700">{detail}</dd>
                </div>
              ))}
            </dl>
          </details>
        </div>
      </section>
    </div>
  );
}

function MicrosoftMark() {
  return (
    <span className="grid h-4 w-4 grid-cols-2 gap-[2px]" aria-hidden="true">
      <span className="bg-[#f25022]" />
      <span className="bg-[#7fba00]" />
      <span className="bg-[#00a4ef]" />
      <span className="bg-[#ffb900]" />
    </span>
  );
}

// The full disclaimer. Changing any wording here or in CONSENT_ITEMS must bump
// CONSENT_VERSION in consent.js so everyone is asked again.
const DISCLAIMER_SECTIONS = [
  ['1. What this service does',
    'Voice Cloning lets LKCMedicine faculty train a synthetic voice model from recordings of their own speech. '
    + 'The model can then read text aloud in a voice that sounds like yours, for example to answer student '
    + 'questions in LKCMedicine teaching tools such as lecture chat and the virtual tutor.'],
  ['2. What we collect',
    'The audio files you upload, short reference clips taken from them, the transcripts generated from them, '
    + 'the voice models trained from them, the text you type or speak while testing, and your NTU account email '
    + 'and name so we know which voices belong to you.'],
  ['3. How it is processed',
    'Your audio is cleaned (background noise removed), transcribed automatically, and used to train a voice model '
    + 'on LKCMedicine-controlled GPU servers. Processing is automated; project staff do not listen to your '
    + 'recordings unless you ask for help or it is needed to investigate a problem or misuse.'],
  ['4. Where it is stored',
    'Recordings and models are kept in LKCMedicine-controlled Amazon Web Services storage in Singapore and Seoul. '
    + 'They are never sold, and are not shared with third parties for their own use.'],
  ['5. Who can use your voice',
    'Only you can see, test and select your voices on this site. A voice is used in a teaching tool only after '
    + 'you, or a course administrator acting with your agreement, selects it there. Project administrators can '
    + 'access voices for support, safety and to act on deletion requests.'],
  ['6. Acceptable use',
    'Upload only recordings of your own voice that you have the right to use. Do not upload recordings of other '
    + 'people, and do not use a cloned voice to impersonate anyone, to mislead, or for anything outside teaching '
    + 'at LKCMedicine. Misuse may lead to voices being removed and access withdrawn.'],
  ['7. Limitations of synthetic speech',
    'A cloned voice is an approximation. It can mispronounce words, especially medical terms, change emphasis, or '
    + 'sound unlike you in places. It speaks whatever text it is given, including text you never recorded. Always '
    + 'test a voice before it is used with students.'],
  ['8. How long we keep it',
    'Recordings and voices are kept while the project runs, or until you ask for them to be deleted. Older '
    + 'versions of a voice are kept so you can compare them, unless you ask us to remove them.'],
  ['9. Withdrawing consent and deletion',
    'You can withdraw consent at any time by contacting the LKCMedicine Voice Cloning project team. We will then '
    + 'delete your recordings and voice models and stop using your voice in teaching tools. Audio already '
    + 'played to students cannot be recalled.'],
  ['10. Questions',
    'For questions about this service or your data, or to request deletion, contact the LKCMedicine Voice Cloning '
    + 'project team. This summary does not replace NTU\'s own data protection policies, which also apply.'],
];

const CONSENT_ITEMS = [
  'The recordings I upload are of my own voice, and I have the right to use them.',
  'I agree to LKCMedicine creating a synthetic voice model from these recordings.',
  'I understand my cloned voice may speak text I did not record, and I will only use it for teaching purposes at LKCMedicine.',
  'I understand I can ask for my recordings and voice models to be deleted at any time.',
];

function ConsentDialog({ email, onAccept }) {
  const [checked, setChecked] = useState(() => CONSENT_ITEMS.map(() => false));
  const [readToEnd, setReadToEnd] = useState(false);
  const scrollRef = useRef(null);
  const auth = useAuth();
  const allChecked = checked.every(Boolean);

  // Conventional "scroll to the end before agreeing": the checkboxes unlock once
  // the bottom of the terms has been reached (or immediately on a tall screen
  // where everything already fits).
  const checkScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 24) setReadToEnd(true);
  }, []);
  useEffect(() => {
    checkScroll();
    window.addEventListener('resize', checkScroll);
    return () => window.removeEventListener('resize', checkScroll);
  }, [checkScroll]);

  // Block page scrolling behind the dialog.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, []);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/60 p-3 backdrop-blur-sm sm:p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="consent-heading"
        className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
      >
        <div className="border-b border-slate-200 px-6 py-5">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">Before you start</p>
          <h1 id="consent-heading" className="mt-1 text-xl font-semibold tracking-tight text-slate-900">
            Voice cloning terms and consent
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Signed in as <span className="font-medium text-slate-900">{email}</span>. Please read to the end, then
            confirm each statement. We ask once per account.
          </p>
        </div>

        <div ref={scrollRef} onScroll={checkScroll} className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="space-y-5">
            {DISCLAIMER_SECTIONS.map(([title, body]) => (
              <section key={title}>
                <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
                <p className="mt-1.5 text-sm leading-6 text-slate-600">{body}</p>
              </section>
            ))}
          </div>

          <fieldset className="mt-8 rounded-xl border border-slate-200 bg-slate-50" disabled={!readToEnd}>
            <legend className="sr-only">Consent statements</legend>
            {CONSENT_ITEMS.map((text, index) => (
              <label
                key={text}
                className={cn(
                  'flex items-start gap-3 border-b border-slate-200 px-5 py-4 last:border-b-0',
                  readToEnd ? 'cursor-pointer hover:bg-white' : 'cursor-not-allowed opacity-50',
                )}
              >
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 accent-[hsl(var(--primary))]"
                  checked={checked[index]}
                  onChange={(e) => setChecked((current) => current.map((value, i) => (i === index ? e.target.checked : value)))}
                />
                <span className="text-sm leading-6 text-slate-700">{text}</span>
              </label>
            ))}
          </fieldset>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 bg-white px-6 py-4">
          <p className="mr-auto text-xs text-slate-500" aria-live="polite">
            {!readToEnd
              ? 'Scroll to the end of the terms to continue.'
              : allChecked ? 'Thank you — you can continue.' : 'Tick all four statements to continue.'}
          </p>
          <button
            type="button"
            onClick={() => auth.signOut()}
            className="inline-flex h-10 items-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Decline and sign out
          </button>
          <button
            type="button"
            disabled={!readToEnd || !allChecked}
            onClick={() => onAccept(saveConsent(email))}
            className="inline-flex h-10 items-center rounded-lg bg-primary px-5 text-sm font-semibold text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            I agree, continue
          </button>
        </div>
      </div>
    </div>
  );
}

const HELP_SECTIONS = [
  {
    title: '1. Record yourself',
    points: [
      'Aim for 10–30 minutes of you speaking naturally — a recorded lecture works well.',
      'One speaker only: cut out questions from students and other voices.',
      'A quiet room and a headset or lapel mic give the best result. Avoid music, echo and fans.',
      'Speak at your usual teaching pace. Natural pauses are fine.',
    ],
  },
  {
    title: '2. Upload and train',
    points: [
      'Drag your files into the upload box. WAV or FLAC is best; MP3, M4A and OGG also work.',
      'Several shorter files are fine — they are combined.',
      'Press Start training. It takes roughly 30–60 minutes. You can close the page; we email you when it is done.',
      'Only one voice can train at a time. If someone else is training, the page shows it and the button opens when they finish.',
    ],
  },
  {
    title: '3. Test your voice',
    points: [
      'Open the Test your voice tab (or the link in your email).',
      'Pick your voice, press the microphone and ask a question — the answer is spoken in your voice.',
      'Each training run creates a new version (e.g. name_2). Older versions are kept so you can compare.',
      'If replies are slow, the GPU may be starting or busy. The page tells you and retries automatically.',
    ],
  },
];

function HelpGuide({ open, onClose }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[90] flex justify-end bg-slate-900/40" onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-heading"
        className="h-full w-full max-w-md overflow-y-auto border-l border-slate-200 bg-white"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-slate-200 bg-white px-5 py-4">
          <h2 id="help-heading" className="text-base font-semibold text-slate-900">How to use Voice Cloning</h2>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900" aria-label="Close guide">
            <X size={18} />
          </button>
        </div>
        <div className="space-y-6 px-5 py-5">
          {HELP_SECTIONS.map((section) => (
            <section key={section.title}>
              <h3 className="text-sm font-semibold text-slate-900">{section.title}</h3>
              <ul className="mt-2 space-y-2">
                {section.points.map((point) => (
                  <li key={point} className="flex gap-2 text-sm leading-6 text-slate-600">
                    <span className="mt-2.5 h-1 w-1 shrink-0 bg-primary" aria-hidden="true" />
                    {point}
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <section className="border-t border-slate-200 pt-5 text-xs leading-5 text-slate-500">
            Your recordings and voices are private to your NTU account. Questions or deletion requests: contact the
            LKCMedicine Voice Cloning project team.
          </section>
        </div>
      </aside>
    </div>
  );
}

// Polls whether someone is training, so the test tab can warn that replies may
// be slower while the shared GPU is busy.
function useTrainingBusy(enabled) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    async function poll() {
      try {
        const res = await getCurrentTraining();
        const status = String(res.data?.status || '');
        if (active) setBusy(Boolean(res.data?.busy) || ['running', 'waiting'].includes(status));
      } catch {
        if (active) setBusy(false);
      }
    }
    poll();
    const id = window.setInterval(poll, 30000);
    return () => { active = false; window.clearInterval(id); };
  }, [enabled]);
  return busy;
}

function VoiceTestTab() {
  const trainingBusy = useTrainingBusy(TRAINING_SHARES_INFERENCE_GPU);
  return (
    <LivePage
      replyMode="phrases"
      variant="voice-test"
      voiceTestNotice={trainingBusy
        ? 'A voice is being trained on the shared GPU right now, so replies may be slower than usual.'
        : ''}
    />
  );
}

function SignedInShell() {
  const auth = useAuth();
  const location = useLocation();
  const email = auth.user?.email || '';
  const [consent, setConsent] = useState(() => readConsent(email));
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpSeen, setHelpSeen] = useState(() => hasSeenHelp());

  useEffect(() => { setConsent(readConsent(email)); }, [email]);

  const [tourOpen, setTourOpen] = useState(false);

  function startTour() {
    setHelpOpen(false);
    setTourOpen(true);
    if (!helpSeen) {
      markHelpSeen();
      setHelpSeen(true);
    }
  }

  const tabs = [
    { to: '/', label: 'Train a voice', end: true, icon: Mic },
    { to: '/test-voice', label: 'Test your voice', end: true, icon: Headphones },
  ];

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      <PostLoginRedirectHandler />
      <SignInRecorder />
      <header className="sticky top-0 z-50 border-b border-slate-200/80 bg-white/90 backdrop-blur-md">
        <div className="h-1 bg-gradient-to-r from-[#d71440] via-[#d71440] to-primary" aria-hidden="true" />
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-2.5 sm:px-8">
          <BrandMark />
          {consent ? (
            <nav
              data-tour="nav-tabs"
              className="order-3 flex w-full rounded-full bg-slate-100 p-1 sm:order-none sm:w-auto"
              aria-label="Sections"
            >
              {tabs.map(({ to, label, end, icon: Icon }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  className={({ isActive }) => cn(
                    'flex flex-1 items-center justify-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium transition-all sm:flex-none',
                    isActive
                      ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200'
                      : 'text-slate-500 hover:text-slate-900',
                  )}
                >
                  <Icon size={15} aria-hidden="true" />
                  {label}
                </NavLink>
              ))}
            </nav>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            {consent ? <div data-tour="gpu"><GpuInstanceControl /></div> : null}
            {consent && !helpSeen ? (
              <button type="button" onClick={startTour} className="hidden text-xs font-medium text-primary hover:underline xl:inline">
                New here? Take the tour
              </button>
            ) : null}
            {consent ? (
              <button
                type="button"
                data-tour="help"
                onClick={startTour}
                aria-label="Take a tour of this site"
                title="Take a tour of this site"
                className={cn(
                  'relative inline-flex h-9 w-9 items-center justify-center rounded-full border text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900',
                  helpSeen ? 'border-slate-200' : 'border-primary text-primary',
                )}
              >
                {!helpSeen ? <span className="absolute inset-0 animate-ping rounded-full border border-primary/60" aria-hidden="true" /> : null}
                <CircleHelp size={17} />
              </button>
            ) : null}
            <span className="mx-1 hidden h-6 w-px bg-slate-200 sm:block" aria-hidden="true" />
            <div className="flex items-center gap-2" title={email}>
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-xs font-semibold text-white">
                {initials(auth.user?.name || email)}
              </span>
              <span className="hidden max-w-[160px] truncate text-xs font-medium text-slate-600 lg:inline">
                {auth.user?.name || email}
              </span>
            </div>
            <button
              type="button"
              onClick={() => auth.signOut()}
              aria-label="Sign out"
              title="Sign out"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-900"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-6 sm:px-8 sm:py-8">
        {!consent ? (
          <ConsentDialog email={email} onAccept={setConsent} />
        ) : (
          <Routes>
            <Route path="/" element={<TrainingPage consent={consent} />} />
            <Route path="/test-voice" element={<VoiceTestTab />} />
            <Route path="*" element={<Navigate to={`/${location.search}`} replace />} />
          </Routes>
        )}
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-4 text-xs text-slate-500 sm:px-8">
          <span>Lee Kong Chian School of Medicine · Nanyang Technological University</span>
          <span>Your voices are private to your NTU account.</span>
        </div>
      </footer>
      <HelpGuide open={helpOpen} onClose={() => setHelpOpen(false)} />
      <GuidedTour open={tourOpen} onClose={() => setTourOpen(false)} onOpenGuide={() => setHelpOpen(true)} />
    </div>
  );
}

export default function TrainingApp() {
  // Local development without SSO still renders the signed-in layout.
  if (!config.authEnabled) {
    return <TooltipProvider><div className="vc-root"><UnsignedShell /></div></TooltipProvider>;
  }
  return (
    <TooltipProvider>
      <div className="vc-root">
        <Routes>
          <Route path="/login" element={<TrainingLogin />} />
          <Route path="*" element={<ProtectedRoute><SignedInShell /></ProtectedRoute>} />
        </Routes>
      </div>
    </TooltipProvider>
  );
}

function UnsignedShell() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-8">
      <p className="mb-4 text-sm text-amber-800">Sign-in is disabled in this build (local development).</p>
      <Routes>
        <Route path="/" element={<TrainingPage consent={null} />} />
        <Route path="/test-voice" element={<VoiceTestTab />} />
      </Routes>
    </div>
  );
}
