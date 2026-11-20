// Voice Studio email + password sign-in (for people without a Microsoft
// account). The studio Lambda returns a signed session token; it is kept in
// localStorage and sent exactly where a Microsoft token would be (the
// X-VCS-Entra-Token header and the live chat auth frame). Only the studio
// build ever creates one, and the backends accept it only from the studio site.
const STORAGE_KEY = 'voice-studio-session';
const TOKEN_PREFIX = 'vst1.';

function storage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** The current session, or null when absent, malformed or expired. */
export function readStudioSession(now = Date.now()) {
  try {
    const saved = JSON.parse(storage()?.getItem(STORAGE_KEY) || 'null');
    if (!saved || typeof saved.token !== 'string' || !saved.token.startsWith(TOKEN_PREFIX)) return null;
    if (!(Date.parse(saved.expiresAt) > now + 60_000)) return null;
    return saved;
  } catch {
    return null;
  }
}

export function saveStudioSession({ token, email, name, expiresAt }) {
  const record = { token, email, name: name || email, expiresAt };
  try { storage()?.setItem(STORAGE_KEY, JSON.stringify(record)); } catch { /* private mode: signed in for this page only */ }
  return record;
}

export function clearStudioSession() {
  try { storage()?.removeItem(STORAGE_KEY); } catch { /* nothing stored */ }
}

export function studioSessionToken() {
  return readStudioSession()?.token || '';
}

export function studioSessionUser() {
  const session = readStudioSession();
  return session ? { email: session.email, name: session.name || session.email, tenantId: '', passwordAccount: true } : null;
}
