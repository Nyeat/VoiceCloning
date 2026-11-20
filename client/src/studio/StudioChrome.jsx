// Shared pieces of the two Voice Studio sites: brand header, Microsoft sign-in
// screen and small UI atoms. Both sites sign in with NTU Microsoft accounts.
import React, { useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Loader2, LogOut } from 'lucide-react';
import ntuLogo from '@/assets/ntu-logo.png';
import { useAuth } from '@/auth/useAuth';
import { cn } from '@/lib/utils';

export function Brand({ product, tone = 'light' }) {
  return (
    <div className="flex items-center gap-3">
      <img src={ntuLogo} alt="Nanyang Technological University" className="h-8 w-auto" />
      <span className={cn('h-7 w-px', tone === 'dark' ? 'bg-white/30' : 'bg-slate-300')} aria-hidden="true" />
      <div className="leading-tight">
        <p className={cn('text-[11px] font-semibold uppercase tracking-[0.16em]', tone === 'dark' ? 'text-white/70' : 'text-slate-500')}>LKCMedicine</p>
        <p className={cn('text-sm font-semibold', tone === 'dark' ? 'text-white' : 'text-slate-900')}>{product}</p>
      </div>
    </div>
  );
}

export function Header({ product, badge, children }) {
  const auth = useAuth();
  const email = auth.user?.email || '';
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <Brand product={product} />
          {badge}
        </div>
        <div className="flex items-center gap-2">
          {children}
          {email && <span className="hidden text-xs text-slate-500 md:inline">{email}</span>}
          <button
            type="button"
            onClick={() => auth.signOut()}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            <LogOut size={14} aria-hidden="true" /> Sign out
          </button>
        </div>
      </div>
    </header>
  );
}

export function SignInScreen({ product, headline, lines, accent = 'from-[#0f1b3d] via-[#16285a] to-[#3a1230]' }) {
  const auth = useAuth();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (auth.isAuthenticated) return <Navigate to="/" replace />;

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

  return (
    <div className="grid min-h-screen bg-white lg:grid-cols-[minmax(0,1.4fr)_minmax(420px,1fr)]">
      <section className={cn('relative hidden overflow-hidden bg-gradient-to-br lg:block', accent)}>
        <div className="absolute -right-32 -top-32 h-[28rem] w-[28rem] rounded-full bg-[#d71440]/25 blur-3xl" aria-hidden="true" />
        <div className="absolute -bottom-40 -left-24 h-[30rem] w-[30rem] rounded-full bg-indigo-400/20 blur-3xl" aria-hidden="true" />
        <div className="relative flex h-full max-w-lg flex-col justify-end p-14 text-white">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">Lee Kong Chian School of Medicine</p>
          <h1 className="mt-3 text-4xl font-semibold leading-tight tracking-tight">{headline}</h1>
          <ol className="mt-8 space-y-2.5">
            {lines.map(([title, detail], index) => (
              <li key={title} className="flex gap-3 rounded-xl border border-white/15 bg-[#0b1430]/45 p-3.5 backdrop-blur-md">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/15 text-xs font-semibold">{index + 1}</span>
                <div>
                  <p className="text-sm font-semibold">{title}</p>
                  <p className="mt-0.5 text-xs leading-5 text-white/75">{detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>
      <section className="flex flex-col justify-center px-6 py-12 sm:px-12">
        <div className="mx-auto w-full max-w-sm">
          <Brand product={product} />
          <h2 className="mt-10 text-2xl font-semibold tracking-tight text-slate-900">Sign in</h2>
          <p className="mt-2 text-sm text-slate-600">Use your NTU staff or associate Microsoft account.</p>
          <button
            type="button"
            onClick={signIn}
            disabled={busy || auth.isLoading}
            className="mt-6 inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-slate-900 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {(busy || auth.isLoading) && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
            Sign in with Microsoft
          </button>
          {(error || auth.error) && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error || auth.error}</p>}
          <p className="mt-6 text-xs leading-5 text-slate-500">
            Your recordings are used only to build a private copy of your voice for LKCMedicine teaching tools. You can ask for them to be deleted at any time.
          </p>
        </div>
      </section>
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
  approved: ['Approved · needs slot', 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'],
  scheduled: ['Ready · slot booked', 'bg-emerald-600 text-white'],
  failed: ['Failed', 'bg-rose-50 text-rose-700 ring-1 ring-rose-200'],
  cancelled: ['Withdrawn', 'bg-slate-100 text-slate-500'],
};

export function StatusPill({ status }) {
  const [label, style] = STATUS_STYLES[status] || [status, 'bg-slate-100 text-slate-600'];
  return <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold', style)}>{label}</span>;
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
  const sizes = { sm: 'h-8 px-3 text-xs', md: 'h-10 px-4 text-sm', lg: 'h-12 px-6 text-base' };
  return (
    <button
      type="button"
      className={cn('inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition disabled:cursor-not-allowed disabled:opacity-50', variants[variant], sizes[size], className)}
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
