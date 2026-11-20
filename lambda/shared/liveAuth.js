// Bearer-token check for the synthesis routes.
//
// The live gateway authenticates the conversation; this closes the other door.
// Without it, authenticating the WebSocket still leaves /api/live/tts-sentence
// open to direct calls, so anyone could spend GPU time without signing in.
//
// Off unless LIVE_AUTH_ENABLED is set, so existing deployments are unchanged.
import { createEntraVerifier, TokenError } from './entraToken.js';

let cached = null;
let cachedStudio = null;

function readEnv(env) {
  return {
    enabled: (env.LIVE_AUTH_ENABLED || 'false') === 'true',
    tenantId: env.ENTRA_TENANT_ID || '',
    audience: env.ENTRA_AUDIENCE || '',
    domains: (env.ENTRA_ALLOWED_EMAIL_DOMAINS || '')
      .split(',')
      .map((domain) => domain.trim())
      .filter(Boolean),
    loadTestSecret: env.LIVE_AUTH_LOADTEST_SECRET || '',
    facultyDomains: (env.FACULTY_ENTRA_ALLOWED_EMAIL_DOMAINS || '')
      .split(',')
      .map((domain) => domain.trim().toLowerCase())
      .filter(Boolean),
    // Voice Studio is open to any Microsoft account (incl. personal accounts,
    // which can be made from a Gmail address). Empty = any domain.
    studioDomains: (env.STUDIO_ALLOWED_EMAIL_DOMAINS || '')
      .split(',')
      .map((domain) => domain.trim())
      .filter(Boolean),
    studioHomeDomains: (env.STUDIO_HOME_DOMAINS || 'ntu.edu.sg')
      .split(',')
      .map((domain) => domain.trim())
      .filter(Boolean),
  };
}

/** Requests from the Voice Studio site (STUDIO_SITE_ORIGINS, by browser Origin). */
export function isStudioRequest(event, env = process.env) {
  const allowed = (env.STUDIO_SITE_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/u, ''))
    .filter(Boolean);
  if (allowed.length === 0) return false;
  const headers = event?.headers || {};
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'origin');
  const origin = key ? String(headers[key] || '').trim().replace(/\/+$/u, '') : '';
  return Boolean(origin) && allowed.includes(origin);
}

/**
 * Origins allowed to synthesise without signing in.
 *
 * Mirrors the live gateway's LIVE_AUTH_EXEMPT_ORIGINS so one open kiosk build
 * gets both halves of a conversation — the gateway's reply and this route's
 * voice — while every other distribution still needs a token. Same caveat as
 * the gateway: Origin is browser-supplied, so this is a soft gate. Synthesis
 * costs GPU time, so treat an exempt origin as a public, metered surface.
 */
export function isAuthExemptOrigin(event, env = process.env) {
  const exempt = (env.LIVE_AUTH_EXEMPT_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/u, ''))
    .filter(Boolean);
  if (exempt.length === 0) return false;

  const headers = event?.headers || {};
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'origin');
  const origin = key ? String(headers[key] || '').trim().replace(/\/+$/u, '') : '';
  if (!origin) return false; // No Origin at all is never exempt.
  return exempt.includes(origin);
}

export function readBearerToken(event) {
  const headers = event?.headers || {};
  const entraKey = Object.keys(headers).find((name) => name.toLowerCase() === 'x-vcs-entra-token');
  const entraToken = entraKey ? String(headers[entraKey] || '').trim() : '';
  if (entraToken) return entraToken;
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'authorization');
  const raw = key ? String(headers[key] || '').trim() : '';
  return /^Bearer\s+/iu.test(raw) ? raw.replace(/^Bearer\s+/iu, '').trim() : '';
}

export function isFacultyRequest(event) {
  const headers = event?.headers || {};
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'x-vcs-site');
  return key ? String(headers[key] || '').trim().toLowerCase() === 'faculty' : false;
}

export function enforceFacultyIdentity(identity, event, allowedDomains) {
  if (!isFacultyRequest(event) || identity?.synthetic) return identity;
  const email = String(identity?.email || '').trim().toLowerCase();
  if (!allowedDomains.some((domain) => email.endsWith(`@${domain}`))) {
    throw new TokenError('domain_not_allowed', 'This Microsoft account cannot use the faculty app.');
  }
  return identity;
}

/**
 * Builds the guard. Returns null when authentication is off, so the caller keeps
 * its previous behaviour exactly.
 *
 * The verifier is module-scoped on purpose: Lambda reuses a warm container, so the
 * JWKS cache survives between invocations instead of refetching on every request.
 */
export function createLiveAuthGuard({ env = process.env, verifier = null, studioVerifier = null, forceStudio = false } = {}) {
  const config = readEnv(env);
  if (!config.enabled) return null;

  if (!config.tenantId || !config.audience) {
    // Fail closed. A route that believes it is protected but is not is worse than
    // one that is plainly refusing.
    console.error(
      '[live-auth] LIVE_AUTH_ENABLED is on but ENTRA_TENANT_ID/ENTRA_AUDIENCE are missing; '
      + 'refusing all synthesis requests.',
    );
    return {
      async authorize() {
        throw new TokenError('misconfigured', 'Synthesis authentication is not configured.');
      },
    };
  }

  if (!verifier && !cached) {
    cached = createEntraVerifier({
      tenantId: config.tenantId,
      audience: config.audience,
      allowedEmailDomains: config.domains,
    });
  }
  const activeVerifier = verifier || cached;
  function studio() {
    if (studioVerifier) return studioVerifier;
    if (!cachedStudio) {
      cachedStudio = createEntraVerifier({
        tenantId: config.tenantId,
        audience: config.audience,
        allowedEmailDomains: config.studioDomains,
        multiTenant: true,
        homeDomains: config.studioHomeDomains,
      });
    }
    return cachedStudio;
  }

  return {
    /**
     * @returns {Promise<{ oid: string, email: string, synthetic: boolean }>}
     * @throws {TokenError} on any failure — never returns an anonymous caller.
     */
    async authorize(event) {
      const token = readBearerToken(event);

      // Load tests hit this route with no interactive sign-in. Same separate
      // credential the gateway uses, so there is still no single switch that
      // turns authentication off.
      if (config.loadTestSecret && token === config.loadTestSecret) {
        return { oid: 'LOADTEST#lambda', email: '', synthetic: true };
      }

      // Voice Studio: any Microsoft account; the faculty-only rule does not apply.
      if (forceStudio || isStudioRequest(event, env)) {
        return { ...await studio().verify(token), synthetic: false, studio: true };
      }
      const identity = { ...await activeVerifier.verify(token), synthetic: false };
      return enforceFacultyIdentity(identity, event, config.facultyDomains);
    },
  };
}

/** Test seam: drops the warm-container verifier cache. */
export function resetLiveAuthCache() {
  cached = null;
  cachedStudio = null;
}
