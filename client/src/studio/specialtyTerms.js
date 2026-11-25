// Part 2 of the recording portal: the lecturer reads medical terms from their
// specialty. Terms come from the AI, a pasted list or a spreadsheet; they are
// read inside short connected scenarios (sentence-sized clips for training,
// natural teaching prosody), and the text read is sent with the recording so
// training labels those clips with it rather than the recogniser's guess.

export const TERM_COUNTS = Object.freeze([50, 100]);
export const TERMS_PER_SCENARIO = 10;
export const MAX_TERMS = 150;
const MAX_TERM_LENGTH = 80;
const WORDS_PER_MINUTE = 125;
const MINUTES_PER_TERM = 0.14;
const SENTENCES_PER_PARAGRAPH = 5;
const CLINICAL_CUE = 'Say each term the way you would teaching on the ward — clear and unhurried. Pause briefly at every full stop.';

function cleanTerm(value) {
  return String(value ?? '')
    .replace(/^\s*(?:[-*•·]|\d+[.)])\s*/u, '')
    .replace(/[\u0000-\u001f|]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, MAX_TERM_LENGTH);
}

function cleanSentence(value) {
  return String(value ?? '').replace(/[\u0000-\u001f|]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/** Terms from pasted text: one per line, or separated by commas or semicolons. */
export function parseTermList(text) {
  const seen = new Set();
  const terms = [];
  for (const piece of String(text || '').split(/[\n\r,;\t]+/u)) {
    const term = cleanTerm(piece);
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms;
}

/** Rows of a CSV file (quoted cells may hold commas, newlines and "" quotes). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const source = String(text || '').replace(/^﻿/u, '');
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { cell += '"'; i += 1; } else if (char === '"') { quoted = false; } else { cell += char; }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell); cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else {
      cell += char;
    }
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Spreadsheet rows → [{ term, sentence }]: column A the term, column B an optional sentence. */
export function rowsToEntries(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const startsWithHeader = /^\s*(terms?|words?|medical terms?)\s*$/iu.test(String(list[0]?.[0] ?? ''));
  return list
    .slice(startsWithHeader ? 1 : 0)
    .map((row) => ({ term: cleanTerm(row?.[0]), sentence: cleanSentence(row?.[1]) }))
    .filter((entry) => entry.term)
    .slice(0, MAX_TERMS);
}

/** The list with new entries appended (source: ai | pasted | excel), skipping terms already in it. */
export function addEntries(list, incoming, source) {
  const seen = new Set(list.map((entry) => entry.term.toLowerCase()));
  const added = [];
  for (const entry of incoming) {
    const term = cleanTerm(entry.term);
    const key = term.toLowerCase();
    if (!term || seen.has(key) || list.length + added.length >= MAX_TERMS) continue;
    seen.add(key);
    added.push({ term, source, sentence: cleanSentence(entry.sentence) });
  }
  return [...list, ...added];
}

export function chunk(items, size) {
  const groups = [];
  for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size));
  return groups;
}

function wordCount(paragraphs) {
  return paragraphs.join(' ').split(/\s+/u).filter(Boolean).length;
}

function section({ index, title, paragraphs, terms }) {
  return {
    id: `terms-${index + 1}`,
    title,
    mood: 'Clinical',
    cue: CLINICAL_CUE,
    paragraphs,
    terms,
    minutes: Math.max(1, Math.round(wordCount(paragraphs) / WORDS_PER_MINUTE)),
  };
}

/** AI scenarios ({ title, paragraphs, terms }) → reading sections numbered from startIndex. */
export function scenarioSections(scenarios, startIndex = 0) {
  return scenarios.map((scenario, offset) => section({
    index: startIndex + offset, title: scenario.title, paragraphs: scenario.paragraphs, terms: scenario.terms,
  }));
}

/** Sentences the lecturer supplied (spreadsheet column B), ten to a section. */
export function ownSentenceSections(entries, startIndex = 0) {
  return chunk(entries, TERMS_PER_SCENARIO).map((group, offset) => section({
    index: startIndex + offset,
    title: 'Your own sentences',
    paragraphs: chunk(group.map((entry) => entry.sentence), SENTENCES_PER_PARAGRAPH).map((sentences) => sentences.join(' ')),
    terms: group.map((entry) => entry.term),
  }));
}

function asSentence(term) {
  const capitalised = term.charAt(0).toUpperCase() + term.slice(1);
  return /[.!?]$/u.test(capitalised) ? capitalised : `${capitalised}.`;
}

/** Terms read on their own (when the lecturer turns scenarios off). */
export function termsAloneSections(terms, startIndex = 0) {
  return chunk(terms, TERMS_PER_SCENARIO).map((group, offset) => section({
    index: startIndex + offset,
    title: 'Terms on their own',
    paragraphs: chunk(group.map(asSentence), SENTENCES_PER_PARAGRAPH).map((sentences) => sentences.join(' ')),
    terms: group,
  }));
}

/** The text of the sections read while recording, in script order. */
export function knownTextOf(sections, readIds) {
  return sections
    .filter((item) => readIds.has(item.id))
    .flatMap((item) => item.paragraphs)
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** A paragraph split into plain text and term spans, for highlighting. */
export function highlightParts(paragraph, terms) {
  const text = String(paragraph || '');
  const wanted = [...new Set((terms || []).map((term) => String(term || '').trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  if (wanted.length === 0) return [{ text, isTerm: false }];
  const pattern = new RegExp(`(${wanted.map(escapeRegExp).join('|')})`, 'giu');
  return text.split(pattern).filter(Boolean).map((piece) => ({
    text: piece,
    isTerm: wanted.some((term) => term.toLowerCase() === piece.toLowerCase()),
  }));
}

export function termsMinutes(count) {
  return Math.round(count * MINUTES_PER_TERM);
}

export function sectionMinutes(sections) {
  return sections.reduce((sum, item) => sum + (item.minutes || 0), 0);
}
