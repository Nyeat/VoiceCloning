import test from 'node:test';
import assert from 'node:assert/strict';
import { CONSENT_VERSION, hasSeenHelp, markHelpSeen, readConsent, saveConsent } from './consent.js';

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)) };
}

test('consent is remembered per account and version', () => {
  const storage = memoryStorage();
  assert.equal(readConsent('a@staff.main.ntu.edu.sg', storage), null);
  saveConsent('A@staff.main.ntu.edu.sg', storage, new Date('2026-11-16T00:00:00Z'));
  assert.equal(readConsent('a@staff.main.ntu.edu.sg', storage).version, CONSENT_VERSION);
  assert.equal(readConsent('b@staff.main.ntu.edu.sg', storage), null);
});

test('the help hint is shown until the guide is opened once', () => {
  const storage = memoryStorage();
  assert.equal(hasSeenHelp(storage), false);
  markHelpSeen(storage);
  assert.equal(hasSeenHelp(storage), true);
});
