import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Same rule as entraTokenParity.test.js: the Lambda and the live gateway are
// deployed separately, so the studio session verifier is a checked copy.
test('the lambda and gateway studio session modules are identical', () => {
  const lambdaCopy = readFileSync(new URL('./studioSession.js', import.meta.url), 'utf8');
  const gatewayCopy = readFileSync(new URL('../../live-gateway/src/services/studioSession.js', import.meta.url), 'utf8');
  assert.equal(lambdaCopy.replace(/\r\n/gu, '\n'), gatewayCopy.replace(/\r\n/gu, '\n'),
    'lambda/shared/studioSession.js has drifted from live-gateway/src/services/studioSession.js');
});
