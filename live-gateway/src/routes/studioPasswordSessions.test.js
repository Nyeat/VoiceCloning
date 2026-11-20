import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { withStudioPasswordSessions } from './liveChat.js';
import { signStudioSession } from '../services/studioSession.js';

test('studio chats accept an email + password session with only the public key', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const signer = { STUDIO_SESSION_PRIVATE_KEY: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') };
  const gatewayEnv = { STUDIO_SESSION_PUBLIC_KEY: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
  const entraCalls = [];
  const verifier = withStudioPasswordSessions({ verify: async (token) => { entraCalls.push(token); return { oid: 'ms', email: 'ms@x.com' }; } }, gatewayEnv);
  const identity = await verifier.verify(signStudioSession({ email: 'dee@gmail.com', name: 'Dee' }, { env: signer }));
  assert.equal(identity.email, 'dee@gmail.com');
  assert.equal(entraCalls.length, 0);
  assert.equal((await verifier.verify('eyJ.microsoft.token')).oid, 'ms', 'Microsoft tokens still go to Entra');
  await assert.rejects(verifier.verify(`${signStudioSession({ email: 'a@b.co' }, { env: signer })}x`), { code: 'bad_signature' });
});
