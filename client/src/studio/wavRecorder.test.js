import test from 'node:test';
import assert from 'node:assert/strict';
import { describeLevels, encodeWav } from './wavRecorder.js';

test('encodes mono 16-bit PCM WAV with a correct header', () => {
  const bytes = encodeWav(new Float32Array([0, 1, -1, 0.5]), 32000);
  const view = new DataView(bytes.buffer);
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...bytes.slice(8, 12)), 'WAVE');
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 32000);
  assert.equal(view.getUint32(40, true), 8);
  assert.equal(view.getInt16(46, true), 32767);
  assert.equal(view.getInt16(48, true), -32768);
});

test('flags silent and clipped takes', () => {
  assert.equal(describeLevels(new Float32Array(1000).fill(0.01)).tooQuiet, true);
  assert.equal(describeLevels(new Float32Array(1000).fill(1)).tooLoud, true);
  const ok = describeLevels(Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i) * 0.5));
  assert.deepEqual([ok.tooQuiet, ok.tooLoud], [false, false]);
});
