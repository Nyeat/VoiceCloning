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

test('streaming resampler keeps the rate and continuity across blocks', async () => {
  const { createResampler, wavHeader } = await import('./wavRecorder.js');
  const push = createResampler(48000, 32000);
  // One second of a 440 Hz tone, fed in uneven blocks.
  const tone = Float32Array.from({ length: 48000 }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.5);
  let total = 0;
  const out = [];
  for (let at = 0; at < tone.length;) {
    const size = 128 + (at % 7) * 300;
    const pcm = push(tone.subarray(at, at + size));
    total += pcm.length;
    out.push(...pcm);
    at += size;
  }
  assert.ok(Math.abs(total - 32000) <= 2, `got ${total} samples`);
  // No jumps at block joins: neighbours of a smooth 440 Hz tone differ by < 0.1 full scale.
  for (let i = 1; i < out.length; i += 1) assert.ok(Math.abs(out[i] - out[i - 1]) < 0.1 * 32767, `jump at ${i}`);
  const header = new DataView(wavHeader(64000).buffer);
  assert.equal(header.getUint32(40, true), 64000);
  assert.equal(header.getUint32(4, true), 36 + 64000);
});
