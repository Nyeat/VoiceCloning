import test from 'node:test';
import assert from 'node:assert/strict';
import { READING_SCRIPT, readingScriptText, readingScriptWordCount } from './readingScript.js';

const sentences = READING_SCRIPT
  .flatMap((section) => section.paragraphs)
  .join(' ')
  .split(/(?<=[.?!])\s+/u);

test('the reading script is long enough to train on (~10 minutes or more)', () => {
  assert.ok(readingScriptWordCount() >= 1_300, `only ${readingScriptWordCount()} words`);
});

test('sentences fit the slicer and reference picker (about 4-9 s each when read)', () => {
  // ~2.5 words/s: 22 words ≈ 9 s. Longer sentences become clips the reference
  // picker scores down; the pipeline cuts at pauses between sentences.
  const tooLong = sentences.filter((sentence) => sentence.split(/\s+/u).length > 22);
  assert.deepEqual(tooLong, []);
});

test('copied text keeps every section and paragraph', () => {
  const text = readingScriptText();
  for (const section of READING_SCRIPT) {
    assert.ok(text.includes(section.title.toUpperCase()));
    for (const paragraph of section.paragraphs) assert.ok(text.includes(paragraph));
  }
});
