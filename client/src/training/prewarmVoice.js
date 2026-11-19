// The voice the training site warms on entry: the person's most recently used
// own voice that has a saved profile (the same default the Test tab selects).
export function pickPrewarmVoice(voices = []) {
  const lastUsedAt = (voice) => Date.parse(voice.activatedAt || voice.updatedAt || '') || 0;
  return voices
    .filter((voice) => voice?.isMine !== false && voice?.hasSavedProfile !== false && voice?.voiceProfileId)
    .reduce((best, voice) => (best === null || lastUsedAt(voice) > lastUsedAt(best) ? voice : best), null);
}
