// Real public-path smoke test: OpenAI conversation, PCM input, and DeanVoice WAV.
// Usage: node scripts/test-staging-mc.mjs .tmp/mc-test-question.wav
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { MC_SYSTEM_PROMPT } from '../client/src/lib/mcSession.js';
const require = createRequire(new URL('../live-gateway/package.json', import.meta.url));
const WebSocket = require('ws');
const origin = 'https://d32nzk2gacfhag.cloudfront.net';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function wavData(buffer) {
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buffer.toString('ascii', 8, 12), 'WAVE');
  let format;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const kind = buffer.toString('ascii', offset, offset + 4);
    const length = buffer.readUInt32LE(offset + 4);
    if (kind === 'fmt ') format = { code: buffer.readUInt16LE(offset + 8), channels: buffer.readUInt16LE(offset + 10), rate: buffer.readUInt32LE(offset + 12), bits: buffer.readUInt16LE(offset + 22) };
    if (kind === 'data') return { ...format, pcm: buffer.subarray(offset + 8, offset + 8 + length) };
    offset += 8 + length + (length % 2);
  }
  throw new Error('No WAV data');
}

const socket = new WebSocket(`${origin.replace('https:', 'wss:')}/api/live/chat/realtime?language=en`, { origin });
const events = [];
socket.on('message', (data) => {
  const event = JSON.parse(data.toString());
  events.push(event);
  if (event.type === 'session.auth.failed' || event.type === 'error') console.log('Gateway event:', event.type, event.message || event.code);
});
socket.on('error', (error) => console.log('WebSocket error:', error.message));
const send = (value) => socket.send(JSON.stringify(value));
const keepalive = setInterval(() => { if (socket.readyState === WebSocket.OPEN) send({ type: 'ping' }); }, 15000);
async function waitEvent(type, from = 0, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const event = events.slice(from).find((event) => event.type === type);
    if (event) return event;
    const failure = events.slice(from).find((event) => ['session.auth.failed', 'error'].includes(event.type));
    if (failure) throw new Error(`${failure.type}: ${failure.message || failure.code}`);
    if (socket.readyState === WebSocket.CLOSED) throw new Error('WebSocket closed before '+type);
    await wait(100);
  }
  throw new Error(`Timeout waiting for ${type}; received ${events.slice(from).map((e) => e.type).join(', ')}`);
}

async function synthesize(text, turn) {
  const body = JSON.stringify({ text, voiceProfileId: 'deanvoice-v1', text_lang: 'en', skip_verify: true });
  const started = Date.now();
  const response = await fetch(`${origin}/api/live/tts-sentence`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'x-amz-content-sha256': createHash('sha256').update(body).digest('hex') }, body,
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`TTS ${response.status}: ${(await response.text()).slice(0, 600)}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const wav = wavData(bytes);
  assert.ok(wav.pcm.length > 4800, 'Reply must contain substantial audio');
  assert.ok(wav.pcm.some((value) => value !== 0), 'Reply must not be silent');
  writeFileSync(`.tmp/mc-reply-${turn}.wav`, bytes);
  return { bytes: bytes.length, milliseconds: Date.now() - started, sampleRate: wav.rate };
}

try {
  mkdirSync('.tmp', { recursive: true });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket open timeout')), 20000);
    socket.once('open', () => { clearTimeout(timeout); resolve(); });
    socket.once('error', (error) => { clearTimeout(timeout); reject(error); });
  });
  send({ type: 'session.init', systemPrompt: MC_SYSTEM_PROMPT });
  await waitEvent('session.ready');
  console.log('Public MC OpenAI session ready.');
  let offset = events.length;
  let started = Date.now();
  send({ type: 'user.text', text: 'We are hosting the NTU Innovation Evening. Welcome our guests in one short sentence.' });
  const first = await waitEvent('assistant.text.done', offset);
  const firstTextMs = Date.now() - started;
  const firstAudio = await synthesize(first.text, 1);
  console.log(JSON.stringify({ turn: 1, text: first.text, textMs: firstTextMs, audio: firstAudio }));
  assert.ok(process.argv[2], 'Provide a 24 kHz mono 16-bit PCM WAV question');
  const question = wavData(readFileSync(process.argv[2]));
  assert.deepEqual([question.code, question.channels, question.rate, question.bits], [1, 1, 24000, 16]);
  offset = events.length;
  send({ type: 'input.resume' });
  for (let index = 0; index < question.pcm.length; index += 4800) {
    send({ type: 'audio.chunk', audio: question.pcm.subarray(index, index + 4800).toString('base64') });
    await wait(100);
  }
  started = Date.now();
  for (let index = 0; index < 12; index++) {
    send({ type: 'audio.chunk', audio: Buffer.alloc(4800).toString('base64') });
    await wait(100);
  }
  const second = await waitEvent('assistant.text.done', offset);
  const secondTextMs = Date.now() - started;
  const transcript = await waitEvent('user.text.done', offset);
  assert.match(transcript.text, /name|event|tonight/i);
  assert.match(second.text, /Innovation Evening/i, 'Second turn must retain first-turn event context');
  const secondAudio = await synthesize(second.text, 2);
  console.log(JSON.stringify({ turn: 2, transcript: transcript.text, text: second.text, textMs: secondTextMs, audio: secondAudio }));
  // Since 2026-11-19 the MC page shows the shared GPU notices, so it reads the
  // GPU status (read-only) through this distribution.
  const status = await fetch(`${origin}/api/instance/status`);
  assert.equal(status.status, 200, 'MC must reach the GPU status for its notices');
  assert.equal(typeof (await status.json()).workerReady, 'boolean');
  console.log('PASS: same-session text + PCM speech -> OpenAI -> DeanVoice audio; GPU status reachable.');
} finally {
  clearInterval(keepalive);
  socket.close();
}
