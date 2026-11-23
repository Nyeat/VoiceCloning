// Voice Studio email + password sessions (no Microsoft account needed).
//
// The studio Lambda signs a short token with an Ed25519 PRIVATE key that lives
// only in the Lambda's live environment (STUDIO_SESSION_PRIVATE_KEY). Every
// other verifier — other Lambda routes and the live chat gateway — needs only
// the PUBLIC key (STUDIO_SESSION_PUBLIC_KEY), which is safe to keep in git.
//
// Token: "vst1.<base64url payload>.<base64url signature>".
// Kept byte-identical with live-gateway/src/services/studioSession.js
// (studioSessionParity.test.js).
import { createPrivateKey, createPublicKey, sign, verify } from 'crypto';

export const STUDIO_TOKEN_PREFIX = 'vst1.';
export const STUDIO_SESSION_DAYS = 14;

export class StudioSessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TokenError';
    this.code = code;
  }
}

export function isStudioSessionToken(token) {
  return typeof token === 'string' && token.startsWith(STUDIO_TOKEN_PREFIX);
}

function keyFromBase64(value, kind) {
  const der = Buffer.from(String(value || '').trim(), 'base64');
  if (der.length === 0) return null;
  return kind === 'private'
    ? createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
    : createPublicKey({ key: der, format: 'der', type: 'spki' });
}

/** Public key from the environment (or derived from the private key on the signer). */
export function studioPublicKey(env = process.env) {
  if (env.STUDIO_SESSION_PUBLIC_KEY) return keyFromBase64(env.STUDIO_SESSION_PUBLIC_KEY, 'public');
  const privateKey = env.STUDIO_SESSION_PRIVATE_KEY ? keyFromBase64(env.STUDIO_SESSION_PRIVATE_KEY, 'private') : null;
  return privateKey ? createPublicKey(privateKey) : null;
}

// via: 'google' when Google verified the address (Voice Studio's only sign-in now).
export function signStudioSession({ email, name = '', via = '' }, { env = process.env, now = Date.now(), days = STUDIO_SESSION_DAYS } = {}) {
  const privateKey = keyFromBase64(env.STUDIO_SESSION_PRIVATE_KEY, 'private');
  if (!privateKey) throw new StudioSessionError('misconfigured', 'Email sign-in is not configured on the server.');
  const iat = Math.floor(now / 1000);
  const payload = Buffer.from(JSON.stringify({
    sub: String(email).trim().toLowerCase(), name: String(name || '').slice(0, 80), iat, exp: iat + days * 86400, typ: 'studio-password', ...(via === 'google' ? { via } : {}),
  })).toString('base64url');
  const signature = sign(null, Buffer.from(payload), privateKey).toString('base64url');
  return `${STUDIO_TOKEN_PREFIX}${payload}.${signature}`;
}

/**
 * @returns {{ oid: string, email: string, name: string, passwordAccount: boolean, via?: 'google' }}
 * @throws {StudioSessionError}
 */
export function verifyStudioSession(token, { env = process.env, now = Date.now() } = {}) {
  if (!isStudioSessionToken(token)) throw new StudioSessionError('missing', 'Sign in to continue.');
  const publicKey = studioPublicKey(env);
  if (!publicKey) throw new StudioSessionError('misconfigured', 'Email sign-in is not configured.');
  const [payloadPart, signaturePart, extra] = token.slice(STUDIO_TOKEN_PREFIX.length).split('.');
  if (!payloadPart || !signaturePart || extra !== undefined) throw new StudioSessionError('malformed', 'Your sign-in is not valid. Please sign in again.');
  let valid = false;
  try {
    valid = verify(null, Buffer.from(payloadPart), publicKey, Buffer.from(signaturePart, 'base64url'));
  } catch {
    valid = false;
  }
  if (!valid) throw new StudioSessionError('bad_signature', 'Your sign-in is not valid. Please sign in again.');
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf-8'));
  } catch {
    throw new StudioSessionError('malformed', 'Your sign-in is not valid. Please sign in again.');
  }
  if (payload?.typ !== 'studio-password' || typeof payload.sub !== 'string' || !payload.sub.includes('@')) {
    throw new StudioSessionError('malformed', 'Your sign-in is not valid. Please sign in again.');
  }
  if (!Number.isFinite(payload.exp) || payload.exp * 1000 <= now) throw new StudioSessionError('expired', 'Your sign-in has expired. Please sign in again.');
  // Google-verified sessions are verified addresses; older password sessions are not.
  const google = payload.via === 'google';
  return { oid: `studio-pw:${payload.sub}`, email: payload.sub, name: payload.name || payload.sub, passwordAccount: !google, ...(google ? { via: 'google' } : {}) };
}
