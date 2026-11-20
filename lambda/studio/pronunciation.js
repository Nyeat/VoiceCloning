// Per-voice pronunciation library. Each trained voice has its own list, so a
// fix for one lecturer's voice never changes another's.
//
// An entry gives either (or both):
//   arpabet   — exact phonemes, e.g. "K OW0 HH IY1 S IH0 N" (the CMU set the
//               engine's English g2p uses); applied when the voice is loaded.
//   soundsLike — a plain respelling, e.g. "koh hee sin"; swapped into the text
//               before synthesis, so it takes effect immediately.
import { clientError } from './workflow.js';

export const VOICE_DICTIONARY_PREFIX = 'pronunciation-dictionary/voices/';

const PHONEMES = new Set([
  'AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW',
  'B', 'CH', 'D', 'DH', 'F', 'G', 'HH', 'JH', 'K', 'L', 'M', 'N', 'NG', 'P', 'R', 'S', 'SH', 'T',
  'TH', 'V', 'W', 'Y', 'Z', 'ZH',
]);
const VOWELS = new Set(['AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW']);

export function voiceDictionaryKey(voiceName) {
  const name = String(voiceName || '');
  if (!/^[A-Za-z0-9._-]+$/u.test(name)) throw clientError(400, 'Invalid voice name');
  return `${VOICE_DICTIONARY_PREFIX}${name}.json`;
}

export function normalizeArpabet(value) {
  const tokens = String(value || '').trim().toUpperCase().split(/[\s,]+/u).filter(Boolean);
  if (tokens.length === 0) return '';
  if (tokens.length > 40) throw clientError(400, 'ARPAbet is too long (40 sounds at most)');
  let vowels = 0;
  const normalized = tokens.map((token) => {
    const match = token.match(/^([A-Z]{1,2})([012])?$/u);
    if (!match || !PHONEMES.has(match[1])) throw clientError(400, `"${token}" is not an ARPAbet sound`);
    if (VOWELS.has(match[1])) {
      vowels += 1;
      // The engine's dictionary always carries stress on vowels; default to unstressed.
      return `${match[1]}${match[2] ?? '0'}`;
    }
    if (match[2]) throw clientError(400, `Only vowels take a stress number ("${token}")`);
    return match[1];
  });
  if (vowels === 0) throw clientError(400, 'ARPAbet needs at least one vowel sound');
  return normalized.join(' ');
}

export function normalizeSoundsLike(value) {
  const text = String(value || '').trim().replace(/\s+/gu, ' ');
  if (!text) return '';
  if (text.length > 80) throw clientError(400, '"Sounds like" must be 80 characters or fewer');
  if (!/^[A-Za-z]+(?:[ '-][A-Za-z]+)*$/u.test(text)) {
    throw clientError(400, '"Sounds like" may use only letters, spaces, apostrophes and hyphens');
  }
  return text;
}

export function validatePronunciation(body = {}) {
  const word = String(body.word || '').trim().replace(/\s+/gu, ' ');
  if (!word) throw clientError(400, 'Enter the word');
  if (word.length > 60 || !/^[A-Za-z][A-Za-z'-]*(?: [A-Za-z][A-Za-z'-]*){0,3}$/u.test(word)) {
    throw clientError(400, 'The word may use letters, apostrophes and hyphens (up to 4 words)');
  }
  const arpabet = normalizeArpabet(body.arpabet);
  const soundsLike = normalizeSoundsLike(body.soundsLike);
  if (!arpabet && !soundsLike) throw clientError(400, 'Give the sounds (ARPAbet) or a "sounds like" spelling');
  if (arpabet && word.includes(' ')) throw clientError(400, 'ARPAbet works on single words; use "sounds like" for phrases');
  return {
    word,
    ...(arpabet ? { arpabet } : {}),
    ...(soundsLike ? { soundsLike } : {}),
    notes: String(body.notes || '').trim().slice(0, 200),
  };
}
