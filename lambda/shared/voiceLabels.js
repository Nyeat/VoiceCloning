// Saved names for trained voices, keyed by voice id (cs-name_7 -> "Lecture voice").
// Lecturers name voices on the training site (voice-labels/<id>.json); Voice
// Studio sets "<label> · <person>". Display only: the id stays the key.
import { getObject, listObjects } from './s3.js';

export const VOICE_LABEL_PREFIX = 'voice-labels/';

function clean(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f<>]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 80).trim();
}

async function defaultStudioLabels() {
  const { studioVoiceLabels } = await import('../studio/index.js');
  return studioVoiceLabels();
}

/** { voiceName: label }. Never throws: a missing name only means the id is shown. */
export async function readVoiceLabels({
  list = listObjects, read = getObject, studioLabels = defaultStudioLabels,
} = {}) {
  const labels = {};
  try {
    Object.assign(labels, await studioLabels());
  } catch (error) {
    console.warn('[voice-labels] studio labels unavailable:', error.message);
  }
  try {
    const objects = (await list(VOICE_LABEL_PREFIX)).filter((object) => object.key.endsWith('.json'));
    await Promise.all(objects.map(async (object) => {
      const voiceName = object.key.slice(object.key.lastIndexOf('/') + 1, -'.json'.length);
      try {
        const label = clean(JSON.parse((await read(object.key)).toString('utf-8'))?.label);
        // The lecturer's own name wins over the studio's generated one.
        if (voiceName && label) labels[voiceName] = label;
      } catch { /* one unreadable record hides only its own name */ }
    }));
  } catch (error) {
    console.warn('[voice-labels] could not list saved names:', error.message);
  }
  return labels;
}
