import fs from 'fs';
import path from 'path';
import { getObject, listObjects } from './s3Storage.js';
import { GPT_SOVITS_ROOT } from '../config.js';

const DICTIONARY_PREFIX = 'pronunciation-dictionary/english/';
const CACHE_TTL_MS = 60_000;
const BEGIN_MARKER = '# BEGIN ADMIN PRONUNCIATION DICTIONARY';
const END_MARKER = '# END ADMIN PRONUNCIATION DICTIONARY';

let cachedEntries = [];
let cacheLoadedAt = 0;

function normalizeWord(value) {
  return String(value || '').trim();
}

function normalizeArpabet(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/gu, ' ');
}

function normalizeSynthesisAlias(value) {
  const alias = String(value || '').trim().replace(/\s+/gu, ' ');
  return alias.length <= 80 && /^[A-Za-z]+(?:[ '-][A-Za-z]+)+$/u.test(alias) ? alias : '';
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function applyReadableOverrides(text) {
  // Readable replacements changed the verifier's expected token sequence (for
  // example, "iron" -> "eye urn") and could reject correctly spoken audio.
  // Pronunciation overrides are ARPAbet-only now, so synthesis text stays exact.
  return String(text || '');
}

export function applySynthesisAliases(text, entries = []) {
  let result = String(text || '');
  const aliases = dedupePronunciationEntries(entries)
    .filter((entry) => entry.synthesisAlias)
    .sort((a, b) => b.word.length - a.word.length);
  for (const entry of aliases) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}'])${escapeRegExp(entry.word)}(?![\\p{L}\\p{N}'])`, 'giu');
    result = result.replace(pattern, entry.synthesisAlias);
  }
  return result;
}

function updatedAtValue(entry) {
  const value = Date.parse(String(entry?.updatedAt || ''));
  return Number.isFinite(value) ? value : 0;
}

export function dedupePronunciationEntries(entries = []) {
  const byWord = new Map();
  for (const rawEntry of entries) {
    const word = normalizeWord(rawEntry?.word);
    const arpabet = normalizeArpabet(rawEntry?.arpabet);
    if (!word || !arpabet) continue;
    const candidate = { ...rawEntry, word, arpabet };
    delete candidate.readable;
    candidate.synthesisAlias = normalizeSynthesisAlias(candidate.synthesisAlias);
    if (!candidate.synthesisAlias) delete candidate.synthesisAlias;
    const key = word.toLowerCase();
    const current = byWord.get(key);
    const candidateTime = updatedAtValue(candidate);
    const currentTime = updatedAtValue(current);
    const winsTie = String(candidate.category || '').localeCompare(String(current?.category || '')) < 0;
    if (!current || candidateTime > currentTime || (candidateTime === currentTime && winsTie)) {
      byWord.set(key, candidate);
    }
  }
  return [...byWord.values()].sort((a, b) => a.word.localeCompare(b.word));
}

export function buildHotDictionaryLines(entries = []) {
  const lines = [];
  const seen = new Set();
  for (const entry of dedupePronunciationEntries(entries)) {
    const rawWord = normalizeWord(entry.word).toUpperCase();
    // GPT-SoVITS' g2p keys on the ASCII letters/digits only, so we strip everything
    // else to form the dictionary key. But a word built ENTIRELY (or mostly) of
    // non-ASCII characters — "ΔG", "β-blocker", "µg" — would collapse onto whatever
    // few ASCII letters survive ("ΔG" -> "G"), silently registering this
    // pronunciation under an unrelated common word. That is worse than a no-op: it
    // hijacks every occurrence of the surviving letters. Greek letters are already
    // spelled out in text normalization (see textPronunciation.js), so such an entry
    // is never needed. Reject it loudly instead of corrupting another word.
    const word = rawWord.replace(/[^A-Z0-9']/gu, '');
    const arpabet = normalizeArpabet(entry.arpabet);
    if (!arpabet) continue;
    if (!word || seen.has(word)) continue;
    if (/[^\x00-\x7F]/u.test(rawWord)) {
      console.warn(
        `[pronunciation] SKIPPED ARPAbet entry for "${entry.word}": non-ASCII characters `
        + 'cannot be a dictionary key (stripping them would hijack the pronunciation of an '
        + 'unrelated word). Greek letters are already spelled out during text normalization.',
      );
      continue;
    }
    seen.add(word);
    lines.push(`${word} ${arpabet}`);
  }
  return lines;
}

function hotDictionaryWords(entries = []) {
  return new Set(buildHotDictionaryLines(entries).map((line) => line.split(/\s+/u)[0]));
}

// Uppercased set of every word that has an ARPAbet override (the entries that get
// compiled into GPT-SoVITS g2p). Used to let an ARPAbet entry win over an SSML
// <sub>/<say-as> rewrite for the same word — the dictionary is the precise path.
export function collectArpabetWords(entries = []) {
  return hotDictionaryWords(entries);
}

// GPT-SoVITS' english.py only reads engdict-hot.rep when it has to rebuild the
// compiled dictionary; if engdict_cache.pickle already exists it loads that and
// never looks at the hot file. So a hot-file edit is silently ignored (even across
// restarts) until the cache is invalidated. Deleting the stale pickle forces a
// rebuild on the next engine start, which is the only path that overlays the hot
// entries. namedict_cache.pickle is for the name dictionary and is left alone.
//
// `force` removes the pickle outright (we just rewrote the hot file). Otherwise it
// is removed only when it is OLDER than the hot file — which self-heals an already
// up-to-date hot file whose entries never made it into a pre-existing stale cache.
function invalidateCompiledDictionaryCache(gptSovitsRoot, { force = false } = {}) {
  if (!gptSovitsRoot) return false;
  const textDir = path.join(gptSovitsRoot, 'GPT_SoVITS', 'text');
  const cachePath = path.join(textDir, 'engdict_cache.pickle');
  const hotPath = path.join(textDir, 'engdict-hot.rep');
  try {
    if (!fs.existsSync(cachePath)) return false;
    if (!force) {
      const cacheMtime = fs.statSync(cachePath).mtimeMs;
      const hotMtime = fs.existsSync(hotPath) ? fs.statSync(hotPath).mtimeMs : 0;
      if (cacheMtime >= hotMtime) return false; // cache already newer than hot edits
    }
    fs.unlinkSync(cachePath);
    return true;
  } catch (error) {
    console.warn(`[pronunciation] could not invalidate engdict cache: ${error.message}`);
  }
  return false;
}

export function writeHotDictionaryOverrides(gptSovitsRoot = GPT_SOVITS_ROOT, entries = []) {
  const lines = buildHotDictionaryLines(entries);
  if (!gptSovitsRoot) return { written: false, lines: 0, changed: false, cacheInvalidated: false };

  const filePath = path.join(gptSovitsRoot, 'GPT_SoVITS', 'text', 'engdict-hot.rep');
  if (!fs.existsSync(filePath)) return { written: false, lines: 0, changed: false, cacheInvalidated: false };

  const current = fs.readFileSync(filePath, 'utf-8');
  const pattern = new RegExp(`\\n?${escapeRegExp(BEGIN_MARKER)}[\\s\\S]*?${escapeRegExp(END_MARKER)}\\n?`, 'u');
  if (lines.length === 0) {
    const next = `${current.replace(pattern, '\n').trimEnd()}\n`;
    const changed = next !== current;
    if (changed) fs.writeFileSync(filePath, next, 'utf-8');
    const cacheInvalidated = invalidateCompiledDictionaryCache(gptSovitsRoot, { force: changed });
    return { written: true, lines: 0, changed, cacheInvalidated };
  }

  const block = `${BEGIN_MARKER}\n${lines.join('\n')}\n${END_MARKER}`;
  const words = hotDictionaryWords(entries);
  const withoutManagedBlock = current.replace(pattern, '\n');
  const withoutAdminWords = withoutManagedBlock
    .split(/\r?\n/u)
    .filter((line) => {
      const word = line.trim().split(/\s+/u)[0]?.toUpperCase();
      return !words.has(word);
    })
    .join('\n');
  const next = `${withoutAdminWords.trimEnd()}\n\n${block}\n`;

  const changed = next !== current;
  if (changed) fs.writeFileSync(filePath, next, 'utf-8');
  // The hot entries only reach g2p after the compiled cache is rebuilt. Force the
  // drop when we just rewrote the file; otherwise still drop a cache that predates
  // the hot file so an already-current hot file self-heals. The engine restart in
  // /inference/start then does the rebuild.
  const cacheInvalidated = invalidateCompiledDictionaryCache(gptSovitsRoot, { force: changed });
  return { written: true, lines: lines.length, changed, cacheInvalidated };
}

export async function loadRuntimePronunciationEntries({
  listStoredObjects = listObjects,
  readObject = getObject,
  force = false,
} = {}) {
  const now = Date.now();
  if (!force && now - cacheLoadedAt < CACHE_TTL_MS) return cachedEntries;

  try {
    const objects = await listStoredObjects(DICTIONARY_PREFIX);
    const entries = [];
    for (const object of objects.filter((item) => item.key.endsWith('.json'))) {
      const body = await readObject(object.key);
      const parsed = JSON.parse(body.toString('utf-8'));
      if (Array.isArray(parsed.entries)) entries.push(...parsed.entries);
    }
    cachedEntries = dedupePronunciationEntries(entries);
    cacheLoadedAt = now;
    console.log(
      `[pronunciation] loaded ${cachedEntries.length} unique ARPAbet entries from `
      + `${entries.length} stored admin entries (${DICTIONARY_PREFIX})`,
    );
    return cachedEntries;
  } catch (error) {
    console.warn(`[pronunciation] Could not load admin dictionary: ${error.message}`);
    cacheLoadedAt = now;
    return cachedEntries;
  }
}

export async function prepareTextWithRuntimeDictionary(text, options = {}) {
  const entries = await loadRuntimePronunciationEntries(options);
  return applySynthesisAliases(text, entries);
}

// ── Per-voice libraries (Voice Studio) ──────────────────────────────────
// pronunciation-dictionary/voices/<voice>.json holds one voice's own entries.
// "soundsLike" respellings are swapped in per request, so they only ever touch
// that voice. ARPAbet entries join the engine's phoneme dictionary when that
// voice is applied (POST /inference/start { pronunciationVoice }); on a
// one-voice-per-slot GPU that makes them per-voice too.
const VOICE_DICTIONARY_PREFIX = 'pronunciation-dictionary/voices/';
const voiceCache = new Map();
let activePronunciationVoice = '';

export function voiceNameFromModelRef(ref) {
  const basename = String(ref || '').split(/[\/]/u).pop() || '';
  const match = basename.match(/^(.+?)[-_]e\d+(?:[_-]s\d+)?\.(?:ckpt|pth)$/iu);
  return match ? match[1] : '';
}

export function voiceNameFromRequest(voiceModel) {
  if (!voiceModel || typeof voiceModel !== 'object') return '';
  return voiceNameFromModelRef(voiceModel.gptRef) || voiceNameFromModelRef(voiceModel.sovitsRef);
}

export async function loadVoicePronunciationEntries(voiceName, {
  readObject = getObject,
  force = false,
} = {}) {
  const name = String(voiceName || '');
  if (!/^[A-Za-z0-9._-]+$/u.test(name)) return [];
  const cached = voiceCache.get(name);
  const now = Date.now();
  if (!force && cached && now - cached.at < CACHE_TTL_MS / 2) return cached.entries;
  let entries = [];
  try {
    const parsed = JSON.parse((await readObject(`${VOICE_DICTIONARY_PREFIX}${name}.json`)).toString('utf-8'));
    entries = (Array.isArray(parsed.entries) ? parsed.entries : [])
      .filter((entry) => normalizeWord(entry?.word))
      .map((entry) => ({
        word: normalizeWord(entry.word),
        arpabet: normalizeArpabet(entry.arpabet),
        soundsLike: String(entry.soundsLike || '').trim(),
      }));
  } catch {
    entries = []; // no library yet (NoSuchKey) or unreadable: the voice simply has none
  }
  voiceCache.set(name, { at: now, entries });
  return entries;
}

export function applyVoiceSoundsLike(text, entries = []) {
  let result = String(text || '');
  const respellings = entries
    .filter((entry) => entry.soundsLike && /^[A-Za-z]+(?:[ '-][A-Za-z]+)*$/u.test(entry.soundsLike))
    .sort((a, b) => b.word.length - a.word.length);
  for (const entry of respellings) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}'])${escapeRegExp(entry.word)}(?![\\p{L}\\p{N}'])`, 'giu');
    result = result.replace(pattern, entry.soundsLike);
  }
  return result;
}

// Voice ARPAbet entries outrank the shared dictionary for the same word.
export function mergeVoiceArpabet(globalEntries = [], voiceEntries = []) {
  const voiceArpabet = voiceEntries
    .filter((entry) => entry.arpabet && !entry.soundsLike)
    .map((entry) => ({ word: entry.word, arpabet: entry.arpabet, category: 'voice', updatedAt: '9999-12-31T00:00:00.000Z' }));
  return [...globalEntries, ...voiceArpabet];
}

export function getActivePronunciationVoice() {
  return activePronunciationVoice;
}

export async function syncHotDictionaryOverrides(options = {}) {
  if (typeof options.pronunciationVoice === 'string' && /^[A-Za-z0-9._-]*$/u.test(options.pronunciationVoice)) {
    activePronunciationVoice = options.pronunciationVoice;
  }
  const globalEntries = await loadRuntimePronunciationEntries({ ...options, force: true });
  const voiceEntries = activePronunciationVoice
    ? await loadVoicePronunciationEntries(activePronunciationVoice, { force: true })
    : [];
  const entries = mergeVoiceArpabet(globalEntries, voiceEntries);
  const result = writeHotDictionaryOverrides(options.gptSovitsRoot || GPT_SOVITS_ROOT, entries);
  if (result.written) {
    console.log(
      `[pronunciation] hot dictionary sync: ${result.lines} ARPAbet line(s) from ${entries.length} admin entr(ies); `
      + `hotFileChanged=${result.changed} compiledCacheInvalidated=${result.cacheInvalidated}`,
    );
  } else {
    console.warn(
      '[pronunciation] hot dictionary sync SKIPPED — engdict-hot.rep not found under '
      + `${options.gptSovitsRoot || GPT_SOVITS_ROOT || '(unset GPT_SOVITS_ROOT)'} — admin ARPAbet entries are NOT applied`,
    );
  }
  return { ...result, entryCount: entries.length };
}
