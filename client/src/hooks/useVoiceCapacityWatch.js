import { useEffect, useRef, useState } from 'react';
import { prepareVoiceCapacity } from '@/services/api.js';
import { runWhenPageVisible } from '@/lib/pageVisibility';
import {
  normalizeVoiceCapacity,
  voiceCapacityBlocksConversation,
  voiceCapacityNotice,
  voiceCapacityWait,
} from '@/lib/voiceCapacity';

// Prepares one cloned voice and reports it the way every site shows it: a
// blocking "Starting/Switching a GPU" wait (chat locked), a non-blocking
// "heavily loaded" notice (chat usable), or nothing when ready. Same polling
// cadence as the lecture chat: every 5 s for the first minute, then 15 s.
export function useVoiceCapacityWatch(voiceProfileId, { enabled = true } = {}) {
  const [capacity, setCapacity] = useState(() => normalizeVoiceCapacity());
  const waitRef = useRef(null);

  useEffect(() => {
    if (!enabled || !voiceProfileId) return undefined;
    let cancelled = false;
    let timer = null;
    let checks = 0;
    const check = async () => {
      checks += 1;
      try {
        const response = await prepareVoiceCapacity(voiceProfileId);
        if (cancelled) return;
        const next = normalizeVoiceCapacity(response?.data || {});
        setCapacity(next);
        if (next.state !== 'READY' || next.capacityTight) {
          const delay = next.state !== 'READY' && checks <= 12 ? 5_000 : 15_000;
          timer = window.setTimeout(() => runWhenPageVisible(() => { if (!cancelled) void check(); }), delay);
        }
      } catch {
        if (cancelled) return;
        setCapacity(normalizeVoiceCapacity({ state: 'ERROR' }));
        timer = window.setTimeout(check, 15_000);
      }
    };
    setCapacity(normalizeVoiceCapacity());
    runWhenPageVisible(() => { if (!cancelled) void check(); });
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [enabled, voiceProfileId]);

  waitRef.current = enabled ? voiceCapacityWait(capacity, waitRef.current, voiceProfileId) : null;
  const message = voiceCapacityNotice(capacity);
  return {
    capacity,
    blocked: enabled && voiceCapacityBlocksConversation(capacity),
    message,
    wait: waitRef.current,
    busy: enabled && /^BUSY_/u.test(capacity.state)
      ? { key: capacity.state, tone: 'info', title: 'Voice is heavily loaded', message }
      : null,
  };
}
