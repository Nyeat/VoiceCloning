import { useEffect } from 'react';
import { getMyVoiceProfiles, prepareVoiceCapacity } from '@/services/api.js';
import { pickPrewarmVoice } from './prewarmVoice.js';

// Entering the training site warms an inference GPU for the person's most
// recently used voice, so "Test your voice" is ready by the time they open it
// (the training GPU is started separately by the GPU status provider). It goes
// through the same coordinator preflight as selecting the voice: route if it is
// already loaded, switch a GPU nobody has used for 10 minutes, else add one.
// The coordinator only acts once a voice has been selected for a few seconds,
// so poll briefly until it answers with something other than CHECKING.
const POLL_MS = 5_000;
const MAX_POLLS = 6;

export function useInferencePrewarm(enabled) {
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let timer = null;
    (async () => {
      let voice;
      try {
        const res = await getMyVoiceProfiles('mine');
        voice = pickPrewarmVoice(Array.isArray(res.data?.voices) ? res.data.voices : []);
      } catch {
        return;
      }
      if (!voice || cancelled) return;
      let polls = 0;
      const poll = async () => {
        if (cancelled) return;
        polls += 1;
        try {
          const res = await prepareVoiceCapacity(voice.voiceProfileId);
          if (String(res?.data?.state || '').toUpperCase() !== 'CHECKING') return;
        } catch { /* best effort; the Test tab prepares again on selection */ }
        if (!cancelled && polls < MAX_POLLS) timer = window.setTimeout(poll, POLL_MS);
      };
      void poll();
    })();
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [enabled]);
}
