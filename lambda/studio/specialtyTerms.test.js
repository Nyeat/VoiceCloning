import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOpenAiCaller, generateTermList, knownTextFiles, validateScenarioRequest, validateTermsRequest, writeScenario,
} from './specialtyTerms.js';

test('validateTermsRequest accepts 50 or 100 terms and trims the specialty', () => {
  assert.deepEqual(validateTermsRequest({ specialty: '  GI bleeding ', focus: 'drugs', count: 100 }), { specialty: 'GI bleeding', focus: 'drugs', count: 100 });
  assert.throws(() => validateTermsRequest({ specialty: 'GI', count: 30 }), /50 or 100/u);
  assert.throws(() => validateTermsRequest({ specialty: '  ', count: 50 }), /specialty/iu);
});

test('validateScenarioRequest caps terms per scenario and drops blanks', () => {
  const result = validateScenarioRequest({ specialty: 'Cardiology', terms: [' atrial fibrillation ', '', 'troponin'] });
  assert.deepEqual(result.terms, ['atrial fibrillation', 'troponin']);
  assert.throws(() => validateScenarioRequest({ specialty: 'Cardiology', terms: Array.from({ length: 13 }, (_, i) => `term ${i}`) }), /12/u);
  assert.throws(() => validateScenarioRequest({ specialty: 'Cardiology', terms: [] }), /term/iu);
});

test('generateTermList de-duplicates and trims to the requested count', async () => {
  const terms = Array.from({ length: 55 }, (_, i) => `term ${i}`);
  const callModel = async () => ({ terms: ['Melaena', 'melaena', ...terms] });
  const result = await generateTermList({ specialty: 'GI', focus: '', count: 50 }, { callModel });
  assert.equal(result.length, 50);
  assert.equal(result[0], 'Melaena');
  assert.equal(result.filter((term) => term.toLowerCase() === 'melaena').length, 1);
});

test('generateTermList fails clearly when the model returns too few terms', async () => {
  await assert.rejects(generateTermList({ specialty: 'GI', count: 50 }, { callModel: async () => ({ terms: ['one'] }) }), /too few/iu);
});

test('writeScenario returns paragraphs that contain every term', async () => {
  const callModel = async () => ({ title: 'A bleed', paragraphs: ['He had melaena for three days.', 'We gave terlipressin early.'] });
  const result = await writeScenario({ specialty: 'GI', terms: ['melaena', 'terlipressin'] }, { callModel });
  assert.equal(result.title, 'A bleed');
  assert.deepEqual(result.paragraphs, ['He had melaena for three days.', 'We gave terlipressin early.']);
  assert.deepEqual(result.missing, []);
});

test('writeScenario retries once, then adds a plain sentence for a term the model keeps leaving out', async () => {
  let calls = 0;
  const callModel = async () => {
    calls += 1;
    return { title: 'A bleed', paragraphs: ['He had melaena for three days.'] };
  };
  const result = await writeScenario({ specialty: 'GI', terms: ['melaena', 'Dieulafoy lesion'] }, { callModel });
  assert.equal(calls, 2);
  assert.deepEqual(result.missing, ['Dieulafoy lesion']);
  assert.match(result.paragraphs.at(-1), /Dieulafoy lesion/u);
});

test('writeScenario strips characters that would break the training manifest', async () => {
  const callModel = async () => ({ title: 'T', paragraphs: ['He had melaena | for three days.\nThen more.'] });
  const result = await writeScenario({ specialty: 'GI', terms: ['melaena'] }, { callModel });
  assert.equal(result.paragraphs[0], 'He had melaena for three days. Then more.');
});

test('createOpenAiCaller sends a JSON-mode chat request and parses the reply', async () => {
  let sent = null;
  const fetchImpl = async (url, options) => {
    sent = { url, options };
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"terms":["a"]}' } }] }) };
  };
  const call = createOpenAiCaller({ apiKey: 'sk-test', model: 'test-model', fetchImpl });
  assert.deepEqual(await call([{ role: 'user', content: 'hi' }]), { terms: ['a'] });
  const body = JSON.parse(sent.options.body);
  assert.equal(body.model, 'test-model');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(sent.options.headers.Authorization, 'Bearer sk-test');
});

test('createOpenAiCaller without a key reports that generation is not configured', async () => {
  const call = createOpenAiCaller({ apiKey: '', fetchImpl: async () => { throw new Error('should not be called'); } });
  await assert.rejects(call([]), (error) => error.statusCode === 503);
});

test('createOpenAiCaller turns an OpenAI error into a 502 without leaking the key', async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'Rate limit' } }) });
  const call = createOpenAiCaller({ apiKey: 'sk-secret', fetchImpl });
  await assert.rejects(call([]), (error) => error.statusCode === 502 && !error.message.includes('sk-secret'));
});

test('knownTextFiles keeps only recordings in this set, keyed by file name', () => {
  const prefix = 'training/datasets/v1/raw/';
  const files = knownTextFiles({
    [`${prefix}terms.wav`]: 'Melaena means black stool.',
    [`${prefix}other.wav`]: '   ',
    'training/datasets/someone-else/raw/x.wav': 'Not ours.',
  }, { prefix, keys: [`${prefix}terms.wav`, `${prefix}other.wav`] });
  assert.deepEqual(files, { 'terms.wav': 'Melaena means black stool.' });
});

test('knownTextFiles refuses an oversized script', () => {
  const prefix = 'training/datasets/v1/raw/';
  assert.throws(() => knownTextFiles({ [`${prefix}t.wav`]: 'x'.repeat(200_001) }, { prefix, keys: [`${prefix}t.wav`] }), /too long/iu);
});

test('chargeAiUse counts per person per day and refuses past the limit', async () => {
  const { chargeAiUse } = await import('./specialtyTerms.js');
  const state = { aiUsage: { 'old@x.com': { day: '2026-01-01', terms: 9, scenarios: 0 } } };
  const now = Date.parse('2026-11-25T03:00:00Z');
  const limits = { terms: 2, scenarios: 1 };
  chargeAiUse(state, { email: 'a@x.com', kind: 'terms', now, limits });
  chargeAiUse(state, { email: 'a@x.com', kind: 'terms', now, limits });
  assert.throws(() => chargeAiUse(state, { email: 'a@x.com', kind: 'terms', now, limits }), (error) => error.statusCode === 429);
  chargeAiUse(state, { email: 'b@x.com', kind: 'terms', now, limits });
  assert.equal(state.aiUsage['old@x.com'], undefined, 'other days are pruned');
  chargeAiUse(state, { email: 'a@x.com', kind: 'terms', now: Date.parse('2026-11-26T03:00:00Z'), limits });
  assert.equal(state.aiUsage['a@x.com'].terms, 1, 'a new day starts again');
});
