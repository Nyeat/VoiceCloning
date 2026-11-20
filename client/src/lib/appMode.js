const APP_MODES = new Set(['combined', 'training', 'live-fast', 'chatbot', 'gi', 'mc', 'record', 'studio']);

const LIVE_DEMO_LOCKOUT_EXEMPT_HOSTS = new Set([
  'd3k2rz0hqm8nxi.cloudfront.net',
  'faculty.lkcmedicine.org',
]);

export function shouldApplyLiveDemoLockout(enabled, hostname = '') {
  const normalizedHostname = String(hostname || '').trim().toLowerCase().replace(/\.$/u, '');
  return enabled === true && !LIVE_DEMO_LOCKOUT_EXEMPT_HOSTS.has(normalizedHostname);
}

export function normalizeAppMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'livefast' || normalized === 'live') return 'live-fast';
  if (normalized === 'train') return 'training';
  if (normalized === 'dean' || normalized === 'kiosk') return 'chatbot';
  if (normalized === 'gi-bleeding' || normalized === 'gibleeding') return 'gi';
  return APP_MODES.has(normalized) ? normalized : 'combined';
}

export function getAppModeConfig(value) {
  const mode = normalizeAppMode(value);
  const gi = mode === 'gi';
  const kiosk = mode === 'chatbot' || gi || mode === 'mc';
  const showTraining = mode === 'combined' || mode === 'training';
  const showLiveFast = mode === 'combined' || mode === 'live-fast' || mode === 'chatbot';
  const showTextToSpeech = mode === 'combined' || mode === 'live-fast';
  const navItems = [];

  if (!kiosk) {
    if (showTraining) {
      navItems.push({ label: 'Training', to: '/', end: true });
    }

    if (showLiveFast) {
      navItems.push({ label: 'Live Fast', to: showTraining ? '/live-fast' : '/', end: !showTraining });
    }

    if (showTextToSpeech) {
      navItems.push({ label: 'Text to Speech', to: showTraining ? '/text-to-speech' : '/?tab=text-to-speech', end: true });
    }
  }

  return {
    mode,
    kiosk,
    gi,
    defaultLiveEngine: 'fast',
    showTraining,
    showLiveFast,
    showTextToSpeech,
    showGiChat: gi,
    // Only the text-chat kiosk build edits and deploys the assistant instructions.
    // The GI build reads whatever was deployed but shows no editor, so students
    // signing in there cannot see or rewrite the prompt.
    showInstructionsEditor: kiosk && !gi,
    navItems,
    defaultPath: '/',
    subtitle: gi
      ? 'GI Bleeding Chatbot'
      : showTraining && showLiveFast
        ? 'GPT-SoVITS Training & Live Fast'
        : showTraining
          ? 'GPT-SoVITS Training'
          : 'Live Fast Chatbot',
  };
}

const viteEnv = import.meta.env || {};

export const APP_MODE_CONFIG = getAppModeConfig(viteEnv.VITE_APP_MODE);
