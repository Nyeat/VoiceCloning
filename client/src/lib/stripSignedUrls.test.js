import assert from 'node:assert/strict';
import test from 'node:test';
import { stripSignedUrls } from './stripSignedUrls.js';

const signed = 'https://bucket.s3.ap-southeast-1.amazonaws.com/a.wav?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=abc&X-Amz-Signature=def';

test('presigned clip links are dropped from saved reference metadata', () => {
  const config = {
    referenceMetadata: {
      primary: { path: 'refs/a.wav', file: { path: 'refs/a.wav', url: signed, transcript: 'Hello there.' } },
      aux: [{ path: 'refs/b.wav', file: { url: signed, filename: 'b.wav' } }],
    },
  };
  const out = stripSignedUrls(config);
  assert.equal('url' in out.referenceMetadata.primary.file, false);
  assert.equal(out.referenceMetadata.primary.file.transcript, 'Hello there.');
  assert.equal(out.referenceMetadata.aux[0].file.filename, 'b.wav');
  assert.equal('url' in out.referenceMetadata.aux[0].file, false);
});

test('plain links, paths and scalars are kept', () => {
  const value = { url: 'https://example.org/page', path: 's3://bucket/key.wav', n: 3, ok: true, none: null };
  assert.deepEqual(stripSignedUrls(value), value);
});
