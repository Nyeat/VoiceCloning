import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldSendLiveMicAudio, shouldTriggerLiveBargeIn, createLiveSynthesisSnapshot, buildLiveSentenceParams } from '../hooks/liveConversation.js';
import { MC_INSTRUCTIONS_MAX, MC_SYSTEM_PROMPT, mcMicConstraints, mcSessionOptions, mcTranscriptEntries, normalizeCaptureSettings, normalizeSavedInstructions, sameCaptureSettings, mcSessionStatus } from './mcSession.js';

test('turn mode keeps the mic available but sends audio only on the human turn', () => {
  for (const phase of ['idle', 'connecting', 'thinking', 'speaking', 'stopping']) {
    assert.equal(shouldSendLiveMicAudio({ phase, micInputEnabled: true, listeningMode: 'turns' }), false, phase);
    assert.equal(shouldTriggerLiveBargeIn({ phase, micInputEnabled: true, listeningMode: 'turns', rms: 1 }), false, phase);
  }
  assert.equal(shouldSendLiveMicAudio({ phase: 'listening', micInputEnabled: true, listeningMode: 'turns' }), true);
  assert.equal(shouldSendLiveMicAudio({ phase: 'listening', micInputEnabled: false, listeningMode: 'turns' }), false);
});

test('continuous mode preserves input during thinking and interruption during playback', () => {
  assert.equal(shouldSendLiveMicAudio({ phase: 'thinking', micInputEnabled: true }), true);
  assert.equal(shouldTriggerLiveBargeIn({ phase: 'speaking', micInputEnabled: true, rms: 0.08 }), true);
  assert.equal(shouldTriggerLiveBargeIn({ phase: 'speaking', micInputEnabled: false, rms: 1 }), false);
});

test('MC synthesis pins Dean through the shared Fast sentence request', () => {
  const snapshot = createLiveSynthesisSnapshot({ refParams: {}, voiceProfileId: 'deanvoice-v1' });
  const request = buildLiveSentenceParams('Welcome to our event.', snapshot.refParams, 'en', { skipVerify: true });
  assert.equal(request.voiceProfileId, 'deanvoice-v1');
  assert.equal(request.skip_verify, true);
  assert.equal(snapshot.engine, 'fast');
  assert.equal(request.speed_factor, undefined, 'saved voice settings are resolved by the existing backend');
});

test('MC status distinguishes mute, human turn, and AI turn', () => {
  assert.equal(mcSessionStatus({ phase: 'listening', micEnabled: false }), 'Muted · tap the mic to talk');
  assert.equal(mcSessionStatus({ phase: 'listening', micEnabled: true }), 'Listening · go ahead');
  assert.equal(mcSessionStatus({ phase: 'listening', micEnabled: true, userSpeaking: true }), 'Hearing you…');
  assert.equal(mcSessionStatus({ phase: 'thinking', micEnabled: false }), 'Got it · replying');
  assert.match(mcSessionStatus({ phase: 'speaking', listeningMode: 'turns' }), /mic paused/);
  assert.match(mcSessionStatus({ phase: 'speaking', listeningMode: 'continuous', micEnabled: true }), /interrupt/);
});

test('MC status shows a reconnect without hiding a reply that is still playing', () => {
  assert.match(mcSessionStatus({ phase: 'listening', micEnabled: true, reconnecting: true }), /reconnecting/);
  assert.match(mcSessionStatus({ phase: 'speaking', listeningMode: 'turns', reconnecting: true }), /speaking/);
});

test('MC status treats a reply that is still being voiced as replying, not speaking', () => {
  assert.equal(mcSessionStatus({ phase: 'speaking', listeningMode: 'turns', micEnabled: true, replyAudible: false }), 'Got it · replying');
  assert.equal(mcSessionStatus({ phase: 'speaking', listeningMode: 'turns', micEnabled: true, replyAudible: false, userSpeaking: true }), 'Hearing you…');
});

test('MC transcript keeps every bubble, tags cut-short replies and shows placeholders as pending', () => {
  assert.deepEqual(mcTranscriptEntries([
    { id: 'u1', role: 'user', text: 'Our first guest is' },
    { id: 'a1', role: 'assistant', text: 'Who is', status: 'interrupted' },
    { id: 'u2', role: 'user', text: 'Listening...' },
  ]), [
    { id: 'u1', role: 'user', text: 'Our first guest is', pending: false, interrupted: false },
    { id: 'a1', role: 'assistant', text: 'Who is', pending: false, interrupted: true },
    { id: 'u2', role: 'user', text: '', pending: true, interrupted: false },
  ]);
});

test('MC capture sliders map to measured VAD and noise settings', () => {
  assert.deepEqual(mcSessionOptions(), {
    turnDetection: { type: 'server_vad', threshold: 0.65, silenceMs: 700, prefixMs: 500 },
    noiseReduction: 'far_field',
  });
  assert.deepEqual(mcSessionOptions({ noiseLevel: 0, pauseMs: 1200 }), {
    turnDetection: { type: 'server_vad', threshold: 0.5, silenceMs: 1200, prefixMs: 500 },
    noiseReduction: 'off',
  });
  assert.equal(mcSessionOptions({ noiseLevel: 4 }).turnDetection.threshold, 0.8);
  assert.deepEqual(mcMicConstraints({ noiseLevel: 0 }), { noiseSuppression: false });
  assert.deepEqual(normalizeCaptureSettings({ noiseLevel: 9, pauseMs: 9999 }), { noiseLevel: 2, pauseMs: 700 });
  assert.deepEqual(normalizeCaptureSettings({ noiseLevel: '3', pauseMs: 840 }), { noiseLevel: 3, pauseMs: 800 });
  assert.equal(sameCaptureSettings({ noiseLevel: 2, pauseMs: 700 }, {}), true);
});

test('saved MC instructions load as written and fall back to the default when unusable', () => {
  assert.equal(normalizeSavedInstructions('Tonight is the alumni gala.'), 'Tonight is the alumni gala.');
  for (const value of [null, undefined, '', '   ', 42, { prompt: 'x' }, 'x'.repeat(MC_INSTRUCTIONS_MAX + 1)]) {
    assert.equal(normalizeSavedInstructions(value), MC_SYSTEM_PROMPT);
  }
});
