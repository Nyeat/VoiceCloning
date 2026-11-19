import test from 'node:test';
import assert from 'node:assert/strict';
import { pickPrewarmVoice } from './prewarmVoice.js';

test('prewarm picks the most recently used own voice that has a saved profile', () => {
  const voices = [
    { voiceProfileId: 'a', updatedAt: '2026-11-01T00:00:00Z' },
    { voiceProfileId: 'b', activatedAt: '2026-11-18T00:00:00Z' },
    { voiceProfileId: 'c', activatedAt: '2026-11-19T00:00:00Z', hasSavedProfile: false },
    { voiceProfileId: 'd', activatedAt: '2026-11-19T00:00:00Z', isMine: false },
  ];
  assert.equal(pickPrewarmVoice(voices).voiceProfileId, 'b');
  assert.equal(pickPrewarmVoice([]), null);
});
