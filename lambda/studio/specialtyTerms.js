// Part 2 of the recording portal: the medical terms of a lecturer's specialty.
//
// The AI writes (a) a list of terms for a specialty and (b) short teaching
// scenarios that use given terms, which the lecturer reads aloud. Scenarios are
// connected sentences of 8–18 words: the slicer cuts clips at sentence pauses,
// and reading in context sounds like teaching, not a word list.
//
// Each call is small (one list, or one scenario of ≤12 terms) so it finishes
// well inside the API's ~30 s limit; the page makes several calls in parallel.
import { clientError } from './workflow.js';

export const TERM_COUNTS = Object.freeze([50, 100]);
export const MAX_TERMS_PER_SCENARIO = 12;
const MAX_SPECIALTY_LENGTH = 120;
const MAX_FOCUS_LENGTH = 200;
const MAX_TERM_LENGTH = 80;
const MAX_KNOWN_TEXT_LENGTH = 200_000;
const MIN_LIST_SHARE = 0.6;
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4.1-mini';
const REQUEST_TIMEOUT_MS = 25_000;

function cleanLine(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f|]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max);
}

function cleanSpecialty(value) {
  const specialty = cleanLine(value, MAX_SPECIALTY_LENGTH);
  if (!specialty) throw clientError(400, 'Please enter your specialty');
  return specialty;
}

function uniqueTerms(values, max = Infinity) {
  const seen = new Set();
  const terms = [];
  for (const value of Array.isArray(values) ? values : []) {
    const term = cleanLine(value, MAX_TERM_LENGTH);
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= max) break;
  }
  return terms;
}

export function validateTermsRequest(body = {}) {
  const count = Number(body.count);
  if (!TERM_COUNTS.includes(count)) throw clientError(400, 'Choose 50 or 100 terms');
  return { specialty: cleanSpecialty(body.specialty), focus: cleanLine(body.focus, MAX_FOCUS_LENGTH), count };
}

export function validateScenarioRequest(body = {}) {
  const raw = Array.isArray(body.terms) ? body.terms : [];
  if (raw.length > MAX_TERMS_PER_SCENARIO) throw clientError(400, `At most ${MAX_TERMS_PER_SCENARIO} terms per scenario`);
  const terms = uniqueTerms(raw);
  if (terms.length === 0) throw clientError(400, 'Add at least one term');
  return { specialty: cleanSpecialty(body.specialty), terms };
}

const SYSTEM_PROMPT = 'You help clinicians record speech for a voice-cloning system that will read medical teaching material aloud in their voice. Reply with JSON only.';

export async function generateTermList({ specialty, focus = '', count }, { callModel }) {
  const prompt = [
    `List exactly ${count} distinct medical terms that a clinician specialising in "${specialty}" says often when teaching${focus ? `, with emphasis on: ${focus}` : ''}.`,
    'Prefer words that are hard to pronounce or easy to mispronounce: conditions, signs, investigations, procedures, scoring systems, drug names, anatomy, and abbreviations that are spoken aloud in this field.',
    'Use British spelling. One term per entry, no explanations.',
    'Return {"terms": ["..."]}.',
  ].join(' ');
  const reply = await callModel([{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }]);
  const terms = uniqueTerms(reply?.terms, count);
  if (terms.length < Math.ceil(count * MIN_LIST_SHARE)) {
    throw clientError(502, 'The AI returned too few terms. Please try again.');
  }
  return terms;
}

function scenarioPrompt(specialty, terms, missing = []) {
  return [
    `Write a short teaching scenario to be read aloud by a clinician specialising in "${specialty}".`,
    `Use every one of these terms exactly as written, each at least once: ${terms.map((term) => `"${term}"`).join(', ')}.`,
    'Rules: two paragraphs of three to five sentences each; every sentence 8 to 18 words, plain and natural, like teaching students on a ward round;',
    'no lists, headings, brackets or quotation marks; write numbers as words; British spelling.',
    'Also give a title of two to five words.',
    missing.length ? `Your last answer left out: ${missing.map((term) => `"${term}"`).join(', ')}. Include them this time.` : '',
    'Return {"title": "...", "paragraphs": ["...", "..."]}.',
  ].filter(Boolean).join(' ');
}

function containsTerm(paragraphs, term) {
  const flatten = (text) => text.toLowerCase().replace(/[\s\-–—]+/gu, ' ');
  return flatten(paragraphs.join(' ')).includes(flatten(term));
}

function cleanParagraphs(value) {
  return (Array.isArray(value) ? value : []).map((paragraph) => cleanLine(paragraph, 2000)).filter(Boolean);
}

/** One reading section: { title, paragraphs, missing } where every term appears in the paragraphs. */
export async function writeScenario({ specialty, terms }, { callModel }) {
  const ask = (missing) => callModel([{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: scenarioPrompt(specialty, terms, missing) }]);
  let reply = await ask([]);
  let paragraphs = cleanParagraphs(reply?.paragraphs);
  let missing = terms.filter((term) => !containsTerm(paragraphs, term));
  if (paragraphs.length === 0 || missing.length > 0) {
    reply = await ask(paragraphs.length ? missing : []);
    const retried = cleanParagraphs(reply?.paragraphs);
    if (retried.length) paragraphs = retried;
    missing = terms.filter((term) => !containsTerm(paragraphs, term));
  }
  // Still left out: a plain sentence each, so every term is recorded once.
  if (missing.length) {
    paragraphs = [...paragraphs, missing.map((term) => `In this topic we also need to say ${term} clearly.`).join(' ')];
  }
  return { title: cleanLine(reply?.title, 60) || 'Specialty terms', paragraphs, missing };
}

/**
 * The OpenAI call used by both, injectable for tests. Throws 503 when no key
 * is set and 502 when OpenAI fails (never echoing the key).
 */
export function createOpenAiCaller({ apiKey, model = DEFAULT_MODEL, fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return async function callModel(messages) {
    if (!apiKey) throw clientError(503, 'Generating terms is not set up yet (no OpenAI key). Paste or upload your terms instead.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(OPENAI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, response_format: { type: 'json_object' }, temperature: 0.7 }),
        signal: controller.signal,
      });
    } catch (error) {
      throw clientError(502, error.name === 'AbortError' ? 'The AI took too long. Please try again.' : 'Could not reach the AI service. Please try again.');
    } finally {
      clearTimeout(timer);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.warn('[studio] OpenAI request failed', response.status, payload?.error?.message || '');
      throw clientError(502, `The AI service refused the request (${response.status}). Please try again.`);
    }
    try {
      return JSON.parse(payload?.choices?.[0]?.message?.content || '{}');
    } catch {
      throw clientError(502, 'The AI returned something unreadable. Please try again.');
    }
  };
}

/**
 * The known script text sent with a submission, as { [file name]: text } for
 * the recordings of this set only. The training worker labels their clips with it.
 */
export function knownTextFiles(knownText, { prefix, keys }) {
  if (!knownText || typeof knownText !== 'object' || Array.isArray(knownText)) return {};
  const allowed = new Set(keys);
  const files = {};
  for (const [key, value] of Object.entries(knownText)) {
    if (!allowed.has(key) || !key.startsWith(prefix) || typeof value !== 'string') continue;
    if (value.length > MAX_KNOWN_TEXT_LENGTH) throw clientError(400, 'The reading script sent with a recording is too long');
    const text = value.replace(/[\u0000-\u001f|]+/gu, ' ').replace(/\s+/gu, ' ').trim();
    if (text) files[key.slice(prefix.length)] = text;
  }
  return files;
}
