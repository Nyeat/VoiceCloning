import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareSpeechText } from './speechText.js';

test('slide bullets and headings become sentences', () => {
  const slide = 'Learning objectives:\n• Describe the cell cycle\n• Explain mitosis; compare with meiosis\n1. DNA replication - S phase\n2) Checkpoints (G1/S, G2/M)';
  assert.equal(
    prepareSpeechText(slide),
    'Learning objectives. Describe the cell cycle. Explain mitosis. Compare with meiosis. DNA replication, S phase. Checkpoints, G1 S, G2 M.',
  );
});

test('colons become pauses but times stay; symbols become words', () => {
  assert.equal(prepareSpeechText('Key idea: blood pressure -> organ damage & stroke at 10:30'), 'Key idea, blood pressure to organ damage and stroke at 10:30.');
  assert.equal(prepareSpeechText('Dose is 2.5 mg, e.g. for adults... 50% respond'), 'Dose is 2.5 mg, e.g. for adults. 50 percent respond.');
});

test('normal prose is left as it is', () => {
  const prose = "Good morning, everyone. Today we're looking at the heart! Any questions?";
  assert.equal(prepareSpeechText(prose), prose);
});

test('other languages are only trimmed', () => {
  assert.equal(prepareSpeechText('  你好：世界；  ', 'zh'), '你好：世界；');
});

test('curly apostrophes stay inside words', () => {
  assert.equal(prepareSpeechText('We’re here; it’s fine'), "We're here. It's fine.");
});
