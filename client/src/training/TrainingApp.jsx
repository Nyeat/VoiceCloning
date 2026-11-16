import React, { useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { CircleHelp, Loader2, LogOut, ShieldCheck, X } from 'lucide-react';
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

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="h-1 bg-[#d71440]" aria-hidden="true" />
      <div className="mx-auto grid max-w-5xl gap-10 px-4 py-10 sm:px-8 lg:grid-cols-[1fr_1.1fr] lg:py-16">
        <section>
          <BrandMark />
          <h1 className="mt-10 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
            Create a digital copy of your teaching voice
          </h1>
          <p className="mt-4 max-w-md text-base leading-7 text-slate-600">
            Upload recordings of yourself speaking, and we train a voice model that can read lecture
            answers aloud in your voice. You can test it here before it is used anywhere else.
          </p>
          <button
            type="button"
            onClick={signIn}
            disabled={busy || auth.isLoading}
            className="mt-8 inline-flex h-11 items-center gap-3 rounded-md bg-primary px-5 text-sm font-semibold text-white transition-colors hover:bg-primary/90 disabled:opacity-60"
          >
            {busy || auth.isLoading ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
            {busy || auth.isLoading ? 'Opening Microsoft…' : 'Sign in with your NTU account'}
          </button>
          <p className="mt-3 text-xs text-slate-500">NTU staff accounts only. Single sign-on via Microsoft.</p>
          {visibleError ? <p className="mt-4 text-sm text-red-700" role="alert">{visibleError}</p> : null}
        </section>

        <section className="border border-slate-200 bg-white" aria-labelledby="privacy-heading">
          <div className="border-b border-slate-200 px-6 py-4">
            <h2 id="privacy-heading" className="text-sm font-semibold text-slate-900">Your voice and your privacy</h2>
            <p className="mt-1 text-xs text-slate-500">Please read this before signing in.</p>
          </div>
          <dl className="divide-y divide-slate-100">
            {PRIVACY_POINTS.map(([term, detail]) => (
              <div key={term} className="grid gap-1 px-6 py-4 sm:grid-cols-[140px_1fr] sm:gap-4">
                <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">{term}</dt>
                <dd className="text-sm leading-6 text-slate-700">{detail}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </div>
  );
}

const CONSENT_ITEMS = [
  'The recordings I upload are of my own voice, and I have the right to use them.',
  'I agree to LKCMedicine creating a synthetic voice model from these recordings.',
  'I understand my cloned voice may speak text I did not record, and I will only use it for teaching purposes at LKCMedicine.',
  'I understand I can ask for my recordings and voice models to be deleted at any time.',
];

function ConsentScreen({ email, onAccept }) {
  const [checked, setChecked] = useState(() => CONSENT_ITEMS.map(() => false));
  const allChecked = checked.every(Boolean);
  const auth = useAuth();

  return (
    <div className="mx-auto w-full max-w-2xl py-6 sm:py-10">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Before you start</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">Consent to voice cloning</h1>
      <p className="mt-3 text-sm leading-6 text-slate-600">
        Signed in as <span className="font-medium text-slate-900">{email}</span>. Please confirm each statement.
        We ask once per account.
      </p>
      <fieldset className="mt-6 border border-slate-200 bg-white">
        <legend className="sr-only">Consent statements</legend>
        {CONSENT_ITEMS.map((text, index) => (
          <label key={text} className="flex cursor-pointer items-start gap-3 border-b border-slate-100 px-5 py-4 last:border-b-0 hover:bg-slate-50">
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
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!allChecked}
          onClick={() => onAccept(saveConsent(email))}
          className="inline-flex h-10 items-center rounded-md bg-primary px-5 text-sm font-semibold text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          I agree, continue
        </button>
        <button
          type="button"
          onClick={() => auth.signOut()}
          className="inline-flex h-10 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Decline and sign out
        </button>
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

  function openHelp() {
    setHelpOpen(true);
    if (!helpSeen) {
      markHelpSeen();
      setHelpSeen(true);
    }
  }

  const tabs = [
    { to: '/', label: 'Train a voice', end: true },
    { to: '/test-voice', label: 'Test your voice', end: true },
  ];

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      <PostLoginRedirectHandler />
      <SignInRecorder />
      <div className="h-1 bg-[#d71440]" aria-hidden="true" />
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-8">
          <BrandMark />
          {consent ? (
            <nav className="order-3 flex w-full gap-1 sm:order-none sm:w-auto" aria-label="Sections">
              {tabs.map((tab) => (
                <NavLink
                  key={tab.to}
                  to={tab.to}
                  end={tab.end}
                  className={({ isActive }) => cn(
                    'border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                    isActive ? 'border-primary text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-900',
                  )}
                >
                  {tab.label}
                </NavLink>
              ))}
            </nav>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            {consent ? <GpuInstanceControl /> : null}
            <button
              type="button"
              onClick={openHelp}
              aria-label="How to use this site"
              title="How to use this site"
              className={cn(
                'relative inline-flex h-8 w-8 items-center justify-center rounded-full border text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900',
                helpSeen ? 'border-slate-200' : 'border-primary text-primary',
              )}
            >
              {!helpSeen ? <span className="absolute inset-0 animate-ping rounded-full border border-primary/60" aria-hidden="true" /> : null}
              <CircleHelp size={16} />
            </button>
            {!helpSeen ? (
              <button type="button" onClick={openHelp} className="hidden text-xs font-medium text-primary xl:inline">
                New here? Start with the guide
              </button>
            ) : null}
            <span className="hidden max-w-[180px] truncate text-xs text-slate-500 lg:inline" title={email}>{email}</span>
            <button
              type="button"
              onClick={() => auth.signOut()}
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-900"
            >
              <LogOut size={14} />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-6 sm:px-8 sm:py-8">
        {!consent ? (
          <ConsentScreen email={email} onAccept={setConsent} />
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
