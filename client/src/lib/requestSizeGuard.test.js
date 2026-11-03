import test from 'node:test';
import assert from 'node:assert/strict';
import { oversizedRequestError, isWafBlockResponse, WAF_BODY_LIMIT_BYTES } from './requestSizeGuard.js';

test('an oversized body on a WAF-protected site is refused with a clear message', () => {
  const body = JSON.stringify({ text: 'a'.repeat(WAF_BODY_LIMIT_BYTES) });
  const error = oversizedRequestError(body, 'live-fast');
  assert.equal(error.code, 'REQUEST_TOO_LARGE');
  assert.match(error.response.data.error, /shorten it or split it/u);
});

test('normal bodies and sites without the WAF are untouched', () => {
  assert.equal(oversizedRequestError(JSON.stringify({ text: 'hello' }), 'live-fast'), null);
  assert.equal(oversizedRequestError('x'.repeat(20_000), 'chatbot'), null);
  assert.equal(oversizedRequestError('x'.repeat(20_000), 'gi'), null);
});

test('multi-byte text is measured in bytes, as the WAF does', () => {
  assert.ok(oversizedRequestError('é'.repeat(4_200), 'training'));
});

test('only a non-JSON 403 counts as a WAF block', () => {
  assert.equal(isWafBlockResponse(403, 'text/html'), true);
  assert.equal(isWafBlockResponse(403, 'application/json'), false);
  assert.equal(isWafBlockResponse(500, 'text/html'), false);
});
