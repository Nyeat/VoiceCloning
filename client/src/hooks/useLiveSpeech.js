import { useEffect, useRef, useState } from 'react';
import {
  cancelGeneration,
  cancelLiveReply,
  getInferenceChunk,
  startGeneration,
  synthesize,
  synthesizeSentence,
} from '../services/api.js';
import { createLiveChatSocket } from '../services/liveChatSocket.js';
import { MIC_TARGET_SAMPLE_RATE, startMicFrames } from '../lib/micCapture.js';
import { acquireApiToken, shouldAttachApiToken } from '../auth/msalClient.js';

export const LIVE_SESSION_READY_TIMEOUT_MS = 15_000;
import { connectInferenceSSE } from '../services/sse.js';
import {
  capacityWaitMessage,
  isCapacityWaitError,
  sanitizeBackendError,
} from '../lib/backendErrors.js';
import { runSynthesisWithRetry } from '../lib/synthesisRetry.js';
import { MC_DEFAULT_CAPTURE, mcMicConstraints, mcSessionOptions } from '../lib/mcSession.js';

// One microphone/turn-taking setup for every chatbot: Live MC's recommended
// "Medium" preset (server VAD 0.65, 0.7 s end-of-turn pause, far-field noise
// reduction, browser noise suppression). Live MC alone overrides it from its
// sliders. Before 2026-11-17 the other chatbots sent nothing and got the
// gateway's semantic VAD, which can wait ~4 s to end a turn.
const DEFAULT_SESSION_OPTIONS = Object.freeze(mcSessionOptions(MC_DEFAULT_CAPTURE));
const DEFAULT_MIC_CONSTRAINTS = Object.freeze(mcMicConstraints(MC_DEFAULT_CAPTURE));
import {
  VIDEO_POSITION_SYNC_INTERVAL_MS,
  shouldSendVideoPosition,
} from '../lib/lessonVideoContext.js';
import {
  LIVE_REPLY_MODES,
  MIN_COMMIT_VOICE_FRAMES,
  USER_TRANSCRIPT_TIMEOUT_MS,
  VOICE_GATE,
  buildLiveSentenceParams,
  buildLiveReplyParams,
  canReuseActiveUserMessage,
  cleanLiveText,
  createChatMessage,
  createLiveSynthesisSnapshot,
  createVoiceGateState,
  nextVoiceGateState,
  findFirstReplayablePart,
  findNextPhrasePlayback,
  findNextReplyPlayback,
  findSelectedPlayback,
  hasPendingReplyWork,
  getMicOffAction,
  isLiveInputPhase,
  isBenignRealtimeError,
  fixSpeechPronunciation,
  interClipGapMs,
  normalizeLiveLanguage,
  normalizeTypedMessage,
  resolvePendingTranscriptPatch,
  resolveSpeakingContinuation,
  shortenFirstFastPhrase,
  splitLiveReplyChunks,
  takeCompleteStreamedSentence,
  shouldTriggerLiveBargeIn,
  shouldSendLiveMicAudio,
  updateMessage,
  buildReconnectSystemPrompt,
  liveReconnectDelayMs,
  LIVE_RECONNECT_MAX_ATTEMPTS,
} from './liveConversation.js';

// While the shared GPU is stopping/restarting, in-flight synth and live-gateway
// calls come back as CloudFront/gateway errors (504 "gateway closed", 503, etc.).
// Turn those into a calm, human message instead of leaking the raw gateway text.
function friendlyLiveError(rawMessage, { prefix = '', fallback = 'The GPU is restarting — please try again in a moment.' } = {}) {
  const clean = sanitizeBackendError(rawMessage);
  if (!clean) return fallback;
  return prefix ? `${prefix}${clean}` : clean;
}

const LIVE_TARGET_SAMPLE_RATE = 24000;
const MANUAL_COMMIT_SILENCE_MS = 360;
// ~4s of 4096-sample frames: covers semantic_vad's longest end-of-turn wait.
const VOICE_GATE_SILENCE_TAIL_FRAMES = 48;
const BARGE_IN_MIN_FRAMES = 2;
const BARGE_IN_COOLDOWN_MS = 900;
// While a long reply plays, the mic is muted so nothing flows over the WebSocket.
// An idle WebSocket behind CloudFront/proxies gets closed at the idle timeout
// (~60s), which would end the conversation mid-reply. Send a lightweight
// keepalive well under that window to keep the connection warm. The gateway
// ignores unknown message types.
const KEEPALIVE_INTERVAL_MS = 15000;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRms(samples) {
  if (!samples.length) return 0;

  let sumSq = 0;
  for (let i = 0; i < samples.length; i += 1) {
    sumSq += samples[i] * samples[i];
  }
  return Math.sqrt(sumSq / samples.length);
}

function downsampleBuffer(input, inputSampleRate, outputSampleRate) {
  if (outputSampleRate === inputSampleRate) return input;
  if (outputSampleRate > inputSampleRate) {
    throw new Error('Output sample rate must be lower than input sample rate.');
  }

  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.round(input.length / ratio);
  const output = new Float32Array(outputLength);

  let inputOffset = 0;
  for (let i = 0; i < outputLength; i += 1) {
    const nextInputOffset = Math.round((i + 1) * ratio);
    let sum = 0;
    let count = 0;
    for (let j = inputOffset; j < nextInputOffset && j < input.length; j += 1) {
      sum += input[j];
      count += 1;
    }
    output[i] = count > 0 ? sum / count : 0;
    inputOffset = nextInputOffset;
  }

  return output;
}

function pcm16Base64(samples) {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);

  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function encodeOpenAiAudioChunk(input, inputSampleRate) {
  const downsampled = downsampleBuffer(input, inputSampleRate, LIVE_TARGET_SAMPLE_RATE);
  return pcm16Base64(downsampled);
}

export function useLiveSpeech({
  refParams,
  fullRefParams = null,
  engine = 'fast',
  replyMode = LIVE_REPLY_MODES.full,
  language = 'en',
  voiceProfileId = '',
  voiceModel = null,
  systemPrompt = '',
  listeningMode = 'continuous',
  fastMaxChunkWords = 0,
  fastMaxSentencesPerChunk = 1,
  getVideoPosition = null,
  onUserQuestion = null,
  // Reopen a dropped live socket instead of ending the conversation (Live MC).
  autoReconnect = false,
  // false streams all mic audio to OpenAI instead of only above-threshold frames.
  noiseGate = true,
  // OpenAI's VAD drives interruption: continuous mode keeps streaming while the
  // AI speaks, and speech during "thinking" drops the half-ready reply.
  fullDuplex = false,
  // Extra session.init fields (turnDetection, noiseReduction, ...) for the gateway.
  sessionOptions = null,
  // getUserMedia audio constraint overrides (e.g. { noiseSuppression: false }).
  micConstraints = null,
} = {}) {
  const isPhraseMode = replyMode === LIVE_REPLY_MODES.phrases;
  const liveLanguage = normalizeLiveLanguage(language);
  const [phase, setPhaseState] = useState('idle');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [messages, setMessages] = useState([]);
  const [selectedReplyId, setSelectedReplyIdState] = useState('');
  // The banner needs to say more than "something went wrong": a GPU switching to
  // this voice is a wait, not a breakage. Tone rides along with the text so the
  // UI never has to guess intent from wording.
  const [errorState, setErrorState] = useState(null);
  const error = errorState?.text ?? null;
  const errorTone = errorState?.tone ?? 'error';

  function setError(value, tone = 'error') {
    if (value == null) {
      setErrorState(null);
      return;
    }
    setErrorState({ text: String(value), tone });
  }
  const [audioLevel, setAudioLevel] = useState(0);
  const [micInputEnabled, setMicInputEnabledState] = useState(false);
  const [bargeInArmed, setBargeInArmedState] = useState(false);
  const [notice, setNotice] = useState('');
  const [speechApiAvailable, setSpeechApiAvailable] = useState(
    typeof window !== 'undefined' && Boolean(window.AudioContext || window.webkitAudioContext)
  );

  const phaseRef = useRef('idle');
  const socketRef = useRef(null);
  const keepAliveTimerRef = useRef(null);
  const autoReconnectRef = useRef(autoReconnect);
  autoReconnectRef.current = autoReconnect;
  const noiseGateRef = useRef(noiseGate);
  noiseGateRef.current = noiseGate;
  const fullDuplexRef = useRef(fullDuplex);
  fullDuplexRef.current = fullDuplex;
  const micCaptureRef = useRef(null);
  const micConstraintsRef = useRef(micConstraints || DEFAULT_MIC_CONSTRAINTS);
  micConstraintsRef.current = micConstraints || DEFAULT_MIC_CONSTRAINTS;
  // OpenAI's VAD says the user is talking right now (between speech events).
  const userSpeakingRef = useRef(false);
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);
  function setUserSpeaking(value) {
    userSpeakingRef.current = value;
    setIsUserSpeaking(value);
  }
  // reconnectingRef spans the gap between a drop and the next session.ready, so
  // the conversation counts as live (not idle) while the socket is reopened.
  const reconnectingRef = useRef(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  function setReconnecting(value) {
    reconnectingRef.current = value;
    setIsReconnecting(value);
  }
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef(null);
  const sessionEverReadyRef = useRef(false);
  const videoPositionTimerRef = useRef(null);
  const lastSentVideoPositionRef = useRef(null);
  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const isCancelledRef = useRef(false);
  const runIdRef = useRef(0);
  const messageSeqRef = useRef(0);
  const messagesRef = useRef([]);
  const selectedReplyIdRef = useRef('');
  const micInputEnabledRef = useRef(false);
  const activeUserMessageIdRef = useRef('');
  const activeAssistantMessageIdRef = useRef('');
  const currentSynthesisMessageIdRef = useRef('');
  const cancelledReplyIdsRef = useRef(new Set());
  // messageId -> per-reply token sent with every clip of that reply, so barge-in
  // can tell the worker to release clips still queued for the GPU. Must be unique
  // across users, not just within this tab.
  const replyTokensRef = useRef(new Map());
  const userTextBuffersRef = useRef(new Map());
  const userTranscriptTimersRef = useRef(new Map());
  const voiceGateRef = useRef(createVoiceGateState());
  const gatePrerollRef = useRef([]);
  // Frames of digital silence still owed to OpenAI after the gate closes.
  const gateSilenceTailRef = useRef(0);
  const turnVoicedFramesRef = useRef(0);
  const assistantTextRef = useRef('');
  const streamedFastReplyRef = useRef(null);
  const noticeTimeoutRef = useRef(null);
  const pendingInputAudioRef = useRef(false);
  // A typed question waiting for the session to come up. The Realtime session
  // cannot accept a turn before session.ready, so a message sent from a cold
  // start is held here and flushed by that event.
  const pendingTextRef = useRef('');
  const sessionReadyTimerRef = useRef(null);
  const inferenceEventSourceRef = useRef(null);
  const activeInferenceSessionIdRef = useRef('');
  const conversationSynthesisRef = useRef(null);
  const bargeInArmedRef = useRef(false);
  const bargeInFramesRef = useRef(0);
  const lastBargeInAtRef = useRef(0);
  const clipGapTimerRef = useRef(null);
  // Engine + ref params are read through refs so switching Live Fast <-> Live Full
  // takes effect on the next reply even while a conversation is already open (the
  // socket handler captured the render snapshot when start() ran).
  const refParamsRef = useRef(refParams);
  const fullRefParamsRef = useRef(fullRefParams);
  const engineRef = useRef(engine);
  const voiceProfileIdRef = useRef(voiceProfileId);
  const voiceModelRef = useRef(voiceModel);
  const systemPromptRef = useRef(systemPrompt);
  const listeningModeRef = useRef(listeningMode);
  useEffect(() => {
    listeningModeRef.current = listeningMode;
    syncOpenAiInputWithMic();
  }, [listeningMode]);
  const getVideoPositionRef = useRef(getVideoPosition);
  const fastMaxChunkWordsRef = useRef(fastMaxChunkWords);
  const fastMaxSentencesPerChunkRef = useRef(fastMaxSentencesPerChunk);
  useEffect(() => { refParamsRef.current = refParams; }, [refParams]);
  useEffect(() => { fullRefParamsRef.current = fullRefParams; }, [fullRefParams]);
  useEffect(() => { engineRef.current = engine; }, [engine]);
  useEffect(() => { voiceProfileIdRef.current = voiceProfileId; }, [voiceProfileId]);
  useEffect(() => { voiceModelRef.current = voiceModel; }, [voiceModel]);
  useEffect(() => { systemPromptRef.current = systemPrompt; }, [systemPrompt]);
  useEffect(() => { getVideoPositionRef.current = getVideoPosition; }, [getVideoPosition]);
  useEffect(() => { fastMaxChunkWordsRef.current = fastMaxChunkWords; }, [fastMaxChunkWords]);
  useEffect(() => {
    fastMaxSentencesPerChunkRef.current = fastMaxSentencesPerChunk;
  }, [fastMaxSentencesPerChunk]);

  // Live Full uses the accurate /inference route with its own ref params; it falls
  // back to the Live Fast reference set when no dedicated Live Full set is ready.
  function getActiveSynthesisSnapshot() {
    return conversationSynthesisRef.current || createLiveSynthesisSnapshot({
      engine: engineRef.current,
      refParams: refParamsRef.current,
      fullRefParams: fullRefParamsRef.current,
      voiceProfileId: voiceProfileIdRef.current,
      voiceModel: voiceModelRef.current,
    });
  }

  function getActiveRefParams() {
    return getActiveSynthesisSnapshot().refParams;
  }

  function synthesizeForEngine(engine, params, options = {}) {
    return engine === 'full'
      ? synthesizeWithRetry(params)
      : synthesizeSentenceWithRetry(params, options);
  }

  function setPhase(phase) {
    phaseRef.current = phase;
    setPhaseState(phase);
    if (listeningModeRef.current === 'turns') {
      gatePrerollRef.current = [];
      voiceGateRef.current = createVoiceGateState();
      syncOpenAiInputWithMic(phase);
    }
  }

  function setSelectedReplyId(id) {
    selectedReplyIdRef.current = id;
    setSelectedReplyIdState(id);
  }

  function setMicInputEnabled(value) {
    micInputEnabledRef.current = Boolean(value);
    setMicInputEnabledState(Boolean(value));
  }

  function setBargeInArmed(value) {
    bargeInArmedRef.current = Boolean(value);
    setBargeInArmedState(Boolean(value));
  }

  function setMessagesSync(updater) {
    setMessages((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      messagesRef.current = next;
      return next;
    });
  }

  function nextMessageId(prefix) {
    messageSeqRef.current += 1;
    return `${prefix}-${Date.now()}-${messageSeqRef.current}`;
  }

  function patchMessage(id, patch) {
    setMessagesSync((prev) => updateMessage(prev, id, patch));
  }

  function patchAudioPart(messageId, partId, patch) {
    setMessagesSync((prev) =>
      prev.map((message) => {
        if (message.id !== messageId) return message;
        return {
          ...message,
          audioParts: (message.audioParts || []).map((part) =>
            part.id === partId ? { ...part, ...patch } : part
          ),
        };
      })
    );
  }

  function appendAudioParts(messageId, parts) {
    if (!Array.isArray(parts) || parts.length === 0) return;
    setMessagesSync((prev) =>
      prev.map((message) => (
        message.id === messageId
          ? { ...message, audioParts: [...(message.audioParts || []), ...parts] }
          : message
      ))
    );
  }

  function appendMessage(message) {
    setMessagesSync((prev) => [...prev, message]);
  }

  function removeMessage(id) {
    setMessagesSync((prev) => prev.filter((message) => message.id !== id));
  }

  function showNotice(message) {
    setNotice(message);
    if (noticeTimeoutRef.current) {
      window.clearTimeout(noticeTimeoutRef.current);
    }
    noticeTimeoutRef.current = window.setTimeout(() => {
      setNotice('');
      noticeTimeoutRef.current = null;
    }, 3500);
  }

  function revokeMessageAudio(message) {
    if (message?.audioUrl) {
      try {
        URL.revokeObjectURL(message.audioUrl);
      } catch {
        // Ignore object URL cleanup failures.
      }
    }
    for (const part of message?.audioParts || []) {
      if (part.audioUrl) {
        try {
          URL.revokeObjectURL(part.audioUrl);
        } catch {
          // Ignore object URL cleanup failures.
        }
      }
    }
  }

  function cleanupConversation() {
    if (sessionReadyTimerRef.current) {
      window.clearTimeout(sessionReadyTimerRef.current);
      sessionReadyTimerRef.current = null;
    }
    if (inferenceEventSourceRef.current) {
      inferenceEventSourceRef.current.close();
      inferenceEventSourceRef.current = null;
    }
    if (activeInferenceSessionIdRef.current) {
      cancelGeneration(activeInferenceSessionIdRef.current).catch(() => {});
      activeInferenceSessionIdRef.current = '';
    }
    for (const message of messagesRef.current) {
      revokeMessageAudio(message);
    }
    messagesRef.current = [];
    setMessages([]);
    setSelectedReplyId('');
    activeUserMessageIdRef.current = '';
    activeAssistantMessageIdRef.current = '';
    currentSynthesisMessageIdRef.current = '';
    streamedFastReplyRef.current = null;
    pendingInputAudioRef.current = false;
    setBargeInArmed(false);
    bargeInFramesRef.current = 0;
    lastBargeInAtRef.current = 0;
    cancelledReplyIdsRef.current = new Set();
    replyTokensRef.current = new Map();
    userTextBuffersRef.current = new Map();
    clearAllUserTranscriptTimers();
  }

  function clearUserTranscriptTimer(id) {
    const timer = userTranscriptTimersRef.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      userTranscriptTimersRef.current.delete(id);
    }
  }

  function clearAllUserTranscriptTimers() {
    for (const timer of userTranscriptTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    userTranscriptTimersRef.current = new Map();
  }

  // Close a user bubble whose transcript never arrived and release the active
  // ref so the next turn gets its own bubble. No-ops unless the bubble is
  // actually stuck in 'transcribing'.
  function finalizePendingUserMessage(id) {
    const message = messagesRef.current.find((entry) => entry.id === id);
    const patch = resolvePendingTranscriptPatch(message);
    if (!patch) return;
    clearUserTranscriptTimer(id);
    userTextBuffersRef.current.delete(message.itemId || id);
    patchMessage(id, patch);
    if (activeUserMessageIdRef.current === id) {
      activeUserMessageIdRef.current = '';
    }
  }

  // The gateway normally closes every turn with user.text.done/failed. This
  // timer is the client's own guarantee: if that terminal event is lost (WS
  // drop, gateway bug, OpenAI never emitting transcription.completed), the
  // bubble still resolves instead of hanging on "Transcribing..." and being
  // overwritten by the next turn.
  function armUserTranscriptTimer(id) {
    clearUserTranscriptTimer(id);
    userTranscriptTimersRef.current.set(id, window.setTimeout(() => {
      userTranscriptTimersRef.current.delete(id);
      finalizePendingUserMessage(id);
    }, USER_TRANSCRIPT_TIMEOUT_MS));
  }

  function findUserMessageId(itemId) {
    if (itemId) {
      const existing = messagesRef.current.find(
        (message) => message.role === 'user' && message.itemId === itemId
      );
      if (existing) return existing.id;
    }

    const activeId = activeUserMessageIdRef.current;
    if (!activeId) return '';
    const active = messagesRef.current.find((message) => message.id === activeId);
    // A finished bubble is history, and a bubble keyed to a different turn
    // belongs to that turn. Reusing either would overwrite a previous message
    // (a stale ref once turned a finished transcript into the next turn's
    // "Transcribing..."), so drop the ref and let the caller create a fresh one.
    if (
      !canReuseActiveUserMessage(active)
      || (itemId && active.itemId && active.itemId !== itemId)
    ) {
      activeUserMessageIdRef.current = '';
      return '';
    }
    return activeId;
  }

  function ensureUserMessage(itemId = '') {
    const existingId = findUserMessageId(itemId);
    if (existingId) {
      if (itemId) patchMessage(existingId, { itemId });
      return existingId;
    }

    const id = itemId ? `user-${itemId}` : nextMessageId('user');
    activeUserMessageIdRef.current = id;
    appendMessage(createChatMessage({
      id,
      role: 'user',
      itemId,
      text: 'Listening...',
      status: 'listening',
    }));
    return id;
  }

  function ensureAssistantMessage() {
    if (activeAssistantMessageIdRef.current) {
      return activeAssistantMessageIdRef.current;
    }

    const id = nextMessageId('assistant');
    activeAssistantMessageIdRef.current = id;
    appendMessage(createChatMessage({
      id,
      role: 'assistant',
      text: '',
      status: 'thinking',
    }));
    return id;
  }

  function pauseOpenAiInput() {
    socketRef.current?.send({ type: 'input.pause' });
  }

  function resumeOpenAiInput() {
    socketRef.current?.send({ type: 'input.resume' });
  }

  function commitOpenAiInput() {
    const sent = socketRef.current?.send({ type: 'input.commit' });
    if (sent) {
      pendingInputAudioRef.current = false;
    }
    return sent;
  }

  function sendManualCommitTail() {
    const sampleCount = Math.round((LIVE_TARGET_SAMPLE_RATE * MANUAL_COMMIT_SILENCE_MS) / 1000);
    sendAudioChunk(new Float32Array(sampleCount), LIVE_TARGET_SAMPLE_RATE);
  }

  // A reply starting used to close the mic outright. Full duplex keeps it open
  // (a continuation or a barge-in must still be heard) and lets the phase rule
  // decide instead.
  function pauseInputForReply() {
    if (fullDuplexRef.current) {
      syncOpenAiInputWithMic();
      return;
    }
    pauseOpenAiInput();
  }

  function syncOpenAiInputWithMic(nextPhase = phaseRef.current) {
    if (shouldSendLiveMicAudio({ fullDuplex: fullDuplexRef.current, phase: nextPhase, micInputEnabled: micInputEnabledRef.current, listeningMode: listeningModeRef.current })) {
      resumeOpenAiInput();
      return;
    }
    pauseOpenAiInput();
  }

  // One transient 5xx must not kill a whole reply: in phrase mode the failure of
  // any clip abandons every clip after it, so the student gets a silent answer
  // from a GPU that was merely still warming up.
  async function withSynthesisRetry(run) {
    const result = await runSynthesisWithRetry(run, {
      isCancelled: () => isCancelledRef.current,
      wait,
      onCapacityWait: (err) => {
        setError(capacityWaitMessage(err, { autoRetry: true }), 'waiting');
      },
    });
    // A wait banner can belong to an earlier sentence/request. Any successful
    // synthesis is stronger, newer evidence that this voice has usable
    // capacity, so never leave that stale status visible while audio plays.
    setErrorState((current) => current?.tone === 'waiting' ? null : current);
    return result;
  }

  // A capacity wait and a real failure reach the UI by the same four paths; only
  // the tone and the wording differ, so build both in one place.
  function reportSynthesisFailure(err, patchTarget) {
    const waitMessage = capacityWaitMessage(err);
    const tone = isCapacityWaitError(err) ? 'waiting' : 'error';
    patchTarget({
      status: 'error',
      error: waitMessage || err.message || 'Voice generation failed',
      errorTone: tone,
    });
    return { tone, waitMessage };
  }

  function setSynthesisBanner(err, { tone, waitMessage }) {
    if (tone === 'waiting') {
      setError(waitMessage, 'waiting');
      return;
    }
    setError(friendlyLiveError(err.message, { prefix: 'Voice reply failed: ' }), 'error');
  }

  function synthesizeWithRetry(params) {
    return withSynthesisRetry(() => synthesize(params));
  }

  function synthesizeSentenceWithRetry(params, options = {}) {
    return withSynthesisRetry(() => synthesizeSentence(params, options));
  }

  // Stable for the life of a reply: every clip of that reply carries the same
  // token, so one cancel frees all of its queued clips.
  function replyTokenFor(messageId) {
    const existing = replyTokensRef.current.get(messageId);
    if (existing) return existing;

    const token = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    replyTokensRef.current.set(messageId, token);
    return token;
  }

  function isVoiceStoppedMessage(messageId) {
    return Boolean(messagesRef.current.find((item) => item.id === messageId)?.voiceStopped);
  }

  // Starting to synthesize a new reply must not cut off a clip that is still
  // reading an earlier reply aloud (a Realtime interruption splits one reply
  // across messages). Keep an actively playing selection — when its clip ends,
  // onAudioEnded chains into this message's parts. Only reset the selection
  // when nothing is actually playing.
  function clearReplySelectionUnlessPlaying() {
    const active = findSelectedPlayback(messagesRef.current, selectedReplyIdRef.current);
    if (!active || phaseRef.current !== 'speaking') {
      setSelectedReplyId('');
    }
  }

  async function synthesizeFullAssistantReply(messageId, text, runId) {
    const synthesis = getActiveSynthesisSnapshot();
    const activeRefParams = synthesis.refParams;
    if (!activeRefParams) {
      patchMessage(messageId, { status: 'error', error: 'No reference audio configured.' });
      return;
    }

    currentSynthesisMessageIdRef.current = messageId;
    cancelledReplyIdsRef.current.delete(messageId);
    pauseInputForReply();
    setSelectedReplyId(messageId);
    setPhase('speaking');
    patchMessage(messageId, { status: 'generating_voice', error: null });

    try {
      const { blob } = await synthesizeForEngine(
        synthesis.engine,
        buildLiveReplyParams(text, activeRefParams, liveLanguage)
      );
      if (
        isCancelledRef.current ||
        runId !== runIdRef.current ||
        cancelledReplyIdsRef.current.has(messageId)
      ) {
        return;
      }

      const url = URL.createObjectURL(blob);
      patchMessage(messageId, { status: 'ready', audioUrl: url, error: null });
      // A voice-stopped reply finishes generating silently; the user replays
      // it with the Play voice button.
      if (!isVoiceStoppedMessage(messageId)) {
        setSelectedReplyId(messageId);
        setPhase('speaking');
      }
    } catch (err) {
      if (isCancelledRef.current || runId !== runIdRef.current) return;

      const outcome = reportSynthesisFailure(err, (patch) => patchMessage(messageId, patch));
      if (!isVoiceStoppedMessage(messageId)) {
        setSynthesisBanner(err, outcome);
        const nextPhase = hasLiveConnection() ? 'listening' : 'idle';
        setPhase(nextPhase);
        syncOpenAiInputWithMic(nextPhase);
      }
    } finally {
      if (currentSynthesisMessageIdRef.current === messageId) {
        currentSynthesisMessageIdRef.current = '';
      }
    }
  }

  async function synthesizePhraseAssistantReply(messageId, text, runId) {
    const synthesis = getActiveSynthesisSnapshot();
    const activeRefParams = synthesis.refParams;
    // The message was already marked generating_voice — settle its status on
    // early exits so it can't pin the conversation in the 'speaking' phase.
    if (!activeRefParams) {
      patchMessage(messageId, { status: 'error', error: 'No reference audio configured.' });
      return;
    }

    if (synthesis.engine === 'full') {
      await synthesizeFullQueuedAssistantReply(messageId, text, runId, synthesis, activeRefParams);
      return;
    }

    const phrases = shortenFirstFastPhrase(splitLiveReplyChunks(text, {
      maxChunkWords: fastMaxChunkWordsRef.current,
      maxSentencesPerChunk: fastMaxSentencesPerChunkRef.current,
    }));
    if (phrases.length === 0) {
      patchMessage(messageId, { status: 'ready' });
      return;
    }

    currentSynthesisMessageIdRef.current = messageId;
    cancelledReplyIdsRef.current.delete(messageId);
    pauseInputForReply();
    clearReplySelectionUnlessPlaying();
    setPhase('speaking');
    patchMessage(messageId, {
      status: 'generating_voice',
      error: null,
      audioParts: phrases.map((phrase, index) => ({
        id: `${messageId}-part-${index + 1}`,
        index: index + 1,
        text: phrase,
        status: 'queued',
        audioUrl: null,
        error: null,
      })),
    });

    try {
      for (let index = 0; index < phrases.length; index += 1) {
        const partId = `${messageId}-part-${index + 1}`;
        if (
          isCancelledRef.current ||
          runId !== runIdRef.current ||
          cancelledReplyIdsRef.current.has(messageId)
        ) {
          return;
        }

        patchAudioPart(messageId, partId, { status: 'generating', error: null });
        const { blob } = await synthesizeForEngine(
          synthesis.engine,
          buildLiveSentenceParams(phrases[index], activeRefParams, liveLanguage, {
            // First clip gates time-to-first-audio — play it unverified.
            skipVerify: index === 0,
          }),
          { replyToken: replyTokenFor(messageId) }
        );

        if (
          isCancelledRef.current ||
          runId !== runIdRef.current ||
          cancelledReplyIdsRef.current.has(messageId)
        ) {
          return;
        }

        const url = URL.createObjectURL(blob);
        // No inline clip selection here: the speaking-continuation effect picks
        // the earliest unplayed ready clip from fresh render state. Selecting
        // partId directly raced the ended handler's ref reads and could jump
        // past a clip that was ready but not yet visible in messagesRef.
        patchAudioPart(messageId, partId, { status: 'ready', audioUrl: url, error: null });
      }

      if (!cancelledReplyIdsRef.current.has(messageId)) {
        patchMessage(messageId, { status: 'ready' });
      }
    } catch (err) {
      // A barged-in reply is already marked 'interrupted', and the worker now
      // rejects its in-flight clip outright (499). That is the cancel working, not
      // a failure — reporting it would both paint a false error and tear down the
      // phase of the replacement reply that is already starting.
      if (
        isCancelledRef.current
        || runId !== runIdRef.current
        || cancelledReplyIdsRef.current.has(messageId)
      ) {
        return;
      }

      const outcome = reportSynthesisFailure(err, (patch) => patchMessage(messageId, patch));
      // A voice-stopped reply fails quietly in the background — tearing down
      // the phase/selection here would cut off a newer reply mid-playback.
      if (!isVoiceStoppedMessage(messageId)) {
        setSynthesisBanner(err, outcome);
        setSelectedReplyId('');
        const nextPhase = hasLiveConnection() ? 'listening' : 'idle';
        setPhase(nextPhase);
        syncOpenAiInputWithMic(nextPhase);
      }
    } finally {
      if (currentSynthesisMessageIdRef.current === messageId) {
        currentSynthesisMessageIdRef.current = '';
      }
    }
  }

  function streamedFastReplyIsStale(state) {
    return (
      isCancelledRef.current
      || state.runId !== runIdRef.current
      || cancelledReplyIdsRef.current.has(state.messageId)
    );
  }

  function failStreamedFastReply(state, err) {
    if (state.failed || streamedFastReplyIsStale(state)) return;
    state.failed = true;
    const outcome = reportSynthesisFailure(err, (patch) => patchMessage(state.messageId, patch));
    if (!isVoiceStoppedMessage(state.messageId)) {
      setSynthesisBanner(err, outcome);
      setSelectedReplyId('');
      const nextPhase = hasLiveConnection() ? 'listening' : 'idle';
      setPhase(nextPhase);
      syncOpenAiInputWithMic(nextPhase);
    }
  }

  function queueStreamedFastText(state, text) {
    let phrases = splitLiveReplyChunks(text, {
      maxChunkWords: fastMaxChunkWordsRef.current,
      maxSentencesPerChunk: fastMaxSentencesPerChunkRef.current,
    });
    if (state.partCount === 0) {
      phrases = shortenFirstFastPhrase(phrases);
    }
    if (phrases.length === 0) return;

    const queuedParts = phrases.map((phrase) => {
      state.partCount += 1;
      return {
        id: `${state.messageId}-part-${state.partCount}`,
        index: state.partCount,
        text: phrase,
        status: 'queued',
        audioUrl: null,
        error: null,
      };
    });
    appendAudioParts(state.messageId, queuedParts);

    for (const part of queuedParts) {
      state.chain = state.chain.then(async () => {
        if (state.failed || streamedFastReplyIsStale(state)) return;
        patchAudioPart(state.messageId, part.id, { status: 'generating', error: null });
        const { blob } = await synthesizeForEngine(
          state.synthesis.engine,
          buildLiveSentenceParams(part.text, state.activeRefParams, liveLanguage, {
            skipVerify: part.index === 1,
          }),
          { replyToken: replyTokenFor(state.messageId) },
        );
        if (streamedFastReplyIsStale(state)) return;
        const url = URL.createObjectURL(blob);
        patchAudioPart(state.messageId, part.id, {
          status: 'ready',
          audioUrl: url,
          error: null,
        });
      }).catch((err) => failStreamedFastReply(state, err));
    }
  }

  function startStreamedFastReply(messageId, completeText, runId) {
    if (streamedFastReplyRef.current || !isPhraseMode) return null;
    const synthesis = getActiveSynthesisSnapshot();
    if (synthesis.engine === 'full' || !synthesis.refParams) return null;

    const state = {
      messageId,
      runId,
      synthesis,
      activeRefParams: synthesis.refParams,
      consumedText: completeText,
      partCount: 0,
      chain: Promise.resolve(),
      failed: false,
      finalized: false,
    };
    streamedFastReplyRef.current = state;
    currentSynthesisMessageIdRef.current = messageId;
    cancelledReplyIdsRef.current.delete(messageId);
    pauseInputForReply();
    clearReplySelectionUnlessPlaying();
    setPhase('speaking');
    patchMessage(messageId, {
      status: 'generating_voice',
      error: null,
      audioParts: [],
    });
    queueStreamedFastText(
      state,
      fixSpeechPronunciation(cleanLiveText(completeText)),
    );
    return state;
  }

  function finishStreamedFastReply(state, remainingText) {
    if (!state || state.finalized) return;
    state.finalized = true;
    queueStreamedFastText(
      state,
      fixSpeechPronunciation(cleanLiveText(remainingText)),
    );
    state.chain.finally(() => {
      if (!state.failed && !streamedFastReplyIsStale(state)) {
        patchMessage(state.messageId, { status: 'ready' });
      }
      if (streamedFastReplyRef.current === state) {
        streamedFastReplyRef.current = null;
      }
      if (currentSynthesisMessageIdRef.current === state.messageId) {
        currentSynthesisMessageIdRef.current = '';
      }
    });
  }

  async function synthesizeFullQueuedAssistantReply(messageId, text, runId, synthesis, activeRefParams) {
    currentSynthesisMessageIdRef.current = messageId;
    cancelledReplyIdsRef.current.delete(messageId);
    pauseInputForReply();
    clearReplySelectionUnlessPlaying();
    setPhase('speaking');
    patchMessage(messageId, { status: 'generating_voice', error: null, audioParts: [] });

    try {
      const res = await startGeneration(buildLiveReplyParams(text, activeRefParams, liveLanguage));
      const sessionId = res.data?.sessionId;
      if (!sessionId) throw new Error('Full inference session did not return a session id.');
      activeInferenceSessionIdRef.current = sessionId;

      await new Promise((resolve, reject) => {
        const pendingChunkFetches = new Set();
        const isStale = () => (
          isCancelledRef.current ||
          runId !== runIdRef.current ||
          cancelledReplyIdsRef.current.has(messageId)
        );

        inferenceEventSourceRef.current = connectInferenceSSE(sessionId, {
          onStart(data = {}) {
            if (isStale()) return;
            const chunks = Array.isArray(data.chunks) && data.chunks.length > 0
              ? data.chunks
              : [{ index: 0, text }];
            patchMessage(messageId, {
              status: 'generating_voice',
              audioParts: chunks.map((chunk, order) => {
                const index = Number.isInteger(chunk.index) ? chunk.index : order;
                return {
                  id: `${messageId}-part-${index + 1}`,
                  index: index + 1,
                  text: chunk.text || text,
                  status: 'queued',
                  audioUrl: null,
                  error: null,
                };
              }),
            });
          },
          onChunkStart(data = {}) {
            if (isStale()) return;
            const index = Number.isInteger(data.index) ? data.index : 0;
            patchAudioPart(messageId, `${messageId}-part-${index + 1}`, { status: 'generating', error: null });
          },
          onChunkComplete(data = {}) {
            if (isStale()) return;
            const index = Number.isInteger(data.index) ? data.index : 0;
            const partId = `${messageId}-part-${index + 1}`;
            const fetchChunk = (async () => {
              const blob = await getInferenceChunk(sessionId, index);
              if (isStale()) return;
              const url = URL.createObjectURL(blob);
              // Selection is handled by the speaking-continuation effect.
              patchAudioPart(messageId, partId, { status: 'ready', audioUrl: url, error: null });
            })();
            pendingChunkFetches.add(fetchChunk);
            fetchChunk.catch(reject).finally(() => pendingChunkFetches.delete(fetchChunk));
          },
          onComplete() {
            Promise.allSettled(Array.from(pendingChunkFetches)).then(() => {
              if (isStale()) {
                resolve();
                return;
              }
              patchMessage(messageId, { status: 'ready' });
              resolve();
            });
          },
          onError(data = {}) {
            reject(new Error(data.message || 'Full inference voice generation failed'));
          },
        });
      });
    } catch (err) {
      if (isCancelledRef.current || runId !== runIdRef.current) return;

      const outcome = reportSynthesisFailure(err, (patch) => patchMessage(messageId, patch));
      if (!isVoiceStoppedMessage(messageId)) {
        setSynthesisBanner(err, outcome);
        setSelectedReplyId('');
        const nextPhase = hasLiveConnection() ? 'listening' : 'idle';
        setPhase(nextPhase);
        syncOpenAiInputWithMic(nextPhase);
      }
    } finally {
      if (inferenceEventSourceRef.current) {
        inferenceEventSourceRef.current.close();
        inferenceEventSourceRef.current = null;
      }
      activeInferenceSessionIdRef.current = '';
      if (currentSynthesisMessageIdRef.current === messageId) {
        currentSynthesisMessageIdRef.current = '';
      }
    }
  }

  function synthesizeAssistantReply(messageId, text, runId) {
    if (isPhraseMode) {
      synthesizePhraseAssistantReply(messageId, text, runId);
      return;
    }

    synthesizeFullAssistantReply(messageId, text, runId);
  }

  function stopKeepAlive() {
    if (keepAliveTimerRef.current) {
      window.clearInterval(keepAliveTimerRef.current);
      keepAliveTimerRef.current = null;
    }
  }

  function startKeepAlive() {
    stopKeepAlive();
    keepAliveTimerRef.current = window.setInterval(() => {
      // send() is a no-op when the socket isn't OPEN, so this is safe.
      socketRef.current?.send({ type: 'keepalive' });
    }, KEEPALIVE_INTERVAL_MS);
  }

  function stopVideoPositionSync() {
    if (videoPositionTimerRef.current) {
      window.clearInterval(videoPositionTimerRef.current);
      videoPositionTimerRef.current = null;
    }
    lastSentVideoPositionRef.current = null;
  }

  // Polls the caller for the lesson video's position instead of taking it as a
  // prop: a playing <video> fires timeupdate several times a second, and this
  // hook must not re-render on every one of them.
  function startVideoPositionSync() {
    stopVideoPositionSync();
    if (typeof getVideoPositionRef.current !== 'function') return;

    const sync = () => {
      const getPosition = getVideoPositionRef.current;
      if (typeof getPosition !== 'function') return;

      const position = getPosition();
      if (!shouldSendVideoPosition(position, lastSentVideoPositionRef.current)) return;

      // send() is a no-op when the socket isn't OPEN, so this is safe.
      const sent = socketRef.current?.send({
        type: 'video.position',
        seconds: Number(position.seconds),
        paused: Boolean(position.paused),
        behavior: position.behavior || undefined,
      });
      if (sent) {
        lastSentVideoPositionRef.current = {
          seconds: Number(position.seconds),
          paused: Boolean(position.paused),
          behavior: position.behavior || undefined,
        };
      }
    };

    sync();
    videoPositionTimerRef.current = window.setInterval(sync, VIDEO_POSITION_SYNC_INTERVAL_MS);
  }

  function hasLiveConnection() {
    return Boolean(socketRef.current) || reconnectingRef.current;
  }

  function stopReconnect() {
    setReconnecting(false);
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }

  function closeSocket() {
    stopReconnect();
    stopKeepAlive();
    stopVideoPositionSync();
    if (socketRef.current) {
      socketRef.current.close();
      socketRef.current = null;
    }
  }

  function stopMicCapture() {
    setAudioLevel(0);
    setMicInputEnabled(false);
    setBargeInArmed(false);
    voiceGateRef.current = createVoiceGateState();
    gatePrerollRef.current = [];
    turnVoicedFramesRef.current = 0;

    setUserSpeaking(false);
    if (micCaptureRef.current) {
      micCaptureRef.current.stop();
      micCaptureRef.current = null;
    }
    audioContextRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }

  function endConversationFromSocket() {
    stopReconnect();
    socketRef.current = null;
    pendingTextRef.current = '';
    stopKeepAlive();
    stopMicCapture();
    conversationSynthesisRef.current = null;
    setInterimTranscript('');
    // If a reply is still playing when the socket drops, don't cut the voice off
    // mid-sentence. Keep playing; onAudioEnded will fall through to idle (socket
    // is now null) once the last clip finishes.
    if (phaseRef.current === 'speaking') {
      return;
    }
    setPhase('idle');
  }

  // Silence the reply that is currently reading aloud. Two flavors:
  // - Barge-in (default): the user is talking over the bot, so the reply is
  //   dead — cancel its synthesis loop too (cancelledReplyIds aborts it).
  // - Stop voice button (cancelPendingSynthesis: false): only playback stops.
  //   Remaining clips keep generating in the background, marked voiceStopped
  //   so nothing auto-plays them until the user presses Play voice.
  function interruptPlayback({ cancelPendingSynthesis = true } = {}) {
    if (phaseRef.current !== 'speaking' && phaseRef.current !== 'thinking') return;
    const playback = findSelectedPlayback(messagesRef.current, selectedReplyIdRef.current);
    const currentReplyId = playback?.message.id || currentSynthesisMessageIdRef.current;
    if (!playback && !currentReplyId) return;

    // A split reply can have a second message still synthesizing while the
    // first one plays — an interruption must silence that one too, or its
    // clips would start reading out later, after the user has moved on.
    const synthesizingId = currentSynthesisMessageIdRef.current;
    for (const messageId of new Set([currentReplyId, synthesizingId].filter(Boolean))) {
      if (cancelPendingSynthesis) {
        cancelledReplyIdsRef.current.add(messageId);
        // Free this reply's queued clips on the worker. Best-effort and fire-and-
        // forget: the local loop has already stopped either way, and a failed
        // cancel must never surface as a conversation error. Deliberately not done
        // for a plain Stop voice, whose clips keep generating by design.
        const replyToken = replyTokensRef.current.get(messageId);
        if (replyToken) cancelLiveReply(replyToken).catch(() => {});
        patchMessage(messageId, { status: 'interrupted' });
      } else {
        patchMessage(messageId, { voiceStopped: true });
      }
    }
    if (playback?.part) {
      // For a plain stop, the cut clip stays replayable ('played' keeps it in
      // the Play voice chain); a barge-in marks it interrupted as before.
      patchAudioPart(playback.message.id, playback.part.id, {
        status: cancelPendingSynthesis ? 'interrupted' : 'played',
      });
    }

    setSelectedReplyId('');
    setPhase('listening');
    syncOpenAiInputWithMic('listening');
    setInterimTranscript(micInputEnabledRef.current ? 'Listening...' : '');
    showNotice(micInputEnabledRef.current ? 'Voice stopped. Listening...' : 'Voice stopped. Mic is off.');
  }

  function stopVoicePlayback() {
    interruptPlayback({ cancelPendingSynthesis: false });
  }

  function playReply(messageId) {
    const message = messagesRef.current.find((item) => item.id === messageId);
    if (!message || message.role !== 'assistant') return;
    const playbackId = isPhraseMode ? findFirstReplayablePart(message)?.id : message.id;
    if (!playbackId) return;
    if (message.voiceStopped) {
      // Pressing Play voice on a stopped reply un-stops it, so clips still
      // being generated in the background chain on after the replay.
      patchMessage(messageId, { voiceStopped: false });
    }
    pauseInputForReply();
    setSelectedReplyId(playbackId);
    setPhase('speaking');
  }

  function sendAudioChunk(input, sampleRate) {
    try {
      const sent = socketRef.current?.send({
        type: 'audio.chunk',
        audio: encodeOpenAiAudioChunk(input, sampleRate),
      });
      return Boolean(sent);
    } catch (err) {
      setError(friendlyLiveError(err.message, { prefix: 'Live audio failed: ' }));
      return false;
    }
  }

  async function requestMicStream() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser does not support live microphone recording.');
    }

    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(micConstraintsRef.current || {}),
      },
    });
  }

  async function startMicCapture(stream) {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      setSpeechApiAvailable(false);
      throw new Error('This browser does not support live audio processing.');
    }

    setSpeechApiAvailable(true);
    setMicInputEnabled(true);
    voiceGateRef.current = createVoiceGateState();
    gatePrerollRef.current = [];
    turnVoicedFramesRef.current = 0;

    let smoothedLevel = 0;
    let shownLevel = 0;
    // Every frame is 24 kHz mono, already resampled with an anti-aliasing filter.
    const handleFrame = (input) => {
      const rms = getRms(input);
      smoothedLevel = smoothedLevel * 0.82 + rms * 0.18;
      // Only re-render for a visible change in the level meter.
      const level = Math.min(1, smoothedLevel * 5);
      if (Math.abs(level - shownLevel) > 0.03) {
        shownLevel = level;
        setAudioLevel(level);
      }

      let sentForBargeIn = false;
      // Full duplex leaves barge-in to OpenAI's VAD (user.speech.started), which
      // hears real speech instead of guessing from loudness.
      if (!fullDuplexRef.current && shouldTriggerLiveBargeIn({
        listeningMode: listeningModeRef.current,
        phase: phaseRef.current,
        micInputEnabled: micInputEnabledRef.current || bargeInArmedRef.current,
        rms: smoothedLevel,
      })) {
        bargeInFramesRef.current += 1;
      } else {
        bargeInFramesRef.current = 0;
      }

      if (
        bargeInFramesRef.current >= BARGE_IN_MIN_FRAMES
        && Date.now() - lastBargeInAtRef.current > BARGE_IN_COOLDOWN_MS
      ) {
        lastBargeInAtRef.current = Date.now();
        bargeInFramesRef.current = 0;
        setMicInputEnabled(true);
        setBargeInArmed(false);
        interruptPlayback();
        sentForBargeIn = sendAudioChunk(input, MIC_TARGET_SAMPLE_RATE);
        if (sentForBargeIn && rms > 0.006) {
          pendingInputAudioRef.current = true;
          turnVoicedFramesRef.current += 1;
        }
      }

      if (shouldSendLiveMicAudio({ fullDuplex: fullDuplexRef.current,
        listeningMode: listeningModeRef.current,
        phase: phaseRef.current,
        micInputEnabled: micInputEnabledRef.current,
      }) && !sentForBargeIn) {
        // Ungated (Live MC): stream every frame and let OpenAI's VAD find the
        // speech. A fixed RMS threshold drops soft or distant voices outright.
        if (!noiseGateRef.current) {
          const sent = sendAudioChunk(input, MIC_TARGET_SAMPLE_RATE);
          if (sent && rms >= VOICE_GATE.threshold) {
            pendingInputAudioRef.current = true;
            turnVoicedFramesRef.current += 1;
          }
          return;
        }
        // Noise-gate what OpenAI hears: sub-threshold frames are buffered, not
        // sent, so its server VAD can't flag breaths/clicks as new speech. On
        // opening, replay the pre-roll so soft speech onsets aren't clipped.
        const wasOpen = voiceGateRef.current.open;
        const gate = nextVoiceGateState(voiceGateRef.current, rms);
        voiceGateRef.current = gate;
        if (gate.open) {
          gateSilenceTailRef.current = 0;
          if (gate.justOpened) {
            for (const buffered of gatePrerollRef.current) {
              sendAudioChunk(buffered, MIC_TARGET_SAMPLE_RATE);
            }
            gatePrerollRef.current = [];
          }
          const sent = sendAudioChunk(input, MIC_TARGET_SAMPLE_RATE);
          if (sent && rms >= VOICE_GATE.threshold) {
            pendingInputAudioRef.current = true;
            turnVoicedFramesRef.current += 1;
          }
        } else {
          // OpenAI's VAD ends a turn by hearing silence after speech; if the
          // stream simply stops when the gate closes, the turn hangs on
          // "Listening..." until noise reopens it. Keep its clock running with
          // true zeros (never mistaken for speech) for a bounded tail.
          if (wasOpen) gateSilenceTailRef.current = VOICE_GATE_SILENCE_TAIL_FRAMES;
          if (gateSilenceTailRef.current > 0) {
            gateSilenceTailRef.current -= 1;
            sendAudioChunk(new Float32Array(input.length), MIC_TARGET_SAMPLE_RATE);
          }
          // The processor reuses `input`; the pre-roll needs its own copy.
          gatePrerollRef.current.push(new Float32Array(input));
          if (gatePrerollRef.current.length > VOICE_GATE.prerollFrames) {
            gatePrerollRef.current.shift();
          }
        }
      }
    };
    // Gated pages keep ~85 ms frames (their gate timings assume it); ungated
    // capture uses 40 ms frames so OpenAI's VAD hears the end of speech sooner.
    const capture = await startMicFrames(stream, {
      frameSize: noiseGateRef.current ? 2048 : 960,
      onFrame: handleFrame,
      AudioContextCtor,
    });
    if (streamRef.current !== stream) {
      capture.stop();
      return;
    }
    micCaptureRef.current = capture;
    audioContextRef.current = capture.audioContext;
  }

  async function enableMicInput() {
    if (phaseRef.current === 'idle') {
      start();
      return;
    }
    if (micInputEnabledRef.current) return;

    if (micCaptureRef.current && streamRef.current) {
      setMicInputEnabled(true);
      setBargeInArmed(false);
      syncOpenAiInputWithMic();
      if (isLiveInputPhase(phaseRef.current)) {
        setInterimTranscript('Listening...');
      }
      showNotice('Mic on.');
      return;
    }

    const micRunId = runIdRef.current;
    try {
      const stream = await requestMicStream();
      if (micRunId !== runIdRef.current || isCancelledRef.current || streamRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      await startMicCapture(stream);
      if (micRunId !== runIdRef.current || isCancelledRef.current) return;
      syncOpenAiInputWithMic();
      if (isLiveInputPhase(phaseRef.current)) {
        setInterimTranscript('Listening...');
      }
      showNotice('Mic on.');
    } catch (err) {
      if (micRunId !== runIdRef.current || isCancelledRef.current) return;
      setError(err.message === 'This browser does not support live microphone recording.'
        ? err.message
        : 'Microphone access denied. Please allow microphone access and try again.');
    }
  }

  function disableMicInput() {
    if (!micInputEnabledRef.current) return;
    const phaseAtToggle = phaseRef.current;
    const action = getMicOffAction({
      phase: phaseAtToggle,
      hasPendingAudio: pendingInputAudioRef.current,
      // OpenAI's VAD hearing speech is evidence too: a quiet voice may never
      // cross the local loudness threshold, and must still be sent, not dropped.
      hasVoiceEvidence: turnVoicedFramesRef.current >= MIN_COMMIT_VOICE_FRAMES || userSpeakingRef.current,
    });

    if (action === 'commit') {
      const id = ensureUserMessage();
      patchMessage(id, { status: 'transcribing', text: 'Transcribing...' });
      armUserTranscriptTimer(id);
      setPhase('thinking');
      setInterimTranscript('Thinking...');
      sendManualCommitTail();
      commitOpenAiInput();
      turnVoicedFramesRef.current = 0;
      // Mute means silent: send what was already said, then fully stop capture so
      // no background noise can barge in over the reply. Tap the mic again to talk.
      stopMicCapture();
      showNotice('Mic off. Sending what you said.');
      return;
    }

    if (action === 'discard') {
      // The pending turn was opened by noise, not speech — drop the phantom
      // bubble and send nothing.
      const id = activeUserMessageIdRef.current;
      if (id) {
        const phantom = messagesRef.current.find((message) => message.id === id);
        if (phantom && (phantom.status === 'listening' || phantom.status === 'transcribing')) {
          clearUserTranscriptTimer(id);
          userTextBuffersRef.current.delete(phantom.itemId || id);
          removeMessage(id);
        }
        activeUserMessageIdRef.current = '';
      }
      pendingInputAudioRef.current = false;
      stopMicCapture();
      pauseOpenAiInput();
      setInterimTranscript('');
      showNotice('Mic off. Nothing heard to send.');
      return;
    }

    stopMicCapture();

    if (action === 'pause') {
      pauseOpenAiInput();
      pendingInputAudioRef.current = false;
    }

    if (phaseAtToggle === 'thinking') {
      setInterimTranscript('Thinking...');
      showNotice('Mic off. Finishing the current reply.');
      return;
    }

    setInterimTranscript('');
    showNotice(phaseAtToggle === 'speaking'
      ? 'Mic off. Voice playback continues.'
      : 'Mic off. Conversation stays open.');
  }

  // Put a typed question on the wire and show it as the user's own bubble. No
  // transcription is involved, so the bubble is final the moment it appears.
  function deliverTextMessage(text) {
    // The mic may have picked up room noise while they were typing; that audio
    // is not part of this turn and must not commit alongside it.
    pauseOpenAiInput();
    pendingInputAudioRef.current = false;

    if (!socketRef.current?.send({ type: 'user.text', text })) {
      setError('The live connection dropped before your message was sent. Please try again.');
      return false;
    }

    appendMessage(createChatMessage({
      id: nextMessageId('user'),
      role: 'user',
      text,
      status: 'done',
    }));
    onUserQuestion?.(text);
    setPhase('thinking');
    setInterimTranscript('Thinking...');
    return true;
  }

  function flushPendingTextMessage() {
    const text = pendingTextRef.current;
    if (!text) return;
    pendingTextRef.current = '';
    deliverTextMessage(text);
  }

  // Ask by typing instead of speaking. Opens the conversation first if none is
  // running, so someone with no microphone never has to press the mic button.
  async function sendTextMessage(rawText) {
    const text = normalizeTypedMessage(rawText);
    if (!text) return false;

    const phaseAtSend = phaseRef.current;
    // A reply is already being generated — a second one would be rejected by
    // the Realtime session anyway.
    if (phaseAtSend === 'thinking' || phaseAtSend === 'stopping') return false;
    // An earlier message is still waiting for the session to come up. Refusing
    // this one keeps the caller's draft intact rather than silently replacing
    // the queued message with it.
    if (pendingTextRef.current) return false;

    // Typing while the assistant is talking means the same thing as speaking
    // over it: stop the voice and answer this instead.
    if (phaseAtSend === 'speaking') {
      interruptPlayback();
    }

    if (phaseAtSend === 'idle') {
      const opened = await openSession({ useMic: false });
      // Queued only after the session is confirmed opening — openSession clears
      // this ref on entry, so setting it first would drop the message.
      if (opened) pendingTextRef.current = text;
      return opened;
    }

    // The socket is open but the Realtime session has not reported ready yet.
    if (phaseAtSend === 'connecting') {
      pendingTextRef.current = text;
      return true;
    }

    return deliverTextMessage(text);
  }

  function handleSocketEvent(event, runId) {
    if (runId !== runIdRef.current || isCancelledRef.current) return;

    switch (event.type) {
      case 'session.authenticated':
        setNotice('Signed in. Preparing live chat...');
        break;

      case 'session.auth.failed':
        if (sessionReadyTimerRef.current) {
          window.clearTimeout(sessionReadyTimerRef.current);
          sessionReadyTimerRef.current = null;
        }
        setError(`Live chat sign-in failed (${event.code || 'unauthorized'}). Sign out, then sign in again.`);
        endConversationFromSocket();
        break;

      case 'session.ready': {
        if (sessionReadyTimerRef.current) {
          window.clearTimeout(sessionReadyTimerRef.current);
          sessionReadyTimerRef.current = null;
        }
        const resumed = reconnectingRef.current;
        setReconnecting(false);
        reconnectAttemptRef.current = 0;
        sessionEverReadyRef.current = true;
        if (resumed) setNotice('');
        // A reply still playing from before the drop keeps playing; only the
        // new gateway session's input gate needs to match it.
        if (resumed && phaseRef.current === 'speaking') {
          syncOpenAiInputWithMic('speaking');
          break;
        }
        setPhase('listening');
        // A text-only session has no mic, so "Listening..." would be a lie.
        setInterimTranscript(micInputEnabledRef.current ? 'Listening...' : '');
        setNotice('');
        flushPendingTextMessage();
        break;
      }

      case 'user.speech.started': {
        setUserSpeaking(true);
        // Continuous full duplex: speaking over the AI, or again while a reply
        // is being prepared, cancels that reply (OpenAI already stopped its
        // generation). Turn-based never gets here: its mic is closed by then.
        if (fullDuplexRef.current && listeningModeRef.current !== 'turns'
          && (phaseRef.current === 'speaking' || phaseRef.current === 'thinking')) {
          interruptPlayback();
        }
        if (phaseRef.current !== 'speaking') {
          pendingInputAudioRef.current = true;
          // A new turn starting proves the previous turn is over: if its bubble
          // is still waiting on a transcript that never came, close it now so
          // this turn gets its own bubble instead of overwriting it.
          const activeId = activeUserMessageIdRef.current;
          const active = messagesRef.current.find((message) => message.id === activeId);
          if (active && (active.itemId || '') !== (event.itemId || '')) {
            finalizePendingUserMessage(activeId);
          }
          ensureUserMessage(event.itemId || '');
          setPhase('listening');
          setInterimTranscript('Listening...');
        }
        break;
      }

      case 'user.speech.stopped': {
        setUserSpeaking(false);
        if (phaseRef.current !== 'speaking') {
          pendingInputAudioRef.current = false;
          // The server closed this turn; voiced frames from it must not count
          // as evidence for the next one.
          turnVoicedFramesRef.current = 0;
          const id = ensureUserMessage(event.itemId || '');
          patchMessage(id, { status: 'transcribing', text: 'Transcribing...' });
          armUserTranscriptTimer(id);
          setPhase('thinking');
          setInterimTranscript('Thinking...');
        }
        break;
      }

      case 'user.text.delta': {
        const id = ensureUserMessage(event.itemId);
        const key = event.itemId || id;
        const nextText = `${userTextBuffersRef.current.get(key) || ''}${event.text || ''}`;
        userTextBuffersRef.current.set(key, nextText);
        patchMessage(id, { itemId: event.itemId || '', text: nextText, status: 'transcribing' });
        // The transcript is streaming, just slowly — push the deadline back.
        armUserTranscriptTimer(id);
        break;
      }

      case 'user.text.done': {
        const id = ensureUserMessage(event.itemId);
        const key = event.itemId || id;
        clearUserTranscriptTimer(id);
        userTextBuffersRef.current.delete(key);
        pendingInputAudioRef.current = false;
        const finalText = cleanLiveText(event.text) || 'Voice message sent.';
        patchMessage(id, {
          itemId: event.itemId || '',
          text: finalText,
          status: 'done',
        });
        if (finalText !== 'Voice message sent.') onUserQuestion?.(finalText);
        if (activeUserMessageIdRef.current === id) {
          activeUserMessageIdRef.current = '';
        }
        break;
      }

      case 'user.text.failed': {
        const id = ensureUserMessage(event.itemId);
        clearUserTranscriptTimer(id);
        pendingInputAudioRef.current = false;
        patchMessage(id, {
          text: 'Voice message sent.',
          status: 'done',
          error: event.message || null,
        });
        if (activeUserMessageIdRef.current === id) {
          activeUserMessageIdRef.current = '';
        }
        break;
      }

      case 'assistant.thinking':
        if (phaseRef.current !== 'speaking') {
          setPhase('thinking');
          setInterimTranscript('Thinking...');
        }
        break;

      case 'assistant.text.delta': {
        const id = ensureAssistantMessage();
        assistantTextRef.current += event.text || '';
        const streamedState = streamedFastReplyRef.current;
        patchMessage(id, {
          text: assistantTextRef.current,
          status: streamedState ? 'generating_voice' : 'thinking',
        });
        setInterimTranscript(assistantTextRef.current);
        if (!streamedState) {
          const completed = takeCompleteStreamedSentence(assistantTextRef.current);
          if (completed) {
            startStreamedFastReply(id, completed.completeText, runId);
          }
        }
        break;
      }

      case 'assistant.text.cancelled': {
        // OpenAI cancelled this reply mid-generation (the user spoke over it and
        // a fresh reply is coming). Keep any partial text as an interrupted bubble
        // for context and cancel an early first-sentence clip if one already began.
        const partialText = cleanLiveText(assistantTextRef.current || event.text || '');
        const id = activeAssistantMessageIdRef.current;
        const streamedState = streamedFastReplyRef.current;
        assistantTextRef.current = '';
        activeAssistantMessageIdRef.current = '';
        setInterimTranscript('');
        if (streamedState) {
          cancelledReplyIdsRef.current.add(streamedState.messageId);
          const replyToken = replyTokensRef.current.get(streamedState.messageId);
          if (replyToken) cancelLiveReply(replyToken).catch(() => {});
          streamedFastReplyRef.current = null;
          if (currentSynthesisMessageIdRef.current === streamedState.messageId) {
            currentSynthesisMessageIdRef.current = '';
          }
          setSelectedReplyId('');
          const nextPhase = hasLiveConnection() ? 'listening' : 'idle';
          setPhase(nextPhase);
          syncOpenAiInputWithMic(nextPhase);
        }
        if (id) {
          if (partialText) {
            patchMessage(id, { text: partialText, status: 'interrupted' });
          } else {
            removeMessage(id);
          }
        }
        break;
      }

      case 'assistant.text.done': {
        // Display the clean model text (the streamed raw, e.g. "GI bleeding",
        // "6.7 percent"); speak the gateway-preprocessed text with dragged
        // initialisms rejoined for smooth pronunciation ("G I" -> "gee eye").
        const rawDisplayText = assistantTextRef.current || event.text || '';
        const displayText = cleanLiveText(rawDisplayText);
        const speechText = fixSpeechPronunciation(cleanLiveText(event.text || assistantTextRef.current || ''));
        const streamedState = streamedFastReplyRef.current;
        assistantTextRef.current = '';
        setInterimTranscript('');
        if (speechText) {
          const id = ensureAssistantMessage();
          activeAssistantMessageIdRef.current = '';
          patchMessage(id, { text: displayText || speechText, status: 'generating_voice' });
          if (streamedState?.messageId === id) {
            const remainingText = rawDisplayText
              .slice(streamedState.consumedText.length)
              .trimStart();
            finishStreamedFastReply(streamedState, remainingText);
          } else {
            synthesizeAssistantReply(id, speechText, runId);
          }
        } else if (phaseRef.current !== 'speaking') {
          setPhase('listening');
        }
        break;
      }

      case 'error': {
        const message = event.message || 'AI conversation failed.';
        // Benign Realtime races (e.g. an active response already in progress)
        // resolve on their own and only confuse the user — don't surface them.
        if (!isBenignRealtimeError(message)) {
          setError(message);
        }
        if (phaseRef.current !== 'speaking') {
          setPhase('listening');
        }
        break;
      }

      // The gateway refused the handshake (no token on a build with no sign-in,
      // or an expired one). Without this the socket just closes mid-handshake,
      // the phase never leaves 'connecting', and the panel's Deploy/Reset stay
      // disabled behind a conversation that can never end.
      case 'session.auth.failed': {
        // Clear the notice too: it still reads "Connected. Preparing live chat..."
        // from onOpen, and leaving that beside the error tells the user the session
        // is still coming up when it has already been refused.
        setNotice('');
        setError(event.message || 'Live chat sign-in was refused.');
        endConversationFromSocket();
        break;
      }

      case 'session.closed':
        if (phaseRef.current !== 'idle') {
          endConversationFromSocket();
        }
        break;

      default:
        break;
    }
  }

  // `useMic: false` opens the same live session without ever calling
  // getUserMedia — the path for someone typing on a machine with no microphone
  // (or no permission to use one). Everything downstream is identical: the
  // reply still streams back and is still spoken in the cloned voice.
  // Returns whether the session actually opened, so a queued typed message
  // knows not to wait for a session that never came up.
  async function openSession({ useMic = true } = {}) {
    if (phaseRef.current !== 'idle') return false;
    const conversationSynthesis = createLiveSynthesisSnapshot({
      engine: engineRef.current,
      refParams: refParamsRef.current,
      fullRefParams: fullRefParamsRef.current,
      voiceProfileId: voiceProfileIdRef.current,
      voiceModel: voiceModelRef.current,
    });
    if (!conversationSynthesis.refParams) {
      setError('No reference audio configured. Go to the Inference page first.');
      return false;
    }
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    isCancelledRef.current = false;
    stopReconnect();
    reconnectAttemptRef.current = 0;
    sessionEverReadyRef.current = false;
    messageSeqRef.current = 0;
    assistantTextRef.current = '';
    pendingTextRef.current = '';
    cleanupConversation();
    // Freeze voice, references, model profile id, and engine for this socket
    // conversation. UI/profile changes take effect only after the user ends it.
    conversationSynthesisRef.current = conversationSynthesis;

    setError(null);
    setNotice('');
    setInterimTranscript('');
    setPhase('connecting');

    if (useMic) {
      let stream;
      try {
        stream = await requestMicStream();
      } catch (err) {
        if (runId !== runIdRef.current || isCancelledRef.current) return false;
        conversationSynthesisRef.current = null;
        setPhase('idle');
        setError(err.message === 'This browser does not support live microphone recording.'
          ? err.message
          : 'Microphone access denied. Please allow microphone access and try again.');
        return false;
      }

      try {
        if (runId !== runIdRef.current || isCancelledRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return false;
        }
        streamRef.current = stream;
        await startMicCapture(stream);
        if (runId !== runIdRef.current || isCancelledRef.current) return false;
      } catch (err) {
        conversationSynthesisRef.current = null;
        stopMicCapture();
        setPhase('idle');
        setError(err.message);
        return false;
      }
    }

    connectLiveSocket(runId, systemPromptRef.current);
    sessionReadyTimerRef.current = window.setTimeout(() => {
      if (runId !== runIdRef.current || phaseRef.current !== 'connecting') return;
      sessionReadyTimerRef.current = null;
      setError('Live chat setup timed out before the AI session became ready. End the chat and try once more.');
      endConversationFromSocket();
    }, LIVE_SESSION_READY_TIMEOUT_MS);
    startVideoPositionSync();
    return true;
  }

  // Opens the gateway socket for this run; after a drop, reopens it. Only the
  // current socket may end or reconnect the conversation, so a replaced
  // socket's late error/close is ignored.
  function connectLiveSocket(runId, prompt) {
    let socket = null;
    let ready = false;
    let readyTimer = null;
    const isCurrent = () => runId === runIdRef.current && socket !== null && socketRef.current === socket;
    const lose = (err) => {
      window.clearTimeout(readyTimer);
      if (!isCurrent() || phaseRef.current === 'idle' || phaseRef.current === 'stopping') return;
      if (autoReconnectRef.current && sessionEverReadyRef.current) {
        if (reconnectAttemptRef.current < LIVE_RECONNECT_MAX_ATTEMPTS) {
          scheduleReconnect(runId);
          return;
        }
        setError('Lost the live connection and could not reconnect. Start the session again.');
      } else if (err) {
        setError(friendlyLiveError(err.message, { fallback: 'The GPU is restarting — reconnecting shortly.' }));
      }
      endConversationFromSocket();
    };
    socket = createLiveChatSocket({
      language: liveLanguage,
      systemPrompt: prompt,
      sessionOptions: sessionOptions || DEFAULT_SESSION_OPTIONS,
      // Same gate the REST client uses, so the socket and the API agree on
      // whether this build authenticates at all.
      getAuthToken: shouldAttachApiToken() ? acquireApiToken : null,
      onOpen: () => {
        if (isCurrent() && !reconnectingRef.current) {
          setNotice('Connected. Preparing live chat...');
        }
      },
      onMessage: (event) => {
        if (event?.type === 'session.ready') {
          ready = true;
          window.clearTimeout(readyTimer);
        }
        handleSocketEvent(event, runId);
      },
      onError: (err) => lose(err),
      onClose: () => lose(null),
    });
    socketRef.current = socket;
    // A reopened socket that never becomes ready counts as another failed attempt.
    if (reconnectingRef.current) {
      readyTimer = window.setTimeout(() => {
        if (!ready) lose(null);
      }, LIVE_SESSION_READY_TIMEOUT_MS);
    }
    startKeepAlive();
  }

  function scheduleReconnect(runId) {
    const dropped = socketRef.current;
    socketRef.current = null;
    setReconnecting(true);
    stopKeepAlive();
    dropped?.close();
    reconnectAttemptRef.current += 1;
    // A reply that was still being written is lost with the old session.
    if (phaseRef.current === 'thinking') setPhase('listening');
    setInterimTranscript('');
    setNotice('Connection dropped — reconnecting...');
    if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      if (runId !== runIdRef.current || !reconnectingRef.current) return;
      connectLiveSocket(runId, buildReconnectSystemPrompt(systemPromptRef.current, messagesRef.current));
    }, liveReconnectDelayMs(reconnectAttemptRef.current));
  }

  // The mic button's entry point. Kept as a zero-argument wrapper because it is
  // wired straight to onClick handlers, which would otherwise pass a MouseEvent
  // as the options object.
  function start() {
    return openSession({ useMic: true });
  }

  function stop() {
    if (phaseRef.current === 'idle' || phaseRef.current === 'stopping') return;

    isCancelledRef.current = true;
    runIdRef.current += 1;
    pendingTextRef.current = '';
    setPhase('stopping');
    setInterimTranscript('');
    closeSocket();
    stopMicCapture();
    conversationSynthesisRef.current = null;
    setPhase('idle');
  }

  function toggle() {
    if (phaseRef.current === 'idle') {
      start();
      return;
    }
    if (phaseRef.current === 'connecting' || phaseRef.current === 'stopping') {
      return;
    }
    if (micInputEnabledRef.current) {
      disableMicInput();
      return;
    }
    enableMicInput();
  }

  function settleAfterPlayback() {
    const nextPhase = hasLiveConnection() ? 'listening' : 'idle';
    setPhase(nextPhase);
    syncOpenAiInputWithMic(nextPhase);
    setInterimTranscript(hasLiveConnection() && micInputEnabledRef.current ? 'Listening...' : '');
    if (!micInputEnabledRef.current && bargeInArmedRef.current) {
      stopMicCapture();
    }
  }

  // "Speaking, but nothing selected": start the earliest unplayed ready clip,
  // keep waiting while clips are generating, or settle out of the speaking
  // phase when the reply is truly finished. Only ever called from the
  // reconciler effect below so the decision always reads fresh rendered state
  // — never from event handlers, whose messagesRef view can lag and re-select
  // a clip that already played.
  function applySpeakingContinuation(messages) {
    if (phaseRef.current !== 'speaking' || selectedReplyIdRef.current) return;
    const decision = resolveSpeakingContinuation(messages, {
      synthesisMessageId: currentSynthesisMessageIdRef.current,
    });
    if (decision.action === 'play') {
      setSelectedReplyId(decision.part.id);
    } else if (decision.action === 'settle') {
      settleAfterPlayback();
    }
  }

  function clearClipGapTimer() {
    if (clipGapTimerRef.current) {
      window.clearTimeout(clipGapTimerRef.current);
      clipGapTimerRef.current = null;
    }
  }

  // Advance to the clip after `playback`, recomputing from fresh state — by the
  // time a gap timer fires, the spent clip's 'played' patch has flushed, so this
  // never re-selects the clip that just ended.
  function advanceFromEndedClip(playback) {
    const nextPlayback = findNextPhrasePlayback(messagesRef.current, playback.part.id);
    const nextReady = nextPlayback?.part
      ? nextPlayback
      : findNextReplyPlayback(messagesRef.current, playback.message.id);
    if (nextReady?.part) {
      setSelectedReplyId(nextReady.part.id);
    } else {
      setSelectedReplyId('');
    }
  }

  // Punctuation-aware breath between clips. The selection is held on the spent
  // clip for the gap — the reconciler effect only acts on an EMPTY selection, so
  // nothing can start playing during the hold — then advances. Guards make a
  // stale timer harmless: it no-ops after a stop, barge-in, or manual replay.
  function scheduleNextClip(playback, gapMs) {
    clearClipGapTimer();
    if (!(gapMs > 0)) {
      advanceFromEndedClip(playback);
      return;
    }
    const endedPartId = playback.part.id;
    clipGapTimerRef.current = window.setTimeout(() => {
      clipGapTimerRef.current = null;
      if (phaseRef.current !== 'speaking') return;
      if (selectedReplyIdRef.current !== endedPartId) return;
      advanceFromEndedClip(playback);
    }, gapMs);
  }

  function onAudioEnded() {
    const playback = findSelectedPlayback(messagesRef.current, selectedReplyIdRef.current);

    if (isPhraseMode && playback?.part) {
      patchAudioPart(playback.message.id, playback.part.id, { status: 'played' });
      const nextPlayback = findNextPhrasePlayback(messagesRef.current, playback.part.id);
      const nextReady = nextPlayback?.part
        ? nextPlayback
        // A Realtime interruption can split one spoken reply across two assistant
        // messages — keep reading straight into the next message's unplayed clips.
        : findNextReplyPlayback(messagesRef.current, playback.message.id);
      if (nextReady?.part) {
        scheduleNextClip(playback, interClipGapMs(playback.part.text));
        return;
      }
    }

    // Only clear the selection here — the speaking-continuation effect makes
    // the play/wait/settle decision on the NEXT render, from fresh state.
    // Deciding synchronously from messagesRef re-selected the clip that just
    // ended (its 'played' patch hadn't flushed yet), and since the selection
    // ended the React batch unchanged, the <audio> effect never re-fired: the
    // reply froze silently on a spent clip right after the short first phrase.
    setSelectedReplyId('');
  }

  // Self-healing playback reconciler. The ended handler and the synthesis
  // loop coordinate through refs that can lag rendered state, so either side
  // can drop the handoff (observed live: replies stopping mid-text at a
  // sentence boundary, or skipping a clip). Re-deciding from fresh state after
  // every render makes those races self-correcting.
  useEffect(() => {
    if (phase !== 'speaking' || selectedReplyId) return;
    applySpeakingContinuation(messages);
  }, [messages, selectedReplyId, phase]);

  useEffect(() => {
    return () => {
      isCancelledRef.current = true;
      runIdRef.current += 1;
      closeSocket();
      stopMicCapture();
      cleanupConversation();
      conversationSynthesisRef.current = null;
      clearClipGapTimer();
      if (noticeTimeoutRef.current) {
        window.clearTimeout(noticeTimeoutRef.current);
      }
    };
  }, []);

  const selectedPlayback = findSelectedPlayback(messages, selectedReplyId);
  const selectedReply = selectedPlayback?.message || null;
  const selectedAudioPart = selectedPlayback?.part || null;
  const audioSrc = selectedPlayback?.audioUrl || null;
  const shouldPlayAudio = phase === 'speaking' && Boolean(audioSrc);
  const finalTranscript = messages
    .filter((message) => message.text && message.status !== 'listening')
    .map((message) => message.text)
    .join(' ');

  return {
    phase,
    interimTranscript,
    finalTranscript,
    messages,
    selectedReply,
    selectedAudioPart,
    selectedReplyId,
    audioSrc,
    error,
    errorTone,
    speechApiAvailable,
    audioLevel,
    isMicInputEnabled: micInputEnabled,
    isBargeInArmed: bargeInArmed,
    notice,
    isConversationActive: phase !== 'idle',
    isReconnecting,
    isUserSpeaking,
    shouldPlayAudio,
    start,
    stop,
    toggle,
    sendTextMessage,
    enableMicInput,
    disableMicInput,
    interruptPlayback,
    stopVoicePlayback,
    playReply,
    onAudioEnded,
  };
}
