import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clipSource, relabelManifest, alignWords, sameWord,
} from './knownTextLabels.js';

const SCRIPT = 'A sixty-eight-year-old man arrives with three days of melaena. Before anything else, we work out his Glasgow-Blatchford score. '
  + 'His score is twelve, so he needs an urgent oesophagogastroduodenoscopy. At endoscopy, we find a duodenal ulcer with a visible vessel.';

function line(file, text) {
  return `/data/denoised/${file}|denoised|EN|${text}`;
}

test('clipSource strips the slicer suffix and keeps the original file name', () => {
  assert.equal(clipSource('terms-abc.wav_0000000000_0000152320.wav'), 'terms-abc.wav');
  assert.equal(clipSource('terms-abc_0000000000_0000152320.wav'), 'terms-abc');
  assert.equal(clipSource('plain.wav'), null);
});

test('sameWord tolerates British/American spellings of a long medical term', () => {
  assert.equal(sameWord('haematochezia', 'hematochezia'), true);
  assert.equal(sameWord('melaena', 'melena'), true);
  assert.equal(sameWord('his', 'is'), false);
  assert.equal(sameWord('score', 'scope'), false);
});

test('alignWords maps ASR words onto script words in order', () => {
  const pairs = alignWords(['we', 'work', 'out', 'his', 'glasgow', 'blatch', 'score'], ['before', 'anything', 'else', 'we', 'work', 'out', 'his', 'glasgowblatchford', 'score']);
  const mapped = new Map(pairs);
  assert.equal(mapped.get(0), 3);
  assert.equal(mapped.get(3), 6);
  assert.equal(mapped.get(6), 8);
});

test('relabelManifest replaces garbled ASR text with the known script text', () => {
  const manifest = [
    line('terms-1.wav_0000000000_0000100000.wav', 'A sixty eight year old man arrives with three days of Malena.'),
    line('terms-1.wav_0000100000_0000200000.wav', 'Before anything else, we work out his Glasgow Blatchford score.'),
    line('terms-1.wav_0000200000_0000300000.wav', 'His score is twelve, so he needs an urgent oesophago gastro duo denoscopy.'),
    line('terms-1.wav_0000300000_0000400000.wav', 'At endoscopy we find a duodenal ulcer with a visible vessel.'),
    line('reading-1.wav_0000000000_0000100000.wav', 'Good morning everyone.'),
  ].join('\n');

  const { manifestText, report } = relabelManifest({ manifestText: manifest, knownText: { 'terms-1.wav': SCRIPT } });
  const texts = manifestText.trim().split('\n').map((row) => row.split('|')[3]);

  assert.equal(texts[0], 'A sixty-eight-year-old man arrives with three days of melaena.');
  assert.equal(texts[1], 'Before anything else, we work out his Glasgow-Blatchford score.');
  assert.equal(texts[2], 'His score is twelve, so he needs an urgent oesophagogastroduodenoscopy.');
  assert.equal(texts[3], 'At endoscopy, we find a duodenal ulcer with a visible vessel.');
  assert.equal(texts[4], 'Good morning everyone.', 'clips from other files keep their ASR text');
  assert.equal(report.relabelled, 4);
  assert.equal(report.keptAsr, 0);
});

test('relabelManifest keeps the other manifest fields untouched', () => {
  const manifest = line('terms-1.wav_0000000000_0000100000.wav', 'A sixty eight year old man arrives with three days of Malena.');
  const { manifestText } = relabelManifest({ manifestText: manifest, knownText: { 'terms-1.wav': SCRIPT } });
  const [audio, speaker, language] = manifestText.trim().split('|');
  assert.equal(audio, '/data/denoised/terms-1.wav_0000000000_0000100000.wav');
  assert.equal(speaker, 'denoised');
  assert.equal(language, 'EN');
});

test('a clip that does not match the script keeps its ASR text', () => {
  const manifest = [
    line('terms-1.wav_0000000000_0000100000.wav', 'Sorry, let me start that again, one moment please.'),
    line('terms-1.wav_0000100000_0000200000.wav', 'Before anything else, we work out his Glasgow Blatchford score.'),
  ].join('\n');
  const { manifestText, report } = relabelManifest({ manifestText: manifest, knownText: { 'terms-1.wav': SCRIPT } });
  const texts = manifestText.trim().split('\n').map((row) => row.split('|')[3]);
  assert.equal(texts[0], 'Sorry, let me start that again, one moment please.');
  assert.equal(texts[1], 'Before anything else, we work out his Glasgow-Blatchford score.');
  assert.equal(report.keptAsr, 1);
});

test('a skipped section between two clips is not glued onto either clip', () => {
  const script = 'First we look at the stool colour. Then we check the pulse. Black stool is called melaena. Fresh blood is called haematochezia.';
  const manifest = [
    line('t.wav_0000000000_0000100000.wav', 'First we look at the stool colour.'),
    line('t.wav_0000100000_0000200000.wav', 'Fresh blood is called hematochezia.'),
  ].join('\n');
  const { manifestText } = relabelManifest({ manifestText: manifest, knownText: { 't.wav': script } });
  const texts = manifestText.trim().split('\n').map((row) => row.split('|')[3]);
  assert.equal(texts[0], 'First we look at the stool colour.');
  assert.equal(texts[1], 'Fresh blood is called haematochezia.');
});

test('a garbled term at the edge of a clip is still included in its label', () => {
  const script = 'Haematochezia means fresh blood. Melaena means black stool.';
  const manifest = [
    line('t.wav_0000000000_0000100000.wav', 'Hemato keyzia means fresh blood.'),
    line('t.wav_0000100000_0000200000.wav', 'Malina means black stool.'),
  ].join('\n');
  const { manifestText } = relabelManifest({ manifestText: manifest, knownText: { 't.wav': script } });
  const texts = manifestText.trim().split('\n').map((row) => row.split('|')[3]);
  assert.equal(texts[0], 'Haematochezia means fresh blood.');
  assert.equal(texts[1], 'Melaena means black stool.');
});

test('clips are ordered by their start time, not by manifest order', () => {
  const manifest = [
    line('terms-1.wav_0000100000_0000200000.wav', 'Before anything else, we work out his Glasgow Blatchford score.'),
    line('terms-1.wav_0000000000_0000100000.wav', 'A sixty eight year old man arrives with three days of Malena.'),
  ].join('\n');
  const { manifestText } = relabelManifest({ manifestText: manifest, knownText: { 'terms-1.wav': SCRIPT } });
  const texts = manifestText.trim().split('\n').map((row) => row.split('|')[3]);
  assert.equal(texts[0], 'Before anything else, we work out his Glasgow-Blatchford score.');
  assert.equal(texts[1], 'A sixty-eight-year-old man arrives with three days of melaena.');
});

test('known text is matched to clips whether or not the slicer kept the extension', () => {
  const manifest = line('terms-1_0000000000_0000100000.wav', 'A sixty eight year old man arrives with three days of Malena.');
  const { report } = relabelManifest({ manifestText: manifest, knownText: { 'terms-1.wav': SCRIPT } });
  assert.equal(report.relabelled, 1);
});

test('a 100-term recording (about 3,000 words) is labelled in a few seconds', () => {
  const sentences = Array.from({ length: 200 }, (_, n) => `In case number ${n} we discuss haematochezia, melaena and oesophageal varices with the team today.`);
  const script = sentences.join(' ');
  const manifest = sentences.map((sentence, n) => line(
    `big.wav_${String(n * 100000).padStart(10, '0')}_${String(n * 100000 + 90000).padStart(10, '0')}.wav`,
    sentence.replace('haematochezia', 'hemato keyzia').replace('melaena', 'Malena'),
  )).join('\n');
  const started = Date.now();
  const { report } = relabelManifest({ manifestText: manifest, knownText: { 'big.wav': script } });
  assert.equal(report.relabelled, 200);
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
});

test('no known text leaves the manifest exactly as it was', () => {
  const manifest = `${line('a.wav_0000000000_0000100000.wav', 'Hello there everyone.')}\n`;
  const { manifestText, report } = relabelManifest({ manifestText: manifest, knownText: {} });
  assert.equal(manifestText, manifest);
  assert.equal(report.relabelled, 0);
});

test('applyKnownTextToManifestFile relabels in place and keeps Whisper\'s manifest once', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { applyKnownTextToManifestFile, readKnownTextFile } = await import('./knownTextLabels.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'known-text-'));
  const listPath = path.join(dir, 'denoised.list');
  const backupPath = path.join(dir, 'asr-whisper.txt');
  const knownPath = path.join(dir, 'known-text.json');
  const whisper = line('t.wav_0000000000_0000100000.wav', 'Malina means black stool today.');
  fs.writeFileSync(listPath, whisper);
  fs.writeFileSync(knownPath, JSON.stringify({ version: 1, files: { 't.wav': 'Melaena means black stool today.', 'empty.wav': '  ' } }));

  const knownText = readKnownTextFile(knownPath);
  assert.deepEqual(Object.keys(knownText), ['t.wav']);
  applyKnownTextToManifestFile({ listPath, backupPath, knownText });
  applyKnownTextToManifestFile({ listPath, backupPath, knownText });

  assert.match(fs.readFileSync(listPath, 'utf-8'), /\|Melaena means black stool today\.$/u);
  assert.equal(fs.readFileSync(backupPath, 'utf-8'), whisper);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readKnownTextFile treats a missing or broken file as no known text', async () => {
  const { readKnownTextFile } = await import('./knownTextLabels.js');
  assert.deepEqual(readKnownTextFile('/no/such/file.json'), {});
});
