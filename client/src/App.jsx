import React, { useEffect, useState } from 'react';
import { Navigate, Routes, Route, NavLink, useLocation } from 'react-router-dom';
import { Loader2, Power } from 'lucide-react';

function AnimatedBackground() {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden="true">
      {/* Blue orb — top-left */}
      <div className="absolute -left-40 -top-40 h-[560px] w-[560px] animate-orb-float-1 rounded-full bg-blue-400/30 blur-[110px]" />
      {/* Violet orb — top-right */}
      <div className="absolute -right-32 -top-24 h-[460px] w-[460px] animate-orb-float-2 rounded-full bg-violet-400/25 blur-[110px]" />
      {/* Cyan orb — bottom-centre */}
      <div className="absolute -bottom-32 left-1/2 h-[420px] w-[420px] -translate-x-1/2 animate-orb-float-3 rounded-full bg-sky-300/20 blur-[100px]" />
    </div>
  );
}
import { TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { APP_MODE_CONFIG, shouldApplyLiveDemoLockout } from '@/lib/appMode';
import { GpuStatusProvider, useGpuStatus } from '@/lib/gpuStatus.jsx';
import { describeGpuStatus } from '@/lib/gpuStatusModel';
import GpuInstanceControl from '@/components/GpuInstanceControl.jsx';
import TrainingApp from './training/TrainingApp.jsx';
import { fetchLiveDemoLockout } from '@/lib/runtimeConfig';

// Live-fast (doovx…) and the Dean demo have no training UI — those are the builds
// that should auto-start the GPU and show the "starting" overlay on entry.
// VITE_GPU_AUTO_START=false (dev) makes every build manual-start only: the badge
// says "GPU stopped · Start" and nothing starts the GPU on page activity.
const GPU_AUTO_START = !APP_MODE_CONFIG.showTraining
  && import.meta.env.VITE_GPU_AUTO_START !== 'false';
import TrainingPage from './pages/TrainingPage.jsx';
import LivePage from './pages/LivePage.jsx';
import GiChatPage from './pages/GiChatPage.jsx';
import GiApp from './GiApp.jsx';
import { LoginPage } from './pages/LoginPage.jsx';
import {
  PostLoginRedirectHandler,
  ProtectedRoute,
  SignInRecorder,
} from '@/auth/AppAuthGate';
import { useAuth } from '@/auth/useAuth';
import { config } from '@/config';

function LiveFastEntry() {
  const location = useLocation();
  const tab = new URLSearchParams(location.search).get('tab');
  return <LivePage replyMode="phrases" mode={tab === 'text-to-speech' ? 'tts' : 'chat'} />;
}

function GpuStartingOverlay() {
  const { status, checking, starting, workerReady, autoStart, start } = useGpuStatus();

  // Only block the page for the auto-start builds, and only until the worker is
  // actually ready. Local dev (no instance configured) is never blocked.
  const configured = status?.configured;
  if (workerReady) return null;
  if (!checking && !configured) return null;
  // Nothing on this page will start it, so a "Starting the GPU" screen would be
  // a lie; the header badge says "GPU stopped" instead.
  if (!autoStart) return null;

  const view = describeGpuStatus({ status, checking, starting, autoStart });
  const heading = {
    checking: 'Checking the GPU',
    starting: 'Starting the GPU',
    warming: 'Warming up the GPU',
    stopping: 'Stopping the GPU',
    unavailable: 'Waiting for the GPU',
  }[view.phase] || 'Getting the GPU ready';
  const detail = view.phase === 'stopping'
    ? 'The shared GPU is shutting down after being idle. It restarts automatically once it has stopped.'
    : view.detail;
  const canManualStart = view.phase === 'unavailable' && status?.startable && !starting;

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-slate-950/70 px-6 backdrop-blur-md">
      <div className="w-full max-w-sm rounded-xl border border-white/10 bg-white p-8 text-center shadow-2xl" role="status" aria-live="polite">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
          {view.phase === 'unavailable'
            ? <Power size={26} className="text-primary" />
            : <Loader2 size={26} className="animate-spin text-primary" />}
        </div>
        <h1 className="text-lg font-semibold text-slate-900">{heading}</h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-600">{detail}</p>
        {canManualStart && (
          <button
            type="button"
            onClick={start}
            className="mt-5 inline-flex h-9 items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-4 text-sm font-medium text-primary transition-colors hover:bg-primary/15"
          >
            <Power size={14} />
            Retry starting GPU
          </button>
        )}
      </div>
    </div>
  );
}

function useLiveDemoLockout() {
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    let active = true;
    async function check() {
      const value = await fetchLiveDemoLockout();
      if (active) setLocked(shouldApplyLiveDemoLockout(value, window.location.hostname));
    }
    check();
    const id = window.setInterval(check, 15000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, []);

  return locked;
}

function LiveDemoLockoutScreen() {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/80 backdrop-blur-md px-6">
      <div className="max-w-md rounded-2xl border border-white/10 bg-white/95 p-8 text-center shadow-2xl">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-amber-100">
          <Power size={26} className="text-amber-600" />
        </div>
        <h1 className="text-lg font-semibold text-slate-900">Dean demo currently live</h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-600">
          Inference and training are paused here while the live demo is running on the
          shared GPU. This page will resume automatically once the demo ends.
        </p>
      </div>
    </div>
  );
}

export default function App() {
  // The gi build is a full app (search → lesson → chat) with its own chrome and
  // auth gate, so it replaces AppShell entirely. The GPU still auto-starts in
  // the background, but the blocking overlay is deliberately not rendered —
  // browsing lessons and the transcript must not wait on the voice engine.
  // The Dean-demo lockout lives inside AppShell, so gi deliberately bypasses it
  // too: a lesson page must stay readable while the shared GPU is busy.
  if (config.authEnabled) return <AuthenticatedApp />;

  return <AppWithGpu autoStart={GPU_AUTO_START} />;
}

function AppWithGpu({ autoStart }) {
  // The training site checks the training worker's health, not the inference
  // fleet's, and never starts the GPU by itself (the badge offers Start).
  if (APP_MODE_CONFIG.mode === 'training') {
    return (
      <GpuStatusProvider autoStart={false} target="training">
        <TrainingApp />
      </GpuStatusProvider>
    );
  }
  return (
    <GpuStatusProvider autoStart={autoStart}>
      {APP_MODE_CONFIG.gi ? <GiApp /> : <AppShell />}
    </GpuStatusProvider>
  );
}

function AuthenticatedApp() {
  const auth = useAuth();
  return <AppWithGpu autoStart={GPU_AUTO_START && auth.isAuthenticated} />;
}

function AppShell() {
  const appConfig = APP_MODE_CONFIG;
  const location = useLocation();
  const locked = useLiveDemoLockout();
  const isLoginRoute = location.pathname === '/login';

  if (locked) {
    return (
      <TooltipProvider>
        <div className="min-h-screen">
          <AnimatedBackground />
          <LiveDemoLockoutScreen />
        </div>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <div className="flex min-h-screen flex-col">
        <PostLoginRedirectHandler />
        <SignInRecorder />
        <AnimatedBackground />
        {GPU_AUTO_START && !isLoginRoute && <GpuStartingOverlay />}
        {/* Minimal header — the sign-in screen is full-bleed, so it has no chrome */}
        {!appConfig.showGiChat && !isLoginRoute && (
        <header className="sticky top-0 z-50 bg-white/90 backdrop-blur-md">
          <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-8">
            <nav className="flex items-center gap-1">
              {appConfig.navItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    cn(
                      'rounded-lg px-3 py-1.5 text-sm font-medium transition-all',
                      isActive
                        ? 'bg-primary/10 text-primary font-semibold'
                        : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'
                    )
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
            <GpuInstanceControl />
          </div>
          {/* thin gradient accent line */}
          <div className="h-px bg-gradient-to-r from-primary/30 via-violet-400/20 to-transparent" />
        </header>
        )}

        {/* Main content */}
        <main className={cn(
          'flex w-full flex-1 flex-col',
          appConfig.showGiChat ? 'min-h-0' : 'mx-auto max-w-6xl px-4 py-4 sm:px-8 sm:py-8'
        )}>
          <Routes>
            <Route
              path="/login"
              element={
                config.authEnabled
                  ? (
                    <LoginPage
                      variant="faculty"
                      title="Faculty Voice Assistant"
                      description="Speak with the assistant your students hear, then write and deploy the instructions it answers them with."
                      accountHint="Use your NTU staff account to continue."
                      privacyNotice="Your use of the voice assistant is saved against your NTU staff account in the lecturers database and kept for 90 days."
                    />
                  )
                  : <Navigate to="/" replace />
              }
            />
            <Route
              path="/"
              element={
                <ProtectedRoute>
                  {appConfig.showGiChat
                    ? <GiChatPage />
                    : appConfig.showTraining
                      ? <TrainingPage />
                      : appConfig.showLiveFast
                        ? <LiveFastEntry />
                        : <Navigate to={appConfig.defaultPath} replace />}
                </ProtectedRoute>
              }
            />
            <Route
              path="/live-fast"
              element={
                appConfig.showLiveFast
                  ? <ProtectedRoute><LivePage replyMode="phrases" /></ProtectedRoute>
                  : <Navigate to={appConfig.defaultPath} replace />
              }
            />
            <Route
              path="/text-to-speech"
              element={
                appConfig.showTextToSpeech
                  ? <ProtectedRoute><LivePage replyMode="phrases" mode="tts" /></ProtectedRoute>
                  : <Navigate to={appConfig.defaultPath} replace />
              }
            />
            <Route path="/inference" element={<Navigate to={appConfig.defaultPath} replace />} />
            <Route path="/live" element={<Navigate to={appConfig.defaultPath} replace />} />
            <Route path="*" element={<Navigate to={appConfig.defaultPath} replace />} />
          </Routes>
        </main>

        {/* Footer */}
        {!appConfig.showGiChat && (
        <footer className="mx-auto w-full max-w-6xl border-t border-slate-100 px-4 sm:px-8">
          <div className="flex items-center py-5">
            <span className="text-xs text-slate-400">Voice Cloning Studio</span>
          </div>
        </footer>
        )}
      </div>
    </TooltipProvider>
  );
}
