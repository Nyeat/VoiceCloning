const BLOCKING_STATES = new Set(['CHECKING', 'STARTING', 'WARMING', 'LIMIT', 'ERROR']);

export function normalizeVoiceCapacity(value = {}) {
  const state = String(value?.state || 'CHECKING').trim().toUpperCase();
  return {
    state,
    canStartConversation: value?.canStartConversation === true,
    availableSlots: Math.max(0, Number(value?.availableSlots) || 0),
    capacityTight: value?.capacityTight === true,
    retryAfterSeconds: Math.max(0, Number(value?.retryAfterSeconds) || 0),
    capacityAction: String(value?.capacityAction || 'none').trim().toLowerCase(),
    simulated: value?.simulated === true,
    message: String(value?.message || '').trim(),
  };
}

export function voiceCapacityBlocksConversation(capacity = {}) {
  const normalized = normalizeVoiceCapacity(capacity);
  return BLOCKING_STATES.has(normalized.state) && !normalized.canStartConversation;
}

export function voiceCapacityNotice(capacity = {}) {
  const value = normalizeVoiceCapacity(capacity);
  if (value.simulated || value.state === 'SIMULATED') {
    return value.message || 'Dev capacity simulation: staging would prepare more capacity, but Dev autoscaling is disabled.';
  }
  if (value.state === 'ON_DEMAND') {
    return value.message || 'This voice will load on the first synthesis request. Selecting it did not start another GPU.';
  }
  // One wording for lectures, Faculty and Test your voice. A ready voice gets no
  // notice at all, even with one slot left.
  if (value.state === 'CHECKING') return 'Getting this voice ready…';
  if (value.state === 'STARTING') {
    return 'Starting a GPU with this voice. This takes about 10 minutes (allow up to 15). Please wait — the chat unlocks automatically, or try another lecture or voice meanwhile.';
  }
  if (value.state === 'WARMING') {
    return 'Switching a GPU to this voice. This usually takes under a minute (up to 3 minutes if that GPU was just in use). The chat unlocks automatically.';
  }
  if (value.state === 'BUSY_STARTING') {
    return 'Lots of people are using this voice. A new GPU is starting in the background, so you may be queued and replies can be slower. You can continue.';
  }
  if (value.state === 'BUSY_WARMING') {
    return 'Lots of people are using this voice. Another GPU is switching to it in the background, so replies can be slower. You can continue.';
  }
  if (value.state === 'BUSY_LIMIT') {
    return 'Lots of people are using this voice and every GPU is in use. You can continue, but replies may be slower.';
  }
  if (value.state === 'LIMIT') {
    return 'Every GPU is in use, so this voice cannot start right now. Please try again shortly or use another voice.';
  }
  if (['READY', 'READY_SCALING', 'READY_WARMING'].includes(value.state)) return '';
  if (value.state === 'ERROR') return 'Voice capacity could not be verified. Please retry before starting a conversation.';
  return '';
}

// Popup timings for a voice that is not usable yet: a cold GPU boot takes
// minutes, a switch on a warm GPU seconds. Estimates only; the popup closes on
// the coordinator's real READY.
export const CAPACITY_WAITS = {
  STARTING: { estimateSeconds: 600, maxSeconds: 900 },
  WARMING: { estimateSeconds: 60, maxSeconds: 180 },
};

export function voiceCapacityTitle(capacity = {}) {
  const value = normalizeVoiceCapacity(capacity);
  if (value.simulated) return 'Dev capacity simulation';
  if (value.state === 'STARTING') return 'Starting a GPU with this voice';
  if (value.state === 'WARMING') return 'Switching a GPU to this voice';
  return 'Getting this voice ready';
}

// The GpuWaitDialog `wait` for a voice, or null when nothing is being waited
// on. Pass the previous wait back in so polls keep its key and start time (the
// timer and a dismissal survive); a new voice or a new phase starts a new wait.
// Every site uses this, so lectures and Live Fast show the same popup.
export function voiceCapacityWait(capacity = {}, previous = null, voiceId = '', now = Date.now()) {
  const value = normalizeVoiceCapacity(capacity);
  const timing = value.simulated || value.canStartConversation ? null : CAPACITY_WAITS[value.state];
  if (!timing) return null;
  const same = previous && previous.voiceId === voiceId && previous.state === value.state;
  const startedAt = same ? previous.startedAt : now;
  return {
    ...timing,
    title: voiceCapacityTitle(value),
    message: voiceCapacityNotice(value) || value.message,
    voiceId,
    state: value.state,
    startedAt,
    key: same ? previous.key : `${voiceId}:${value.state}:${startedAt}`,
  };
}
