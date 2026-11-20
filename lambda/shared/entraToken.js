// Validates Microsoft Entra tokens.
//
// This is the only thing standing between a caller and a transcript written under
// someone else's name, so every check below is load-bearing. The order matters:
// nothing in the payload is trusted until the signature verifies against a key
// from the tenant's JWKS.
//
// No JWT library: Node's crypto verifies RS256 straight from a JWK, and the
// gateway ships as a systemd service on EC2 where fewer dependencies is worth
// more than the convenience.
//
// DUPLICATED, deliberately: this file exists identically at
// live-gateway/src/services/entraToken.js and lambda/shared/entraToken.js. The two
// services are packaged and deployed separately with no shared module. The copies
// must stay byte-identical — lambda/shared/entraTokenParity.test.js fails if they
// drift, so fix a bug in one and copy it to the other.
import { createPublicKey, createVerify } from 'node:crypto';

// Entra rotates signing keys; an hour is well inside its rotation window, and
// Entra publishes a new key well before it starts signing with it.
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;
// An attacker can mint tokens with arbitrary `kid` values. Without this floor,
// each one would trigger a fetch and turn the gateway into a JWKS flood source.
const JWKS_REFETCH_COOLDOWN_MS = 60 * 1000;
// Tolerates ordinary clock drift between Entra and the gateway host.
const CLOCK_SKEW_SECONDS = 60;

export class TokenError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TokenError';
    this.code = code;
  }
}

function decodeSegment(segment) {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new TokenError('malformed', 'Token segment is not valid base64url JSON.');
  }
}

function normalizeDomain(domain) {
  return domain.trim().replace(/^@+/u, '').toLowerCase();
}

/**
 * @param {object} options
 * @param {string} options.tenantId       Entra tenant (directory) ID.
 * @param {string} options.audience       Expected `aud`: the API's app ID URI.
 * @param {string[]} options.allowedEmailDomains  Empty array allows any domain.
 * @param {boolean} [options.multiTenant] Accept any Microsoft account — work or
 *   school accounts of any directory and personal accounts — for the public Voice
 *   Studio site. The home-tenant rule below keeps it from being a way around NTU
 *   sign-in: an address in a home domain is accepted only from `tenantId`.
 * @param {string[]} [options.homeDomains] Domains (and their subdomains) that
 *   only the home tenant may assert, e.g. ['ntu.edu.sg'].
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]    Epoch milliseconds; injectable for tests.
 */
export function createEntraVerifier({
  tenantId,
  audience,
  allowedEmailDomains = [],
  multiTenant = false,
  homeDomains = [],
  fetchImpl = fetch,
  now = () => Date.now(),
}) {
  if (!tenantId) throw new Error('createEntraVerifier requires tenantId.');
  if (!audience) throw new Error('createEntraVerifier requires audience.');

  const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  // The common key set signs tokens of every directory and of personal accounts.
  const jwksUri = multiTenant
    ? 'https://login.microsoftonline.com/common/discovery/v2.0/keys'
    : `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`;
  const protectedDomains = homeDomains.map(normalizeDomain).filter(Boolean);
  const domains = allowedEmailDomains.map(normalizeDomain).filter(Boolean);

  let keysByKid = new Map();
  let fetchedAtMs = 0;
  let inFlight = null;

  async function fetchJwks() {
    // Collapse concurrent misses into one request — a burst of new connections
    // after a key rotation would otherwise all fetch at once.
    if (inFlight) return inFlight;

    inFlight = (async () => {
      const response = await fetchImpl(jwksUri);
      if (!response.ok) {
        throw new TokenError('jwks_unavailable', `JWKS fetch failed: HTTP ${response.status}.`);
      }
      const body = await response.json();
      const next = new Map();
      for (const key of body?.keys || []) {
        // Signing keys only. An encryption key here would never verify a token,
        // and accepting one invites confusion about what a `kid` match means.
        if (key.kid && key.kty === 'RSA' && (key.use === 'sig' || key.use === undefined)) {
          next.set(key.kid, key);
        }
      }
      if (next.size === 0) {
        throw new TokenError('jwks_unavailable', 'JWKS contained no usable RSA signing keys.');
      }
      keysByKid = next;
      fetchedAtMs = now();
      return keysByKid;
    })().finally(() => {
      inFlight = null;
    });

    return inFlight;
  }

  async function resolveKey(kid) {
    const isStale = now() - fetchedAtMs > JWKS_CACHE_TTL_MS;
    if (keysByKid.size === 0 || isStale) await fetchJwks();

    const cached = keysByKid.get(kid);
    if (cached) return cached;

    // Unknown kid usually means a rotation we have not seen yet — refetch once,
    // but not more often than the cooldown, so bogus kids cannot drive traffic.
    if (now() - fetchedAtMs > JWKS_REFETCH_COOLDOWN_MS) await fetchJwks();

    const refreshed = keysByKid.get(kid);
    if (!refreshed) {
      throw new TokenError('unknown_key', `No signing key matches kid "${kid}".`);
    }
    return refreshed;
  }

  /**
   * Verifies a token and returns the caller's identity.
   * Throws TokenError on any failure — never returns a partial or anonymous result.
   *
   * @returns {Promise<{ oid: string, email: string, name: string, tenantId: string }>}
   */
  async function verify(rawToken) {
    if (typeof rawToken !== 'string' || rawToken.length === 0) {
      throw new TokenError('missing', 'No token supplied.');
    }

    const segments = rawToken.split('.');
    if (segments.length !== 3) {
      throw new TokenError('malformed', 'Token is not a three-segment JWT.');
    }
    const [headerSegment, payloadSegment, signatureSegment] = segments;

    const header = decodeSegment(headerSegment);
    // Pinning the algorithm defeats both `alg: none` and the HS256 confusion
    // attack, where the RSA public key is replayed as an HMAC secret.
    if (header.alg !== 'RS256') {
      throw new TokenError('bad_algorithm', `Unsupported token algorithm "${header.alg}".`);
    }
    if (!header.kid) {
      throw new TokenError('malformed', 'Token header has no kid.');
    }

    const jwk = await resolveKey(header.kid);
    const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${headerSegment}.${payloadSegment}`);
    verifier.end();

    if (!verifier.verify(publicKey, Buffer.from(signatureSegment, 'base64url'))) {
      throw new TokenError('bad_signature', 'Token signature does not verify.');
    }

    // Past this line the payload is authentic — but authentic is not the same as
    // intended for us, which is what the claim checks below establish.
    const payload = decodeSegment(payloadSegment);
    const nowSeconds = Math.floor(now() / 1000);

    const tokenTenant = typeof payload.tid === 'string' ? payload.tid : '';
    const expectedIssuer = multiTenant ? `https://login.microsoftonline.com/${tokenTenant}/v2.0` : issuer;
    if (!tokenTenant || payload.iss !== expectedIssuer) {
      throw new TokenError('bad_issuer', 'Token issuer is not the expected tenant.');
    }
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(audience)) {
      // Without this, any token signed by Entra for any application would pass.
      throw new TokenError('bad_audience', 'Token was not issued for this API.');
    }
    if (!multiTenant && payload.tid !== tenantId) {
      throw new TokenError('bad_tenant', 'Token is from a different directory.');
    }
    if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_SECONDS < nowSeconds) {
      throw new TokenError('expired', 'Token has expired.');
    }
    if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW_SECONDS > nowSeconds) {
      throw new TokenError('not_yet_valid', 'Token is not valid yet.');
    }

    const oid = typeof payload.oid === 'string' ? payload.oid : (multiTenant && typeof payload.sub === 'string' ? payload.sub : '');
    if (!oid) {
      // oid is the stable per-user key. Falling back to email would fork a
      // user's history the first time their name changes.
      throw new TokenError('no_subject', 'Token has no oid claim.');
    }

    const email = (payload.preferred_username || payload.upn || '').toLowerCase();
    if (email.includes('#ext#')) {
      throw new TokenError('guest_account', 'Guest accounts are not allowed.');
    }
    if (domains.length > 0 && !domains.some((domain) => email.endsWith(`@${domain}`))) {
      throw new TokenError('domain_not_allowed', 'Account domain is not allowed.');
    }
    const emailDomain = email.slice(email.lastIndexOf('@') + 1);
    if (multiTenant && tokenTenant !== tenantId
      && protectedDomains.some((domain) => emailDomain === domain || emailDomain.endsWith(`.${domain}`))) {
      // Another directory (or a personal account) claiming an NTU address.
      throw new TokenError('bad_tenant', 'This address must sign in through its own organisation.');
    }

    return {
      oid,
      email,
      name: typeof payload.name === 'string' ? payload.name : email,
      tenantId: payload.tid,
      roles: Array.isArray(payload.roles)
        ? payload.roles.filter((role) => typeof role === 'string').slice(0, 20)
        : [],
    };
  }

  return { verify };
}
