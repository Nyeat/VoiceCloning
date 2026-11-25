import fs from 'node:fs';
import path from 'node:path';

// What a run's processed data (sliced clips, denoised clips, transcripts,
// extracted features) was made from: every raw audio file and its size.
// 2026-11-25: cs-nathanael-ng_5 was re-run with a new 25-min recording, but the
// worker still held the clips sliced from that name's earlier 30 s of audio;
// "sliced audio already exists" skipped slicing, so training saw 3 old clips and
// the quality gate failed. Derived data is only reused when this matches.
export function describeRawInputs(rawDir) {
  const files = [];
  const walk = (dir, prefix = '') => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, relative);
      else files.push([relative, fs.statSync(full).size]);
    }
  };
  walk(rawDir);
  files.sort((a, b) => a[0].localeCompare(b[0]));
  return JSON.stringify(files);
}

/**
 * Throws away processed data made from different audio than `rawDir` holds now
 * (or of unknown origin: no stamp), then records the current inputs. Returns
 * true when something stale was cleared. `dirs` are emptied (and recreated),
 * `files` deleted.
 */
export function resetIfInputsChanged({ rawDir, stampPath, dirs = [], files = [] }) {
  const current = describeRawInputs(rawDir);
  const previous = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, 'utf-8') : null;
  if (previous === current) return false;
  const hadData = dirs.some((dir) => fs.existsSync(dir) && fs.readdirSync(dir).length > 0)
    || files.some((file) => fs.existsSync(file));
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const file of files) fs.rmSync(file, { force: true });
  fs.writeFileSync(stampPath, current);
  return hadData;
}
