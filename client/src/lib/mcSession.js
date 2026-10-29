export const MC_SYSTEM_PROMPT = `You are an AI co-host sharing the stage with a human master of ceremonies at Nanyang Technological University, Singapore. Speak with the warmth, poise, and clear delivery of an experienced public speaker. You are an AI using a cloned Dean voice, not the Dean himself; never claim to be him or speak on his behalf.

Listen to the human host and respond to what they actually say. Keep the exchange lively, courteous, and natural. Usually answer in one to three short sentences, then leave space for the host. Match their energy without overdoing enthusiasm. Use light, inclusive humour when it fits. Do not greet the audience again on every turn or invent applause, stage directions, sound effects, or other speakers' dialogue.

Help with introductions, transitions, audience engagement, and conversational questions. Only use event details, names, titles, and schedules supplied by the host; ask a brief clarification instead of inventing them. Do not assume every question is medical or restrict the conversation to a lecture. Do not claim to see the room or know who is present. If asked to wait, acknowledge briefly and wait for the host's next turn.

Write only the words to be spoken aloud, with natural punctuation. No markdown, lists, or stage directions. Always respond in English.`;

// Turn detection and noise filtering measured with scripts/vad-bench-mc.mjs
// (2026-10-06). Server VAD ends a turn about pauseMs + 0.6 s after the speaker
// stops, every time; semantic VAD's tail reached 3-5 s. A stricter VAD
// threshold with far-field noise reduction cut false turns from a background
// talker from 6 (0.5) to 4 (0.65) to 2 (0.8) and still caught a soft speaker;
// with no noise reduction a background talker kept the turn from ever ending.
// 500 ms of pre-speech audio keeps word onsets in the transcript. The
// transcriber gets no prompt: a context prompt leaked into transcripts.
export const NOISE_LEVELS = Object.freeze([
  { label: 'Off', hint: 'No filtering. Quiet rooms only: background talk can stop your turn from ending.', threshold: 0.5, noiseReduction: 'off', browser: false },
  { label: 'Low', hint: 'Light filtering for a quiet room with a close mic.', threshold: 0.5, noiseReduction: 'near_field', browser: true },
  { label: 'Medium', hint: 'Recommended. Removes steady noise and ignores most background chatter.', threshold: 0.65, noiseReduction: 'far_field', browser: true },
  { label: 'High', hint: 'For a noisy hall. Speak toward the mic.', threshold: 0.72, noiseReduction: 'far_field', browser: true },
  { label: 'Max', hint: 'Ignores the most background talk. Very soft voices may be missed.', threshold: 0.8, noiseReduction: 'far_field', browser: true },
]);
export const PAUSE_RANGE = Object.freeze({ min: 400, max: 1500, step: 100 });
export const MC_DEFAULT_CAPTURE = Object.freeze({ noiseLevel: 2, pauseMs: 700 });

export function normalizeCaptureSettings(value) {
  const level = Math.round(Number(value?.noiseLevel));
  const pause = Math.round(Number(value?.pauseMs) / PAUSE_RANGE.step) * PAUSE_RANGE.step;
  return {
    noiseLevel: level >= 0 && level < NOISE_LEVELS.length ? level : MC_DEFAULT_CAPTURE.noiseLevel,
    pauseMs: pause >= PAUSE_RANGE.min && pause <= PAUSE_RANGE.max ? pause : MC_DEFAULT_CAPTURE.pauseMs,
  };
}

export function sameCaptureSettings(a, b) {
  const x = normalizeCaptureSettings(a);
  const y = normalizeCaptureSettings(b);
  return x.noiseLevel === y.noiseLevel && x.pauseMs === y.pauseMs;
}

// The operator's saved instructions, kept in this browser so a reload or the
// next visit starts from them instead of the bundled default. Anything that is
// not a non-empty string within the textarea limit reads as the default.
export const MC_INSTRUCTIONS_MAX = 12000;

export function normalizeSavedInstructions(value) {
  return typeof value === 'string' && value.trim() && value.length <= MC_INSTRUCTIONS_MAX ? value : MC_SYSTEM_PROMPT;
}

// session.init extras for the gateway.
export function mcSessionOptions(settings = MC_DEFAULT_CAPTURE) {
  const { noiseLevel, pauseMs } = normalizeCaptureSettings(settings);
  return {
    turnDetection: { type: 'server_vad', threshold: NOISE_LEVELS[noiseLevel].threshold, silenceMs: pauseMs, prefixMs: 500 },
    noiseReduction: NOISE_LEVELS[noiseLevel].noiseReduction,
  };
}

// Browser-side capture processing. Echo cancellation always stays on.
export function mcMicConstraints(settings = MC_DEFAULT_CAPTURE) {
  return { noiseSuppression: NOISE_LEVELS[normalizeCaptureSettings(settings).noiseLevel].browser };
}

const PENDING_TEXT = new Set(['Listening...', 'Transcribing...', 'Thinking...']);

// One bubble per message. Placeholder text becomes a typing indicator, and a
// reply that was cut short is kept and tagged, never hidden.
export function mcTranscriptEntries(messages) {
  return messages.map((message) => {
    const pending = !message.text || PENDING_TEXT.has(message.text);
    return {
      id: message.id,
      role: message.role,
      text: pending ? '' : message.text,
      pending,
      interrupted: message.role === 'assistant' && message.status === 'interrupted',
    };
  });
}

export function mcSessionStatus({ phase, micEnabled, listeningMode, reconnecting = false, userSpeaking = false, replyAudible = true }) {
  if (phase === 'idle') return 'Ready when you are';
  // A reply already playing keeps playing through a reconnect.
  if (reconnecting && phase !== 'speaking') return 'Connection dropped · reconnecting';
  if (phase === 'connecting') return 'Connecting your session';
  if (phase === 'stopping') return 'Ending session';
  if (phase === 'speaking' && replyAudible) {
    if (listeningMode === 'turns') return 'AI MC speaking · mic paused';
    return micEnabled ? 'AI MC speaking · talk to interrupt' : 'AI MC speaking';
  }
  if (micEnabled && userSpeaking) return 'Hearing you…';
  if (phase === 'thinking' || phase === 'speaking') return 'Got it · replying';
  return micEnabled ? 'Listening · go ahead' : 'Muted · tap the mic to talk';
}
