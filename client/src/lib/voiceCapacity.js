const BLOCKING_STATES = new Set(['CHECKING', 'STARTING', 'WARMING', 'LIMIT', 'ERROR', 'PAUSED']);

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
    waitStartedAt: Math.max(0, Number(value?.waitStartedAt) || 0),
    sharedBoot: value?.sharedBoot === true,
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
  if (value.state === 'PAUSED') {
    return value.message || 'The GPU has been turned off by an administrator, so voice features are unavailable for now.';
  }
  if (value.state === 'CHECKING') return 'Getting this voice ready…';
  if (value.state === 'STARTING' && value.sharedBoot) {
    return 'A GPU is already starting, and this voice loads on it as soon as it is up — no extra GPU is started for it. A GPU takes about 15 minutes to start (allow up to 20); the timer shows how long this one has been going. The chat unlocks automatically.';
  }
  if (value.state === 'STARTING') {
    return 'Starting a GPU with this voice. This takes about 15 minutes (allow up to 20). Please wait — the chat unlocks automatically, or try another lecture or voice meanwhile.';
  }
  if (value.state === 'WARMING') {
    return 'Switching an idle GPU to this voice. This usually takes under a minute. The chat unlocks automatically.';
  }
  if (value.state === 'BUSY_STARTING') {
    return 'Lots of people are using this voice. A new GPU is starting in the background, so you may be queued and replies can be slower. You can continue.';
  }
  if (value.state === 'BUSY_WARMING') {
    return 'Lots of people are using this voice. Another GPU is switching to it in the background, so replies can be slower. You can continue.';
  }
  if (value.state === 'BUSY_QUEUED') {
    return 'Lots of people are using this voice, so replies may wait briefly. Another GPU is added automatically if messages start queueing. You can continue.';
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
  STARTING: { estimateSeconds: 900, maxSeconds: 1200 },
  WARMING: { estimateSeconds: 60, maxSeconds: 180 },
};

export function voiceCapacityTitle(capacity = {}) {
  const value = normalizeVoiceCapacity(capacity);
  if (value.simulated) return 'Dev capacity simulation';
  if (value.state === 'PAUSED') return 'Voice features are off';
  if (value.state === 'STARTING') return value.sharedBoot ? 'Waiting for the GPU that is starting' : 'Starting a GPU with this voice';
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
  // One wait per voice: a boot that ends in a switch (STARTING -> WARMING) is
  // the same wait, so its timer, estimate and a dismissal carry over instead of
  // restarting at 0s.
  const same = previous && previous.voiceId === voiceId;
  // The coordinator's start time is shared by every user waiting on this voice
  // and survives a reload; the earliest known start wins.
  const serverStart = value.waitStartedAt ? Math.min(value.waitStartedAt, now) : 0;
  const startedAt = same
    ? Math.min(previous.startedAt, serverStart || previous.startedAt)
    : serverStart || now;
  return {
    // A boot never shrinks to a switch estimate mid-wait; a failed switch that
    // becomes a boot grows to the boot estimate.
    estimateSeconds: Math.max(timing.estimateSeconds, same ? Number(previous.estimateSeconds) || 0 : 0),
    maxSeconds: Math.max(timing.maxSeconds, same ? Number(previous.maxSeconds) || 0 : 0),
    title: voiceCapacityTitle(value),
    message: voiceCapacityNotice(value) || value.message,
    voiceId,
    state: value.state,
    startedAt,
    key: same ? previous.key : `${voiceId}:${value.state}:${startedAt}`,
  };
}
