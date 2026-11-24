// Text tidied before it is spoken (owner 2026-11-24): staff mostly paste slide
// content — bullets, headings without full stops, "Topic: detail", "a; b",
// arrows and symbols — which the voice reads badly (run-on lines, skipped or
// spoken symbols). This turns it into plain sentences: one line = one
// sentence ending in a full stop, ":" and ";" become pauses (comma / full
// stop), symbols become words or go. English only; other text is just trimmed.
// Used by the TTS page (LivePage) and Voice Studio's tester (VoiceTestBench).

const BULLET = /^\s*(?:[-*+•▪◦·●○■□➢➤►▶✓✔→‣⁃–—]+|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)](?=\s))\s*/u;
const END = /[.!?]$/u;

function tidyLine(line) {
  let text = line.replace(BULLET, '').trim();
  if (!text) return '';
  text = text
    .replace(/[‘’]/gu, "'")
    .replace(/\s*(?:->|=>|→|⇒)\s*/gu, ' to ')
    .replace(/\s*&\s*/gu, ' and ')
    .replace(/(\d)\s*%/gu, '$1 percent')
    .replace(/(\d):(\d)/gu, '$1\u0000$2') // keep times like 10:30
    .replace(/\s*:\s*$/u, '.') // "Key points:" ends the sentence
    .replace(/\s*:\s*/gu, ', ')
    .replace(/\s*;\s*(\S?)/gu, (match, next) => `. ${next.toUpperCase()}`)
    .replace(/\u0000/gu, ':')
    .replace(/\s+[-–—]+\s+/gu, ', ') // spaced dashes are pauses
    .replace(/[([{]\s*/gu, ', ')
    .replace(/\s*[)\]}]/gu, ',')
    .replace(/(?:\.\s*){2,}|…/gu, '. ')
    .replace(/["“”‘’`*#_~|<>^=\\]+/gu, ' ')
    .replace(/(\w)'(\w)/gu, "$1'$2")
    .replace(/'/gu, (match, offset, whole) => (/\w/u.test(whole[offset - 1] || '') && /\w/u.test(whole[offset + 1] || '') ? match : ' '))
    .replace(/\s*\/\s*/gu, ' ');
  return text;
}

function tidyPunctuation(text) {
  return text
    .replace(/\s+/gu, ' ')
    .replace(/\s+([,.!?])/gu, '$1')
    .replace(/([,.!?])(?=[A-Za-z])/gu, (match, mark, offset, whole) => (
      // keep "e.g." / "3.5" / "U.S." intact
      mark === '.' && /[A-Za-z0-9]/u.test(whole[offset - 1] || '') && /^.\w\./u.test(whole.slice(offset, offset + 3)) ? match : `${mark} `))
    .replace(/,(?:\s*,)+/gu, ',')
    .replace(/,\s*([.!?])/gu, '$1')
    .replace(/([.!?])\s*,/gu, '$1')
    .replace(/^[\s,.]+/u, '')
    .trim();
}

/** Slide-style text as plain spoken sentences. `language` other than English: trimmed only. */
export function prepareSpeechText(input, language = 'en') {
  const raw = String(input ?? '');
  if (!/^en/iu.test(String(language || 'en'))) return raw.trim();
  const sentences = raw
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map(tidyLine)
    .map((line) => tidyPunctuation(line))
    .filter((line) => /[A-Za-z0-9]/u.test(line))
    .map((line) => {
      const sentence = END.test(line) ? line : `${line.replace(/[,\s]+$/u, '')}.`;
      return sentence.charAt(0).toUpperCase() + sentence.slice(1);
    });
  return tidyPunctuation(sentences.join(' '));
}
