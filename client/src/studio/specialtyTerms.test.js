import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addEntries, chunk, highlightParts, knownTextOf, ownSentenceSections, parseCsv, parseTermList, rowsToEntries,
  sectionMinutes, scenarioSections, termsAloneSections, termsMinutes,
} from './specialtyTerms.js';

test('parseTermList splits lines, commas and semicolons, strips bullets and de-duplicates', () => {
  const terms = parseTermList('1. haematochezia\n• melaena, Melaena\n- Glasgow-Blatchford score; Rockall score\n\n  terlipressin  ');
  assert.deepEqual(terms, ['haematochezia', 'melaena', 'Glasgow-Blatchford score', 'Rockall score', 'terlipressin']);
});

test('parseCsv handles quoted cells with commas and escaped quotes', () => {
  assert.deepEqual(parseCsv('term,sentence\n"Mallory-Weiss tear","A tear, after ""retching""."\nmelaena,\n'), [
    ['term', 'sentence'],
    ['Mallory-Weiss tear', 'A tear, after "retching".'],
    ['melaena', ''],
  ]);
});

test('rowsToEntries skips a header row and keeps an optional own sentence', () => {
  const entries = rowsToEntries([['Term', 'Sentence'], ['melaena', 'Black stool is called melaena.'], ['  terlipressin ', null], [null, 'orphan sentence'], [42, '']]);
  assert.deepEqual(entries, [
    { term: 'melaena', sentence: 'Black stool is called melaena.' },
    { term: 'terlipressin', sentence: '' },
    { term: '42', sentence: '' },
  ]);
});

test('addEntries appends new terms with their source and ignores ones already listed', () => {
  const list = addEntries([{ term: 'melaena', source: 'ai', sentence: '' }], [{ term: 'Melaena' }, { term: 'TIPS', sentence: '' }], 'pasted');
  assert.deepEqual(list.map((entry) => [entry.term, entry.source]), [['melaena', 'ai'], ['TIPS', 'pasted']]);
});

test('chunk splits into groups of a given size', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('scenarioSections turns AI scenarios into numbered reading sections with their terms', () => {
  const sections = scenarioSections([
    { title: 'A patient with melaena', paragraphs: ['He had melaena for three days.'], terms: ['melaena'] },
  ], 0);
  assert.equal(sections[0].id, 'terms-1');
  assert.equal(sections[0].title, 'A patient with melaena');
  assert.equal(sections[0].mood, 'Clinical');
  assert.deepEqual(sections[0].terms, ['melaena']);
  assert.ok(sections[0].minutes >= 1);
});

test('ownSentenceSections groups uploaded sentences, ten to a section', () => {
  const entries = Array.from({ length: 12 }, (_, i) => ({ term: `t${i}`, sentence: `Sentence about t${i}.` }));
  const sections = ownSentenceSections(entries, 3);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].id, 'terms-4');
  assert.equal(sections[0].paragraphs[0].split('. ').length, 5);
  assert.deepEqual(sections[1].terms, ['t10', 't11']);
});

test('termsAloneSections lists terms as short sentences when no scenario is wanted', () => {
  const sections = termsAloneSections(['melaena', 'TIPS'], 0);
  assert.equal(sections[0].paragraphs[0], 'Melaena. TIPS.');
});

test('knownTextOf joins the paragraphs of the sections that were read', () => {
  const sections = [
    { id: 'terms-1', paragraphs: ['One two.', 'Three four.'] },
    { id: 'terms-2', paragraphs: ['Five six.'] },
  ];
  assert.equal(knownTextOf(sections, new Set(['terms-1', 'terms-2'])), 'One two. Three four. Five six.');
  assert.equal(knownTextOf(sections, new Set(['terms-2'])), 'Five six.');
});

test('highlightParts marks each term, ignoring case and keeping the original text', () => {
  const parts = highlightParts('Melaena and TIPS; then melaena again.', ['melaena', 'TIPS']);
  assert.deepEqual(parts, [
    { text: 'Melaena', isTerm: true },
    { text: ' and ', isTerm: false },
    { text: 'TIPS', isTerm: true },
    { text: '; then ', isTerm: false },
    { text: 'melaena', isTerm: true },
    { text: ' again.', isTerm: false },
  ]);
});

test('highlightParts prefers the longer of two overlapping terms', () => {
  const parts = highlightParts('Oesophageal varices bleed.', ['varices', 'oesophageal varices']);
  assert.deepEqual(parts[0], { text: 'Oesophageal varices', isTerm: true });
});

test('termsMinutes estimates reading time for 50 and 100 terms', () => {
  assert.equal(termsMinutes(50), 7);
  assert.equal(termsMinutes(100), 14);
  assert.equal(sectionMinutes([{ minutes: 2 }, { minutes: 3 }]), 5);
});
