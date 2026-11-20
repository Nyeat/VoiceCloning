import test from 'node:test';
import assert from 'node:assert/strict';
import {
  voiceNameFromModelRef,
  applyVoiceSoundsLike,
  mergeVoiceArpabet,
  buildHotDictionaryLines,
  loadVoicePronunciationEntries,
} from './runtimePronunciationDictionary.js';
import { prepareTextBeforeNormalization } from '../routes/inference.js';

test('voice name comes from the weight file name', () => {
  assert.equal(voiceNameFromModelRef('models/user-models/gpt/alice_2-e15.ckpt'), 'alice_2');
  assert.equal(voiceNameFromModelRef('models/user-models/sovits/alice_e8_s120.pth'), 'alice');
  assert.equal(voiceNameFromModelRef(''), '');
});

test('sounds-like respellings replace whole words only', () => {
  const entries = [{ word: 'cohesin', soundsLike: 'koh hee sin' }];
  assert.equal(applyVoiceSoundsLike('Cohesin binds; cohesins differ.', entries), 'koh hee sin binds; cohesins differ.');
});

test('a voice ARPAbet entry outranks the shared dictionary', () => {
  const merged = mergeVoiceArpabet(
    [{ word: 'tomato', arpabet: 'T AH0 M EY1 T OW2', updatedAt: '2026-01-01T00:00:00Z' }],
    [{ word: 'tomato', arpabet: 'T AH0 M AA1 T OW2', soundsLike: '' }],
  );
  assert.deepEqual(buildHotDictionaryLines(merged), ['TOMATO T AH0 M AA1 T OW2']);
});

test('missing voice library is empty, not an error', async () => {
  const entries = await loadVoicePronunciationEntries('nobody', { readObject: async () => { throw new Error('NoSuchKey'); }, force: true });
  assert.deepEqual(entries, []);
});

test('synthesis text uses only the requested voice library', async () => {
  const loadVoiceEntries = async (name) => (name === 'alice' ? [{ word: 'cohesin', soundsLike: 'koh hee sin', arpabet: '' }] : []);
  const loadEntries = async () => [];
  const alice = await prepareTextBeforeNormalization('cohesin', { loadEntries, loadVoiceEntries, voiceModel: { gptRef: 'gpt/alice-e15.ckpt' } });
  const bob = await prepareTextBeforeNormalization('cohesin', { loadEntries, loadVoiceEntries, voiceModel: { gptRef: 'gpt/bob-e15.ckpt' } });
  assert.match(alice, /koh hee sin/u);
  assert.doesNotMatch(bob, /koh hee sin/u);
});
