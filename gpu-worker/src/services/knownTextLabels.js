// Labels training clips with the text the speaker actually read.
//
// Whisper labels every clip, and it mangles rare medical terms ("melaena" →
// "Malena", "haematochezia" → "hemato keyzia"). A clip whose label does not
// match its audio teaches GPT-SoVITS the wrong pronunciation, so for a recording
// whose script we know (Voice Studio's Part 2, the specialty terms) we replace
// Whisper's text with the script's own words.
//
// How: every clip the slicer cut from that recording is put in time order, and
// Whisper's words are aligned to the script's words (an order-preserving,
// spelling-tolerant match). Each clip's label is the stretch of script its
// matched words cover, widened at the edges by as many words as Whisper left
// unmatched there (that is where a garbled term sits), never across a sentence
// end. A clip that barely matches (a restart, a stray remark) keeps Whisper's
// text, so nothing here can make a label worse than it was.
import fs from 'fs';
import path from 'path';

const SLICE_SUFFIX = /_(\d{6,})_(\d{6,})\.wav$/iu;
const SENTENCE_END = /[.!?]["'”’)]*$/u;
const MIN_MATCHED_WORDS = 2;
const MIN_MATCHED_SHARE = 0.5;
const FUZZY_MIN_LENGTH = 6;
const FUZZY_MAX_LENGTH_GAP = 3;
const FUZZY_MIN_SIMILARITY = 0.6;
const EXACT_SCORE = 2;
const FUZZY_SCORE = 1;
// The alignment table is ASR words × script words; past this it is skipped.
const MAX_ALIGNMENT_CELLS = 30_000_000;

/** The recording a clip was sliced from, or null if the name is not a slice. */
export function clipSource(filename) {
  const base = path.basename(String(filename || '').replace(/\\/gu, '/'));
  return SLICE_SUFFIX.test(base) ? base.replace(SLICE_SUFFIX, '') : null;
}

function clipStart(filename) {
  const match = path.basename(String(filename || '').replace(/\\/gu, '/')).match(SLICE_SUFFIX);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function stripExtension(name) {
  return String(name || '').replace(/\.[a-z0-9]{2,4}$/iu, '');
}

export function normalizeWord(word) {
  return String(word || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']+/gu, '')
    .replace(/^'+|'+$/gu, '');
}

function wordsOf(text) {
  return String(text || '')
    .split(/[\s\-–—/]+/u)
    .map(normalizeWord)
    .filter(Boolean);
}

function editDistance(a, b) {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[b.length];
}

/** Same word, allowing small spelling differences in long words (haem-/hem-, -aena/-ena). */
export function sameWord(a, b) {
  if (a === b) return true;
  if (a.length < FUZZY_MIN_LENGTH || b.length < FUZZY_MIN_LENGTH) return false;
  if (Math.abs(a.length - b.length) > FUZZY_MAX_LENGTH_GAP) return false;
  return 1 - editDistance(a, b) / Math.max(a.length, b.length) >= FUZZY_MIN_SIMILARITY;
}

// Word pairs repeat a lot ("the", "we"), so each distinct pair is scored once,
// in a table indexed by word id.
function matchScorer(asrWords, scriptWords) {
  const ids = new Map();
  const idOf = (word) => {
    if (!ids.has(word)) ids.set(word, ids.size);
    return ids.get(word);
  };
  const asrIds = asrWords.map(idOf);
  const asrCount = ids.size;
  const scriptIds = scriptWords.map(idOf);
  const scriptCount = ids.size;
  const words = [...ids.keys()];
  const table = new Int8Array(asrCount * scriptCount).fill(-1);
  return (i, j) => {
    const a = asrIds[i];
    const b = scriptIds[j];
    if (a === b) return EXACT_SCORE;
    const cell = a * scriptCount + b;
    if (table[cell] < 0) table[cell] = sameWord(words[a], words[b]) ? FUZZY_SCORE : 0;
    return table[cell];
  };
}

/**
 * Order-preserving alignment of ASR words to script words (weighted longest
 * common subsequence). Returns [asrIndex, scriptIndex] pairs, in order.
 */
export function alignWords(asrWords, scriptWords) {
  const rows = asrWords.length;
  const cols = scriptWords.length;
  if (rows === 0 || cols === 0 || (rows + 1) * (cols + 1) > MAX_ALIGNMENT_CELLS) return [];
  const width = cols + 1;
  const score = new Int32Array((rows + 1) * width);
  const scorer = matchScorer(asrWords, scriptWords);
  for (let i = 1; i <= rows; i += 1) {
    for (let j = 1; j <= cols; j += 1) {
      const match = scorer(i - 1, j - 1);
      const diagonal = match > 0 ? score[(i - 1) * width + (j - 1)] + match : -1;
      score[i * width + j] = Math.max(diagonal, score[(i - 1) * width + j], score[i * width + (j - 1)]);
    }
  }
  // Walking back, skip a script word whenever that costs nothing: among equally
  // good alignments this picks the earliest script position for each word, so a
  // clip's last "score" lands on its own sentence's, not a later sentence's.
  const pairs = [];
  let i = rows;
  let j = cols;
  while (i > 0 && j > 0) {
    const here = score[i * width + j];
    const match = scorer(i - 1, j - 1);
    if (here === score[i * width + (j - 1)]) {
      j -= 1;
    } else if (match > 0 && here === score[(i - 1) * width + (j - 1)] + match) {
      pairs.push([i - 1, j - 1]);
      i -= 1;
      j -= 1;
    } else {
      i -= 1;
    }
  }
  return pairs.reverse();
}

function parseRow(line) {
  const parts = String(line || '').split('|');
  if (parts.length < 4) return null;
  return { parts, filename: path.basename(parts[0].replace(/\\/gu, '/')), text: parts.slice(3).join('|').trim() };
}

function scriptTokens(text) {
  const tokens = String(text || '').split(/\s+/u).filter(Boolean);
  const units = [];
  tokens.forEach((token, tokenIndex) => {
    wordsOf(token).forEach((word) => units.push({ word, tokenIndex }));
  });
  return { tokens, units };
}

// Each clip's matched script tokens, plus how many ASR words it left unmatched at each edge.
function clipSpans(clips, units) {
  const asrWords = [];
  const owner = [];
  clips.forEach((clip, clipIndex) => {
    clip.words.forEach((word) => { asrWords.push(word); owner.push(clipIndex); });
  });
  const offsets = [];
  let offset = 0;
  clips.forEach((clip) => { offsets.push(offset); offset += clip.words.length; });

  const matched = clips.map(() => []);
  for (const [asrIndex, unitIndex] of alignWords(asrWords, units.map((unit) => unit.word))) {
    matched[owner[asrIndex]].push({ asrIndex: asrIndex - offsets[owner[asrIndex]], tokenIndex: units[unitIndex].tokenIndex });
  }
  return clips.map((clip, clipIndex) => {
    const hits = matched[clipIndex];
    const accepted = hits.length >= MIN_MATCHED_WORDS && hits.length / Math.max(1, clip.words.length) >= MIN_MATCHED_SHARE;
    if (!accepted) return { accepted: false };
    return {
      accepted: true,
      start: hits[0].tokenIndex,
      end: hits[hits.length - 1].tokenIndex,
      leading: hits[0].asrIndex,
      trailing: clip.words.length - 1 - hits[hits.length - 1].asrIndex,
    };
  });
}

// Widens accepted spans into the script words between them: forward by the
// unmatched words at a clip's end (stopping after a sentence end), backward by
// those at the next clip's start (never taking the end of a previous sentence).
function widenSpans(spans, tokenCount, tokens) {
  const accepted = spans.filter((span) => span.accepted);
  accepted.forEach((span, index) => {
    const previous = accepted[index - 1];
    const floor = previous ? previous.end + 1 : 0;
    let taken = 0;
    while (taken < span.leading && span.start - 1 >= floor && !SENTENCE_END.test(tokens[span.start - 1])) {
      span.start -= 1;
      taken += 1;
    }
  });
  accepted.forEach((span, index) => {
    const next = accepted[index + 1];
    const ceiling = next ? next.start - 1 : tokenCount - 1;
    let taken = 0;
    while (taken < span.trailing && span.end + 1 <= ceiling && !SENTENCE_END.test(tokens[span.end])) {
      span.end += 1;
      taken += 1;
    }
  });
  return spans;
}

function knownFileFor(source, knownText) {
  if (Object.prototype.hasOwnProperty.call(knownText, source)) return source;
  const bare = stripExtension(source);
  return Object.keys(knownText).find((name) => name === bare || stripExtension(name) === bare) || null;
}

function cleanLabel(text) {
  return String(text || '').replace(/[|\r\n]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/**
 * Rewrites a GPT-SoVITS ASR manifest (path|speaker|lang|text per line) so clips
 * cut from a recording with known text carry that text.
 * knownText: { [recording file name]: the text that was read }.
 */
export function relabelManifest({ manifestText = '', knownText = {} } = {}) {
  const report = { files: 0, relabelled: 0, keptAsr: 0, perFile: {} };
  const known = knownText && typeof knownText === 'object' ? knownText : {};
  if (Object.keys(known).length === 0) return { manifestText, report };

  const lines = String(manifestText || '').split(/\r?\n/u);
  const groups = new Map();
  lines.forEach((line, lineIndex) => {
    const row = parseRow(line);
    if (!row) return;
    const source = clipSource(row.filename);
    const file = source ? knownFileFor(source, known) : null;
    if (!file) return;
    if (!groups.has(file)) groups.set(file, []);
    groups.get(file).push({ ...row, lineIndex, start: clipStart(row.filename), words: wordsOf(row.text) });
  });

  const output = [...lines];
  for (const [file, group] of groups) {
    const clips = [...group].sort((a, b) => a.start - b.start || a.lineIndex - b.lineIndex);
    const { tokens, units } = scriptTokens(known[file]);
    const spans = widenSpans(clipSpans(clips, units), tokens.length, tokens);
    const stats = { clips: clips.length, relabelled: 0 };
    clips.forEach((clip, index) => {
      const span = spans[index];
      if (!span?.accepted) {
        report.keptAsr += 1;
        return;
      }
      const label = cleanLabel(tokens.slice(span.start, span.end + 1).join(' '));
      if (!label) {
        report.keptAsr += 1;
        return;
      }
      output[clip.lineIndex] = [...clip.parts.slice(0, 3), label].join('|');
      stats.relabelled += 1;
      report.relabelled += 1;
    });
    report.files += 1;
    report.perFile[file] = stats;
  }
  return { manifestText: output.join('\n'), report };
}

/**
 * Reads the known-text file Voice Studio saved with the recordings
 * ({ files: { [recording]: text } }); an absent or broken file means none.
 */
export function readKnownTextFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const files = parsed && typeof parsed.files === 'object' && !Array.isArray(parsed.files) ? parsed.files : {};
    return Object.fromEntries(Object.entries(files).filter(([name, text]) => name && typeof text === 'string' && text.trim()));
  } catch {
    return {};
  }
}

/**
 * Relabels the ASR manifest file in place. Whisper's own manifest is kept once
 * at backupPath (never overwritten), and relabelling always starts from it, so
 * a resumed run gives the same labels as the first.
 */
export function applyKnownTextToManifestFile({ listPath, backupPath, knownText }) {
  if (Object.keys(knownText || {}).length === 0) return { files: 0, relabelled: 0, keptAsr: 0, perFile: {} };
  if (!fs.existsSync(backupPath)) fs.copyFileSync(listPath, backupPath);
  const whisper = fs.readFileSync(backupPath, 'utf-8');
  const { manifestText, report } = relabelManifest({ manifestText: whisper, knownText });
  fs.writeFileSync(listPath, manifestText);
  return report;
}
