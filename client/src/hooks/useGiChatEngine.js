import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getFullActiveVoiceProfile, prepareVoiceCapacity } from '@/services/api.js';
import { useLiveSpeech } from '@/hooks/useLiveSpeech.js';
import { buildLiveFastRefParams, normalizeLiveFastSettings } from '@/lib/liveFastSetup';
import { resolveChatbotSystemPrompt } from '@/lib/chatbotSystemPrompt';
import { resolveChatbotDocuments } from '@/lib/chatbotDocuments';
import { assembleSystemPrompt } from '@/lib/assembleSystemPrompt';
import { useGpuStatus } from '@/lib/gpuStatus.jsx';
import { sanitizeBackendError } from '@/lib/backendErrors';
import { APP_MODE_CONFIG } from '@/lib/appMode';
import {
  describePinnedVoice,
  describeVoiceForDisplay,
  matchesPinnedVoice,
  resolvePinnedVoiceKey,
  resolvePinnedVoiceProfileId,
} from '@/lib/giVoicePin';
import { buildSavedVoiceModelSnapshot } from '@/lib/savedVoiceProfile';
import { isResponseBusy, isVoiceActive, toGiStatus } from './giChatStatus.js';
import { getMyLearnerSummary } from '@/services/learnerAnalytics';
import { buildLearnerSupportGuidance } from '@/lib/learnerGuidance';
import { useDeployedChatbotPrompt } from './useDeployedChatbotPrompt.js';
import {
  normalizeVoiceCapacity,
  voiceCapacityBlocksConversation,
  voiceCapacityNotice,
} from '@/lib/voiceCapacity';

// Kiosk-only engine setup for the gi skin. This is the subset of
// pages/LivePage.jsx:300-615 that a chat-only UI needs: resolve the active
// cloned-voice profile, build live-fast reference params from it, assemble the
// system prompt, and hand all of that to the shared useLiveSpeech hook.
//
// `lessonContext` is an optional prompt section describing the lesson video the
// student is watching (see lib/lessonVideoContext.js), and `getVideoPosition` an
// optional poll for where that video is right now, so the assistant can resolve
// "what does she mean here?". The standalone kiosk has no video and passes
// neither.
//
// `category` names which deployed assistant to load — the lesson slug on the
// lecture site, omitted on the kiosk so it falls back to the default category.
export function useGiChatEngine({
  lessonContext = '',
  lessonSlug = 'gi-bleeding',
  voiceProfileId = '',
  category,
  getVideoPosition = null,
  onUserQuestion = null,
} = {}) {
  const { workerReady, configured } = useGpuStatus();
  const backendQueryable = !configured || workerReady;

  const [activeProfile, setActiveProfile] = useState(null);
  const [profileError, setProfileError] = useState('');
  const [clearedBeforeId, setClearedBeforeId] = useState('');
  const [learnerSummary, setLearnerSummary] = useState(null);
  const [voiceCapacity, setVoiceCapacity] = useState(() => normalizeVoiceCapacity());

  const profileRequestRef = useRef(0);
  const {
    version: deployedPromptVersion,
    voiceProfileId: publishedVoiceProfileId,
    voiceDisplayName: publishedVoiceDisplayName,
    refresh: refreshDeployedPrompt,
  } = useDeployedChatbotPrompt({ category });
  const voicePinOptions = useMemo(() => ({
    search: typeof window === 'undefined' ? '' : window.location.search,
    env: import.meta.env,
  }), []);
  const buildPinnedVoiceProfileId = useMemo(
    () => resolvePinnedVoiceProfileId(voicePinOptions),
    [voicePinOptions]
  );
  const buildPinnedVoiceKey = useMemo(
    () => resolvePinnedVoiceKey(voicePinOptions),
    [voicePinOptions]
  );

  // The faculty-published lecture binding is authoritative. The course prop is
  // the legacy bundled mapping, and the build pin remains the final fallback for
  // old lectures and standalone kiosks. Every downstream capacity and synthesis
  // request uses this one resolved id.
  const requestedVoiceProfileId = String(
    publishedVoiceProfileId || voiceProfileId || buildPinnedVoiceProfileId || ''
  ).trim();
  const usesStandardVoice = requestedVoiceProfileId.toLowerCase().startsWith('elevenlabs:');
  const backendReadyForVoice = usesStandardVoice || backendQueryable;
  const pinnedVoiceKey = requestedVoiceProfileId
    ? describePinnedVoice(requestedVoiceProfileId)
    : buildPinnedVoiceKey;
  // System prompt + uploaded documents come from the deployed config, refreshed
  // at mount and again whenever a conversation ends; the lecture skin has no
  // editor for them (the faculty site owns that UI). The lesson context is the
  // final reference section. useLiveSpeech snapshots this when the socket opens,
  // so a lesson that arrives after the student has already started talking only
  // takes effect on the next conversation.
  //
  // Assembly goes through assembleSystemPrompt and nothing is appended around it,
  // because a lecturer authors and tests on the faculty site and deploys to here
  // — anything added on one side only is a prompt the lecturer never saw. That
  // drift is how a hardcoded GI bleeding scope gate survived every prompt anyone
  // deployed, so a custom assistant answered normally on faculty and then refused
  // on lectures with "I can only help with GI bleeding education and this lesson
  // video." Both sites now call the same function; keep it that way.
  const systemPrompt = useMemo(() => {
    // No editor on this skin, so a local copy could only be stale — the deployed
    // prompt and documents (or the bundled default) are the source of truth here.
    const prompt = resolveChatbotSystemPrompt({ allowLocalOverride: false });
    const documents = resolveChatbotDocuments({ allowLocalOverride: false });
    const assembled = assembleSystemPrompt({ prompt, documents, lessonContext });
    const supportGuidance = buildLearnerSupportGuidance(learnerSummary);
    return supportGuidance ? `${assembled}\n\n${supportGuidance}` : assembled;
  }, [learnerSummary, lessonContext, deployedPromptVersion]);

  useEffect(() => {
    let active = true;
    getMyLearnerSummary(lessonSlug)
      .then((summary) => { if (active) setLearnerSummary(summary); })
      .catch(() => { if (active) setLearnerSummary(null); });
    return () => { active = false; };
  }, [lessonSlug]);

  const loadActiveProfile = useCallback(async () => {
    const requestId = ++profileRequestRef.current;
    try {
      const res = await getFullActiveVoiceProfile();
      if (profileRequestRef.current !== requestId) return;
      setActiveProfile(res.data || null);
      setProfileError('');
    } catch (err) {
      if (profileRequestRef.current !== requestId) return;
      if (err.response?.status === 404) {
        // No voice profile has been activated yet — the ordinary state of a
        // fresh deployment, not an error. Mirrors pages/LivePage.jsx:691-696.
        setActiveProfile(null);
        setProfileError('');
        return;
      }
      setProfileError(
        sanitizeBackendError(err.response?.data?.error || err.message || 'Could not load the voice profile.')
      );
    }
  }, []);

  useEffect(() => {
    // A configured GI build sends its fixed voiceProfileId with every synthesis
    // request. The synthesis backend resolves that saved profile itself, so page
    // startup must not be blocked by a separate profile GET (or its auth timing).
    if (!backendQueryable || requestedVoiceProfileId) return;
    loadActiveProfile();
  }, [backendQueryable, loadActiveProfile, requestedVoiceProfileId]);

  useEffect(() => {
    // Stock voices do not use a GPU model pool and must never start or wait for
    // coordinator capacity.
    if (!requestedVoiceProfileId || usesStandardVoice) return undefined;
    let cancelled = false;
    let timer = null;
    let checks = 0;
    // A voice switch on a warm GPU takes seconds, a cold boot minutes: check
    // every 5 s for the first minute, then every 15 s. A voice that is merely
    // busy (capacityTight) is already usable and keeps the slow cadence.
    const nextDelayMs = (state) => (state !== 'READY' && checks <= 12 ? 5_000 : 15_000);
    const check = async () => {
      checks += 1;
      try {
        const response = await prepareVoiceCapacity(requestedVoiceProfileId);
        if (cancelled) return;
        const next = normalizeVoiceCapacity(response?.data || {});
        setVoiceCapacity(next);
        if (next.state !== 'READY' || next.capacityTight) {
          timer = window.setTimeout(check, nextDelayMs(next.state));
        }
      } catch {
        if (!cancelled) {
          setVoiceCapacity(normalizeVoiceCapacity({ state: 'ERROR' }));
          timer = window.setTimeout(check, 15_000);
        }
      }
    };
    setVoiceCapacity(normalizeVoiceCapacity());
    void check();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [requestedVoiceProfileId, usesStandardVoice]);

  // Human-readable name of the voice in force, for the read-only indicator.
  //
  // The published name comes first, and only when the published voice is the one
  // actually in force — it is the name the lecturer chose the voice by on the
  // faculty site, so a student and a lecturer looking at the same lecture see the
  // same words ("Alice - Clear, Engaging Educator"). Without it a stock voice
  // showed its raw id, which names nothing to anyone.
  //
  // Then the id described, which shows a cloned voice's slug as-is and calls an
  // unresolved stock voice a "standard voice". Then, with no requested
  // voice at all, the loaded profile's own name: getFullActiveVoiceProfile()
  // returns the stored profile payload directly (lambda/voice-profile/index.js),
  // which carries displayName — no separate model-list lookup needed.
  const publishedVoiceIsInForce =
    Boolean(requestedVoiceProfileId) && requestedVoiceProfileId === String(publishedVoiceProfileId || '').trim();
  const activeVoiceLabel = requestedVoiceProfileId
    ? ((publishedVoiceIsInForce ? String(publishedVoiceDisplayName || '').trim() : '')
      || describeVoiceForDisplay(requestedVoiceProfileId))
    : String(activeProfile?.displayName || '').trim();

  // The cloned voice this build expects. The active profile is a single shared
  // backend setting, so without a pin the gi app would speak in whatever voice
  // someone else activated last.
  // Only true once a profile has actually loaded and turned out to be the wrong
  // one — a not-yet-loaded profile must not read as a mismatch.
  const voiceMismatch = !requestedVoiceProfileId
    && Boolean(activeProfile)
    && !matchesPinnedVoice(activeProfile, pinnedVoiceKey);

  const refParams = useMemo(() => {
    // An empty object is intentional: createLiveSynthesisSnapshot adds the
    // configured voiceProfileId, and Lambda resolves Dean's refs/settings.
    if (requestedVoiceProfileId) return {};
    if (!activeProfile) return null;
    return buildLiveFastRefParams({
      primaryPath: activeProfile.ref_audio_path || '',
      promptText: activeProfile.prompt_text || '',
      promptLang: activeProfile.prompt_lang || 'en',
      auxRefAudios: (activeProfile.aux_ref_audio_paths || []).map((path) => ({ path })),
      settings: normalizeLiveFastSettings(activeProfile.defaults || {}),
    });
  }, [activeProfile, requestedVoiceProfileId]);

  const fastSettings = useMemo(
    () => normalizeLiveFastSettings(activeProfile?.defaults || {}),
    [activeProfile]
  );

  const voiceModel = useMemo(
    () => buildSavedVoiceModelSnapshot(activeProfile),
    [activeProfile]
  );

  const liveSpeech = useLiveSpeech({
    refParams,
    fullRefParams: null,
    engine: APP_MODE_CONFIG.defaultLiveEngine,
    replyMode: 'phrases',
    language: activeProfile?.text_lang || 'en',
    voiceProfileId: requestedVoiceProfileId || activeProfile?.voiceProfileId || '',
    voiceModel,
    systemPrompt,
    fastMaxChunkWords: fastSettings.maxChunkWords,
    fastMaxSentencesPerChunk: fastSettings.maxSentencesPerChunk,
    getVideoPosition,
    onUserQuestion,
  });

  // Pick up a deploy the moment a conversation ends, so the next one runs the
  // current config. A kiosk here stays open all day: fetching only at mount meant
  // a lecturer could remove a PDF, deploy, and still be answered from it in every
  // later chat, because starting a new conversation re-reads the prompt but never
  // re-fetches it. Refreshing on the way into idle keeps the round trip off the
  // start path, where it would delay first audio.
  const previousPhaseRef = useRef(liveSpeech.phase);
  useEffect(() => {
    const previous = previousPhaseRef.current;
    previousPhaseRef.current = liveSpeech.phase;
    if (liveSpeech.phase === 'idle' && previous !== 'idle') {
      refreshDeployedPrompt();
    }
  }, [liveSpeech.phase, refreshDeployedPrompt]);

  // "New chat" hides the transcript and closes the current realtime session.
  const visibleMessages = useMemo(() => {
    if (!clearedBeforeId) return liveSpeech.messages;
    const cutoff = liveSpeech.messages.findIndex((message) => message.id === clearedBeforeId);
    return cutoff === -1 ? liveSpeech.messages : liveSpeech.messages.slice(cutoff + 1);
  }, [liveSpeech.messages, clearedBeforeId]);

  const newChat = useCallback(() => {
    const last = liveSpeech.messages[liveSpeech.messages.length - 1];
    setClearedBeforeId(last ? last.id : '');
    // Hiding the bubbles is not enough on its own. The Realtime conversation
    // lives on OpenAI's side, and the socket stays open between turns for the
    // whole session — so every message this just hid is still context for the
    // next reply, and a "new" chat inherits the character drift of the old one.
    // stop() closes the socket (and no-ops when already idle); the next turn,
    // typed or spoken, opens a fresh session from a standing start.
    liveSpeech.stop();
  }, [liveSpeech.messages, liveSpeech.stop]);

  const toggleMute = useCallback(() => {
    if (liveSpeech.isMicInputEnabled) {
      liveSpeech.disableMicInput();
    } else {
      liveSpeech.enableMicInput();
    }
  }, [liveSpeech.isMicInputEnabled, liveSpeech.disableMicInput, liveSpeech.enableMicInput]);

  const error = liveSpeech.error || profileError;
  // A capacity wait ("a GPU is switching to this voice") arrives on the error
  // channel but is not a failure, so the kiosk must not paint it red — same rule
  // as pages/LivePage.jsx. A profile-load failure has no tone of its own and
  // stays red.
  const errorTone = liveSpeech.error ? liveSpeech.errorTone : 'error';

  // True only once an activated voice profile has produced usable reference
  // params — gates the controls so a fresh deployment with no cloned voice
  // can't reach useLiveSpeech's "Go to the Inference page first" dead end
  // (gi mode has no Inference page to go to).
  const capacityBlocksConversation = requestedVoiceProfileId && !usesStandardVoice
    ? voiceCapacityBlocksConversation(voiceCapacity)
    : false;
  const voiceReady = refParams !== null && !voiceMismatch && !capacityBlocksConversation;
  const capacityMessage = requestedVoiceProfileId && !usesStandardVoice
    ? voiceCapacityNotice(voiceCapacity)
    : '';

  return {
    status: toGiStatus(liveSpeech.phase, { hasError: Boolean(error) }),
    messages: visibleMessages,
    error,
    errorTone,
    voiceActive: isVoiceActive(liveSpeech.phase),
    responseBusy: isResponseBusy(liveSpeech.phase),
    connecting: !backendReadyForVoice || Boolean(
      requestedVoiceProfileId && !usesStandardVoice && voiceCapacity.state === 'CHECKING'
    ),
    micMuted: !liveSpeech.isMicInputEnabled,
    toggleMute,
    startConversation: liveSpeech.start,
    stopConversation: liveSpeech.stop,
    newChat,
    // Typing is the alternative to the mic, for students on a machine without
    // one. Sending from a standing start opens the conversation by itself, so
    // this stays available while idle — it is only closed off while a reply is
    // already being generated, or while the session is coming up or going down.
    sendText: liveSpeech.sendTextMessage,
    canSendText:
      voiceReady
      && backendReadyForVoice
      && !['connecting', 'thinking', 'stopping'].includes(liveSpeech.phase),
    activeVoiceLabel,
    voiceReady,
    // The pinned voice is not the one the backend has active. Surfaced so the
    // UI can say so specifically instead of the generic "no voice set up".
    voiceMismatch,
    // Mic-permission / unsupported-browser advisories from useLiveSpeech —
    // surfaced separately from `error` so GiChatPage can render them on the
    // amber advisory channel instead of the red error channel.
    notice: voiceMismatch
      ? `This build is pinned to the "${pinnedVoiceKey}" cloned voice, but "${activeVoiceLabel}" is currently active on the backend. Activate the pinned voice profile to continue.`
      : capacityMessage || liveSpeech.notice,
    speechApiAvailable: liveSpeech.speechApiAvailable,
    // Playback plumbing — GiChatPage drives a hidden <audio> element from these.
    phase: liveSpeech.phase,
    audioSrc: liveSpeech.audioSrc,
    selectedReplyId: liveSpeech.selectedReplyId,
    playbackReady: liveSpeech.shouldPlayAudio && Boolean(liveSpeech.audioSrc),
    onAudioEnded: liveSpeech.onAudioEnded,
    // Per-reply playback controls, mirroring pages/LivePage.jsx:3914-3948.
    // `speakingMessageId` is the reply currently reading aloud, so its bubble
    // can show "Playing" instead of the "Play voice" replay affordance.
    speakingMessageId:
      liveSpeech.phase === 'speaking' ? liveSpeech.selectedReply?.id || '' : '',
    playReply: liveSpeech.playReply,
    stopVoicePlayback: liveSpeech.stopVoicePlayback,
  };
}
