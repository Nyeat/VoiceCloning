// Voice-cloning consent is recorded per signed-in account and per wording
// version: changing the wording (bump CONSENT_VERSION) asks everyone again.
export const CONSENT_VERSION = '2026-11-16';

const KEY_PREFIX = 'vc-training-consent';
const HELP_SEEN_KEY = 'vc-training-help-seen';

function consentKey(email) {
  return `${KEY_PREFIX}:${CONSENT_VERSION}:${String(email || '').trim().toLowerCase()}`;
}

export function readConsent(email, storage = globalThis.localStorage) {
  if (!email) return null;
  try {
    const parsed = JSON.parse(storage?.getItem(consentKey(email)) || 'null');
    return parsed?.version === CONSENT_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

export function saveConsent(email, storage = globalThis.localStorage, now = new Date()) {
  const record = { version: CONSENT_VERSION, acceptedAt: now.toISOString() };
  try {
    storage?.setItem(consentKey(email), JSON.stringify(record));
  } catch {
    // Private mode: consent still holds for this page view.
  }
  return record;
}

export function hasSeenHelp(storage = globalThis.localStorage) {
  try {
    return storage?.getItem(HELP_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function markHelpSeen(storage = globalThis.localStorage) {
  try {
    storage?.setItem(HELP_SEEN_KEY, '1');
  } catch {
    // Ignore: the hint simply shows again next visit.
  }
}
