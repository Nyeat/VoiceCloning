// MSAL's acquireTokenSilent can hand back a cached ID token that has already
// expired (ID tokens last ~1 h and are not refreshed on their own), and the
// backends then answer "Sign in to …" at random-looking moments. Callers check
// this and force a refresh before sending the token.
const DEFAULT_MARGIN_MS = 5 * 60_000;

export function jwtExpiresAtMs(token = '') {
  try {
    const payload = String(token).split('.')[1];
    if (!payload) return 0;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const json = typeof atob === 'function'
      ? atob(padded)
      : Buffer.from(padded, 'base64').toString('binary');
    const exp = Number(JSON.parse(json).exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

// True for a token that is missing, unreadable, expired, or about to expire.
export function tokenNeedsRefresh(token, now = Date.now(), marginMs = DEFAULT_MARGIN_MS) {
  const expiresAt = jwtExpiresAtMs(token);
  return !expiresAt || expiresAt - now <= marginMs;
}
