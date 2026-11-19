import test from 'node:test';
import assert from 'node:assert/strict';
import { jwtExpiresAtMs, tokenNeedsRefresh } from './tokenExpiry.js';

const jwt = (payload) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;

test('an expired or nearly expired ID token is refreshed before use', () => {
  const now = 1_000_000_000_000;
  const exp = (ms) => jwt({ exp: Math.floor((now + ms) / 1000) });
  assert.equal(jwtExpiresAtMs(exp(3_600_000)), now + 3_600_000);
  assert.equal(tokenNeedsRefresh(exp(3_600_000), now), false);
  assert.equal(tokenNeedsRefresh(exp(2 * 60_000), now), true);
  assert.equal(tokenNeedsRefresh(exp(-60_000), now), true);
  assert.equal(tokenNeedsRefresh('', now), true);
  assert.equal(tokenNeedsRefresh('not-a-jwt', now), true);
});
