// Shared pieces of the two Voice Studio sites: brand header, sign-in screen
// (Google, Microsoft, email + password) and small UI atoms.
import React, { useEffect, useRef, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { HelpCircle, Loader2, LogOut, X } from 'lucide-react';
import ntuLogo from '@/assets/ntu-logo.png';
import campusPhoto from '@/assets/lkc-campus.jpg';
import { useAuth } from '@/auth/useAuth';
import { cn } from '@/lib/utils';

export function Brand({ product, tone = 'light' }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
      <img src={ntuLogo} alt="Nanyang Technological University" className="h-7 w-auto shrink-0 sm:h-8" />
      <span className={cn('h-7 w-px shrink-0', tone === 'dark' ? 'bg-white/30' : 'bg-slate-300')} aria-hidden="true" />
      <div className="min-w-0 leading-tight">
        <p className={cn('text-[11px] font-semibold uppercase tracking-[0.16em]', tone === 'dark' ? 'text-white/70' : 'text-slate-500')}>LKCMedicine</p>
        <p className={cn('truncate text-sm font-semibold', tone === 'dark' ? 'text-white' : 'text-slate-900')}>{product}</p>
      </div>
    </div>
  );
}

export function Header({ product, badge, children }) {
  const auth = useAuth();
  const email = auth.user?.email || '';
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-2.5 sm:px-6 sm:py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Brand product={product} />
          {badge}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          {children}
          <a href="/faq" target="_blank" rel="noreferrer" aria-label="FAQ" className="inline-flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-medium text-slate-600 hover:bg-slate-50 sm:h-9"><HelpCircle size={16} aria-hidden="true" /> <span className="hidden sm:inline">FAQ</span></a>
          {email && <span className="hidden max-w-[16rem] truncate text-xs text-slate-500 md:inline" title={email}>{email}</span>}
          <button
            type="button"
            onClick={() => auth.signOut()}
            aria-label="Sign out"
            title={email ? `Signed in as ${email}` : undefined}
            className="inline-flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-2.5 text-xs font-medium text-slate-600 hover:bg-slate-50 sm:h-9 sm:px-3"
          >
            <LogOut size={15} aria-hidden="true" /> <span className="hidden sm:inline">Sign out</span>
          </button>
        </div>
      </div>
    </header>
  );
}

// FAQ call-out on the sign-in page: one round button with a slow halo.
const HALO_CSS = `
@keyframes vs-halo {
  0% { transform: scale(1); opacity: 0.55; }
  100% { transform: scale(1.9); opacity: 0; }
}
.vs-halo::before, .vs-halo::after {
  content: ''; position: absolute; inset: 0; border-radius: 9999px;
  background: hsl(var(--primary)); animation: vs-halo 2.4s ease-out infinite; z-index: -1;
}
.vs-halo::after { animation-delay: 1.2s; }
@media (prefers-reduced-motion: reduce) { .vs-halo::before, .vs-halo::after { animation: none; opacity: 0.25; transform: scale(1.25); } }
`;

function FaqDialog({ onClose, children }) {
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="vs-root fixed inset-0 z-50 flex items-end justify-center bg-slate-950/60 backdrop-blur-sm sm:items-center sm:p-6" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="faq-title" className="flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:max-h-full sm:rounded-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 sm:px-5 sm:py-4">
          <h2 id="faq-title" className="min-w-0 text-lg font-semibold text-slate-900">Questions &amp; answers</h2>
          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <a href="/faq" target="_blank" rel="noreferrer" className="text-xs font-semibold text-primary hover:underline">Open as a page</a>
            <button type="button" onClick={onClose} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100" aria-label="Close"><X size={18} /></button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">{children}</div>
      </div>
    </div>
  );
}

const providerButton = 'inline-flex h-11 w-full items-center justify-center gap-3 rounded-full border border-slate-300 bg-white text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-60';

function MicrosoftLogo() {
  return (
    <svg width="16" height="16" viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" /><rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" /><rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

function MicrosoftSignIn({ from }) {
  const auth = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function signIn() {
    setBusy(true);
    setError('');
    try {
      await auth.signIn(from);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : 'Microsoft sign-in could not be started.');
    }
  }
  return (
    <div>
      <button type="button" onClick={signIn} disabled={busy || auth.isLoading} className={providerButton}>
        {busy || auth.isLoading ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <MicrosoftLogo />}
        Continue with Microsoft
      </button>
      {(error || auth.error) && <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error || auth.error}</p>}
    </div>
  );
}

// "Sign in with Google" through Google Identity Services: Google's own button
// (account chooser) plus One Tap, which offers the Gmail accounts already
// signed in on this browser. Shown only when VITE_GOOGLE_CLIENT_ID is set.
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
let googleScript = null;
function loadGoogleScript() {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (!googleScript) {
    googleScript = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => { googleScript = null; reject(new Error('Google sign-in could not load.')); };
      document.head.appendChild(script);
    });
  }
  return googleScript;
}

function GoogleSignIn({ onSignIn }) {
  const slot = useRef(null);
  const handler = useRef(onSignIn);
  handler.current = onSignIn;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    loadGoogleScript().then(() => {
      if (cancelled || !slot.current) return;
      const id = window.google.accounts.id;
      id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        ux_mode: 'popup',
        itp_support: true,
        callback: async ({ credential }) => {
          setBusy(true);
          setError('');
          try {
            await handler.current(credential);
          } catch (err) {
            setError(err?.response?.data?.error || err?.message || 'Google sign-in failed');
            setBusy(false);
          }
        },
      });
      id.renderButton(slot.current, {
        theme: 'outline', size: 'large', shape: 'pill', text: 'continue_with', logo_alignment: 'center',
        width: Math.min(400, slot.current.offsetWidth || 320),
      });
      id.prompt();
    }).catch((err) => { if (!cancelled) setError(err.message); });
    return () => {
      cancelled = true;
      window.google?.accounts?.id?.cancel();
    };
  }, []);
  return (
    <div>
      <div className="relative flex h-11 justify-center">
        <div ref={slot} className="w-full [&>div]:mx-auto" />
        {busy && <div className="absolute inset-0 flex items-center justify-center rounded-full bg-white/80"><Loader2 size={18} className="animate-spin text-slate-500" aria-hidden="true" /></div>}
      </div>
      {error && <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
    </div>
  );
}

// One form for everyone: an email with no account yet is signed up on the spot.
function PasswordSignIn({ onSignIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const field = 'block h-11 w-full rounded-xl border border-slate-300 px-3.5 text-sm placeholder:text-slate-400 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSignIn('login', { email: email.trim(), password });
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Could not sign in');
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-2.5">
      <input required type="email" aria-label="Email" placeholder="Email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" className={field} />
      <input required type="password" aria-label="Password" placeholder="Password (8+ characters if new)" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" className={field} />
      <button type="submit" disabled={busy} className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-slate-900 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60">
        {busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
        Continue
      </button>
      <p className="text-xs text-slate-500">No account yet? Just enter an email and a password and we create one.</p>
      {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
    </form>
  );
}

function FaqHalo({ onOpen }) {
  return (
    <button type="button" onClick={onOpen} className="group flex w-full items-center gap-4 rounded-2xl p-2 text-left hover:bg-slate-50">
      <span className="vs-halo relative isolate flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary text-white shadow-lg shadow-primary/30">
        <HelpCircle size={22} aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-slate-900">New here? Start with the FAQ</span>
        <span className="block text-xs text-slate-500">What happens to your voice and how long it takes</span>
      </span>
    </button>
  );
}

/**
 * Sign-in page. With onPasswordSignIn it also offers email + password (any
 * address; a new one is signed up on the spot), with onGoogleSignIn "Continue
 * with Google". faq: content for the FAQ call-out.
 */
export function SignInScreen({
  product, headline, lines, accent = 'from-[#0f1b3d] to-[#16285a]', onPasswordSignIn = null, onGoogleSignIn = null, faq = null,
}) {
  const auth = useAuth();
  const location = useLocation();
  const [faqOpen, setFaqOpen] = useState(false);
  if (auth.isAuthenticated) return <Navigate to="/" replace />;
  const from = typeof location.state?.from === 'string' ? location.state.from : '/';
  const google = Boolean(onGoogleSignIn && GOOGLE_CLIENT_ID);

  return (
    <div className="vs-root grid min-h-screen bg-white lg:grid-cols-[minmax(0,1.2fr)_minmax(440px,1fr)]">
      <style>{HALO_CSS}</style>
      <section className={cn('relative hidden overflow-hidden bg-gradient-to-br lg:block', accent)}>
        <img src={campusPhoto} alt="Lee Kong Chian School of Medicine, Novena campus" className="absolute inset-0 h-full w-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-t from-slate-950/90 via-slate-950/45 to-transparent" aria-hidden="true" />
        <div className="relative flex h-full max-w-lg flex-col justify-end p-14 text-white">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/60">Lee Kong Chian School of Medicine</p>
          <h1 className="mt-3 text-4xl font-semibold leading-tight tracking-tight">{headline}</h1>
          <ol className="mt-10 space-y-5">
            {lines.map(([title, detail], index) => (
              <li key={title} className="flex gap-4">
                <span className="mt-0.5 text-sm font-semibold tabular-nums text-white/50">0{index + 1}</span>
                <div>
                  <p className="text-sm font-semibold">{title}</p>
                  <p className="mt-0.5 text-sm leading-6 text-white/70">{detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>
      <section className="flex flex-col justify-center px-5 py-8 sm:px-12 sm:py-10">
        <div className="mx-auto w-full max-w-sm">
          <Brand product={product} />
          <h2 className="mt-8 text-2xl sm:mt-10 font-semibold tracking-tight text-slate-900">Welcome</h2>
          <p className="mt-1 text-sm text-slate-500">Sign in, or create an account in one step.</p>
          <div className="mt-6 space-y-2.5">
            {google && <GoogleSignIn onSignIn={onGoogleSignIn} />}
            <MicrosoftSignIn from={from} />
          </div>
          {onPasswordSignIn && (
            <>
              <div className="my-5 flex items-center gap-3 text-xs text-slate-400" aria-hidden="true">
                <span className="h-px flex-1 bg-slate-200" />or use email<span className="h-px flex-1 bg-slate-200" />
              </div>
              <PasswordSignIn onSignIn={onPasswordSignIn} />
            </>
          )}
          {faq && <div className="mt-8 border-t border-slate-100 pt-5"><FaqHalo onOpen={() => setFaqOpen(true)} /></div>}
          <p className="mt-6 text-xs leading-5 text-slate-500">
            Your recordings are used only to build a private copy of your voice for LKCMedicine teaching tools. You can ask for them to be deleted at any time.
          </p>
        </div>
      </section>
      {faqOpen && <FaqDialog onClose={() => setFaqOpen(false)}>{faq}</FaqDialog>}
    </div>
  );
}

export function Card({ className, children }) {
  return <section className={cn('rounded-2xl border border-slate-200 bg-white shadow-sm', className)}>{children}</section>;
}

const STATUS_STYLES = {
  uploading: ['Not submitted', 'bg-slate-100 text-slate-600'],
  queued: ['Queued', 'bg-amber-50 text-amber-700 ring-1 ring-amber-200'],
  training: ['Training', 'bg-blue-50 text-blue-700 ring-1 ring-blue-200'],
  'quality-check': ['Quality check', 'bg-violet-50 text-violet-700 ring-1 ring-violet-200'],
  review: ['Needs review', 'bg-violet-50 text-violet-700 ring-1 ring-violet-200'],
  approved: ['Approved', 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'],
  scheduled: ['Ready · slot booked', 'bg-emerald-600 text-white'],
  ready: ['Ready to test', 'bg-emerald-600 text-white'],
  failed: ['Failed', 'bg-rose-50 text-rose-700 ring-1 ring-rose-200'],
  cancelled: ['Withdrawn', 'bg-slate-100 text-slate-500'],
};

export function StatusPill({ status }) {
  const [label, style] = STATUS_STYLES[status] || [status, 'bg-slate-100 text-slate-600'];
  return <span className={cn('inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold', style)}>{label}</span>;
}

export function Notice({ tone = 'info', children, className }) {
  const tones = {
    info: 'border-blue-200 bg-blue-50 text-blue-900',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    warn: 'border-amber-200 bg-amber-50 text-amber-900',
    error: 'border-rose-200 bg-rose-50 text-rose-800',
  };
  return <div className={cn('rounded-xl border px-4 py-3 text-sm leading-6', tones[tone], className)}>{children}</div>;
}

export function Button({ variant = 'primary', size = 'md', className, ...props }) {
  const variants = {
    primary: 'bg-primary text-white hover:bg-primary/90',
    dark: 'bg-slate-900 text-white hover:bg-slate-800',
    outline: 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50',
    danger: 'bg-rose-600 text-white hover:bg-rose-700',
    success: 'bg-emerald-600 text-white hover:bg-emerald-700',
    ghost: 'text-slate-600 hover:bg-slate-100',
  };
  // Phones: small buttons a little taller (easier to tap), large ones less wide.
  const sizes = { sm: 'h-9 px-3 text-xs sm:h-8', md: 'h-10 px-4 text-sm', lg: 'h-12 px-4 text-sm sm:px-6 sm:text-base' };
  return (
    <button
      type="button"
      className={cn('inline-flex max-w-full items-center justify-center gap-2 rounded-lg text-center font-semibold leading-tight transition disabled:cursor-not-allowed disabled:opacity-50', variants[variant], sizes[size], className)}
      {...props}
    />
  );
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds || 0));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

export function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  return bytes > 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(0.1, bytes / 1e6).toFixed(1)} MB`;
}
