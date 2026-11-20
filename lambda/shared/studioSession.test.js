import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { isStudioSessionToken, signStudioSession, verifyStudioSession } from './studioSession.js';

function keys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    STUDIO_SESSION_PRIVATE_KEY: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    STUDIO_SESSION_PUBLIC_KEY: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

const T0 = Date.parse('2026-11-21T00:00:00Z');

test('a signed studio session verifies with only the public key', () => {
  const env = keys();
  const token = signStudioSession({ email: 'Someone@Gmail.com', name: 'Some One' }, { env, now: T0 });
  assert.ok(isStudioSessionToken(token));
  const identity = verifyStudioSession(token, { env: { STUDIO_SESSION_PUBLIC_KEY: env.STUDIO_SESSION_PUBLIC_KEY }, now: T0 + 1000 });
  assert.deepEqual(identity, { oid: 'studio-pw:someone@gmail.com', email: 'someone@gmail.com', name: 'Some One', passwordAccount: true });
});

test('tampered, foreign-key and expired tokens are refused', () => {
  const env = keys();
  const token = signStudioSession({ email: 'a@gmail.com' }, { env, now: T0 });
  const [prefixAndPayload, signature] = [token.slice(0, token.lastIndexOf('.')), token.slice(token.lastIndexOf('.') + 1)];
  const forged = `vst1.${Buffer.from(JSON.stringify({ sub: 'boss@ntu.edu.sg', typ: 'studio-password', exp: 9e9 })).toString('base64url')}.${signature}`;
  assert.throws(() => verifyStudioSession(forged, { env, now: T0 }), { code: 'bad_signature' });
  assert.throws(() => verifyStudioSession(`${prefixAndPayload}.AAAA`, { env, now: T0 }), { code: 'bad_signature' });
  assert.throws(() => verifyStudioSession(token, { env: keys(), now: T0 }), { code: 'bad_signature' });
  assert.throws(() => verifyStudioSession(token, { env, now: T0 + 15 * 86400_000 }), { code: 'expired' });
  assert.throws(() => verifyStudioSession('eyJ.not.ours', { env, now: T0 }), { code: 'missing' });
});
