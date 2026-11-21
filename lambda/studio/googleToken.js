// Verifies a Google Identity Services ID token ("Sign in with Google") for
// Voice Studio. Nothing in the payload is trusted until the RS256 signature
// verifies against Google's published keys; then issuer, audience (our OAuth
// client ID), expiry and email_verified are checked. No JWT library, same as
// shared/entraToken.js.
import { createPublicKey, createVerify } from 'node:crypto';

const JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;
const JWKS_REFETCH_COOLDOWN_MS = 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;

export class GoogleTokenError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GoogleTokenError';
    this.code = code;
  }
}

function decode(segment) {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new GoogleTokenError('malformed', 'Google sign-in token is not valid.');
  }
}

export function createGoogleVerifier({ clientId, fetchImpl = fetch, now = () => Date.now() }) {
  let keys = new Map();
  let fetchedAt = 0;
  let inFlight = null;

  async function fetchKeys() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const response = await fetchImpl(JWKS_URI);
      if (!response.ok) throw new GoogleTokenError('jwks_unavailable', `Google keys fetch failed: HTTP ${response.status}`);
      const body = await response.json();
      const next = new Map((body?.keys || []).filter((key) => key.kid && key.kty === 'RSA').map((key) => [key.kid, key]));
      if (next.size === 0) throw new GoogleTokenError('jwks_unavailable', 'Google published no signing keys.');
      keys = next;
      fetchedAt = now();
      return keys;
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  async function keyFor(kid) {
    if (keys.size === 0 || now() - fetchedAt > JWKS_CACHE_TTL_MS) await fetchKeys();
    if (!keys.has(kid) && now() - fetchedAt > JWKS_REFETCH_COOLDOWN_MS) await fetchKeys();
    const key = keys.get(kid);
    if (!key) throw new GoogleTokenError('unknown_key', 'Google sign-in token is not valid.');
    return key;
  }

  /** @returns {Promise<{ email: string, name: string }>} */
  async function verify(rawToken) {
    if (!clientId) throw new GoogleTokenError('misconfigured', 'Google sign-in is not configured.');
    const segments = typeof rawToken === 'string' ? rawToken.split('.') : [];
    if (segments.length !== 3) throw new GoogleTokenError('malformed', 'Google sign-in token is not valid.');
    const [headerPart, payloadPart, signaturePart] = segments;
    const header = decode(headerPart);
    if (header.alg !== 'RS256' || !header.kid) throw new GoogleTokenError('bad_algorithm', 'Google sign-in token is not valid.');
    const publicKey = createPublicKey({ key: await keyFor(header.kid), format: 'jwk' });
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${headerPart}.${payloadPart}`);
    verifier.end();
    if (!verifier.verify(publicKey, Buffer.from(signaturePart, 'base64url'))) {
      throw new GoogleTokenError('bad_signature', 'Google sign-in token is not valid.');
    }
    const payload = decode(payloadPart);
    const nowSeconds = Math.floor(now() / 1000);
    if (!ISSUERS.has(payload.iss)) throw new GoogleTokenError('bad_issuer', 'Google sign-in token is not valid.');
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(clientId)) throw new GoogleTokenError('bad_audience', 'Google sign-in token is not for this site.');
    if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_SECONDS < nowSeconds) {
      throw new GoogleTokenError('expired', 'Google sign-in expired. Please try again.');
    }
    if (payload.email_verified !== true || typeof payload.email !== 'string' || !payload.email.includes('@')) {
      throw new GoogleTokenError('unverified', 'Your Google account has no verified email address.');
    }
    return { email: payload.email.trim().toLowerCase(), name: String(payload.name || '').trim() };
  }

  return { verify };
}
