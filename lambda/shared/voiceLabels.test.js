import assert from 'node:assert/strict';
import test from 'node:test';
import { readVoiceLabels } from './voiceLabels.js';

test('saved voice names: lecturer names win over studio names; bad records are skipped', async () => {
  const files = {
    'voice-labels/cs-a_1.json': JSON.stringify({ label: 'Lecture voice' }),
    'voice-labels/cs-b_2.json': '{not json',
  };
  const labels = await readVoiceLabels({
    list: async () => Object.keys(files).map((key) => ({ key })),
    read: async (key) => Buffer.from(files[key]),
    studioLabels: async () => ({ 'cs-a_1': 'My voice · A', 'x-c_3': 'My voice · C' }),
  });
  assert.deepEqual(labels, { 'cs-a_1': 'Lecture voice', 'x-c_3': 'My voice · C' });
});

test('saved voice names never throw', async () => {
  const labels = await readVoiceLabels({
    list: async () => { throw new Error('no bucket'); },
    studioLabels: async () => { throw new Error('no state'); },
  });
  assert.deepEqual(labels, {});
});
