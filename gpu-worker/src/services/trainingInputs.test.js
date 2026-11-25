import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeRawInputs, resetIfInputsChanged } from './trainingInputs.js';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcs-inputs-'));
  const dirs = ['raw', 'sliced', 'asr'].map((name) => path.join(root, name));
  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });
  const [rawDir, slicedDir, asrDir] = dirs;
  return { root, rawDir, slicedDir, asrDir, stampPath: path.join(root, 'raw-inputs.json'), scores: path.join(root, 'clip-scores.json') };
}

test('new recordings for a name clear the clips sliced from the old ones (2026-11-25 cs-nathanael-ng_5)', () => {
  const t = setup();
  fs.writeFileSync(path.join(t.rawDir, 'short.wav'), 'x'.repeat(10));
  const opts = { rawDir: t.rawDir, stampPath: t.stampPath, dirs: [t.slicedDir, t.asrDir], files: [t.scores] };
  assert.equal(resetIfInputsChanged(opts), false, 'first run: nothing stale');
  fs.writeFileSync(path.join(t.slicedDir, 'short_0001.wav'), 'clip');
  fs.writeFileSync(t.scores, '[]');
  assert.equal(resetIfInputsChanged(opts), false, 'same recordings: processed data kept (resume)');
  assert.ok(fs.existsSync(path.join(t.slicedDir, 'short_0001.wav')));

  fs.writeFileSync(path.join(t.rawDir, 'lecture-25min.wav'), 'y'.repeat(100));
  assert.equal(resetIfInputsChanged(opts), true, 'new recording: stale data cleared');
  assert.deepEqual(fs.readdirSync(t.slicedDir), []);
  assert.equal(fs.existsSync(t.scores), false);
  assert.equal(fs.readFileSync(t.stampPath, 'utf-8'), describeRawInputs(t.rawDir));
});

test('data left by an older worker (no stamp) is not trusted', () => {
  const t = setup();
  fs.writeFileSync(path.join(t.rawDir, 'a.wav'), 'x');
  fs.writeFileSync(path.join(t.slicedDir, 'old.wav'), 'clip');
  assert.equal(resetIfInputsChanged({ rawDir: t.rawDir, stampPath: t.stampPath, dirs: [t.slicedDir] }), true);
  assert.deepEqual(fs.readdirSync(t.slicedDir), []);
});
