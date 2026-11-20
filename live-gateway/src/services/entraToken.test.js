import assert from 'node:assert/strict';
import { createHmac, createSign, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { createEntraVerifier } from './entraToken.js';

const TENANT_ID = '45e82b6b-5ac4-41a7-a36f-e702e5e3a355';
const AUDIENCE = 'api://9b5c52c0-5f02-4dbf-83ac-c68d246abc68';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const DOMAINS = [
  'staff.main.ntu.edu.sg',
  'student.main.ntu.edu.sg',
  'assoc.main.ntu.edu.sg',
];
const NOW_MS = 1_770_000_000_000;
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

function makeKey(kid) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig' } };
}

const PRIMARY = makeKey('primary-kid');

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function validClaims(overrides = {}) {
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    tid: TENANT_ID,
    oid: 'e3f1c0aa-1111-2222-3333-444455556666',
    preferred_username: 'CS-NATHANAEL.NG@assoc.main.ntu.edu.sg',
    name: 'Nathanael Ng',
    exp: NOW_SECONDS + 3600,
    nbf: NOW_SECONDS - 60,
    ...overrides,
  };
}

function signToken(claims = validClaims(), key = PRIMARY, headerOverrides = {}) {
  const header = encode({ alg: 'RS256', kid: key.kid, typ: 'JWT', ...headerOverrides });
  const payload = encode(claims);
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  signer.end();
  return `${header}.${payload}.${signer.sign(key.privateKey).toString('base64url')}`;
}

function makeVerifier({ keys = [PRIMARY], now = () => NOW_MS } = {}) {
  const state = { fetchCount: 0, keys };
  const fetchImpl = async () => {
    state.fetchCount += 1;
    return {
      ok: true,
      json: async () => ({ keys: state.keys.map((key) => key.jwk) }),
    };
  };
  const verifier = createEntraVerifier({
    tenantId: TENANT_ID,
    audience: AUDIENCE,
    allowedEmailDomains: DOMAINS,
    fetchImpl,
    now,
  });
  return { verifier, state };
}

async function assertRejects(verifier, token, code) {
  await assert.rejects(() => verifier.verify(token), (error) => {
    assert.equal(error.code, code, `expected code "${code}", got "${error.code}"`);
    return true;
  });
}

test('a well-formed tenant token yields the caller identity', async () => {
  const { verifier } = makeVerifier();

  const identity = await verifier.verify(signToken());

  assert.deepEqual(identity, {
    oid: 'e3f1c0aa-1111-2222-3333-444455556666',
    email: 'cs-nathanael.ng@assoc.main.ntu.edu.sg',
    name: 'Nathanael Ng',
    tenantId: TENANT_ID,
    roles: [],
  });
});

test('a token signed by a key outside the tenant JWKS is rejected', async () => {
  // The whole gate rests on this: an attacker who can mint their own RSA key
  // must not be able to mint their own users.
  const foreign = makeKey('primary-kid');
  const { verifier } = makeVerifier();

  await assertRejects(verifier, signToken(validClaims(), foreign), 'bad_signature');
});

test('a payload edited after signing is rejected', async () => {
  const { verifier } = makeVerifier();
  const [header, , signature] = signToken().split('.');
  const swapped = encode(validClaims({ oid: 'someone-elses-oid' }));

  await assertRejects(verifier, `${header}.${swapped}.${signature}`, 'bad_signature');
});

test('unsigned and HMAC-signed tokens are rejected before any key lookup', async () => {
  const { verifier, state } = makeVerifier();
  const claims = encode(validClaims());

  const unsigned = `${encode({ alg: 'none', kid: PRIMARY.kid })}.${claims}.`;
  await assertRejects(verifier, unsigned, 'bad_algorithm');

  // Classic algorithm-confusion attempt: sign with HMAC, hoping the verifier
  // uses the RSA public key as a shared secret.
  const header = encode({ alg: 'HS256', kid: PRIMARY.kid });
  const mac = createHmac('sha256', JSON.stringify(PRIMARY.jwk))
    .update(`${header}.${claims}`)
    .digest('base64url');
  await assertRejects(verifier, `${header}.${claims}.${mac}`, 'bad_algorithm');

  assert.equal(state.fetchCount, 0, 'rejected tokens must not trigger a JWKS fetch');
});

test('a token minted for a different application is rejected', async () => {
  const { verifier } = makeVerifier();
  const otherApp = validClaims({ aud: 'api://11111111-2222-3333-4444-555555555555' });

  await assertRejects(verifier, signToken(otherApp), 'bad_audience');
});

test('tokens from another issuer or directory are rejected', async () => {
  const { verifier } = makeVerifier();

  await assertRejects(
    verifier,
    signToken(validClaims({ iss: 'https://login.microsoftonline.com/common/v2.0' })),
    'bad_issuer',
  );
  await assertRejects(
    verifier,
    signToken(validClaims({ tid: '00000000-0000-0000-0000-000000000000' })),
    'bad_tenant',
  );
});

test('expired and not-yet-valid tokens are rejected outside the skew window', async () => {
  const { verifier } = makeVerifier();

  await assertRejects(verifier, signToken(validClaims({ exp: NOW_SECONDS - 120 })), 'expired');
  await assertRejects(
    verifier,
    signToken(validClaims({ nbf: NOW_SECONDS + 120 })),
    'not_yet_valid',
  );
});

test('clock skew within a minute is tolerated', async () => {
  const { verifier } = makeVerifier();

  // A gateway host running slightly fast must not reject tokens that only just
  // expired, or sessions would fail intermittently for no visible reason.
  await verifier.verify(signToken(validClaims({ exp: NOW_SECONDS - 30 })));
});

test('accounts outside the allowed domains are rejected', async () => {
  const { verifier } = makeVerifier();

  await assertRejects(
    verifier,
    signToken(validClaims({ preferred_username: 'someone@gmail.com' })),
    'domain_not_allowed',
  );
  await assertRejects(
    verifier,
    signToken(validClaims({ preferred_username: 'evil@notntu.edu.sg' })),
    'domain_not_allowed',
  );
});

test('a lookalike domain suffix does not satisfy the allowlist', async () => {
  const { verifier } = makeVerifier();
  // Guards the endsWith check: "@evilassoc.main.ntu.edu.sg" must not pass as
  // "assoc.main.ntu.edu.sg".
  const lookalike = validClaims({ preferred_username: 'me@evilassoc.main.ntu.edu.sg' });

  await assertRejects(verifier, signToken(lookalike), 'domain_not_allowed');
});

test('every allowed NTU domain is accepted, students included', async () => {
  // Stands in for the accounts we cannot sign in as. Nothing about verification
  // treats a student differently from staff — the domain string is the only
  // thing that varies — so exercising all three here is the closest we can get
  // to a student sign-in without a student account.
  const { verifier } = makeVerifier();

  for (const domain of DOMAINS) {
    const identity = await verifier.verify(
      signToken(validClaims({ preferred_username: `SOMEONE@${domain}` })),
    );
    assert.equal(identity.email, `someone@${domain}`);
  }
});

test('e.ntu.edu.sg is NTU but is not on the allowlist', async () => {
  // Deliberate, and worth a test because it is the easy one to get wrong: the
  // domain resolves to the same NTU tenant as the three allowed suffixes, so a
  // token bearing it is genuine and still rejected. If a cohort turns out to
  // sign in with this suffix, the fix is the env allowlist, not this code.
  const { verifier } = makeVerifier();

  await assertRejects(
    verifier,
    signToken(validClaims({ preferred_username: 'student@e.ntu.edu.sg' })),
    'domain_not_allowed',
  );
});

test('guest accounts are rejected even on an allowed domain', async () => {
  const { verifier } = makeVerifier();
  const guest = validClaims({
    preferred_username: 'outsider_gmail.com#EXT#@assoc.main.ntu.edu.sg',
  });

  await assertRejects(verifier, signToken(guest), 'guest_account');
});

test('a token without an oid claim is rejected rather than keyed off email', async () => {
  const { verifier } = makeVerifier();
  const claims = validClaims();
  delete claims.oid;

  await assertRejects(verifier, signToken(claims), 'no_subject');
});

test('malformed and missing tokens are rejected', async () => {
  const { verifier } = makeVerifier();

  await assertRejects(verifier, '', 'missing');
  await assertRejects(verifier, undefined, 'missing');
  await assertRejects(verifier, 'not.a.jwt.at.all', 'malformed');
  await assertRejects(verifier, 'aaaa.bbbb.cccc', 'malformed');
});

test('the JWKS is fetched once and reused across verifications', async () => {
  const { verifier, state } = makeVerifier();

  await verifier.verify(signToken());
  await verifier.verify(signToken());

  assert.equal(state.fetchCount, 1);
});

test('concurrent first connections collapse into a single JWKS fetch', async () => {
  const { verifier, state } = makeVerifier();

  await Promise.all([
    verifier.verify(signToken()),
    verifier.verify(signToken()),
    verifier.verify(signToken()),
  ]);

  assert.equal(state.fetchCount, 1);
});

test('an unknown kid does not trigger a fetch per attempt', async () => {
  // Otherwise anyone could drive JWKS traffic by looping over random kids.
  const { verifier, state } = makeVerifier();
  const rotated = makeKey('rotated-kid');

  await assertRejects(verifier, signToken(validClaims(), rotated), 'unknown_key');
  await assertRejects(verifier, signToken(validClaims(), rotated), 'unknown_key');

  assert.equal(state.fetchCount, 1);
});

test('a rotated signing key is picked up after the refetch cooldown', async () => {
  let currentMs = NOW_MS;
  const { verifier, state } = makeVerifier({ now: () => currentMs });
  const rotated = makeKey('rotated-kid');

  await verifier.verify(signToken());
  assert.equal(state.fetchCount, 1);

  state.keys = [PRIMARY, rotated];
  currentMs += 61_000;
  const identity = await verifier.verify(signToken(validClaims(), rotated));

  assert.equal(identity.oid, 'e3f1c0aa-1111-2222-3333-444455556666');
  assert.equal(state.fetchCount, 2);
});

test('a JWKS endpoint failure rejects the connection rather than admitting it', async () => {
  const verifier = createEntraVerifier({
    tenantId: TENANT_ID,
    audience: AUDIENCE,
    allowedEmailDomains: DOMAINS,
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    now: () => NOW_MS,
  });

  await assertRejects(verifier, signToken(), 'jwks_unavailable');
});

test('the verifier refuses to start without a tenant or audience', () => {
  assert.throws(() => createEntraVerifier({ audience: AUDIENCE }), /tenantId/);
  assert.throws(() => createEntraVerifier({ tenantId: TENANT_ID }), /audience/);
});

// ── Voice Studio: any Microsoft account (multiTenant) ──
const CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

function makeStudioVerifier() {
  const fetched = [];
  const verifier = createEntraVerifier({
    tenantId: TENANT_ID,
    audience: AUDIENCE,
    allowedEmailDomains: [],
    multiTenant: true,
    homeDomains: ['ntu.edu.sg'],
    fetchImpl: async (url) => {
      fetched.push(url);
      return { ok: true, json: async () => ({ keys: [PRIMARY.jwk] }) };
    },
    now: () => NOW_MS,
  });
  return { verifier, fetched };
}

function consumerClaims(overrides = {}) {
  return validClaims({
    iss: `https://login.microsoftonline.com/${CONSUMER_TENANT}/v2.0`,
    tid: CONSUMER_TENANT,
    preferred_username: 'jane.doe@gmail.com',
    ...overrides,
  });
}

test('studio verifier accepts a personal Microsoft account (e.g. a Gmail sign-in) using the common keys', async () => {
  const { verifier, fetched } = makeStudioVerifier();
  const identity = await verifier.verify(signToken(consumerClaims()));
  assert.equal(identity.email, 'jane.doe@gmail.com');
  assert.equal(identity.tenantId, CONSUMER_TENANT);
  assert.match(fetched[0], /\/common\/discovery\/v2\.0\/keys$/u);
});

test('studio verifier still accepts NTU tenant accounts', async () => {
  const { verifier } = makeStudioVerifier();
  const identity = await verifier.verify(signToken(validClaims()));
  assert.equal(identity.email, 'cs-nathanael.ng@assoc.main.ntu.edu.sg');
});

test('studio verifier refuses an NTU address asserted by any other directory', async () => {
  const { verifier } = makeStudioVerifier();
  await assertRejects(verifier, signToken(consumerClaims({ preferred_username: 'lkc-digitallearning@ntu.edu.sg' })), 'bad_tenant');
  await assertRejects(verifier, signToken(consumerClaims({ preferred_username: 'x@staff.main.ntu.edu.sg' })), 'bad_tenant');
});

test('studio verifier requires the issuer to match the token tenant and the audience to match', async () => {
  const { verifier } = makeStudioVerifier();
  await assertRejects(verifier, signToken(consumerClaims({ iss: ISSUER })), 'bad_issuer');
  await assertRejects(verifier, signToken(consumerClaims({ aud: 'api://someone-else' })), 'bad_audience');
});

test('single-tenant verifier still rejects personal accounts', async () => {
  const { verifier } = makeVerifier();
  await assertRejects(verifier, signToken(consumerClaims()), 'bad_issuer');
});
