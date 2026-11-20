// Canonical mapping from an NTU email address to the voices that email owns.
//
// A lecturer owns as many voices as they train — every run makes a new one and
// nothing is ever replaced. The email fixes the base name and copies after the
// first are numbered automatically: DeanVoice, DeanVoice_2, DeanVoice_3. There
// is nothing to type; the name is never chosen by hand.
//
// NTU hands out two addresses for the same mailbox — the SMTP form
// (josephsung@ntu.edu.sg) and the Entra UPN (JOSEPHSUNG@staff.main.ntu.edu.sg).
// Both name one person, so only the local part decides the voice name; the
// domain is validated and then discarded.
//
// Ownership is also recorded on the saved profile (ownerEmail) rather than read
// back out of a name: a name can answer "which voice", never "how many".
//
// This file is duplicated byte-for-byte into the client bundle, the Lambda
// router, and the GPU training worker, which are packaged separately and share
// no module. voiceIdentityParity.test.js fails if the copies drift — copy the
// changed file over the others rather than reconciling them by hand.

const EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const NTU_DOMAIN_RE = /^(?:[a-z0-9-]+\.)*ntu\.edu\.sg$/u;

// GPT-SoVITS writes the experiment name into weight filenames and S3 keys, so
// it stays well under any path limit.
export const MAX_VOICE_NAME_LENGTH = 64;

// A ceiling only so a broken caller cannot spin forever looking for a free
// name. Nobody is training a thousand copies of one voice.
export const MAX_VOICE_COPIES = 999;

// Base names are dash-slugs, so an underscore appears in a derived name exactly
// once: as this separator. That is what makes ownership decidable — alice@ owns
// alice and alice_2, but never alice-2, which belongs to alice.2@, nor alice2,
// which belongs to alice2@.
const COPY_SEPARATOR = '_';
const COPY_SUFFIX_RE = /^[1-9][0-9]*$/u;

// Voices trained before names were derived from email. Their weights already
// sit on S3 under these experiment names and the lecture and GI sites pin the
// resulting profile ids, so the owner is attached to the existing name instead
// of renaming deployed artifacts. Keyed by canonical local part; the names must
// not contain COPY_SEPARATOR or ownership becomes ambiguous.
const LEGACY_VOICE_OWNERS = new Map([
  ['josephsung', 'DeanVoice'],
]);

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function splitEmail(email) {
  const normalized = normalizeEmail(email);
  if (!EMAIL_SHAPE_RE.test(normalized)) return null;
  const at = normalized.lastIndexOf('@');
  return { localPart: normalized.slice(0, at), domain: normalized.slice(at + 1) };
}

// FNV-1a, 24 bits as 6 hex chars: deterministic in every runtime (browser,
// Lambda, worker) without crypto. A naming disambiguator, not a secret.
function shortHash(value) {
  let hash = 0x811c9dc5;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash & 0xffffff).toString(16).padStart(6, '0');
}

function externalVoiceName(email, localPart) {
  return `x-${localPart.slice(0, 24).replace(/-+$/u, '')}-${shortHash(email.replace(/\+[^@]*@/u, '@'))}`;
}

export function isNtuEmail(email) {
  const parts = splitEmail(email);
  return Boolean(parts && NTU_DOMAIN_RE.test(parts.domain));
}

// Plus-addressing is an alias for the same mailbox, so it is stripped before
// slugging — user+lecture@ntu.edu.sg and user@ntu.edu.sg are one lecturer.
export function canonicalLocalPart(email) {
  const parts = splitEmail(email);
  if (!parts) return '';
  return parts.localPart.split('+')[0]
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

// Each half is slugged separately so the separator survives into the id: were
// it flattened to a dash, alice_2 and alice-2 — two lecturers' voices — would
// both become alice-2-v1 and overwrite each other in storage.
export function buildVoiceProfileId(voiceName) {
  const slug = String(voiceName || '')
    .split(COPY_SEPARATOR)
    .map((part) => part.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, ''))
    .filter(Boolean)
    .join(COPY_SEPARATOR);
  return slug ? `${slug}-v1` : '';
}

// Returns the base identity plus the reason it is unusable, so callers can show
// one message instead of re-deriving the rule.
// `allowExternal`: Voice Studio only. The training site stays NTU-only.
export function describeVoiceIdentity(email, { allowExternal = false } = {}) {
  const normalizedEmail = normalizeEmail(email);
  const invalid = (error) => ({
    valid: false, error, email: normalizedEmail, baseVoiceName: '', voiceProfileId: '',
  });

  if (!normalizedEmail) {
    return invalid('Enter your NTU email address.');
  }
  if (!EMAIL_SHAPE_RE.test(normalizedEmail)) {
    return invalid('Enter a valid email address.');
  }
  if (!allowExternal && !isNtuEmail(normalizedEmail)) {
    return invalid('Use your NTU email address (an @ntu.edu.sg address).');
  }

  const localPart = canonicalLocalPart(normalizedEmail);
  if (!localPart) {
    return invalid('This email address cannot be used to name a voice.');
  }

  // NTU addresses keep their plain names (one person, two NTU domains, one
  // name). Any other address — Voice Studio accepts any Microsoft account —
  // gets an "x-" name with a short hash of the full address, so jane@gmail.com
  // and jane@yahoo.com can never share (or overwrite) a voice.
  const baseVoiceName = isNtuEmail(normalizedEmail)
    ? (LEGACY_VOICE_OWNERS.get(localPart) || localPart)
    : externalVoiceName(normalizedEmail, localPart);
  if (baseVoiceName.length > MAX_VOICE_NAME_LENGTH) {
    return invalid(`This email address is too long to name a voice (max ${MAX_VOICE_NAME_LENGTH} characters).`);
  }

  return {
    valid: true,
    error: '',
    email: normalizedEmail,
    baseVoiceName,
    voiceProfileId: buildVoiceProfileId(baseVoiceName),
  };
}

// True when `voiceName` is one of the voices `email` can own — the base name or
// a numbered copy of it. Authorises a run without enumerating what already
// exists, which is the separate question nextVoiceName answers.
export function ownsVoiceName(email, voiceName, options = {}) {
  const candidate = String(voiceName || '').trim();
  if (!candidate) return false;
  const { baseVoiceName } = describeVoiceIdentity(email, options);
  if (!baseVoiceName) return false;
  if (candidate === baseVoiceName) return true;

  const [base, suffix = '', ...extra] = candidate.split(COPY_SEPARATOR);
  if (extra.length > 0) return false;
  return base === baseVoiceName
    && COPY_SUFFIX_RE.test(suffix)
    && Number(suffix) >= 2
    && Number(suffix) <= MAX_VOICE_COPIES;
}

// The next voice this lecturer would create: the base name while it is free,
// then the lowest free number. Training never replaces a voice, so the caller
// must pass every name already in use.
export function nextVoiceName(email, takenNames = [], options = {}) {
  const { baseVoiceName } = describeVoiceIdentity(email, options);
  if (!baseVoiceName) return '';

  const taken = new Set(
    Array.from(takenNames || []).map((name) => String(name || '').trim()).filter(Boolean),
  );
  if (!taken.has(baseVoiceName)) return baseVoiceName;

  for (let copy = 2; copy <= MAX_VOICE_COPIES; copy += 1) {
    const candidate = `${baseVoiceName}${COPY_SEPARATOR}${copy}`;
    if (candidate.length > MAX_VOICE_NAME_LENGTH) return '';
    if (!taken.has(candidate)) return candidate;
  }
  return '';
}

export function voiceProfileIdForEmail(email) {
  return describeVoiceIdentity(email).voiceProfileId;
}
