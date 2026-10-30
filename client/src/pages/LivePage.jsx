import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getInferenceStatus,
  getModels,
  getTrainingAudioUrl,
  getTrainingAudioFiles,
  getTrainingRunMetadata,
  activateVoiceProfile,
  deleteVoiceProfileConfig,
  getFullActiveVoiceProfile,
  ensureVoiceProfile,
  getMyVoiceProfiles,
  getVoiceProfileConfigs,
  saveVoiceProfileConfig,
  selectModels,
  startGeneration,
  getCurrentInference,
  getGenerationResultSource,
  getInferenceChunk,
  getInferenceChunkPreviewUrl,
  getInferenceChunkVersionUrl,
  regenerateInferenceChunk,
  restoreInferenceChunk,
  deleteInferenceChunk,
  insertInferenceChunk,
  synthesizeSentence,
  getPronunciationDictionary,
  searchPronunciationDictionary,
  scanOovWords,
  savePronunciationEntry,
  deletePronunciationEntry,
  startInferenceServer,
  stopInferenceServer,
} from '../services/api.js';
import { useLiveSpeech } from '../hooks/useLiveSpeech.js';
import { useInferenceSSE } from '../hooks/useInferenceSSE.js';
import {
  LIVE_LANGUAGE_OPTIONS,
  getLiveLanguageConfig,
  normalizeLiveLanguage,
  splitLiveReplyChunks,
  shortenFirstFastPhrase,
  nextAudioErrorAction,
} from '../hooks/liveConversation.js';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { ChatTextInput } from '@/components/ChatTextInput.jsx';
import { MicLevelMeter } from '@/components/MicLevelMeter';
import {
  chooseBestReferenceSet,
  findForeignReferencePaths,
  describeReferenceCandidate,
  shouldAutoApplyBestReferenceSet,
} from '@/lib/referenceSelection';
import { buildVoiceProfiles } from '@/lib/voiceProfiles';
import {
  DEFAULT_LIVE_FAST_SETTINGS,
  buildLiveFastReferencePreviewItems,
  buildLiveFastRefParams,
  normalizeLiveFastSettings,
} from '@/lib/liveFastSetup';
import {
  DEFAULT_LIVE_FULL_SETTINGS,
  buildLiveFullConfigPayload,
  buildLiveFullRefParams,
  resolveLiveFullRefParams,
  filterLiveFastConfigs,
  filterLiveFullConfigs,
  isAutoManagedLiveFastConfig,
  normalizeLiveFullSettings,
} from '@/lib/liveFullSetup';
import {
  buildModelSelectWarmPayload,
  extractModelSelectWarmedReferenceSelection,
  isSelectedModelLoaded,
  canPinVoicePerRequest,
  isVoiceReadyToSynthesize,
  resolveInferenceStatusState,
  resolveWarmedReferencePrompt,
  sameLoadedWeights,
  shouldHoldReadyDuringTransientStatus,
  shouldLoadSelectedProfile,
} from '@/lib/modelLoading';
import { formatActiveVoiceProfileSummary } from '@/lib/activeVoiceProfile';
import { getStorageMode } from '@/lib/runtimeConfig';
import { useGpuStatus } from '@/lib/gpuStatus.jsx';
import { isTransientBackendError, sanitizeBackendError } from '@/lib/backendErrors';
import { voiceCapacityNotice } from '@/lib/voiceCapacity';
import FloatingNotice from '@/components/FloatingNotice';
import {
  addTtsHistoryItem,
  createTtsHistoryItem,
  getTtsHistoryByRoute,
} from '@/lib/ttsHistory';
import { concatWavBlobs } from '@/lib/wavConcat';
import { waitForPlayableAudioSource } from '@/lib/audioReadiness';
import { generateLiveFastQueuedTts } from '@/lib/liveFastQueuedTts';
import {
  clearPendingFullTts,
  loadPendingFullTts,
  savePendingFullTts,
} from '@/lib/pendingFullTts';
import { fetchDatamuseArpabet } from '@/lib/arpabet';
import {
  parsePronunciationCsv,
  serializePronunciationCsv,
} from '@/lib/pronunciationCsv';
import { buildVoiceProfileId, buildVoiceProfilePayload } from '@/lib/voiceProfilePayload';
import { normalizeVoiceKey, resolveInitialVoiceKey } from '@/lib/chatbotVoice';
import MyVoicesPanel from '../components/MyVoicesPanel.jsx';
import {
  resolveChatbotSystemPrompt,
  getDefaultChatbotSystemPrompt,
  persistChatbotSystemPrompt,
  clearChatbotSystemPrompt,
  setDeployedChatbotSystemPrompt,
  hasStoredChatbotSystemPrompt,
} from '@/lib/chatbotSystemPrompt';
import {
  fetchDeployedChatbotSystemPrompt,
  fetchChatbotPromptCategories,
  deployChatbotSystemPrompt,
} from '@/services/chatbotPrompt';
import {
  DEFAULT_CHATBOT_CATEGORY,
  normalizeChatbotCategory,
} from '@/lib/chatbotCategory';
import {
  MAX_DOCUMENTS_CHARS,
  resolveChatbotDocuments,
  persistChatbotDocuments,
  clearChatbotDocuments,
  hasStoredChatbotDocuments,
  setDeployedChatbotDocuments,
  addChatbotDocument,
  removeChatbotDocument,
  buildDocumentsContext,
} from '@/lib/chatbotDocuments';
import { assembleSystemPrompt } from '@/lib/assembleSystemPrompt';
import { extractPdfText } from '@/lib/chatbotPdf';
import { APP_MODE_CONFIG } from '@/lib/appMode';
import {
  buildSavedVoiceProfileRestoreKey,
  findSavedVoiceProfileKey,
  hasRestorableSavedVoiceProfile,
  matchesSavedVoiceProfileReferenceSelection,
  matchesSavedVoiceProfileSelection,
} from '@/lib/savedVoiceProfile';
import {
  createVoiceProfileBrowserDebugSummary,
  writeVoiceProfileBrowserDebug,
} from '@/lib/voiceProfileDebug';
import {
  createAutoVoiceProfileSyncFingerprint,
  getAutoSyncRequestFingerprint,
} from '@/lib/autoVoiceProfileSync';
import {
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  Clock,
  Download,
  Loader2,
  Mic,
  MicOff,
  Pencil,
  PlayCircle,
  Plus,
  RefreshCw,
  Undo2,
  Search,
  ScanSearch,
  Sparkles,
  Square,
  Trash2,
  Upload,
  UserRound,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';


function fallbackName(filePath) {
  return (filePath || '').replace(/\\/g, '/').split('/').pop() || 'reference.wav';
}

function normalizeReferenceLanguage(lang) {
  const value = String(lang || '').trim().toLowerCase();
  return ['en', 'zh', 'ja', 'ko', 'auto'].includes(value) ? value : 'en';
}

const PRONUNCIATION_CATEGORIES = ['general', 'biology', 'chemistry', 'medical', 'names', 'acronyms', 'math'];

// Picked from the lecture menu to reveal the add field. Safe as a sentinel
// because normalizeChatbotCategory only ever yields lowercase letters, numbers
// and hyphens, so no real lecture id can look like this.
const ADD_CHATBOT_CATEGORY = '__add-lecture__';

// Advanced settings are still fully wired up (state + auto-applied defaults);
// this just hides the collapsible UI so it doesn't confuse end users. Flip to
// true to expose the panel again.
// Keep Dev and staging on identical application code. Visibility is an explicit
// deployment concern: Dev exposes tuning controls, while staging applies the
// saved settings without exposing the panel.
const SHOW_ADVANCED_SETTINGS = import.meta.env.VITE_SHOW_ADVANCED_SETTINGS !== 'false';

function buildConfigId(seed = '') {
  const slug = String(seed || 'config')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${slug || 'config'}-${Date.now().toString(36)}`;
}

function formatReferenceScore(candidate) {
  if (!candidate) return 'unscored';
  return `${Math.round(candidate.score)} ${candidate.eligible ? 'strict' : 'manual'}`;
}

function ChatBubble({ message, selected, selectedPart, onPlay, audioRef }) {
  const isUser = message.role === 'user';
  const readyParts = (message.audioParts || []).filter((part) => part.audioUrl);
  const hasVoice = !isUser && (Boolean(message.audioUrl) || readyParts.length > 0);
  const isBusy = ['thinking', 'generating_voice', 'transcribing', 'listening'].includes(message.status);
  return (
    <div className={cn('flex gap-2.5', isUser ? 'justify-end' : 'justify-start')}>
      {!isUser && (
        <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500">
          <Bot size={14} />
        </div>
      )}

      <div className={cn(
        'max-w-[76%] rounded-2xl px-4 py-3',
        isUser
          ? 'rounded-br-md bg-slate-900 text-white'
          : 'rounded-bl-md border border-slate-100 bg-slate-50 text-slate-900'
      )}>
        <p className={cn('whitespace-pre-wrap text-sm leading-6', isBusy && !message.text && 'italic opacity-60')}>
          {message.text || (isUser ? 'Listening...' : 'Thinking...')}
        </p>

        {message.error && (
          <p className={cn(
            'mt-2 flex items-center gap-1 text-xs',
            message.errorTone === 'waiting' ? 'text-amber-600' : 'text-red-500',
          )}>
            {message.errorTone === 'waiting' ? <Clock size={12} /> : <CircleAlert size={12} />}
            {message.error}
          </p>
        )}

        {hasVoice && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onPlay(message.id)}
              className={cn(
                'flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors',
                selected
                  ? 'bg-slate-900 text-white'
                  : 'border border-slate-200 bg-white text-slate-700 hover:border-slate-300'
              )}
            >
              {selected ? <Volume2 size={11} /> : <PlayCircle size={11} />}
              {selected ? 'Playing' : 'Play voice'}
            </button>
            {message.audioUrl && (
              <a
                href={message.audioUrl}
                download={`live_reply_${message.id}.wav`}
                className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-500 hover:border-slate-300"
              >
                <Download size={11} />WAV
              </a>
            )}
          </div>
        )}
      </div>

      {isUser && (
        <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white">
          <UserRound size={14} />
        </div>
      )}
    </div>
  );
}

export default function LivePage({ replyMode = 'phrases', mode = 'chat' }) {
  const kiosk = APP_MODE_CONFIG.kiosk;
  // Where "please train your voice" sends a lecturer with no voice yet. Blank
  // (the default) simply drops the link rather than guessing a host.
  const TRAINING_APP_URL = String(import.meta.env.VITE_TRAINING_APP_URL || '').trim();
  const canEditInstructions = APP_MODE_CONFIG.showInstructionsEditor;
  // Faculty only: which voices this lecturer owns, resolved server-side from
  // their signed-in email. `scope` is a request, not a permission — the server
  // downgrades it to 'mine' for anyone who is not an admin.
  const [myVoices, setMyVoices] = useState([]);
  // Stock ElevenLabs voices, offered to every lecturer alongside their own. They
  // are tracked separately from `selectedPersonKey` on purpose: that key must
  // name a real pair of GPT-SoVITS weights, and a stock voice has none.
  const [standardVoices, setStandardVoices] = useState([]);
  const [selectedStandardVoiceId, setSelectedStandardVoiceId] = useState('');
  const [myVoicesScope, setMyVoicesScope] = useState('mine');
  const [myVoicesAdmin, setMyVoicesAdmin] = useState(false);
  const [myVoicesLoading, setMyVoicesLoading] = useState(false);
  const [myVoicesError, setMyVoicesError] = useState('');
  const [myVoicesReloadToken, setMyVoicesReloadToken] = useState(0);
  const ensuredVoiceRef = useRef('');
  // Which assistant this panel is editing. Each category is stored separately,
  // so switching here swaps the whole panel — instructions, documents and the
  // browser-local draft of both.
  const [chatbotCategory, setChatbotCategory] = useState(DEFAULT_CHATBOT_CATEGORY);
  const [chatbotCategories, setChatbotCategories] = useState([]);
  const [newChatbotCategory, setNewChatbotCategory] = useState('');
  // The add-a-lecture field is a rare action, so it stays out of the panel until
  // it is asked for from the foot of the lecture menu.
  const [addingChatbotCategory, setAddingChatbotCategory] = useState(false);
  const newChatbotCategoryRef = useRef(null);
  // Radix hands focus back to the trigger when the menu closes, which would land
  // the lecturer on the select they just used instead of the field they asked
  // for. Set while the close is in flight so that handoff can be redirected.
  const focusNewChatbotCategoryRef = useRef(false);
  const [chatbotSystemPrompt, setChatbotSystemPrompt] = useState(() => (kiosk ? resolveChatbotSystemPrompt() : ''));
  const [chatbotDocuments, setChatbotDocuments] = useState(() => (kiosk ? resolveChatbotDocuments() : []));
  const [chatbotDocError, setChatbotDocError] = useState('');
  const [chatbotDeployState, setChatbotDeployState] = useState({ status: 'idle', message: '' });
  // Same assembly the lecture site runs (see lib/assembleSystemPrompt.js). What a
  // lecturer tests here is what students get, which is only true while both sides
  // go through that one function.
  const chatbotCombinedSystemPrompt = useMemo(
    () => assembleSystemPrompt({
      prompt: chatbotSystemPrompt,
      documents: chatbotDocuments,
    }),
    [chatbotSystemPrompt, chatbotDocuments],
  );
  // Everything selectable: the default, whatever has been deployed, and the
  // lecture being edited right now — a brand-new one has nothing deployed yet
  // and would otherwise vanish from its own picker.
  const chatbotCategoryOptions = useMemo(() => {
    const ids = new Set([
      DEFAULT_CHATBOT_CATEGORY,
      chatbotCategory,
      ...chatbotCategories.map((entry) => entry.category),
    ]);
    return Array.from(ids).sort((a, b) => {
      if (a === DEFAULT_CHATBOT_CATEGORY) return -1;
      if (b === DEFAULT_CHATBOT_CATEGORY) return 1;
      return a.localeCompare(b);
    });
  }, [chatbotCategories, chatbotCategory]);
  const [gptModels, setGptModels] = useState([]);
  const [sovitsModels, setSovitsModels] = useState([]);
  const [modelsFetched, setModelsFetched] = useState(false);
  const [modelError, setModelError] = useState('');
  const [gpuNotice, setGpuNotice] = useState(null);
  // Shared GPU lifecycle: don't hit model/status endpoints until the worker is
  // ready (otherwise a cold GPU answers with 503/404 pages). When no instance is
  // configured (local dev) the backend is always considered queryable.
  const { workerReady: gpuWorkerReady, configured: gpuConfigured } = useGpuStatus();
  const backendQueryable = !gpuConfigured || gpuWorkerReady;
  // Only the live-fast build (doovx…) surfaces "someone else switched the shared
  // model". Explicitly the 'live-fast' mode — NOT the Dean demo (chatbot mode),
  // which also has showLiveFast but should stay quiet.
  const isLiveFastBuild = APP_MODE_CONFIG.mode === 'live-fast';
  const initialBackendLoadRef = useRef(false);
  const observedLoadedSigRef = useRef(null);
  const [selectedPersonKey, setSelectedPersonKey] = useState('');
  const [loadedGPTPath, setLoadedGPTPath] = useState('');
  const [loadedSoVITSPath, setLoadedSoVITSPath] = useState('');
  const [modelSelectionOnly, setModelSelectionOnly] = useState(false);
  const [serverReady, setServerReady] = useState(false);
  const [loadingModel, setLoadingModel] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [activeVoiceProfile, setActiveVoiceProfile] = useState(null);
  const [loadingActiveVoiceProfile, setLoadingActiveVoiceProfile] = useState(true);
  const [activeVoiceProfileError, setActiveVoiceProfileError] = useState('');
  const [voiceConfigs, setVoiceConfigs] = useState([]);
  const [loadingVoiceConfigs, setLoadingVoiceConfigs] = useState(false);
  const [loadedVoiceConfigsProfileId, setLoadedVoiceConfigsProfileId] = useState('');
  const [voiceConfigError, setVoiceConfigError] = useState('');
  const [loadedConfigId, setLoadedConfigId] = useState('');
  const [trainingRunMetadata, setTrainingRunMetadata] = useState(null);
  const [trainingRunMetadataError, setTrainingRunMetadataError] = useState('');
  const [savingConfigId, setSavingConfigId] = useState('');
  const [generatingSampleConfigId, setGeneratingSampleConfigId] = useState('');
  const [draggingConfigId, setDraggingConfigId] = useState('');
  const [configSampleUrls, setConfigSampleUrls] = useState({});
  const [liveFullConfigs, setLiveFullConfigs] = useState([]);
  const [loadedLiveFullConfigId, setLoadedLiveFullConfigId] = useState('');
  const [savingLiveFullConfigId, setSavingLiveFullConfigId] = useState('');
  const [generatingLiveFullSampleConfigId, setGeneratingLiveFullSampleConfigId] = useState('');
  const [liveFullMessage, setLiveFullMessage] = useState('');

  const [trainingAudioFiles, setTrainingAudioFiles] = useState([]);
  const [loadedTrainingAudioSourceKey, setLoadedTrainingAudioSourceKey] = useState('');
  const [loadingTrainingAudio, setLoadingTrainingAudio] = useState(false);
  const [refAudioPath, setRefAudioPath] = useState('');
  const [promptText, setPromptText] = useState('');
  const [promptLang, setPromptLang] = useState('en');
  const [auxRefAudios, setAuxRefAudios] = useState([]);
  const [referenceMessage, setReferenceMessage] = useState('');
  const [previewReference, setPreviewReference] = useState({ path: '', url: null, filename: '', role: '' });
  const [liveFullPreviewReference, setLiveFullPreviewReference] = useState({ path: '', url: null, filename: '', role: '' });
  const [referenceAudioUrls, setReferenceAudioUrls] = useState({});
  const [loadingPreviewPath, setLoadingPreviewPath] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  // Mobile-only: the kiosk "Assistant instructions" panel is a slide-over drawer on
  // small screens (it stays an in-flow sidebar at lg+). This tracks the drawer state.
  const [showInstructions, setShowInstructions] = useState(false);

  const [speed, setSpeed] = useState(DEFAULT_LIVE_FAST_SETTINGS.speed);
  const [topK, setTopK] = useState(DEFAULT_LIVE_FAST_SETTINGS.topK);
  const [topP, setTopP] = useState(DEFAULT_LIVE_FAST_SETTINGS.topP);
  const [temperature, setTemperature] = useState(DEFAULT_LIVE_FAST_SETTINGS.temperature);
  const [repPenalty, setRepPenalty] = useState(DEFAULT_LIVE_FAST_SETTINGS.repPenalty);
  const [liveFastOutputGainDb, setLiveFastOutputGainDb] = useState(DEFAULT_LIVE_FAST_SETTINGS.outputGainDb);
  const [liveFastMaxChunkWords, setLiveFastMaxChunkWords] = useState(DEFAULT_LIVE_FAST_SETTINGS.maxChunkWords);
  const [liveFastMaxSentences, setLiveFastMaxSentences] = useState(DEFAULT_LIVE_FAST_SETTINGS.maxSentencesPerChunk);
  const [liveFullRefAudioPath, setLiveFullRefAudioPath] = useState('');
  const [liveFullPromptText, setLiveFullPromptText] = useState('');
  const [liveFullPromptLang, setLiveFullPromptLang] = useState('en');
  const [liveFullAuxRefAudios, setLiveFullAuxRefAudios] = useState([]);
  const [liveFullSpeed, setLiveFullSpeed] = useState(DEFAULT_LIVE_FULL_SETTINGS.speed);
  const [liveFullTopK, setLiveFullTopK] = useState(DEFAULT_LIVE_FULL_SETTINGS.topK);
  const [liveFullTopP, setLiveFullTopP] = useState(DEFAULT_LIVE_FULL_SETTINGS.topP);
  const [liveFullTemperature, setLiveFullTemperature] = useState(DEFAULT_LIVE_FULL_SETTINGS.temperature);
  const [liveFullRepPenalty, setLiveFullRepPenalty] = useState(DEFAULT_LIVE_FULL_SETTINGS.repPenalty);
  const [liveFullOutputGainDb, setLiveFullOutputGainDb] = useState(DEFAULT_LIVE_FULL_SETTINGS.outputGainDb);
  const [liveFullMaxChunkWords, setLiveFullMaxChunkWords] = useState(DEFAULT_LIVE_FULL_SETTINGS.maxChunkWords);
  const [liveFullMaxSentences, setLiveFullMaxSentences] = useState(DEFAULT_LIVE_FULL_SETTINGS.maxSentencesPerChunk);

  const [selectedLanguage, setSelectedLanguage] = useState('en');
  // Chatbot synthesis engine: 'fast' (live/tts-sentence) or 'full' (/inference for accuracy).
  // Dean kiosk defaults to Live Fast; the toggle can opt into Live Full.
  const [liveEngine, setLiveEngine] = useState(APP_MODE_CONFIG.defaultLiveEngine);
  const [ttsText, setTtsText] = useState('');
  const [ttsHistory, setTtsHistory] = useState([]);
  const [regeneratingFullChunk, setRegeneratingFullChunk] = useState('');
  const [fullChunkDrafts, setFullChunkDrafts] = useState({});
  const [fullChunkInsert, setFullChunkInsert] = useState({ key: '', text: '' });
  const [ttsFastGenerating, setTtsFastGenerating] = useState(false);
  const [ttsFastProgress, setTtsFastProgress] = useState({ total: 0, current: 0, text: '' });
  // Which button (if any) is running the async chunked flow: null | 'fast' | 'full'.
  const [streamingRoute, setStreamingRoute] = useState(null);
  // Progressive-queue playback controls (Live Fast Queue / Full Inference Queue).
  const [queuePlayback, setQueuePlayback] = useState({ active: false, paused: false });
  const [ttsError, setTtsError] = useState('');
  const [ttsWarning, setTtsWarning] = useState('');
  const [pronunciationCategory, setPronunciationCategory] = useState('general');
  const [pronunciationWord, setPronunciationWord] = useState('');
  const [pronunciationArpabet, setPronunciationArpabet] = useState('');
  const [pronunciationSynthesisAlias, setPronunciationSynthesisAlias] = useState('');
  const [pronunciationVerifyPhonemes, setPronunciationVerifyPhonemes] = useState(false);
  const [editingPronunciationWord, setEditingPronunciationWord] = useState('');
  const [pronunciationEntries, setPronunciationEntries] = useState([]);
  const [pronunciationSearch, setPronunciationSearch] = useState('');
  const [pronunciationSearchResults, setPronunciationSearchResults] = useState(null);
  const [pronunciationSearching, setPronunciationSearching] = useState(false);
  const [pronunciationMessage, setPronunciationMessage] = useState('');
  const [pronunciationBusy, setPronunciationBusy] = useState(false);
  const [pronunciationGenerating, setPronunciationGenerating] = useState(false);
  const [pronunciationTestingWord, setPronunciationTestingWord] = useState('');
  const [pronunciationReloadPending, setPronunciationReloadPending] = useState(false);
  const [oovScan, setOovScan] = useState(null); // { flagged, totalWords, coveredWords, dictionaryLoaded } | null
  const [oovScanning, setOovScanning] = useState(false);
  const [oovScanError, setOovScanError] = useState('');
  const [fullOovAcknowledgedKey, setFullOovAcknowledgedKey] = useState('');
  const audioRef = useRef(null);
  const messagesEndRef = useRef(null);
  const referencePreviewAudioRef = useRef(null);
  const liveFullPreviewAudioRef = useRef(null);
  const autoReferenceKeyRef = useRef('');
  const autoLoadAttemptKeyRef = useRef('');
  const urlVoiceKeyRef = useRef('');
  const restoredActiveVoiceProfileKeyRef = useRef('');
  const previewRequestRef = useRef(0);
  const configSampleUrlsRef = useRef({});
  const voiceConfigsRef = useRef([]);
  const voiceConfigLoadRequestRef = useRef(0);
  const selectedExpNameRef = useRef('');
  const autoDefaultConfigKeyRef = useRef('');
  const autoLoadedLiveFastConfigProfileRef = useRef('');
  const liveFullDefaultKeyRef = useRef('');
  const liveFullAutoDefaultSaveKeyRef = useRef('');
  const reorderingConfigRef = useRef(false);
  const pendingAutoSyncFingerprintRef = useRef('');
  const autoSyncRequestFingerprintRef = useRef('');
  const lastAutoSyncedFingerprintRef = useRef('');
  const statusRequestVersionRef = useRef(0);
  const notReadyStatusCountRef = useRef(0);
  const serverReadyStateRef = useRef(false);
  const modelLoadVersionRef = useRef(0);
  const loadedModelStateRef = useRef({ gptPath: '', sovitsPath: '' });
  const ttsHistoryRef = useRef([]);
  const queuedTtsAudioRef = useRef(null);
  const queuedTtsRef = useRef({ clips: [], playingIndex: -1, active: false, paused: false });
  const pronunciationWordInputRef = useRef(null);
  const pronunciationImportInputRef = useRef(null);
  const ttsInference = useInferenceSSE();
  const pendingFullTtsRef = useRef(null);
  const fullTtsSubmissionRef = useRef(false);
  const restoredFullTtsRef = useRef(false);
  const completingFullTtsSessionRef = useRef('');
  // Tracks which Full Inference chunks have already been pulled for queued playback.
  const fullQueuedFetchRef = useRef({ sessionId: '', fetched: 0, busy: false });
  // True while a queue route is still producing clips, so playback end-detection
  // knows whether a missing "next clip" means done vs. waiting for more.
  const queueProducingRef = useRef(false);

  const voiceProfiles = useMemo(() => buildVoiceProfiles(gptModels, sovitsModels), [gptModels, sovitsModels]);
  const availableProfiles = useMemo(() => voiceProfiles.filter((p) => p.complete), [voiceProfiles]);
  const selectedProfile = availableProfiles.find((p) => p.key === selectedPersonKey) || null;
  const selectedGPT = selectedProfile?.gptModel?.path || '';
  const selectedSoVITS = selectedProfile?.sovitsModel?.path || '';
  const selectedExpName = selectedProfile?.expName || '';
  selectedExpNameRef.current = selectedExpName;
  const selectedVoiceProfileId = selectedProfile ? buildVoiceProfileId(selectedProfile.displayName) : '';
  const canRestoreActiveVoiceProfile = matchesSavedVoiceProfileSelection({
    profile: activeVoiceProfile,
    voiceProfileId: selectedVoiceProfileId,
    selectedGPT,
    selectedSoVITS,
  }) && hasRestorableSavedVoiceProfile(activeVoiceProfile);
  const activeVoiceProfileRestoreKey = canRestoreActiveVoiceProfile
    ? buildSavedVoiceProfileRestoreKey(activeVoiceProfile)
    : '';
  const loadedProfile = availableProfiles.find((p) =>
    sameLoadedWeights(p.gptModel?.path, loadedGPTPath) && sameLoadedWeights(p.sovitsModel?.path, loadedSoVITSPath)
  ) || null;

  // A voice with a saved profile is resolved by the backend per request, on
  // whichever GPU instance serves the call — references included. Waiting for
  // one instance's status poll to report it loaded is meaningless behind a load
  // balancer, and never converges once the group holds more than one instance.
  // Declared ahead of the speaking-voice label below, which has to name a stock
  // voice when one is picked.
  const standardVoice = useMemo(
    () => standardVoices.find((voice) => voice.voiceProfileId === selectedStandardVoiceId) || null,
    [standardVoices, selectedStandardVoiceId],
  );
  const usingStandardVoice = Boolean(standardVoice);

  const selectedVoiceResolvesPerRequest = canEditInstructions
    && Boolean(selectedVoiceProfileId)
    && myVoices.some((voice) => (
      voice.displayName === selectedProfile?.displayName && voice.hasSavedProfile
    ));
  // Second, build-independent route to the same conclusion: once the selection
  // names both halves of the weight pair, every synthesis this page issues can
  // carry them as `voice_model`, and the worker pins exactly those weights on
  // whichever instance serves the call (gpu-inference-worker/src/services/
  // requestVoiceModel.js -> ensureRequestVoiceModel). No saved profile and no
  // ownership lookup needed, which matters because both of those are faculty-only
  // and left the live-fast/TTS build with no per-request route at all.
  //
  // This is what lets two sites hold two different voices at once. The GPU still
  // holds one model at a time, but that is now a scheduling detail the worker
  // resolves per request instead of a singleton the pages fight over: previously
  // each site auto-loaded its own voice over the other's and then waited forever
  // for /inference/status to report a voice the other site had already replaced.
  const selectedVoicePinsOwnWeights = canPinVoicePerRequest({
    voiceProfileId: selectedVoiceProfileId,
    selectedGPT,
    selectedSoVITS,
  });
  // The voice the user is about to hear. Once it is resolved per request the
  // loaded-model report describes some arbitrary instance rather than this
  // chat, so naming that voice would be actively wrong; elsewhere the loaded
  // model is still the honest answer and the label is unchanged.
  const speakingProfile = usingStandardVoice
    ? standardVoice
    : (selectedVoiceResolvesPerRequest || selectedVoicePinsOwnWeights)
      ? (selectedProfile || loadedProfile)
      : (loadedProfile || selectedProfile);

  const liveLanguage = normalizeLiveLanguage(selectedLanguage);
  const liveLanguageConfig = getLiveLanguageConfig(liveLanguage);
  const liveFastSettings = useMemo(() => normalizeLiveFastSettings({
    speed,
    topK,
    topP,
    temperature,
    repPenalty,
    outputGainDb: liveFastOutputGainDb,
    maxChunkWords: liveFastMaxChunkWords,
    maxSentencesPerChunk: liveFastMaxSentences,
  }), [speed, topK, topP, temperature, repPenalty, liveFastOutputGainDb, liveFastMaxChunkWords, liveFastMaxSentences]);
  const liveRefParams = useMemo(() => buildLiveFastRefParams({
    primaryPath: refAudioPath, promptText, promptLang, auxRefAudios,
    settings: liveFastSettings,
  }), [refAudioPath, promptText, promptLang, auxRefAudios, liveFastSettings]);
  const liveFullSettings = useMemo(() => normalizeLiveFullSettings({
    speed: liveFullSpeed,
    topK: liveFullTopK,
    topP: liveFullTopP,
    temperature: liveFullTemperature,
    repPenalty: liveFullRepPenalty,
    outputGainDb: liveFullOutputGainDb,
    maxChunkWords: liveFullMaxChunkWords,
    maxSentencesPerChunk: liveFullMaxSentences,
  }), [liveFullSpeed, liveFullTopK, liveFullTopP, liveFullTemperature, liveFullRepPenalty, liveFullOutputGainDb, liveFullMaxChunkWords, liveFullMaxSentences]);
  const liveFastRankOneReferenceSummary = useMemo(() => {
    const rankOneConfig = voiceConfigs[0] || null;
    const { primaryPath, auxPaths } = getConfigReferencePaths(rankOneConfig);
    return {
      config: rankOneConfig,
      primaryPath,
      auxPaths,
      primaryName: primaryPath ? fallbackName(primaryPath) : 'none',
    };
  }, [voiceConfigs]);
  // A saved rank #1 config is the preferred source — it pins a reviewed reference
  // clip and its transcript. But a voice that has never had one saved still has a
  // reference selection: the one Live Fast is synthesising with right now, chosen
  // by the model load's auto-reference pass. Requiring the config made Full the
  // only route that could not use it, which dead-ended those voices on
  // "Create or load Live Fast rank #1" with no way forward from this screen.
  // Full takes the same clip; only the settings differ.
  const liveFullRefParams = useMemo(() => resolveLiveFullRefParams({
    configParams: buildLiveFullRefParamsFromLiveFastRankOne(voiceConfigs[0], liveFullSettings),
    primaryPath: refAudioPath,
    promptText,
    promptLang,
    auxRefAudios,
    settings: liveFullSettings,
  }), [
    voiceConfigs,
    trainingAudioFiles,
    liveFullSettings,
    refAudioPath,
    promptText,
    promptLang,
    auxRefAudios,
  ]);
  const liveVoiceModel = useMemo(() => ({
    voiceProfileId: selectedVoiceProfileId,
    gptRef: selectedGPT,
    sovitsRef: selectedSoVITS,
    revision: String(activeVoiceProfile?.updatedAt || selectedProfile?.updatedAt || ''),
  }), [
    selectedVoiceProfileId,
    selectedGPT,
    selectedSoVITS,
    activeVoiceProfile?.updatedAt,
    selectedProfile?.updatedAt,
  ]);
  // The same snapshot, but only once it can actually pin a voice. A half-filled
  // `voice_model` is worse than none: the worker keys its scheduler on whatever
  // it is given and then falls through to the weights the GPU already held.
  const pinnedVoiceModel = selectedVoicePinsOwnWeights ? liveVoiceModel : null;

  // A stock voice is addressed purely by id — no reference clip, no weights.
  // The empty ref params keep the snapshot shape the conversation hook expects,
  // and the null voice model is deliberate: `selectedGPT`/`selectedSoVITS` still
  // hold whatever cloned voice was selected before, and passing those along
  // would pin the wrong model onto an ElevenLabs request.
  const standardVoiceRefParams = useMemo(() => ({}), []);
  const speakingVoiceProfileId = usingStandardVoice
    ? standardVoice.voiceProfileId
    : selectedVoiceProfileId;
  const speakingRefParams = usingStandardVoice ? standardVoiceRefParams : liveRefParams;
  const speakingVoiceModel = usingStandardVoice ? null : liveVoiceModel;
  const currentAutoSyncFingerprint = useMemo(() => createAutoVoiceProfileSyncFingerprint({
    sourceKey: selectedExpName,
    selectedGPT,
    selectedSoVITS,
    refAudioPath,
    promptText,
    promptLang,
    textLang: liveLanguage,
    preferredRoute: 'sentence',
    auxRefAudioPaths: auxRefAudios.map((item) => item.path),
    defaults: {
      top_k: topK,
      top_p: topP,
      temperature,
      repetition_penalty: repPenalty,
      speed_factor: speed,
      output_gain_db: liveFastOutputGainDb,
      max_chunk_words: liveFastMaxChunkWords,
      max_sentences_per_chunk: liveFastMaxSentences,
    },
  }), [
    selectedExpName,
    selectedGPT,
    selectedSoVITS,
    refAudioPath,
    promptText,
    promptLang,
    liveLanguage,
    auxRefAudios,
    topK,
    topP,
    temperature,
    repPenalty,
    speed,
    liveFastOutputGainDb,
    liveFastMaxChunkWords,
    liveFastMaxSentences,
  ]);
  const selectedReferenceItems = useMemo(() => buildLiveFastReferencePreviewItems({
    primaryPath: refAudioPath, promptText, trainingAudioFiles, auxRefAudios,
  }), [refAudioPath, promptText, trainingAudioFiles, auxRefAudios]);
  const selectedLiveFullReferenceItems = useMemo(() => buildLiveFastReferencePreviewItems({
    primaryPath: liveFullRefAudioPath,
    promptText: liveFullPromptText,
    trainingAudioFiles,
    auxRefAudios: liveFullAuxRefAudios,
  }), [liveFullRefAudioPath, liveFullPromptText, trainingAudioFiles, liveFullAuxRefAudios]);
  const referenceCandidateMap = useMemo(() => (
    Object.fromEntries(trainingAudioFiles.map((file) => [file.path, describeReferenceCandidate(file)]))
  ), [trainingAudioFiles]);
  const currentReferenceMetadata = useMemo(() => {
    const sourcePrimary = referenceCandidateMap[refAudioPath];
    const primary = refAudioPath ? describeReferenceCandidate({
      ...(sourcePrimary?.file || {}),
      filename: sourcePrimary?.filename || fallbackName(refAudioPath),
      path: refAudioPath,
      transcript: promptText,
      lang: promptLang,
    }) : null;
    const aux = auxRefAudios.map((file) => referenceCandidateMap[file.path] || describeReferenceCandidate(file));
    return {
      mode: primary?.eligible ? 'strict' : 'manual',
      primary,
      aux,
      selectedPaths: {
        primary: refAudioPath,
        aux: auxRefAudios.map((item) => item.path),
      },
    };
  }, [referenceCandidateMap, refAudioPath, promptText, promptLang, auxRefAudios]);
  const currentLiveFullReferenceMetadata = useMemo(() => {
    const sourcePrimary = referenceCandidateMap[liveFullRefAudioPath];
    const primary = liveFullRefAudioPath ? describeReferenceCandidate({
      ...(sourcePrimary?.file || {}),
      filename: sourcePrimary?.filename || fallbackName(liveFullRefAudioPath),
      path: liveFullRefAudioPath,
      transcript: liveFullPromptText,
      lang: liveFullPromptLang,
    }) : null;
    const aux = liveFullAuxRefAudios.map((file) => referenceCandidateMap[file.path] || describeReferenceCandidate(file));
    return {
      mode: primary?.eligible ? 'strict' : 'manual',
      primary,
      aux,
      selectedPaths: {
        primary: liveFullRefAudioPath,
        aux: liveFullAuxRefAudios.map((item) => item.path),
      },
    };
  }, [referenceCandidateMap, liveFullRefAudioPath, liveFullPromptText, liveFullPromptLang, liveFullAuxRefAudios]);
  const currentLiveFastMetadata = useMemo(() => ({
    configName: selectedProfile?.displayName ? `${selectedProfile.displayName} default` : 'Default',
    selected: true,
    rank: 1,
    language: liveLanguage,
    preferredRoute: 'sentence',
    defaults: {
      top_k: topK,
      top_p: topP,
      temperature,
      repetition_penalty: repPenalty,
      speed_factor: speed,
      output_gain_db: liveFastOutputGainDb,
      max_chunk_words: liveFastMaxChunkWords,
      max_sentences_per_chunk: liveFastMaxSentences,
    },
  }), [selectedProfile, liveLanguage, topK, topP, temperature, repPenalty, speed, liveFastOutputGainDb, liveFastMaxChunkWords, liveFastMaxSentences]);

  const liveSpeech = useLiveSpeech({
    refParams: speakingRefParams,
    fullRefParams: usingStandardVoice ? standardVoiceRefParams : liveFullRefParams,
    engine: liveEngine,
    replyMode,
    language: liveLanguage,
    voiceProfileId: speakingVoiceProfileId,
    voiceModel: speakingVoiceModel,
    systemPrompt: kiosk ? chatbotCombinedSystemPrompt : '',
    fastMaxChunkWords: liveFastSettings.maxChunkWords,
    fastMaxSentencesPerChunk: liveFastSettings.maxSentencesPerChunk,
  });
  const playbackReady = liveSpeech.shouldPlayAudio && Boolean(liveSpeech.audioSrc);
  const isConversationActive = liveSpeech.phase !== 'idle';
  const liveSelectedModelLoaded = isSelectedModelLoaded({
    serverReady, selectedGPT, selectedSoVITS, loadedGPTPath, loadedSoVITSPath,
  });
  const autoSyncRequestFingerprint = getAutoSyncRequestFingerprint({
    pendingFingerprint: pendingAutoSyncFingerprintRef.current,
    currentFingerprint: currentAutoSyncFingerprint,
    lastSyncedFingerprint: lastAutoSyncedFingerprintRef.current,
    ready: liveSelectedModelLoaded && Boolean(refAudioPath),
    busy: isConversationActive || loadingModel,
    inFlightFingerprint: autoSyncRequestFingerprintRef.current,
  });

  useEffect(() => {
    voiceConfigsRef.current = voiceConfigs;
  }, [voiceConfigs]);

  // Load the deployed instructions and documents for the selected category, at
  // startup and again on every switch. A local edit in this browser still wins,
  // so an editor mid-draft is not overwritten by the shared copy — the two halves
  // are tracked separately because a lecturer may well be redrafting the text
  // while leaving last deploy's PDFs alone. Drafts are per category too, so the
  // "mid-draft wins" rule cannot carry one lecture's text into another's deploy.
  useEffect(() => {
    if (!kiosk) return undefined;
    let cancelled = false;
    (async () => {
      const { prompt, documents } = await fetchDeployedChatbotSystemPrompt({
        category: chatbotCategory,
      });
      if (cancelled || (!prompt.trim() && documents.length === 0)) return;
      setDeployedChatbotSystemPrompt(prompt);
      setDeployedChatbotDocuments(documents);
      if (prompt.trim() && !hasStoredChatbotSystemPrompt({ category: chatbotCategory })) {
        setChatbotSystemPrompt(prompt);
      }
      if (!hasStoredChatbotDocuments({ category: chatbotCategory })) {
        setChatbotDocuments(documents);
      }
    })();
    return () => { cancelled = true; };
  }, [kiosk, chatbotCategory]);

  // The lectures that already have something deployed, for the picker. Refreshed
  // after a deploy so a newly named lecture appears without a reload.
  const refreshChatbotCategories = useCallback(async () => {
    if (!canEditInstructions) return;
    setChatbotCategories(await fetchChatbotPromptCategories());
  }, [canEditInstructions]);

  useEffect(() => { refreshChatbotCategories(); }, [refreshChatbotCategories]);

  async function fetchModels(attempt = 0) {
    if (attempt === 0) setModelsFetched(false);
    try {
      const res = await getModels();
      setGptModels(res.data.gpt || []);
      setSovitsModels(res.data.sovits || []);
      setModelError('');
      setModelsFetched(true);
    } catch (err) {
      // The model list 404s/503s for a while as the worker warms up. Retry quietly
      // instead of flashing a raw gateway error at the user.
      if (isTransientBackendError(err) && attempt < 6) {
        window.setTimeout(() => fetchModels(attempt + 1), 2500);
        return;
      }
      setModelError(sanitizeBackendError(err.response?.data?.error || err.message || 'Failed to load models.'));
      setModelsFetched(true);
    }
  }

  function applyInferenceStatusState(nextState = {}) {
    loadedModelStateRef.current = {
      gptPath: String(nextState.loadedGPTPath || '').trim(),
      sovitsPath: String(nextState.loadedSoVITSPath || '').trim(),
    };
    serverReadyStateRef.current = Boolean(nextState.serverReady);
    setServerReady(serverReadyStateRef.current);
    setLoadedGPTPath(loadedModelStateRef.current.gptPath);
    setLoadedSoVITSPath(loadedModelStateRef.current.sovitsPath);
  }

  async function checkStatus() {
    const requestVersion = ++statusRequestVersionRef.current;
    try {
      const res = await getInferenceStatus();
      if (statusRequestVersionRef.current !== requestVersion) {
        return;
      }
      const nextState = resolveInferenceStatusState({
        status: res.data,
        fallbackLoadedGPTPath: loadedModelStateRef.current.gptPath,
        fallbackLoadedSoVITSPath: loadedModelStateRef.current.sovitsPath,
      });
      const hasKnownLoadedModel = Boolean(
        loadedModelStateRef.current.gptPath && loadedModelStateRef.current.sovitsPath,
      );
      if (!nextState.serverReady && serverReadyStateRef.current && hasKnownLoadedModel) {
        notReadyStatusCountRef.current += 1;
        // A single transient ready:false response occurs while the Python worker
        // respawns or weights switch. Confirm it twice before flashing "No model".
        if (shouldHoldReadyDuringTransientStatus({
          nextState,
          previousServerReady: serverReadyStateRef.current,
          hasKnownLoadedModel,
          consecutiveNotReady: notReadyStatusCountRef.current,
        })) return;
      } else {
        notReadyStatusCountRef.current = 0;
      }
      applyInferenceStatusState(nextState);
    } catch {
      // A transient network/gateway failure is NOT proof the model unloaded. Keep
      // the last known-good state so the UI doesn't flap to "not loaded" (which
      // previously forced a manual page refresh). A genuine "not ready" arrives as
      // a successful response with ready:false, handled above.
    }
  }

  async function loadActiveVoiceProfile() {
    setLoadingActiveVoiceProfile(true);
    try {
      const res = await getFullActiveVoiceProfile();
      setActiveVoiceProfile(res.data || null);
      setActiveVoiceProfileError('');
    } catch (err) {
      if (err.response?.status === 404) {
        setActiveVoiceProfile(null);
        setActiveVoiceProfileError('');
      } else {
        setActiveVoiceProfileError(err.response?.data?.error || err.message || 'Could not load saved voice profile.');
      }
    } finally {
      setLoadingActiveVoiceProfile(false);
    }
  }

  async function loadVoiceConfigs(voiceProfileId = selectedVoiceProfileId) {
    const requestId = ++voiceConfigLoadRequestRef.current;
    if (!voiceProfileId) {
      setVoiceConfigs([]);
      setLiveFullConfigs([]);
      setLoadedVoiceConfigsProfileId('');
      setVoiceConfigError('');
      return;
    }
    setLoadedVoiceConfigsProfileId('');
    setLoadingVoiceConfigs(true);
    try {
      const res = await getVoiceProfileConfigs(voiceProfileId);
      if (voiceConfigLoadRequestRef.current !== requestId) return;
      const configs = res.data.configs || [];
      const liveFastConfigs = filterLiveFastConfigs(configs);
      const nextLiveFullConfigs = filterLiveFullConfigs(configs);
      voiceConfigsRef.current = liveFastConfigs;
      setVoiceConfigs(liveFastConfigs);
      setLiveFullConfigs(nextLiveFullConfigs);
      setLoadedVoiceConfigsProfileId(voiceProfileId);
      console.info('[voice-configs] loaded configs', {
        voiceProfileId,
        count: configs.length,
        liveFastCount: liveFastConfigs.length,
        liveFullCount: nextLiveFullConfigs.length,
        configs: configs.map((config) => ({
          configId: config.configId,
          configName: config.configName,
          rank: config.rank,
          hasTrainingMetadata: Boolean(config.trainingMetadata && Object.keys(config.trainingMetadata).length > 0),
          trainingMetadata: config.trainingMetadata || null,
          inferenceMetadata: config.inferenceMetadata || null,
          referenceMetadata: config.referenceMetadata || null,
          sample: config.sample || null,
        })),
      });
      if (
        liveFastConfigs[0]
        && !isAutoManagedLiveFastConfig(liveFastConfigs[0], selectedExpName)
        && autoLoadedLiveFastConfigProfileRef.current !== voiceProfileId
      ) {
        autoLoadedLiveFastConfigProfileRef.current = voiceProfileId;
        applyVoiceConfig(liveFastConfigs[0], { silent: true });
        await syncRankOneConfigToVoiceProfile(liveFastConfigs[0], { context: 'startup rank #1 config' });
      }
      setVoiceConfigError('');
    } catch (err) {
      if (voiceConfigLoadRequestRef.current !== requestId) return;
      setVoiceConfigs([]);
      setLiveFullConfigs([]);
      setVoiceConfigError(err.response?.data?.error || err.message || 'Could not load saved configs.');
    } finally {
      if (voiceConfigLoadRequestRef.current === requestId) {
        setLoadingVoiceConfigs(false);
      }
    }
  }

  // Training metadata for the SELECTED voice only. The active profile can still be the
  // previous voice, so its metadata is used only when it names the same dataset.
  function selectedVoiceTrainingMetadata() {
    const sameSource = (metadata) => (
      metadata && Object.keys(metadata).length > 0
      && (!metadata.expName || !selectedExpName || metadata.expName === selectedExpName)
    );
    if (sameSource(trainingRunMetadata)) return trainingRunMetadata;
    const activeTraining = activeVoiceProfile?.metadata?.training;
    return sameSource(activeTraining) ? activeTraining : null;
  }

  async function loadTrainingRunMetadata(expName = selectedExpName) {
    if (!expName) {
      setTrainingRunMetadata(null);
      setTrainingRunMetadataError('');
      return;
    }
    try {
      const res = await getTrainingRunMetadata(expName);
      const metadata = res.data.metadata || null;
      setTrainingRunMetadata(metadata);
      setTrainingRunMetadataError('');
      console.info('[voice-configs] loaded training metadata', { expName, metadata });
    } catch (err) {
      const message = err.response?.status === 404
        ? 'No training metadata saved for this model yet.'
        : err.response?.data?.error || err.message || 'Could not load training metadata.';
      setTrainingRunMetadata(null);
      setTrainingRunMetadataError(message);
      console.info('[voice-configs] training metadata unavailable', { expName, message });
    }
  }

  function buildCurrentConfigPayload({ configId = '', configName = '' } = {}) {
    const resolvedConfigName = configName || currentLiveFastMetadata.configName;
    return {
      configName: resolvedConfigName,
      rank: voiceConfigs.length + 1,
      selected: true,
      trainingMetadata: selectedVoiceTrainingMetadata() || {},
      inferenceMetadata: {
        ...currentLiveFastMetadata,
        configName: resolvedConfigName,
        ...(configId ? { configId } : {}),
      },
      referenceMetadata: currentReferenceMetadata,
      sample: {},
      ...(configId ? { configId } : {}),
    };
  }

  function resolveReferenceFile(path, fallback = {}) {
    const normalizedPath = String(path || '').trim();
    if (!normalizedPath) return null;
    return trainingAudioFiles.find((file) => file.path === normalizedPath)
      || fallback?.file
      || {
        filename: fallback.filename || fallbackName(normalizedPath),
        path: normalizedPath,
        transcript: fallback.transcript || '',
        lang: fallback.lang || '',
      };
  }

  function referencePromptText(referencePrimary = {}, resolvedFile = {}, fallbackText = '') {
    return String(
      referencePrimary?.file?.transcript
        || referencePrimary?.transcript
        || resolvedFile?.transcript
        || fallbackText
        || ''
    );
  }

  function referencePromptLang(referencePrimary = {}, resolvedFile = {}, fallbackLang = 'en') {
    return normalizeReferenceLanguage(
      referencePrimary?.file?.lang
        || referencePrimary?.lang
        || resolvedFile?.lang
        || fallbackLang
    );
  }

  function buildConfigVoiceProfilePayload(config) {
    if (!config || !selectedProfile || !selectedGPT || !selectedSoVITS) return;
    const reference = config.referenceMetadata || {};
    const inference = config.inferenceMetadata || {};
    const defaults = inference.defaults || {};
    const primaryPath = String(reference.selectedPaths?.primary || reference.primary?.path || '').trim();
    if (!primaryPath) return;
    const primaryFile = resolveReferenceFile(primaryPath, reference.primary) || {};
    const promptTextFromConfig = referencePromptText(reference.primary, primaryFile, promptText);
    const promptLangFromConfig = referencePromptLang(reference.primary, primaryFile, promptLang);
    const auxPaths = Array.isArray(reference.selectedPaths?.aux)
      ? reference.selectedPaths.aux
      : Array.isArray(reference.aux)
        ? reference.aux.map((item) => item?.path).filter(Boolean)
        : [];

    return {
      displayName: selectedProfile.displayName,
      selectedGPT,
      selectedSoVITS,
      refAudioPath: primaryPath,
      promptText: promptTextFromConfig,
      promptLang: normalizeReferenceLanguage(promptLangFromConfig),
      textLang: inference.language || liveLanguage,
      preferredRoute: inference.preferredRoute || 'sentence',
      auxRefAudioPaths: auxPaths,
      defaults: {
        top_k: defaults.top_k ?? topK,
        top_p: defaults.top_p ?? topP,
        temperature: defaults.temperature ?? temperature,
        repetition_penalty: defaults.repetition_penalty ?? repPenalty,
        speed_factor: defaults.speed_factor ?? speed,
        output_gain_db: defaults.output_gain_db ?? DEFAULT_LIVE_FAST_SETTINGS.outputGainDb,
        max_chunk_words: defaults.max_chunk_words ?? DEFAULT_LIVE_FAST_SETTINGS.maxChunkWords,
        max_sentences_per_chunk: defaults.max_sentences_per_chunk ?? DEFAULT_LIVE_FAST_SETTINGS.maxSentencesPerChunk,
      },
      trainingMetadata: config.trainingMetadata || selectedVoiceTrainingMetadata() || undefined,
      referenceMetadata: reference,
      liveFastMetadata: inference,
    };
  }

  async function syncConfigToVoiceProfile(config) {
    const configPayload = buildConfigVoiceProfilePayload(config);
    if (!configPayload) return;
    const storageMode = await getStorageMode();
    const payload = buildVoiceProfilePayload({
      ...configPayload,
      storageMode,
    });
    const response = await activateVoiceProfile(payload);
    const summary = response.data || {};
    setActiveVoiceProfile(summary.voiceProfileId ? {
      ...payload,
      ...summary,
      voiceProfileId: summary.voiceProfileId || payload.voiceProfileId,
      displayName: summary.displayName || payload.displayName,
    } : null);
    console.info('[voice-configs] synced config to voice profile', {
      voiceProfileId: payload.voiceProfileId,
      configId: config.configId,
      rank: config.rank,
    });
  }

  async function syncRankOneConfigToVoiceProfile(config, { required = false, context = 'rank #1 config' } = {}) {
    if (!config) return false;
    try {
      await syncConfigToVoiceProfile(config);
      setVoiceConfigError('');
      return true;
    } catch (err) {
      const message = err.response?.data?.error || err.message || 'voice profile sync failed';
      const fullMessage = `Could not sync ${context} to voice profile: ${message}`;
      setVoiceConfigError(fullMessage);
      console.warn('[voice-configs] rank #1 voice profile sync failed', {
        voiceProfileId: selectedVoiceProfileId,
        configId: config.configId,
        context,
        message,
      });
      if (required) {
        throw new Error(fullMessage);
      }
      return false;
    }
  }

  function applyConfigAsActiveLiveFastProfile(config) {
    const configPayload = buildConfigVoiceProfilePayload(config);
    if (!configPayload) return;
    setActiveVoiceProfile((current) => ({
      ...(current || {}),
      voiceProfileId: selectedVoiceProfileId,
      displayName: configPayload.displayName,
      gptPath: selectedGPT,
      sovitsPath: selectedSoVITS,
      ref_audio_path: configPayload.refAudioPath,
      prompt_text: configPayload.promptText,
      prompt_lang: configPayload.promptLang,
      text_lang: configPayload.textLang,
      preferredRoute: configPayload.preferredRoute,
      aux_ref_audio_paths: configPayload.auxRefAudioPaths,
      defaults: configPayload.defaults,
      metadata: {
        ...(current?.metadata || {}),
        ...(configPayload.trainingMetadata ? { training: configPayload.trainingMetadata } : {}),
        reference: configPayload.referenceMetadata,
        liveFast: configPayload.liveFastMetadata,
      },
    }));
  }

  function clearReferenceSelection() {
    const audio = referencePreviewAudioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    setRefAudioPath('');
    setPromptText('');
    setPromptLang('en');
    setAuxRefAudios([]);
    setReferenceMessage('');
    setPreviewReference({ path: '', url: null, filename: '', role: '' });
    setReferenceAudioUrls({});
    setLoadingPreviewPath('');
  }

  function applyVoiceConfig(config, { silent = false } = {}) {
    const reference = config?.referenceMetadata || {};
    const inference = config?.inferenceMetadata || {};
    const defaults = inference.defaults || {};
    const primaryPath = String(reference.selectedPaths?.primary || reference.primary?.path || '').trim();
    const auxPaths = Array.isArray(reference.selectedPaths?.aux)
      ? reference.selectedPaths.aux
      : Array.isArray(reference.aux)
        ? reference.aux.map((item) => item?.path).filter(Boolean)
        : [];
    if (primaryPath) {
      const primaryFile = resolveReferenceFile(primaryPath, reference.primary) || {};
      setRefAudioPath(primaryPath);
      setPromptText(referencePromptText(reference.primary, primaryFile));
      setPromptLang(referencePromptLang(reference.primary, primaryFile));
    }
    setAuxRefAudios(auxPaths.slice(0, 5).map((path) => (
      trainingAudioFiles.find((file) => file.path === path) || {
        filename: fallbackName(path),
        path,
        transcript: '',
        lang: '',
      }
    )));
    setSelectedLanguage(normalizeLiveLanguage(inference.language || liveLanguage));
    setSpeed(Number.isFinite(defaults.speed_factor) ? defaults.speed_factor : speed);
    setTopK(Number.isFinite(defaults.top_k) ? defaults.top_k : topK);
    setTopP(Number.isFinite(defaults.top_p) ? defaults.top_p : topP);
    setTemperature(Number.isFinite(defaults.temperature) ? defaults.temperature : temperature);
    setRepPenalty(Number.isFinite(defaults.repetition_penalty) ? defaults.repetition_penalty : repPenalty);
    setLiveFastOutputGainDb(Number.isFinite(defaults.output_gain_db) ? defaults.output_gain_db : DEFAULT_LIVE_FAST_SETTINGS.outputGainDb);
    const chunkSettings = normalizeLiveFastSettings({
      maxChunkWords: defaults.max_chunk_words,
      maxSentencesPerChunk: defaults.max_sentences_per_chunk,
    });
    setLiveFastMaxChunkWords(chunkSettings.maxChunkWords);
    setLiveFastMaxSentences(chunkSettings.maxSentencesPerChunk);
    setLoadedConfigId(config?.configId || '');
    if (!silent) {
      setReferenceMessage(`Loaded config ${config.configName || config.configId}.`);
    }
  }

  function applyBestReference(files = trainingAudioFiles, { markForAutoSync = false } = {}) {
    const selection = chooseBestReferenceSet(files);
    if (!selection.primary) {
      clearReferenceSelection();
      if (markForAutoSync) {
        pendingAutoSyncFingerprintRef.current = '';
      }
      setReferenceMessage(selection.reason);
      return selection;
    }
    const nextPromptLang = normalizeReferenceLanguage(selection.primary.lang);
    setRefAudioPath(selection.primary.path);
    setPromptText(selection.primary.transcript || '');
    setPromptLang(nextPromptLang);
    setAuxRefAudios(selection.aux);
    // Only persist a scored-strict pick. A fallback pick (or one made before clip
    // quality scores / ASR transcripts landed) would freeze a mediocre ref + padded
    // 5 aux into the saved rank #1 config. Show it in the UI but don't save it; a
    // later load with scores present will produce (and persist) the scored-strict set.
    if (markForAutoSync && !selection.ready) {
      pendingAutoSyncFingerprintRef.current = '';
    }
    if (markForAutoSync && selection.ready) {
      pendingAutoSyncFingerprintRef.current = createAutoVoiceProfileSyncFingerprint({
        sourceKey: selectedExpName,
        selectedGPT,
        selectedSoVITS,
        refAudioPath: selection.primary.path,
        promptText: selection.primary.transcript || '',
        promptLang: nextPromptLang,
        textLang: liveLanguage,
        preferredRoute: 'sentence',
        auxRefAudioPaths: selection.aux.map((item) => item.path),
        defaults: {
          top_k: topK,
          top_p: topP,
          temperature,
          repetition_penalty: repPenalty,
          speed_factor: speed,
          output_gain_db: liveFastOutputGainDb,
          max_chunk_words: liveFastMaxChunkWords,
          max_sentences_per_chunk: liveFastMaxSentences,
        },
      });
    }
    writeVoiceProfileBrowserDebug('live auto-selected references', createVoiceProfileBrowserDebugSummary({
      context: 'live auto-select',
      voiceProfileId: selectedProfile?.key || '',
      displayName: selectedProfile?.displayName || '',
      selectedExpName,
      refAudioPath: selection.primary.path,
      promptText: selection.primary.transcript || '',
      promptLang: nextPromptLang,
      textLang: liveLanguage,
      auxRefAudioPaths: selection.aux.map((item) => item.path),
      defaults: {
        top_k: topK,
        top_p: topP,
        temperature,
        repetition_penalty: repPenalty,
        speed_factor: speed,
        output_gain_db: liveFastOutputGainDb,
        max_chunk_words: liveFastMaxChunkWords,
        max_sentences_per_chunk: liveFastMaxSentences,
      },
    }));
    setReferenceMessage(
      selection.ready
        ? `${selection.primary.filename} selected with ${selection.aux.length} auxiliary clip${selection.aux.length === 1 ? '' : 's'}.`
        : `${selection.primary.filename} selected with ${selection.aux.length} auxiliary clip${selection.aux.length === 1 ? '' : 's'} (clip scores not ready yet — not saved).`,
    );
    return selection;
  }

  function applyBestLiveFullReference(files = trainingAudioFiles) {
    const selection = chooseBestReferenceSet(files);
    if (!selection.primary) {
      setLiveFullRefAudioPath('');
      setLiveFullPromptText('');
      setLiveFullPromptLang('en');
      setLiveFullAuxRefAudios([]);
      setLiveFullMessage(selection.reason);
      return;
    }

    setLiveFullRefAudioPath(selection.primary.path);
    setLiveFullPromptText(selection.primary.transcript || '');
    setLiveFullPromptLang(normalizeReferenceLanguage(selection.primary.lang));
    setLiveFullAuxRefAudios(selection.aux);
    setLiveFullMessage(`${selection.primary.filename} selected for Live Full with ${selection.aux.length} auxiliary clip${selection.aux.length === 1 ? '' : 's'}.`);
  }

  function getConfigReferencePaths(config) {
    const reference = config?.referenceMetadata || {};
    const primaryPath = String(reference.selectedPaths?.primary || reference.primary?.path || '').trim();
    const auxPaths = Array.isArray(reference.selectedPaths?.aux)
      ? reference.selectedPaths.aux
      : Array.isArray(reference.aux)
        ? reference.aux.map((item) => item?.path).filter(Boolean)
        : [];
    return {
      primaryPath,
      auxPaths: auxPaths
        .map((path) => String(path || '').trim())
        .filter(Boolean)
        .filter((path) => path !== primaryPath)
        .slice(0, 5),
    };
  }

  function buildLiveFullRefParamsFromLiveFastRankOne(config = voiceConfigsRef.current[0], settings = liveFullSettings) {
    const reference = config?.referenceMetadata || {};
    const { primaryPath, auxPaths } = getConfigReferencePaths(config);
    if (!primaryPath) return null;

    const primaryFile = resolveReferenceFile(primaryPath, reference.primary) || {};
    const prompt = referencePromptText(reference.primary, primaryFile).trim();
    if (!prompt) return null;

    return buildLiveFullRefParams({
      primaryPath,
      promptText: prompt,
      promptLang: referencePromptLang(reference.primary, primaryFile),
      auxRefAudios: auxPaths.map((path) => resolveReferenceFile(path) || { path }),
      settings,
    });
  }

  function syncLoadedModelReferenceSelection(result = {}) {
    const selection = extractModelSelectWarmedReferenceSelection(result);
    if (!selection) {
      return null;
    }

    const primaryPath = selection.refAudioPath;
    const primaryFile = trainingAudioFiles.find((file) => file.path === primaryPath) || null;
    const selectedActiveProfile = selectedVoiceProfileId
      && activeVoiceProfile?.voiceProfileId === selectedVoiceProfileId
      ? activeVoiceProfile
      : null;
    const auxMatches = selection.auxRefAudioPaths.map((path) => (
      trainingAudioFiles.find((file) => file.path === path) || {
        filename: fallbackName(path),
        path,
        transcript: '',
        lang: '',
      }
    ));
    const resolvedPrompt = resolveWarmedReferencePrompt(
      selection,
      primaryFile,
      selectedActiveProfile,
    );

    pendingAutoSyncFingerprintRef.current = '';
    autoSyncRequestFingerprintRef.current = '';
    setRefAudioPath(primaryPath);
    setPromptText(resolvedPrompt.promptText);
    setPromptLang(normalizeReferenceLanguage(resolvedPrompt.promptLang));
    setAuxRefAudios(auxMatches);
    setPreviewReference({ path: '', url: null, filename: '', role: '' });

    if (selectedActiveProfile) {
      setActiveVoiceProfile((current) => (
        current ? {
          ...current,
          ref_audio_path: primaryPath,
          prompt_text: resolvedPrompt.promptText,
          prompt_lang: normalizeReferenceLanguage(resolvedPrompt.promptLang),
          aux_ref_audio_paths: selection.auxRefAudioPaths,
        } : current
      ));
    }

    return {
      ...selection,
      primaryFilename: primaryFile?.filename || fallbackName(primaryPath),
    };
  }

  async function loadSelectedModel(attempt = 0, requestVersion = null) {
    // Rank #1 is the source of truth for references. Never race model warming
    // against the config request, because that can fall back to stale profile refs.
    if (
      !selectedProfile
      || isConversationActive
      || loadedVoiceConfigsProfileId !== selectedVoiceProfileId
    ) return;
    const activeRequestVersion = requestVersion ?? (modelLoadVersionRef.current + 1);
    if (requestVersion == null) modelLoadVersionRef.current = activeRequestVersion;
    const selectionChanged = () => activeRequestVersion !== modelLoadVersionRef.current;
    setLoadingModel(true); setModelError('');
    try {
      const rankOneConfig = voiceConfigsRef.current[0] || null;
      const rankOneIsAutoManaged = isAutoManagedLiveFastConfig(rankOneConfig, selectedExpName);
      const rankOneReferences = getConfigReferencePaths(rankOneConfig);
      const response = await selectModels(selectedGPT, selectedSoVITS, buildModelSelectWarmPayload({
        voiceProfileId: selectedVoiceProfileId,
        refAudioPath: rankOneIsAutoManaged ? '' : rankOneReferences.primaryPath,
        auxRefAudioPaths: rankOneIsAutoManaged ? [] : rankOneReferences.auxPaths,
        refreshAutoReferences: rankOneIsAutoManaged,
        // Choosing a voice in TTS/Faculty prepares it on a GPU, exactly like
        // opening a lecture, so the first Generate does not pay a cold start.
      }));
      if (selectionChanged()) {
        return;
      }
      const coordinatorCapacity = response.data?.coordinatorCapacity;
      const selectionOnly = response.data?.selectionOnly === true;
      setModelSelectionOnly(selectionOnly);
      if (coordinatorCapacity && !coordinatorCapacity.canStartConversation) {
        setGpuNotice({
          tone: coordinatorCapacity.simulated ? 'info' : 'warning',
          title: coordinatorCapacity.simulated ? 'Dev capacity simulation' : 'Preparing voice capacity',
          message: coordinatorCapacity.message || voiceCapacityNotice(coordinatorCapacity),
        });
        window.setTimeout(() => loadSelectedModel(attempt, activeRequestVersion), 15_000);
        return;
      }
      const coordinatorState = String(coordinatorCapacity?.state || '').toUpperCase();
      if (coordinatorCapacity?.simulated || ['SIMULATED', 'ON_DEMAND'].includes(coordinatorState)) {
        setGpuNotice({
          tone: 'info',
          title: coordinatorCapacity?.simulated ? 'Dev capacity simulation' : 'Voice loads on demand',
          message: coordinatorCapacity.message || voiceCapacityNotice(coordinatorCapacity),
        });
      } else if (coordinatorCapacity?.capacityTight || /^BUSY_/u.test(coordinatorState)) {
        setGpuNotice({
          tone: 'info',
          title: coordinatorCapacity.simulated ? 'Dev capacity simulation' : 'Voice is heavily loaded',
          message: coordinatorCapacity.message
            || 'This voice is available, but your request may queue while additional capacity is prepared.',
        });
      }
      const latestRankOneConfig = voiceConfigsRef.current[0] || rankOneConfig;
      const latestRankOneIsAutoManaged = isAutoManagedLiveFastConfig(latestRankOneConfig, selectedExpName);
      const syncedSelection = latestRankOneConfig && !latestRankOneIsAutoManaged
        ? null
        : syncLoadedModelReferenceSelection(response.data || {});
      if (latestRankOneConfig && !latestRankOneIsAutoManaged) {
        applyVoiceConfig(latestRankOneConfig, { silent: true });
        await syncRankOneConfigToVoiceProfile(latestRankOneConfig, { context: 'model-load rank #1 config' });
        if (selectionChanged()) {
          return;
        }
      }
      statusRequestVersionRef.current += 1;
      applyInferenceStatusState({
        serverReady: true,
        loadedGPTPath: selectedGPT,
        loadedSoVITSPath: selectedSoVITS,
      });
      setReferenceMessage(
        selectionOnly
          ? 'Voice selected. GPU capacity will be prepared by the first synthesis request.'
          : latestRankOneConfig && !latestRankOneIsAutoManaged
          ? `Loaded rank #1 config ${latestRankOneConfig.configName || latestRankOneConfig.configId} after model load.`
          : ['SIMULATED', 'ON_DEMAND'].includes(coordinatorState)
          ? 'Voice pinned. It will load on the first synthesis request if no idle GPU is available.'
          : syncedSelection
          ? `${syncedSelection.primaryFilename} loaded with ${syncedSelection.auxRefAudioPaths.length} auxiliary clip${syncedSelection.auxRefAudioPaths.length === 1 ? '' : 's'}.`
          : 'Voice model loaded.',
      );
    } catch (err) {
      if (selectionChanged()) return;
      // Model loading can 404/503 for a while (Python inference server still
      // spawning / binding the weights). Retry patiently before surfacing anything,
      // and never show the raw gateway HTML.
      if (isTransientBackendError(err) && attempt < 8) {
        window.setTimeout(() => loadSelectedModel(attempt + 1, activeRequestVersion), 3000);
        return;
      }
      // Give up quietly on a transient failure but clear the attempt guard so the
      // auto-load effect can try again once the inference server settles.
      if (isTransientBackendError(err)) {
        autoLoadAttemptKeyRef.current = '';
      } else {
        setModelError(sanitizeBackendError(err.response?.data?.error || err.message || 'Could not load this voice model.'));
      }
      setLoadingModel(false);
      return;
    }
    setLoadingModel(false);
  }

  // Refuse to persist references that belong to another voice's dataset (BUGS.md
  // 2026-10-26: a new voice was saved with the previous voice's clips).
  function assertReferencesBelongToSelectedVoice(primaryPath, auxPaths = []) {
    const foreign = findForeignReferencePaths([primaryPath, ...auxPaths], selectedExpName);
    if (foreign.length > 0) {
      throw new Error(`Reference clips belong to another voice (${fallbackName(foreign[0])}); reselect references for ${selectedProfile?.displayName || selectedExpName}.`);
    }
  }

  async function persistSelectedVoiceProfile() {
    if (!selectedProfile || !selectedGPT || !selectedSoVITS || !refAudioPath) {
      throw new Error('Voice profile is not ready to save yet.');
    }
    assertReferencesBelongToSelectedVoice(refAudioPath, auxRefAudios.map((item) => item.path));

    const storageMode = await getStorageMode();
    const payload = buildVoiceProfilePayload({
      displayName: selectedProfile.displayName,
      selectedGPT,
      selectedSoVITS,
      refAudioPath,
      promptText,
      promptLang,
      textLang: liveLanguage,
      preferredRoute: 'sentence',
      auxRefAudioPaths: auxRefAudios.map((item) => item.path),
      defaults: {
        top_k: topK,
        top_p: topP,
        temperature,
        repetition_penalty: repPenalty,
        speed_factor: speed,
        output_gain_db: liveFastOutputGainDb,
        max_chunk_words: liveFastMaxChunkWords,
        max_sentences_per_chunk: liveFastMaxSentences,
      },
      trainingMetadata: selectedVoiceTrainingMetadata() || undefined,
      referenceMetadata: currentReferenceMetadata,
      liveFastMetadata: currentLiveFastMetadata,
      storageMode,
    });

    const response = await activateVoiceProfile(payload);
    const summary = response.data || {};
    setActiveVoiceProfile(summary.voiceProfileId ? {
      ...payload,
      ...summary,
      voiceProfileId: summary.voiceProfileId || payload.voiceProfileId,
      displayName: summary.displayName || payload.displayName,
    } : null);
    setActiveVoiceProfileError('');
    setLoadingActiveVoiceProfile(false);
    return { summary, payload };
  }

  // Auto-sync of live Live Fast edits. When a rank #1 saved config exists it is the
  // source of truth that reloads (model load) apply, so we must update the saved config
  // itself from the current UI state - not just activate the voice profile. Otherwise the
  // edit lands on the voice profile but the stale config overwrites it on the next refresh.
  async function persistLiveFastAutoSync() {
    const rankOneConfig = voiceConfigsRef.current[0] || null;
    if (!rankOneConfig?.configId || !selectedVoiceProfileId) {
      // No saved config yet: just activate the voice profile here. Config #1 itself
      // is auto-created separately (the default-config effect), which then syncs
      // rank #1 to the profile and takes over as the source of truth.
      const { summary, payload } = await persistSelectedVoiceProfile();
      return { displayName: summary.displayName || payload.displayName, voiceProfileId: summary.voiceProfileId || payload.voiceProfileId };
    }

    assertReferencesBelongToSelectedVoice(refAudioPath, auxRefAudios.map((item) => item.path));
    const payload = {
      ...buildCurrentConfigPayload({
        configId: rankOneConfig.configId,
        configName: rankOneConfig.configName || currentLiveFastMetadata.configName,
      }),
      rank: rankOneConfig.rank || 1,
      sample: rankOneConfig.sample || {},
      referenceMetadata: {
        ...currentReferenceMetadata,
        ...(isAutoManagedLiveFastConfig(rankOneConfig, selectedExpName) ? { mode: 'auto' } : {}),
      },
    };
    const res = await saveVoiceProfileConfig(selectedVoiceProfileId, rankOneConfig.configId, payload);
    const saved = res.data.config;
    setVoiceConfigs((current) => {
      const without = current.filter((item) => item.configId !== saved.configId);
      const next = [...without, saved].sort((a, b) => Number(a.rank || 0) - Number(b.rank || 0));
      voiceConfigsRef.current = next;
      return next;
    });
    await syncRankOneConfigToVoiceProfile(saved, { required: true, context: 'auto-synced rank #1 config' });
    return { displayName: selectedProfile?.displayName || '', voiceProfileId: selectedVoiceProfileId };
  }

  async function saveSelectedVoiceProfile() {
    if (!selectedProfile || !selectedGPT || !selectedSoVITS || !liveRefParams) return;

    setSavingProfile(true);
    setModelError('');

    try {
      const { summary, payload } = await persistSelectedVoiceProfile();
      lastAutoSyncedFingerprintRef.current = currentAutoSyncFingerprint;
      pendingAutoSyncFingerprintRef.current = '';
      setReferenceMessage(
        `Saved voice profile ${summary.displayName || selectedProfile.displayName} (${summary.voiceProfileId || payload.voiceProfileId}).`,
      );
    } catch (err) {
      setModelError(err.response?.data?.error || err.message || 'Could not save this voice profile.');
    } finally {
      setSavingProfile(false);
    }
  }

  async function saveCurrentVoiceConfig(existingConfig = null, { applySaved = true, referenceMode = '' } = {}) {
    if (!selectedVoiceProfileId || !refAudioPath) return;
    const configId = existingConfig?.configId || buildConfigId(selectedProfile?.displayName || selectedVoiceProfileId);
    setSavingConfigId(configId);
    setModelError('');
    setVoiceConfigError('');
    try {
      assertReferencesBelongToSelectedVoice(refAudioPath, auxRefAudios.map((item) => item.path));
      const payload = {
        ...buildCurrentConfigPayload({
          configId,
          configName: existingConfig?.configName || currentLiveFastMetadata.configName,
        }),
        rank: existingConfig?.rank || voiceConfigs.length + 1,
        sample: existingConfig?.sample || {},
        ...(referenceMode ? {
          referenceMetadata: { ...currentReferenceMetadata, mode: referenceMode },
        } : {}),
      };
      const res = await saveVoiceProfileConfig(selectedVoiceProfileId, configId, payload);
      const saved = res.data.config;
      console.info('[voice-configs] saved config', {
        voiceProfileId: selectedVoiceProfileId,
        configId: saved.configId,
        primaryReference: saved.referenceMetadata?.selectedPaths?.primary || saved.referenceMetadata?.primary?.path || '',
        auxReferences: saved.referenceMetadata?.selectedPaths?.aux || [],
        config: saved,
        hasTrainingMetadata: Boolean(saved.trainingMetadata && Object.keys(saved.trainingMetadata).length > 0),
      });
      setVoiceConfigs((current) => {
        const without = current.filter((item) => item.configId !== saved.configId);
        const next = [...without, saved].sort((a, b) => Number(a.rank || 0) - Number(b.rank || 0));
        voiceConfigsRef.current = next;
        return next;
      });
      if (Number(saved.rank || 0) === 1) {
        if (applySaved) {
          applyVoiceConfig(saved, { silent: true });
        }
        await syncRankOneConfigToVoiceProfile(saved, { required: true, context: 'saved rank #1 config' });
      } else if (existingConfig?.configId === loadedConfigId) {
        applyConfigAsActiveLiveFastProfile(saved);
        if (applySaved) {
          applyVoiceConfig(saved, { silent: true });
        }
      } else if (applySaved && !existingConfig) {
        applyVoiceConfig(saved, { silent: true });
      }
      setReferenceMessage(`${existingConfig ? 'Updated' : 'Saved'} config ${saved.configName || saved.configId}.`);
      setLoadedConfigId(saved.configId);
    } catch (err) {
      const message = err.response?.data?.error || err.message || 'Could not save config.';
      setModelError(message);
      setVoiceConfigError(message);
    } finally {
      setSavingConfigId('');
    }
  }

  function applyLiveFullReferenceDefaultsFromConfig(config) {
    const reference = config?.referenceMetadata || {};
    const primaryPath = String(reference.selectedPaths?.primary || reference.primary?.path || '').trim();
    const auxPaths = Array.isArray(reference.selectedPaths?.aux)
      ? reference.selectedPaths.aux
      : Array.isArray(reference.aux)
        ? reference.aux.map((item) => item?.path).filter(Boolean)
        : [];
    if (!primaryPath) return;

    const primaryFile = resolveReferenceFile(primaryPath, reference.primary) || {};
    setLiveFullRefAudioPath(primaryPath);
    setLiveFullPromptText(referencePromptText(reference.primary, primaryFile));
    setLiveFullPromptLang(referencePromptLang(reference.primary, primaryFile));
    setLiveFullAuxRefAudios(auxPaths.slice(0, 5).map((path) => (
      trainingAudioFiles.find((file) => file.path === path) || {
        filename: fallbackName(path),
        path,
        transcript: '',
        lang: '',
      }
    )));
  }

  function applyLiveFullConfig(config, { silent = false } = {}) {
    const defaults = config?.inferenceMetadata?.defaults || {};
    setLiveFullSpeed(Number.isFinite(defaults.speed_factor) ? defaults.speed_factor : DEFAULT_LIVE_FULL_SETTINGS.speed);
    setLiveFullTopK(Number.isFinite(defaults.top_k) ? defaults.top_k : DEFAULT_LIVE_FULL_SETTINGS.topK);
    setLiveFullTopP(Number.isFinite(defaults.top_p) ? defaults.top_p : DEFAULT_LIVE_FULL_SETTINGS.topP);
    setLiveFullTemperature(Number.isFinite(defaults.temperature) ? defaults.temperature : DEFAULT_LIVE_FULL_SETTINGS.temperature);
    setLiveFullRepPenalty(Number.isFinite(defaults.repetition_penalty) ? defaults.repetition_penalty : DEFAULT_LIVE_FULL_SETTINGS.repPenalty);
    setLiveFullOutputGainDb(Number.isFinite(defaults.output_gain_db) ? defaults.output_gain_db : DEFAULT_LIVE_FULL_SETTINGS.outputGainDb);
    setLiveFullMaxChunkWords(Number.isInteger(defaults.max_chunk_words) ? defaults.max_chunk_words : DEFAULT_LIVE_FULL_SETTINGS.maxChunkWords);
    setLiveFullMaxSentences(Number.isInteger(defaults.max_sentences_per_chunk) ? defaults.max_sentences_per_chunk : DEFAULT_LIVE_FULL_SETTINGS.maxSentencesPerChunk);
    setLoadedLiveFullConfigId(config?.configId || '');
    if (!silent) {
      setLiveFullMessage(`Loaded Live Full config ${config.configName || config.configId}.`);
    }
  }

  function buildCurrentLiveFullConfigPayload({ configId = '', configName = '' } = {}) {
    const rankOneConfig = voiceConfigsRef.current[0] || liveFastRankOneReferenceSummary.config;
    const resolvedConfigName = configName || (selectedProfile?.displayName
      ? `${selectedProfile.displayName} full`
      : 'Live Full default');
    return buildLiveFullConfigPayload({
      configId,
      configName: resolvedConfigName,
      rank: liveFullConfigs.length + 1,
      language: liveLanguage,
      settings: liveFullSettings,
      trainingMetadata: selectedVoiceTrainingMetadata() || {},
      referenceMetadata: {
        source: 'liveFastRankOne',
        liveFastConfigId: rankOneConfig?.configId || '',
      },
    });
  }

  async function saveCurrentLiveFullConfig(existingConfig = null, { applySaved = true } = {}) {
    if (!selectedVoiceProfileId) {
      setLiveFullMessage('Load a voice profile before saving Live Full metadata.');
      return;
    }
    if (!voiceConfigsRef.current[0]) {
      setLiveFullMessage('Create Live Fast rank #1 before saving Live Full metadata.');
      return;
    }
    const configId = existingConfig?.configId || buildConfigId(`${selectedProfile?.displayName || selectedVoiceProfileId}-full`);
    setSavingLiveFullConfigId(configId);
    try {
      const payload = {
        ...buildCurrentLiveFullConfigPayload({
          configId,
          configName: existingConfig?.configName || '',
        }),
        rank: existingConfig?.rank || liveFullConfigs.length + 1,
      };
      const res = await saveVoiceProfileConfig(selectedVoiceProfileId, configId, payload);
      const saved = res.data.config;
      setLiveFullConfigs((current) => {
        const without = current.filter((item) => item.configId !== saved.configId);
        return [...without, saved].sort((a, b) => Number(a.rank || 0) - Number(b.rank || 0));
      });
      if (applySaved) {
        applyLiveFullConfig(saved, { silent: true });
      }
      setLoadedLiveFullConfigId(saved.configId);
      setLiveFullMessage(`${existingConfig ? 'Updated' : 'Saved'} Live Full config ${saved.configName || saved.configId}.`);
    } catch (err) {
      setLiveFullMessage(err.response?.data?.error || err.message || 'Could not save Live Full config.');
    } finally {
      setSavingLiveFullConfigId('');
    }
  }

  async function loadSavedLiveFullConfig(config) {
    if (!config?.configId) return;
    setSavingLiveFullConfigId(config.configId);
    try {
      applyLiveFullConfig(config);
    } finally {
      setSavingLiveFullConfigId('');
    }
  }

  async function deleteSavedLiveFullConfig(configId) {
    if (!selectedVoiceProfileId || !configId) return;
    setSavingLiveFullConfigId(configId);
    try {
      await deleteVoiceProfileConfig(selectedVoiceProfileId, configId);
      setLiveFullConfigs((current) => current.filter((item) => item.configId !== configId));
      if (loadedLiveFullConfigId === configId) setLoadedLiveFullConfigId('');
      setLiveFullMessage(`Deleted Live Full config ${configId}.`);
    } catch (err) {
      setLiveFullMessage(err.response?.data?.error || err.message || 'Could not delete Live Full config.');
    } finally {
      setSavingLiveFullConfigId('');
    }
  }

  async function moveLiveFullConfig(configId, direction) {
    if (!selectedVoiceProfileId || !configId || savingLiveFullConfigId) return;
    const currentIndex = liveFullConfigs.findIndex((item) => item.configId === configId);
    const targetIndex = currentIndex + direction;
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= liveFullConfigs.length) return;

    const reordered = [...liveFullConfigs];
    const [moved] = reordered.splice(currentIndex, 1);
    reordered.splice(targetIndex, 0, moved);
    const reranked = reordered.map((config, index) => ({ ...config, rank: index + 1 }));

    setSavingLiveFullConfigId(configId);
    try {
      const savedConfigs = [];
      for (const config of reranked) {
        const res = await saveVoiceProfileConfig(selectedVoiceProfileId, config.configId, config);
        savedConfigs.push(res.data.config);
      }
      setLiveFullConfigs(savedConfigs.sort((a, b) => Number(a.rank || 0) - Number(b.rank || 0)));
      setLiveFullMessage(`Moved ${moved.configName || moved.configId} to #${targetIndex + 1}.`);
    } catch (err) {
      setLiveFullMessage(err.response?.data?.error || err.message || 'Could not reorder Live Full configs.');
    } finally {
      setSavingLiveFullConfigId('');
    }
  }

  async function generateLiveFullConfigSample(config) {
    if (!config?.configId || !selectedVoiceProfileId || streamingRoute !== null) return;
    const inference = config.inferenceMetadata || {};
    const defaults = inference.defaults || {};
    const sampleText = 'This is a short full inference voice configuration sample.';
    const params = buildLiveFullRefParamsFromLiveFastRankOne(voiceConfigsRef.current[0], {
      speed: defaults.speed_factor ?? DEFAULT_LIVE_FULL_SETTINGS.speed,
      topK: defaults.top_k ?? DEFAULT_LIVE_FULL_SETTINGS.topK,
      topP: defaults.top_p ?? DEFAULT_LIVE_FULL_SETTINGS.topP,
      temperature: defaults.temperature ?? DEFAULT_LIVE_FULL_SETTINGS.temperature,
      repPenalty: defaults.repetition_penalty ?? DEFAULT_LIVE_FULL_SETTINGS.repPenalty,
      outputGainDb: defaults.output_gain_db ?? DEFAULT_LIVE_FULL_SETTINGS.outputGainDb,
      maxChunkWords: defaults.max_chunk_words ?? DEFAULT_LIVE_FULL_SETTINGS.maxChunkWords,
      maxSentencesPerChunk: defaults.max_sentences_per_chunk ?? DEFAULT_LIVE_FULL_SETTINGS.maxSentencesPerChunk,
    });
    if (!params) {
      setLiveFullMessage('Live Full sample needs Live Fast rank #1 with a primary reference transcript.');
      return;
    }

    setGeneratingLiveFullSampleConfigId(config.configId);
    setStreamingRoute('full');
    setTtsError('');
    try {
      applyLiveFullConfig(config, { silent: true });
      const res = await startGeneration({
        text: sampleText,
        voiceProfileId: selectedVoiceProfileId,
        text_lang: inference.language || liveLanguage,
        ...params,
      });
      const { sessionId } = res.data;
      pendingFullTtsRef.current = {
        sessionId,
        text: sampleText,
        voiceName: selectedProfile?.displayName || loadedProfile?.displayName || '',
        languageLabel: liveLanguageConfig.label,
        route: 'full',
      };
      ttsInference.connect(sessionId, { initialStatus: 'waiting' });

      const sample = {
        text: sampleText,
        route: 'full',
        generatedAt: new Date().toISOString(),
        sessionId,
      };
      await saveVoiceProfileConfig(selectedVoiceProfileId, config.configId, { ...config, sample });
      setLiveFullConfigs((current) => current.map((item) => (
        item.configId === config.configId ? { ...item, sample } : item
      )));
      setLiveFullMessage(`Generating sample for ${config.configName || config.configId}.`);
    } catch (err) {
      pendingFullTtsRef.current = null;
      setStreamingRoute(null);
      setLiveFullMessage(err.response?.data?.error || err.message || 'Could not generate Live Full sample.');
    } finally {
      setGeneratingLiveFullSampleConfigId('');
    }
  }

  async function loadSavedVoiceConfig(config) {
    if (!config?.configId) return;
    setSavingConfigId(config.configId);
    setModelError('');
    setVoiceConfigError('');
    try {
      applyVoiceConfig(config);
      // Load is session/pipeline-only. Rank #1 persistence happens when a config
      // is saved, updated, reordered, or selected during model load; previewing a
      // config must not rewrite the persistent voice profile.
      applyConfigAsActiveLiveFastProfile(config);
      setReferenceMessage(`Loaded config ${config.configName || config.configId} into inference.`);
      console.info('[voice-configs] loaded config into inference', {
        voiceProfileId: selectedVoiceProfileId,
        configId: config.configId,
        primaryReference: config.referenceMetadata?.selectedPaths?.primary || config.referenceMetadata?.primary?.path || '',
        auxReferences: config.referenceMetadata?.selectedPaths?.aux || [],
      });
    } catch (err) {
      const message = err.response?.data?.error || err.message || 'Could not load config into inference.';
      setModelError(message);
      setVoiceConfigError(message);
    } finally {
      setSavingConfigId('');
    }
  }

  async function deleteSavedVoiceConfig(configId) {
    if (!selectedVoiceProfileId || !configId) return;
    setSavingConfigId(configId);
    setVoiceConfigError('');
    try {
      await deleteVoiceProfileConfig(selectedVoiceProfileId, configId);
      console.info('[voice-configs] deleted config', { voiceProfileId: selectedVoiceProfileId, configId });
      let nextConfigs = [];
      setVoiceConfigs((current) => {
        const next = current.filter((item) => item.configId !== configId);
        voiceConfigsRef.current = next;
        nextConfigs = next;
        return next;
      });
      if (nextConfigs[0]) {
        applyVoiceConfig(nextConfigs[0], { silent: true });
        await syncRankOneConfigToVoiceProfile(nextConfigs[0], { required: true, context: 'new rank #1 config after delete' });
      } else if (loadedConfigId === configId) {
        setLoadedConfigId('');
      }
      setConfigSampleUrls((current) => {
        if (current[configId]) URL.revokeObjectURL(current[configId]);
        const next = { ...current };
        delete next[configId];
        configSampleUrlsRef.current = next;
        return next;
      });
      setReferenceMessage(`Deleted config ${configId}.`);
    } catch (err) {
      const message = err.response?.data?.error || err.message || 'Could not delete config.';
      setModelError(message);
      setVoiceConfigError(message);
    } finally {
      setSavingConfigId('');
    }
  }

  async function moveVoiceConfig(configId, direction) {
    if (!selectedVoiceProfileId || !configId || savingConfigId) return;
    const currentIndex = voiceConfigs.findIndex((item) => item.configId === configId);
    const targetIndex = currentIndex + direction;
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= voiceConfigs.length) return;
    const reordered = [...voiceConfigs];
    const [moved] = reordered.splice(currentIndex, 1);
    reordered.splice(targetIndex, 0, moved);
    const reranked = reordered.map((config, index) => ({ ...config, rank: index + 1 }));
    setSavingConfigId(configId);
    setVoiceConfigError('');
    try {
      const savedConfigs = [];
      for (const config of reranked) {
        const res = await saveVoiceProfileConfig(selectedVoiceProfileId, config.configId, config);
        savedConfigs.push(res.data.config);
      }
      const sorted = savedConfigs.sort((a, b) => Number(a.rank || 0) - Number(b.rank || 0));
      voiceConfigsRef.current = sorted;
      setVoiceConfigs(sorted);
      if (sorted[0]) {
        applyVoiceConfig(sorted[0], { silent: true });
        await syncRankOneConfigToVoiceProfile(sorted[0], { required: true, context: 'new rank #1 config after reorder' });
      }
      console.info('[voice-configs] reordered configs', {
        voiceProfileId: selectedVoiceProfileId,
        order: sorted.map((config) => ({ configId: config.configId, rank: config.rank })),
      });
      setReferenceMessage(`Moved ${moved.configName || moved.configId} to #${targetIndex + 1}.`);
    } catch (err) {
      const message = err.response?.data?.error || err.message || 'Could not reorder configs.';
      setModelError(message);
      setVoiceConfigError(message);
    } finally {
      setSavingConfigId('');
    }
  }

  async function persistConfigOrder(nextOrder, { movedConfigId = '' } = {}) {
    if (!selectedVoiceProfileId || nextOrder.length === 0) return;
    const reranked = nextOrder.map((config, index) => ({ ...config, rank: index + 1 }));
    setSavingConfigId(movedConfigId || reranked[0]?.configId || '');
    setVoiceConfigError('');
    try {
      const savedConfigs = [];
      for (const config of reranked) {
        const res = await saveVoiceProfileConfig(selectedVoiceProfileId, config.configId, config);
        savedConfigs.push(res.data.config);
      }
      const sorted = savedConfigs.sort((a, b) => Number(a.rank || 0) - Number(b.rank || 0));
      voiceConfigsRef.current = sorted;
      setVoiceConfigs(sorted);
      if (sorted[0]) {
        applyVoiceConfig(sorted[0], { silent: true });
        await syncRankOneConfigToVoiceProfile(sorted[0], { required: true, context: 'new rank #1 config after reorder' });
      }
      console.info('[voice-configs] reordered configs', {
        voiceProfileId: selectedVoiceProfileId,
        order: sorted.map((config) => ({ configId: config.configId, rank: config.rank, configName: config.configName })),
      });
    } catch (err) {
      const message = err.response?.data?.error || err.message || 'Could not reorder configs.';
      setModelError(message);
      setVoiceConfigError(message);
    } finally {
      setSavingConfigId('');
      setDraggingConfigId('');
      reorderingConfigRef.current = false;
    }
  }

  function handleConfigDrop(targetConfigId) {
    if (!draggingConfigId || draggingConfigId === targetConfigId) {
      setDraggingConfigId('');
      return;
    }
    const fromIndex = voiceConfigs.findIndex((item) => item.configId === draggingConfigId);
    const toIndex = voiceConfigs.findIndex((item) => item.configId === targetConfigId);
    if (fromIndex < 0 || toIndex < 0) {
      setDraggingConfigId('');
      return;
    }
    const reordered = [...voiceConfigs];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);
    const reranked = reordered.map((config, index) => ({ ...config, rank: index + 1 }));
    reorderingConfigRef.current = true;
    voiceConfigsRef.current = reranked;
    setVoiceConfigs(reranked);
    if (reranked[0]) {
      applyVoiceConfig(reranked[0], { silent: true });
    }
    persistConfigOrder(reranked, { movedConfigId: moved.configId });
  }

  async function renameVoiceConfig(config, nextName) {
    const configName = String(nextName || '').trim() || config.configId;
    if (!selectedVoiceProfileId || !config?.configId || configName === config.configName) return;
    setSavingConfigId(config.configId);
    setVoiceConfigError('');
    try {
      const res = await saveVoiceProfileConfig(selectedVoiceProfileId, config.configId, {
        ...config,
        configName,
      });
      const saved = res.data.config;
      setVoiceConfigs((current) => {
        const next = current.map((item) => (
          item.configId === saved.configId ? saved : item
        ));
        voiceConfigsRef.current = next;
        return next;
      });
      if (Number(saved.rank || 0) === 1) {
        await syncRankOneConfigToVoiceProfile(saved, { required: true, context: 'renamed rank #1 config' });
      }
      console.info('[voice-configs] renamed config', {
        voiceProfileId: selectedVoiceProfileId,
        configId: saved.configId,
        configName: saved.configName,
      });
    } catch (err) {
      const message = err.response?.data?.error || err.message || 'Could not rename config.';
      setModelError(message);
      setVoiceConfigError(message);
    } finally {
      setSavingConfigId('');
    }
  }

  async function generateConfigSample(config) {
    if (!config?.configId) return;
    const reference = config.referenceMetadata || {};
    const inference = config.inferenceMetadata || {};
    const defaults = inference.defaults || {};
    const primaryPath = reference.selectedPaths?.primary || reference.primary?.path || refAudioPath;
    const primaryFile = resolveReferenceFile(primaryPath, reference.primary) || {};
    const auxPaths = Array.isArray(reference.selectedPaths?.aux) ? reference.selectedPaths.aux : [];
    const prompt = referencePromptText(reference.primary, primaryFile, promptText).trim();
    const params = {
      text: 'This is a short saved voice configuration sample.',
      text_lang: inference.language || liveLanguage,
      // Sampling a config must audition the voice that config belongs to, not
      // whichever voice the shared GPU is holding for someone else right now.
      ...(pinnedVoiceModel ? { voice_model: pinnedVoiceModel } : {}),
      ref_audio_path: primaryPath,
      prompt_text: prompt,
      prompt_lang: referencePromptLang(reference.primary, primaryFile, promptLang),
      aux_ref_audio_paths: auxPaths,
        speed_factor: defaults.speed_factor ?? speed,
        output_gain_db: defaults.output_gain_db ?? DEFAULT_LIVE_FAST_SETTINGS.outputGainDb,
      top_k: defaults.top_k ?? topK,
      top_p: defaults.top_p ?? topP,
      temperature: defaults.temperature ?? temperature,
      repetition_penalty: defaults.repetition_penalty ?? repPenalty,
    };
    if (!params.ref_audio_path) {
      setModelError('Config has no primary reference audio.');
      return;
    }
    if (!params.prompt_text) {
      const message = 'Config sample needs a primary reference transcript. Load the config, enter the primary transcript, update the config, then sample again.';
      setModelError(message);
      setVoiceConfigError(message);
      return;
    }
    setGeneratingSampleConfigId(config.configId);
    setModelError('');
    setVoiceConfigError('');
    try {
      const result = await synthesizeSentence(params);
      const url = URL.createObjectURL(result.blob);
      setConfigSampleUrls((current) => {
        if (current[config.configId]) URL.revokeObjectURL(current[config.configId]);
        const next = { ...current, [config.configId]: url };
        configSampleUrlsRef.current = next;
        return next;
      });
      const sample = {
        text: params.text,
        generatedAt: new Date().toISOString(),
        localOnly: true,
      };
      const saved = {
        ...config,
        sample,
      };
      await saveVoiceProfileConfig(selectedVoiceProfileId, config.configId, saved);
      console.info('[voice-configs] generated sample', {
        voiceProfileId: selectedVoiceProfileId,
        configId: config.configId,
        params,
        sample,
      });
      setVoiceConfigs((current) => current.map((item) => (
        item.configId === config.configId ? { ...item, sample } : item
      )));
      setReferenceMessage(`Generated sample for ${config.configName || config.configId}.`);
    } catch (err) {
      const message = err.response?.data?.error || err.message || 'Could not generate config sample.';
      setModelError(message);
      setVoiceConfigError(message);
    } finally {
      setGeneratingSampleConfigId('');
    }
  }

  async function generateTextToSpeech(route) {
    const text = ttsText.trim();
    if (!text) {
      setTtsError('Enter text to generate audio.');
      return;
    }
    if (!selectedVoiceProfileId || !isReady) {
      setTtsError('Load a voice profile and config before generating audio.');
      return;
    }

    // Carrying the weight pair on the request is what makes this instance-agnostic:
    // the worker loads exactly this voice for exactly this call, so a concurrent
    // session on another site cannot synthesise in the wrong voice or evict ours.
    // It also skips the saved-profile lookup in lambda/shared/voiceProfileRuntime.js,
    // which 404s for a trained voice that was never saved as a profile.
    const baseParams = {
      text,
      voiceProfileId: selectedVoiceProfileId,
      text_lang: liveLanguage,
      ...(pinnedVoiceModel ? { voice_model: pinnedVoiceModel } : {}),
    };
    const liveFastParams = {
      ...baseParams,
      ...(liveRefParams || {}),
      top_k: topK,
      top_p: topP,
      temperature,
      repetition_penalty: repPenalty,
      speed_factor: speed,
      output_gain_db: liveFastOutputGainDb,
    };
    const voiceName = speakingProfile?.displayName || '';
    const languageLabel = liveLanguageConfig.label;

    setTtsError('');
    setTtsWarning('');

    if (route === 'fastQueued') {
      setTtsFastGenerating(true);
      setTtsFastProgress({ total: 0, current: 0, text: '' });
      queuedTtsRef.current = { clips: [], playingIndex: -1, active: true, paused: false };
      setQueuePlayback({ active: true, paused: false });
      queueProducingRef.current = true;
      try {
        const result = await generateLiveFastQueuedTts({
          text,
          baseParams: liveFastParams,
          synthesizeSentence,
          splitText: (value) => shortenFirstFastPhrase(splitLiveReplyChunks(value, {
            maxChunkWords: liveFastSettings.maxChunkWords,
            maxSentencesPerChunk: liveFastSettings.maxSentencesPerChunk,
          })),
          createObjectUrl: (blob) => URL.createObjectURL(blob),
          onProgress: setTtsFastProgress,
          onClipReady: (clip) => {
            queuedTtsRef.current.clips[clip.index] = clip;
            playNextQueuedTtsClip();
          },
        });
        if (result.clips.length === 0) {
          throw new Error('No audio clips were generated.');
        }
        // Record the full passage to the Live Fast output panel so the queue lands
        // somewhere when it finishes (matching the non-queued Live Fast button).
        const blobs = result.clips.map((clip) => clip.blob).filter(Boolean);
        if (blobs.length > 0) {
          const blob = blobs.length > 1 ? await concatWavBlobs(blobs, { pauseMs: 120 }) : blobs[0];
          recordTtsHistory({ route: 'fast', url: URL.createObjectURL(blob), text, voiceName, languageLabel });
        }
      } catch (err) {
        setTtsError(friendlyTtsError(err, 'Could not generate queued Live Fast audio.'));
      } finally {
        queueProducingRef.current = false;
        // If playback already drained while we were still generating, clear the controls.
        const queue = queuedTtsRef.current;
        if (queue.active && !queue.paused && !queue.clips[queue.playingIndex + 1]) {
          const audio = queuedTtsAudioRef.current;
          if (!audio || audio.paused) {
            queue.active = false;
            setQueuePlayback({ active: false, paused: false });
          }
        }
        setTtsFastGenerating(false);
        setTtsFastProgress({ total: 0, current: 0, text: '' });
      }
      return;
    }

    if (route === 'fast') {
      setTtsFastGenerating(true);
      setTtsFastProgress({ total: 0, current: 0, text: '' });
      try {
        const phrases = splitLiveReplyChunks(text, {
          maxChunkWords: liveFastSettings.maxChunkWords,
          maxSentencesPerChunk: liveFastSettings.maxSentencesPerChunk,
        });
        const clips = [];
        setTtsFastProgress({ total: phrases.length, current: 0, text: phrases[0] || '' });
        for (let index = 0; index < phrases.length; index += 1) {
          const phrase = phrases[index];
          setTtsFastProgress({ total: phrases.length, current: index + 1, text: phrase });
          const result = await synthesizeSentence({ ...liveFastParams, text: phrase });
          clips.push(result.blob);
        }
        const blob = clips.length > 1 ? await concatWavBlobs(clips, { pauseMs: 120 }) : clips[0];
        recordTtsHistory({ route: 'fast', url: URL.createObjectURL(blob), text, voiceName, languageLabel });
      } catch (err) {
        setTtsError(friendlyTtsError(err, 'Could not generate text to speech audio.'));
      } finally {
        setTtsFastGenerating(false);
        setTtsFastProgress({ total: 0, current: 0, text: '' });
      }
      return;
    }

    // Full inference uses the chunked async flow. It avoids the
    // CloudFront ~30s origin timeout / 6MB response limit that a single synchronous
    // request hits. It returns a sessionId immediately, streams progress over SSE, and
    // fetches the finished audio via a presigned URL (bytes never traverse the Lambda).
    if (!liveFullRefParams) {
      // Reaching here now means there is no reference clip at all, not merely no
      // saved config — the fallback above covers the latter. Name the thing the
      // user can actually act on.
      setTtsError('Pick a reference clip for this voice before generating Full Inference audio.');
      return;
    }
    if (fullTtsSubmissionRef.current) {
      setTtsWarning('A Full Inference request is already active. Reusing it prevents duplicate GPU work.');
      return;
    }
    fullTtsSubmissionRef.current = true;
    // Maximum-quality Full preflight: automatically surface words that would fall
    // through to neural pronunciation guessing. Stop once so the user can add an
    // override; a deliberate second click acknowledges the warning and proceeds.
    setOovScanning(true);
    try {
      const scanResponse = await scanOovWords(text);
      const scanResult = scanResponse.data || {};
      const flagged = Array.isArray(scanResult.flagged) ? scanResult.flagged : [];
      const scanState = {
        flagged,
        totalWords: scanResult.totalWords ?? 0,
        coveredWords: scanResult.coveredWords ?? 0,
        dictionaryLoaded: scanResult.dictionaryLoaded !== false,
      };
      setOovScan(scanState);
      setOovScanError('');
      const warningKey = `${text}\n${flagged.join('|').toLowerCase()}`;
      if (scanState.dictionaryLoaded && flagged.length > 0 && fullOovAcknowledgedKey !== warningKey) {
        fullTtsSubmissionRef.current = false;
        setFullOovAcknowledgedKey(warningKey);
        setTtsWarning(
          `Review ${flagged.length} pronunciation ${flagged.length === 1 ? 'word' : 'words'} below before Full synthesis. `
          + 'Add overrides for maximum quality, or click the Full button again to continue intentionally.',
        );
        return;
      }
    } catch (err) {
      // The worker's strict ASR verification still protects Full output. A preflight
      // scan outage should not make the primary synthesis button unusable.
      setOovScanError(friendlyTtsError(err, 'Pronunciation preflight was unavailable.'));
    } finally {
      setOovScanning(false);
    }
    // Full Inference Queue: play each chunk as the server finishes it (progressive
    // playback), instead of waiting for the whole passage — same UX as Live Fast Queue.
    if (route === 'fullQueued') {
      queuedTtsRef.current = { clips: [], playingIndex: -1, active: true, paused: false };
      fullQueuedFetchRef.current = { sessionId: '', fetched: 0, busy: false };
      setQueuePlayback({ active: true, paused: false });
      queueProducingRef.current = true;
    }
    setStreamingRoute(route);
    try {
      const res = await startGeneration({ ...baseParams, ...liveFullRefParams });
      const { sessionId } = res.data;
      const pending = {
        sessionId,
        text,
        voiceName,
        languageLabel,
        route,
        savedAt: Date.now(),
      };
      pendingFullTtsRef.current = pending;
      savePendingFullTts(pending);
      ttsInference.connect(sessionId, { initialStatus: 'waiting' });
    } catch (err) {
      fullTtsSubmissionRef.current = false;
      pendingFullTtsRef.current = null;
      clearPendingFullTts();
      setTtsError(friendlyTtsError(err, 'Could not generate text to speech audio.'));
      setStreamingRoute(null);
      if (route === 'fullQueued') stopQueuedTtsPlayback();
    }
  }

  function playNextQueuedTtsClip() {
    const queue = queuedTtsRef.current;
    if (queue.paused) return;
    const nextIndex = queue.playingIndex + 1;
    const nextClip = queue.clips[nextIndex];
    const audio = queuedTtsAudioRef.current;
    if (!queue.active || !nextClip || !audio || !audio.paused) return;

    queue.playingIndex = nextIndex;
    audio.src = nextClip.url;
    audio.play().catch((err) => {
      setTtsError(err.message || 'Browser blocked queued playback.');
    });
  }

  function handleQueuedTtsEnded() {
    const queue = queuedTtsRef.current;
    const hasNext = Boolean(queue.clips[queue.playingIndex + 1]);
    // No more clips and nothing left to produce -> the queue is fully played out.
    if (!hasNext && !queueProducingRef.current && !queue.paused) {
      queue.active = false;
      setQueuePlayback({ active: false, paused: false });
      return;
    }
    playNextQueuedTtsClip();
  }

  function pauseQueuedTtsPlayback() {
    const queue = queuedTtsRef.current;
    queue.paused = true;
    const audio = queuedTtsAudioRef.current;
    if (audio && !audio.paused) audio.pause();
    setQueuePlayback({ active: true, paused: true });
  }

  function resumeQueuedTtsPlayback() {
    const queue = queuedTtsRef.current;
    queue.paused = false;
    setQueuePlayback({ active: true, paused: false });
    const audio = queuedTtsAudioRef.current;
    // Resume the current clip if it was paused mid-play; otherwise advance.
    if (audio && audio.src && audio.currentTime > 0 && audio.currentTime < (audio.duration || Infinity)) {
      audio.play().catch((err) => {
        setTtsError(err.message || 'Browser blocked queued playback.');
      });
    } else {
      playNextQueuedTtsClip();
    }
  }

  function stopQueuedTtsPlayback() {
    const queue = queuedTtsRef.current;
    queue.active = false;
    queue.paused = false;
    queueProducingRef.current = false;
    const audio = queuedTtsAudioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    setQueuePlayback({ active: false, paused: false });
  }

  function recordTtsHistory({ route, url, text, voiceName, languageLabel, sessionId = '', chunks = [] }) {
    const item = createTtsHistoryItem({ route, url, text, voiceName, languageLabel, sessionId, chunks });
    setTtsHistory((current) => {
      const next = addTtsHistoryItem(current, item);
      ttsHistoryRef.current = next;
      return next;
    });
  }

  async function completeFullTtsGeneration(sessionId) {
    const pending = pendingFullTtsRef.current;
    if (!pending || pending.sessionId !== sessionId) return;
    if (completingFullTtsSessionRef.current === sessionId) return;

    completingFullTtsSessionRef.current = sessionId;
    try {
      const source = await getGenerationResultSource(sessionId);
      const playableUrl = await waitForPlayableAudioSource(source.url);
      recordTtsHistory({
        route: pending.route,
        url: playableUrl,
        text: pending.text,
        voiceName: pending.voiceName,
        languageLabel: pending.languageLabel,
        sessionId,
        chunks: ttsInference.chunks,
      });
    } catch (err) {
      setTtsError(err.message || 'Could not fetch the generated audio.');
    } finally {
      if (pendingFullTtsRef.current?.sessionId === sessionId) {
        pendingFullTtsRef.current = null;
      }
      fullTtsSubmissionRef.current = false;
      clearPendingFullTts();
      completingFullTtsSessionRef.current = '';
      // Server is done producing chunks; let queue end-detection finish naturally.
      queueProducingRef.current = false;
      const queue = queuedTtsRef.current;
      if (queue.active && !queue.paused && !queue.clips[queue.playingIndex + 1]) {
        const audio = queuedTtsAudioRef.current;
        if (!audio || audio.paused) {
          queue.active = false;
          setQueuePlayback({ active: false, paused: false });
        }
      }
      setStreamingRoute(null);
      ttsInference.reset();
    }
  }

  // The panel speaks in saved-profile terms; the page selects by the key derived
  // from the model filenames, which is the display name normalised.
  async function handleSelectMyVoice(voice) {
    // A stock voice has no trained model to look up and nothing to load — the
    // id alone is the whole selection.
    if (voice?.provider === 'elevenlabs') {
      setMyVoicesError('');
      setSelectedStandardVoiceId(voice.voiceProfileId);
      return;
    }

    const key = normalizeVoiceKey(voice?.displayName);
    const match = availableProfiles.find((profile) => profile.key === key);
    if (!match) {
      setMyVoicesError(`${voice?.displayName || 'That voice'} has no trained model on this backend yet.`);
      return;
    }
    setMyVoicesError('');
    // Picking a cloned voice leaves the stock selection behind.
    setSelectedStandardVoiceId('');
    handleVoiceSelection(match.key);
    // Synthesis resolves the voice per request by id, which needs a saved
    // profile record; training never writes one. Create it on first use rather
    // than making the lecturer visit the TTS page. Selection has already
    // happened, so a failure here degrades to the old pre-loaded path.
    if (voice?.hasSavedProfile === false) {
      try {
        await ensureVoiceProfile(voice.displayName);
        setMyVoices((voices) => voices.map((item) => (
          item.voiceProfileId === voice.voiceProfileId ? { ...item, hasSavedProfile: true } : item
        )));
      } catch (err) {
        setMyVoicesError(
          err?.response?.data?.error || err?.message || `Could not finish setting up ${voice.displayName}.`,
        );
      }
    }
  }

  function handleVoiceSelection(value) {
    const nextProfile = availableProfiles.find((profile) => profile.key === value) || null;
    // Keep the visible selection urgent so Radix can close the menu immediately;
    // defer the many dependent reference-state resets to a transition.
    setSelectedPersonKey(value);
    setModelSelectionOnly(false);
    setModelError('');
    autoReferenceKeyRef.current = '';
    autoLoadAttemptKeyRef.current = '';
    modelLoadVersionRef.current += 1;
    pendingAutoSyncFingerprintRef.current = '';
    autoSyncRequestFingerprintRef.current = '';
    startTransition(() => {
      setTrainingAudioFiles([]);
      setLoadedTrainingAudioSourceKey('');
      clearReferenceSelection();
    });
    writeVoiceProfileBrowserDebug('live voice switched', createVoiceProfileBrowserDebugSummary({
      context: 'live voice switch',
      displayName: nextProfile?.displayName || '',
      selectedExpName: nextProfile?.expName || '',
    }));
  }

  function deleteTtsHistoryItem(result) {
    if (!result?.id) return;
    if (String(result.url || '').startsWith('blob:')) URL.revokeObjectURL(result.url);
    setTtsHistory((current) => {
      const next = current.filter((item) => item.id !== result.id);
      ttsHistoryRef.current = next;
      return next;
    });
  }

  function friendlyTtsError(err, fallback) {
    const status = err?.response?.status;
    const raw = err?.response?.data?.error || err?.message || '';
    if (status === 409 || /another generation is already running/iu.test(raw)) {
      return 'Another person is using Live Full right now. Wait for their generation to finish, then try again.';
    }
    if (status === 404) {
      return 'This Live Full session is no longer available. Generate it again to create a new editable session.';
    }
    const sanitized = sanitizeBackendError(raw);
    if (!sanitized && isTransientBackendError(err)) {
      return 'The shared GPU did not respond in time. Please wait a moment and try again.';
    }
    return sanitized || fallback;
  }

  async function regenerateFullChunk(historyItem, chunk) {
    if (!historyItem?.sessionId || !Number.isInteger(chunk?.index)) return;
    const busyKey = `${historyItem.id}:${chunk.index}`;
    const editedText = String(fullChunkDrafts[busyKey] ?? chunk.text ?? '').trim();
    if (!editedText) {
      setTtsError('Sentence text cannot be empty.');
      return;
    }
    setRegeneratingFullChunk(busyKey);
    setTtsError('');
    try {
      const res = await regenerateInferenceChunk(historyItem.sessionId, chunk.index, editedText, chunk);
      const revision = res.data?.revision || Date.now();
      const savedText = res.data?.text || editedText;
      const source = await getGenerationResultSource(historyItem.sessionId);
      const separator = source.url.includes('?') ? '&' : '?';
      const playableUrl = await waitForPlayableAudioSource(`${source.url}${separator}v=${revision}`);
      if (String(historyItem.url || '').startsWith('blob:') && historyItem.url !== playableUrl) {
        URL.revokeObjectURL(historyItem.url);
      }
      setTtsHistory((current) => {
        const next = current.map((item) => item.id === historyItem.id ? {
          ...item,
          url: playableUrl,
          revision,
          chunks: item.chunks.map((itemChunk) => ({
              ...itemChunk,
              ...(itemChunk.index === chunk.index ? {
                text: savedText,
                attempts: res.data?.attempts,
                fallback: res.data?.fallback === true,
                fallbackReason: res.data?.fallbackReason || '',
              } : {}),
              versions: itemChunk.index === chunk.index
                ? (Array.isArray(res.data?.versions) ? res.data.versions : [])
                : itemChunk.versions,
            })),
        } : item);
        ttsHistoryRef.current = next;
        return next;
      });
      setFullChunkDrafts((current) => ({ ...current, [busyKey]: savedText }));
    } catch (err) {
      setTtsError(friendlyTtsError(err, 'Could not regenerate this sentence.'));
    } finally {
      setRegeneratingFullChunk('');
    }
  }

  async function restoreFullChunk(historyItem, chunk, version) {
    if (!historyItem?.sessionId || !Number.isInteger(chunk?.index)) return;
    const busyKey = `${historyItem.id}:${chunk.index}`;
    setRegeneratingFullChunk(busyKey);
    setTtsError('');
    try {
      const res = await restoreInferenceChunk(
        historyItem.sessionId,
        chunk.index,
        version.id,
        chunk,
      );
      const revision = res.data?.revision || Date.now();
      const savedText = res.data?.text || chunk.text || '';
      const source = await getGenerationResultSource(historyItem.sessionId);
      const separator = source.url.includes('?') ? '&' : '?';
      const playableUrl = await waitForPlayableAudioSource(`${source.url}${separator}v=${revision}`);
      setTtsHistory((current) => {
        const next = current.map((item) => item.id === historyItem.id ? {
          ...item,
          url: playableUrl,
          revision,
          chunks: item.chunks.map((itemChunk) => itemChunk.index === chunk.index
            ? {
              ...itemChunk,
              text: savedText,
              fallbackReason: res.data?.fallbackReason || '',
              fallback: res.data?.fallback === true,
              versions: Array.isArray(res.data?.versions) ? res.data.versions : [],
            }
            : itemChunk),
        } : item);
        ttsHistoryRef.current = next;
        return next;
      });
      setFullChunkDrafts((current) => ({ ...current, [busyKey]: savedText }));
    } catch (err) {
      setTtsError(friendlyTtsError(err, 'Could not restore the previous generation.'));
    } finally {
      setRegeneratingFullChunk('');
    }
  }

  async function deleteFullChunk(historyItem, chunk) {
    if (!historyItem?.sessionId || !Number.isInteger(chunk?.index) || historyItem.chunks?.length <= 1) return;
    const busyKey = `${historyItem.id}:${chunk.index}`;
    setRegeneratingFullChunk(busyKey);
    setTtsError('');
    try {
      const res = await deleteInferenceChunk(historyItem.sessionId, chunk.index);
      const revision = res.data?.revision || Date.now();
      const chunks = Array.isArray(res.data?.chunks) ? res.data.chunks : [];
      const source = await getGenerationResultSource(historyItem.sessionId);
      const separator = source.url.includes('?') ? '&' : '?';
      const playableUrl = await waitForPlayableAudioSource(`${source.url}${separator}v=${revision}`);
      if (String(historyItem.url || '').startsWith('blob:') && historyItem.url !== playableUrl) {
        URL.revokeObjectURL(historyItem.url);
      }
      setTtsHistory((current) => {
        const next = current.map((item) => item.id === historyItem.id
          ? { ...item, url: playableUrl, revision, chunks }
          : item);
        ttsHistoryRef.current = next;
        return next;
      });
      setFullChunkDrafts((current) => Object.fromEntries(
        Object.entries(current).filter(([key]) => !key.startsWith(`${historyItem.id}:`)),
      ));
    } catch (err) {
      setTtsError(friendlyTtsError(err, 'Could not delete this audio chunk.'));
    } finally {
      setRegeneratingFullChunk('');
    }
  }

  async function insertFullChunk(historyItem, index) {
    if (!historyItem?.sessionId || !Number.isInteger(index)) return;
    const insertKey = `${historyItem.id}:${index}`;
    const text = String(fullChunkInsert.key === insertKey ? fullChunkInsert.text : '').trim();
    if (!text) {
      setTtsError('Enter text for the new chunk.');
      return;
    }
    const busyKey = `insert:${insertKey}`;
    setRegeneratingFullChunk(busyKey);
    setTtsError('');
    try {
      const res = await insertInferenceChunk(historyItem.sessionId, index, text);
      const revision = res.data?.revision || Date.now();
      const chunks = Array.isArray(res.data?.chunks) ? res.data.chunks : [];
      const source = await getGenerationResultSource(historyItem.sessionId);
      const separator = source.url.includes('?') ? '&' : '?';
      const playableUrl = await waitForPlayableAudioSource(`${source.url}${separator}v=${revision}`);
      if (String(historyItem.url || '').startsWith('blob:') && historyItem.url !== playableUrl) {
        URL.revokeObjectURL(historyItem.url);
      }
      setTtsHistory((current) => {
        const next = current.map((item) => item.id === historyItem.id
          ? { ...item, url: playableUrl, revision, chunks }
          : item);
        ttsHistoryRef.current = next;
        return next;
      });
      setFullChunkDrafts((current) => Object.fromEntries(
        Object.entries(current).filter(([key]) => !key.startsWith(`${historyItem.id}:`)),
      ));
      setFullChunkInsert({ key: '', text: '' });
    } catch (err) {
      setTtsError(friendlyTtsError(err, 'Could not insert this audio chunk.'));
    } finally {
      setRegeneratingFullChunk('');
    }
  }

  function renderFullChunkInsert(historyItem, index) {
    const insertKey = `${historyItem.id}:${index}`;
    const open = fullChunkInsert.key === insertKey;
    const busy = regeneratingFullChunk === `insert:${insertKey}`;
    if (!open) {
      return (
        <Button
          key={`insert-${insertKey}`}
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setFullChunkInsert({ key: insertKey, text: '' })}
          disabled={Boolean(regeneratingFullChunk) || streamingRoute !== null}
          className="h-7 w-full rounded-md border border-dashed border-slate-200 text-[10px] text-slate-400 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-600"
        >
          <Plus size={11} /> Add chunk here
        </Button>
      );
    }
    return (
      <div key={`insert-${insertKey}`} className="rounded-lg border border-dashed border-sky-200 bg-sky-50/40 p-2.5">
        <Label htmlFor={`full-chunk-insert-${insertKey}`} className="text-[11px] font-semibold text-slate-600">
          New chunk at position {index + 1}
        </Label>
        <Textarea
          id={`full-chunk-insert-${insertKey}`}
          value={fullChunkInsert.text}
          onChange={(event) => setFullChunkInsert({ key: insertKey, text: event.target.value })}
          disabled={busy}
          rows={3}
          placeholder="Enter text to synthesize with the same Full quality pipeline…"
          className="mt-1.5 min-h-[78px] w-full resize-y rounded-md border-sky-100 bg-white px-3 py-2 text-sm leading-5 shadow-none focus-visible:ring-1"
        />
        <div className="mt-2 flex justify-end gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setFullChunkInsert({ key: '', text: '' })}
            disabled={busy}
            className="h-7 px-2 text-[10px]"
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => insertFullChunk(historyItem, index)}
            disabled={busy || Boolean(regeneratingFullChunk) || streamingRoute !== null || !fullChunkInsert.text.trim()}
            className="h-7 px-2.5 text-[10px]"
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
            {busy ? 'Generating' : 'Generate and insert'}
          </Button>
        </div>
      </div>
    );
  }

  async function loadPronunciationEntries(category = pronunciationCategory) {
    setPronunciationBusy(true);
    setPronunciationMessage('');
    try {
      const res = await getPronunciationDictionary(category);
      setPronunciationEntries(res.data.entries || []);
    } catch (err) {
      setPronunciationMessage(err.response?.data?.error || err.message || 'Could not load pronunciation dictionary.');
    } finally {
      setPronunciationBusy(false);
    }
  }

  async function searchPronunciationEntries(event) {
    event?.preventDefault();
    const search = pronunciationSearch.trim();
    if (!search) {
      setPronunciationSearchResults(null);
      return;
    }
    setPronunciationSearching(true);
    setPronunciationMessage('');
    try {
      const res = await searchPronunciationDictionary(search);
      const entries = res.data.entries || [];
      setPronunciationSearchResults({
        entries,
        totalMatches: res.data.totalMatches || 0,
        truncated: res.data.truncated === true,
      });
      const exactMatch = entries.find((entry) => (
        String(entry.word || '').toLowerCase() === search.toLowerCase()
      ));
      if (exactMatch) editPronunciation(exactMatch);
    } catch (err) {
      setPronunciationMessage(err.response?.data?.error || err.message || 'Could not search pronunciation dictionary.');
    } finally {
      setPronunciationSearching(false);
    }
  }

  function clearPronunciationSearch() {
    setPronunciationSearch('');
    setPronunciationSearchResults(null);
  }

  async function generatePronunciation() {
    const word = pronunciationWord.trim();
    if (!word) {
      setPronunciationMessage('Enter a word first.');
      return;
    }
    setPronunciationGenerating(true);
    setPronunciationMessage('');
    try {
      const result = await fetchDatamuseArpabet(word);
      if (!result) {
        setPronunciationArpabet('');
        setPronunciationMessage(`No pronunciation found for "${word}" — enter it manually.`);
        return;
      }
      setPronunciationArpabet(result.arpabet);
      setPronunciationMessage('Generated — review and Save entry.');
    } catch {
      setPronunciationMessage('Could not reach Datamuse — check your connection or enter manually.');
    } finally {
      setPronunciationGenerating(false);
    }
  }

  async function savePronunciation() {
    const word = pronunciationWord.trim();
    if (!word) {
      setPronunciationMessage('Enter a word before saving.');
      return;
    }
    if (!pronunciationArpabet.trim()) {
      setPronunciationMessage('Add an ARPAbet pronunciation before saving.');
      return;
    }
    setPronunciationBusy(true);
    setPronunciationMessage('');
    try {
      const res = await savePronunciationEntry({
        word,
        category: pronunciationCategory,
        arpabet: pronunciationArpabet,
        synthesisAlias: pronunciationSynthesisAlias.trim(),
        verifyPhonemes: pronunciationVerifyPhonemes,
        source: 'admin-arpabet',
      });
      setPronunciationEntries(res.data.dictionary?.entries || []);
      setPronunciationReloadPending(true);
      setPronunciationMessage(`Saved ${word}. Any older category entry was replaced. Click "Load changes" to apply.`);
      setEditingPronunciationWord('');
      if (pronunciationSearchResults) await searchPronunciationEntries();
    } catch (err) {
      setPronunciationMessage(err.response?.data?.error || err.message || 'Could not save pronunciation entry.');
    } finally {
      setPronunciationBusy(false);
    }
  }

  function editPronunciation(entry) {
    if (entry.category) setPronunciationCategory(entry.category);
    setEditingPronunciationWord(entry.word || '');
    setPronunciationWord(entry.word || '');
    setPronunciationArpabet(entry.arpabet || '');
    setPronunciationSynthesisAlias(entry.synthesisAlias || '');
    setPronunciationVerifyPhonemes(entry.verifyPhonemes === true);
    setPronunciationMessage(`Editing ${entry.word}.`);
    window.requestAnimationFrame(() => {
      pronunciationWordInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      pronunciationWordInputRef.current?.focus({ preventScroll: true });
    });
  }

  async function handleScanOovWords() {
    const text = ttsText.trim();
    if (!text) return;
    setOovScanning(true);
    setOovScanError('');
    try {
      const res = await scanOovWords(text);
      const result = res.data || {};
      setOovScan({
        flagged: Array.isArray(result.flagged) ? result.flagged : [],
        totalWords: result.totalWords ?? 0,
        coveredWords: result.coveredWords ?? 0,
        dictionaryLoaded: result.dictionaryLoaded !== false,
      });
    } catch (err) {
      setOovScanError(err?.response?.data?.error || err.message || 'Scan failed.');
      setOovScan(null);
    } finally {
      setOovScanning(false);
    }
  }

  // Click a flagged word to start a dictionary override for it: prefills the Word field
  // (and its Generate/Save flow below) so the admin only supplies the ARPAbet.
  function startOverrideForWord(word) {
    setEditingPronunciationWord('');
    setPronunciationWord(word);
    setPronunciationArpabet('');
    setPronunciationSynthesisAlias('');
    setPronunciationVerifyPhonemes(false);
    setPronunciationMessage(`Add an override for "${word}", then Generate or type the ARPAbet and Save entry.`);
  }

  function clearPronunciationForm() {
    setEditingPronunciationWord('');
    setPronunciationWord('');
    setPronunciationArpabet('');
    setPronunciationSynthesisAlias('');
    setPronunciationVerifyPhonemes(false);
    setPronunciationMessage('');
  }

  async function deletePronunciation(entry) {
    const word = String(entry.word || '').trim();
    if (!word) return;
    const category = entry.category || pronunciationCategory;
    setPronunciationBusy(true);
    setPronunciationMessage('');
    try {
      const res = await deletePronunciationEntry({ word, category });
      if (category === pronunciationCategory) {
        setPronunciationEntries(res.data.dictionary?.entries || []);
      } else {
        await loadPronunciationEntries(pronunciationCategory);
      }
      setPronunciationSearchResults((current) => (
        current
          ? { ...current, entries: current.entries.filter((item) => item.word.toLowerCase() !== word.toLowerCase()), totalMatches: Math.max(0, current.totalMatches - 1) }
          : null
      ));
      if (editingPronunciationWord.toLowerCase() === word.toLowerCase()) clearPronunciationForm();
      setPronunciationReloadPending(true);
      setPronunciationMessage(`Deleted ${word} from every category. Click "Load changes" to apply.`);
    } catch (err) {
      setPronunciationMessage(err.response?.data?.error || err.message || 'Could not delete pronunciation entry.');
    } finally {
      setPronunciationBusy(false);
    }
  }

  function buildPronunciationTestText(entry) {
    const word = String(entry.word || '').trim();
    return `Pronunciation test. ${word}. ${word} is used in this sentence.`;
  }

  async function testPronunciation(entry = null) {
    const word = String(entry?.word || pronunciationWord || '').trim();
    const arpabet = String(entry?.arpabet || pronunciationArpabet || '').trim();
    if (!word) {
      setPronunciationMessage('Enter a word before testing.');
      return;
    }
    if (arpabet && !entry) {
      setPronunciationMessage('Save ARPAbet first, then load pronunciation changes before testing it.');
      return;
    }
    if (arpabet && pronunciationReloadPending) {
      setPronunciationMessage('Load pending pronunciation changes before testing ARPAbet entries.');
      return;
    }
    if (!selectedVoiceProfileId || !isReady) {
      setPronunciationMessage('Load a voice profile and config before testing pronunciation.');
      return;
    }

    setPronunciationTestingWord(word);
    setPronunciationMessage(`Testing ${word} with Live Fast sentence TTS...`);
    try {
      const text = buildPronunciationTestText({ word });
      const result = await synthesizeSentence({
        text,
        voiceProfileId: selectedVoiceProfileId,
        text_lang: liveLanguage,
        ...(pinnedVoiceModel ? { voice_model: pinnedVoiceModel } : {}),
        ...(liveRefParams || {}),
      });
      recordTtsHistory({
        route: 'fast',
        url: URL.createObjectURL(result.blob),
        text,
        voiceName: speakingProfile?.displayName || '',
        languageLabel: liveLanguageConfig.label,
      });
      setPronunciationMessage(`Generated Live Fast pronunciation test for ${word}.`);
    } catch (err) {
      setPronunciationMessage(err.response?.data?.error || err.message || 'Could not test pronunciation.');
    } finally {
      setPronunciationTestingWord('');
    }
  }

  function exportPronunciationCsv() {
    const csv = serializePronunciationCsv(pronunciationEntries);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `pronunciation-${pronunciationCategory}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    setPronunciationMessage(`Exported ${pronunciationEntries.length} ${pronunciationCategory} entries.`);
  }

  async function importPronunciationCsv(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setPronunciationBusy(true);
    setPronunciationMessage(`Importing ${file.name}...`);
    try {
      const rows = parsePronunciationCsv(await file.text(), pronunciationCategory);
      if (rows.length === 0) {
        setPronunciationMessage('No valid pronunciation rows found. CSV needs word plus ARPAbet.');
        return;
      }

      for (const row of rows) {
        await savePronunciationEntry({
          ...row,
          synthesisAlias: row.synthesisAlias || '',
          verifyPhonemes: row.verifyPhonemes === true,
          source: 'csv-arpabet',
        });
      }

      await loadPronunciationEntries(pronunciationCategory);
      setPronunciationReloadPending(true);
      setPronunciationMessage(`Imported ${rows.length} ARPAbet entries. Click "Load changes" to apply.`);
    } catch (err) {
      setPronunciationMessage(err.response?.data?.error || err.message || 'Could not import pronunciation CSV.');
    } finally {
      setPronunciationBusy(false);
    }
  }

  async function loadPendingPronunciationChanges() {
    setPronunciationBusy(true);
    setPronunciationMessage('Loading pronunciation changes...');
    try {
      await stopInferenceServer();
      await startInferenceServer();
      autoLoadAttemptKeyRef.current = '';
      setPronunciationReloadPending(false);
      setPronunciationMessage('Loaded pronunciation changes; reloading the selected voice profile...');
      await checkStatus();
    } catch (err) {
      setPronunciationMessage(err.response?.data?.error || err.message || 'Could not load pronunciation changes.');
    } finally {
      setPronunciationBusy(false);
    }
  }

  useEffect(() => {
    if (restoredFullTtsRef.current) return;
    restoredFullTtsRef.current = true;
    const pending = loadPendingFullTts();
    if (!pending) return;

    pendingFullTtsRef.current = pending;
    fullTtsSubmissionRef.current = true;
    setTtsText(pending.text);
    setStreamingRoute(pending.route);
    setTtsWarning('Reconnected to the Full Inference request that was active before refresh. No new GPU request was started.');
    if (pending.route === 'fullQueued') {
      queuedTtsRef.current = { clips: [], playingIndex: -1, active: true, paused: false };
      fullQueuedFetchRef.current = { sessionId: pending.sessionId, fetched: 0, busy: false };
      queueProducingRef.current = true;
      setQueuePlayback({ active: true, paused: false });
    }
    ttsInference.connect(pending.sessionId, {
      initialStatus: 'waiting',
      initialTotalChunks: pending.totalChunks,
      initialCompletedChunks: pending.completedChunks,
      initialChunks: pending.chunks,
      initialCurrentChunkText: pending.currentChunkText,
    });
  }, [ttsInference.connect]);

  useEffect(() => {
    if (!streamingRoute) return undefined;
    const warnBeforeLeaving = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeLeaving);
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving);
  }, [streamingRoute]);

  useEffect(() => {
    const pending = pendingFullTtsRef.current;
    if (!streamingRoute || !pending) return;
    const updated = {
      ...pending,
      totalChunks: ttsInference.totalChunks,
      completedChunks: ttsInference.completedChunks,
      chunks: ttsInference.chunks,
      currentChunkText: ttsInference.currentChunkText,
      savedAt: Date.now(),
    };
    pendingFullTtsRef.current = updated;
    savePendingFullTts(updated);
  }, [
    streamingRoute,
    ttsInference.totalChunks,
    ttsInference.completedChunks,
    ttsInference.chunks,
    ttsInference.currentChunkText,
  ]);

  useEffect(() => {
    const pending = pendingFullTtsRef.current;
    if (!pending) return;

    if (ttsInference.status === 'complete') {
      completeFullTtsGeneration(pending.sessionId);
    } else if (ttsInference.status === 'error' || ttsInference.status === 'cancelled') {
      setTtsError(ttsInference.error || 'Could not generate text to speech audio.');
      pendingFullTtsRef.current = null;
      fullTtsSubmissionRef.current = false;
      clearPendingFullTts();
      setStreamingRoute(null);
      if (pending.route === 'fullQueued') stopQueuedTtsPlayback();
      ttsInference.reset();
    }
  }, [ttsInference.status, ttsInference.error]);

  useEffect(() => {
    if (!streamingRoute || !pendingFullTtsRef.current) return undefined;

    let stopped = false;
    const poll = async () => {
      const pending = pendingFullTtsRef.current;
      if (!pending || stopped || completingFullTtsSessionRef.current) return;
      try {
        const res = await getCurrentInference();
        const state = res.data || {};
        if (state.sessionId !== pending.sessionId) return;
        if (state.status === 'complete' || state.resultReady) {
          completeFullTtsGeneration(pending.sessionId);
        } else if (state.status === 'error' || state.status === 'cancelled') {
          setTtsError(state.error || 'Could not generate text to speech audio.');
          pendingFullTtsRef.current = null;
          fullTtsSubmissionRef.current = false;
          clearPendingFullTts();
          setStreamingRoute(null);
          if (pending.route === 'fullQueued') stopQueuedTtsPlayback();
          ttsInference.reset();
        }
      } catch {
        // SSE remains the primary signal; polling is only a best-effort fallback.
      }
    };

    const interval = window.setInterval(poll, 2000);
    poll();
    return () => {
      stopped = true;
      window.clearInterval(interval);
    };
  }, [streamingRoute, ttsInference.reset]);

  // Full Inference Queue progressive playback: each time the server reports another
  // chunk finished (completedChunks), pull that chunk's audio and enqueue it so it
  // starts playing before the whole passage is done — the Full-inference analogue
  // of Live Fast Queue.
  useEffect(() => {
    if (streamingRoute !== 'fullQueued') return undefined;
    const pending = pendingFullTtsRef.current;
    if (!pending) return undefined;

    const { sessionId } = pending;
    if (fullQueuedFetchRef.current.sessionId !== sessionId) {
      fullQueuedFetchRef.current = { sessionId, fetched: 0, busy: false };
    }
    const completed = ttsInference.completedChunks;
    if (completed <= fullQueuedFetchRef.current.fetched) return undefined;

    let cancelled = false;
    (async () => {
      const tracker = fullQueuedFetchRef.current;
      if (tracker.busy) return;
      tracker.busy = true;
      try {
        while (!cancelled && tracker.fetched < completed && queuedTtsRef.current.active) {
          const index = tracker.fetched;
          try {
            const blob = await getInferenceChunk(sessionId, index);
            queuedTtsRef.current.clips[index] = { index, url: URL.createObjectURL(blob) };
            playNextQueuedTtsClip();
          } catch {
            // Chunk not retrievable yet; a later completedChunks tick will retry it.
            break;
          }
          tracker.fetched = index + 1;
        }
      } finally {
        tracker.busy = false;
      }
    })();

    return () => { cancelled = true; };
  }, [streamingRoute, ttsInference.completedChunks]);

  useEffect(() => {
    if (mode !== 'tts') return;
    loadPronunciationEntries(pronunciationCategory);
  }, [mode, pronunciationCategory]);

  // Manual reference edits should persist just like an auto-picked set: mark the
  // new selection as pending so the auto-sync effect saves it to the active voice
  // profile. Without this, manual changes are silently reverted the next time the
  // active profile re-fetches (model reload, gpu-ready) restores the saved set.
  function markReferenceSelectionForAutoSync({
    primaryPath = refAudioPath,
    prompt = promptText,
    lang = promptLang,
    auxFiles = auxRefAudios,
  } = {}) {
    pendingAutoSyncFingerprintRef.current = createAutoVoiceProfileSyncFingerprint({
      sourceKey: selectedExpName,
      selectedGPT,
      selectedSoVITS,
      refAudioPath: primaryPath,
      promptText: prompt,
      promptLang: lang,
      textLang: liveLanguage,
      preferredRoute: 'sentence',
      auxRefAudioPaths: auxFiles.map((item) => item.path),
      defaults: {
        top_k: topK,
        top_p: topP,
        temperature,
        repetition_penalty: repPenalty,
        speed_factor: speed,
        max_chunk_words: liveFastMaxChunkWords,
        max_sentences_per_chunk: liveFastMaxSentences,
      },
    });
  }

  function handlePrimaryReferenceChange(path) {
    const file = trainingAudioFiles.find((item) => item.path === path);
    if (!file) return;
    const nextLang = normalizeReferenceLanguage(file.lang);
    const nextAux = auxRefAudios.filter((item) => item.path !== file.path).slice(0, 5);
    setRefAudioPath(file.path); setPromptText(file.transcript || '');
    setPromptLang(nextLang);
    setAuxRefAudios(nextAux);
    setReferenceMessage(`${file.filename} is now the primary reference.`);
    markReferenceSelectionForAutoSync({
      primaryPath: file.path,
      prompt: file.transcript || '',
      lang: nextLang,
      auxFiles: nextAux,
    });
  }

  function handleAuxToggle(file, checked) {
    if (!file?.path || file.path === refAudioPath) return;
    const without = auxRefAudios.filter((item) => item.path !== file.path);
    const nextAux = checked ? [...without, file].slice(0, 5) : without;
    setAuxRefAudios(nextAux);
    markReferenceSelectionForAutoSync({ auxFiles: nextAux });
  }

  function handleLiveFullPrimaryReferenceChange(path) {
    const file = trainingAudioFiles.find((item) => item.path === path);
    if (!file) return;
    setLiveFullRefAudioPath(file.path);
    setLiveFullPromptText(file.transcript || '');
    setLiveFullPromptLang(normalizeReferenceLanguage(file.lang));
    setLiveFullAuxRefAudios((cur) => cur.filter((item) => item.path !== file.path).slice(0, 5));
    setLiveFullMessage(`${file.filename} is now the Live Full primary reference.`);
  }

  function handleLiveFullAuxToggle(file, checked) {
    if (!file?.path || file.path === liveFullRefAudioPath) return;
    setLiveFullAuxRefAudios((cur) => {
      const without = cur.filter((item) => item.path !== file.path);
      return checked ? [...without, file].slice(0, 5) : without;
    });
  }

  async function handlePreviewReference(item) {
    if (!item?.path || !selectedExpName) return;
    const filename = item.filename || fallbackName(item.path);
    const url = referenceAudioUrls[item.path];
    if (!url) { setReferenceMessage(`${filename} is still loading. Try again.`); return; }
    setPreviewReference({ path: item.path, url, filename, role: item.role });
    setReferenceMessage('');
    const audio = referencePreviewAudioRef.current;
    if (!audio) return;
    if (audio.getAttribute('src') !== url) { audio.src = url; audio.load(); }
    audio.play().catch(() => setReferenceMessage(`Use the audio controls below to play ${filename}.`));
  }

  async function handlePreviewLiveFullReference(item) {
    if (!item?.path || !selectedExpName) return;
    const filename = item.filename || fallbackName(item.path);
    const url = referenceAudioUrls[item.path];
    if (!url) { setLiveFullMessage(`${filename} is still loading. Try again.`); return; }
    setLiveFullPreviewReference({ path: item.path, url, filename, role: item.role });
    setLiveFullMessage('');
    const audio = liveFullPreviewAudioRef.current;
    if (!audio) return;
    if (audio.getAttribute('src') !== url) { audio.src = url; audio.load(); }
    audio.play().catch(() => setLiveFullMessage(`Use the audio controls below to play ${filename}.`));
  }

  // Presigned preview URLs only depend on the clip *paths*, not on the quality
  // scores / transcripts that the training-audio re-fetch loop is polling for. Key
  // this effect on the stable path set so a 6s poll that returns the same clips
  // (just with freshly-landed scores) does NOT re-issue a URL request per clip.
  const trainingAudioPathKey = useMemo(
    () => trainingAudioFiles.map((item) => item.path).join('\n'),
    [trainingAudioFiles],
  );

  useEffect(() => {
    if (!selectedExpName || trainingAudioFiles.length === 0) { setReferenceAudioUrls({}); setLoadingPreviewPath(''); return; }
    let ignore = false;
    const requestId = previewRequestRef.current + 1;
    previewRequestRef.current = requestId;
    setLoadingPreviewPath('all');
    Promise.all(trainingAudioFiles.map(async (item) => {
      try {
        const url = await getTrainingAudioUrl(selectedExpName, item.filename || fallbackName(item.path));
        return [item.path, url];
      } catch { return [item.path, null]; }
    })).then((entries) => {
      if (ignore || previewRequestRef.current !== requestId) return;
      setReferenceAudioUrls(Object.fromEntries(entries.filter(([, url]) => Boolean(url))));
    }).finally(() => { if (!ignore && previewRequestRef.current === requestId) setLoadingPreviewPath(''); });
    return () => { ignore = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedExpName, trainingAudioPathKey]);

  useEffect(() => {
    if (!previewReference.path) return;
    if (!trainingAudioFiles.some((item) => item.path === previewReference.path)) {
      const audio = referencePreviewAudioRef.current;
      if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
      setPreviewReference({ path: '', url: null, filename: '', role: '' });
    }
  }, [trainingAudioFiles, previewReference.path]);

  useEffect(() => {
    if (!liveFullPreviewReference.path) return;
    if (!trainingAudioFiles.some((item) => item.path === liveFullPreviewReference.path)) {
      const audio = liveFullPreviewAudioRef.current;
      if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
      setLiveFullPreviewReference({ path: '', url: null, filename: '', role: '' });
    }
  }, [trainingAudioFiles, liveFullPreviewReference.path]);

  useEffect(() => {
    if (!previewReference.path) return;
    const nextUrl = referenceAudioUrls[previewReference.path];
    if (!nextUrl) {
      const audio = referencePreviewAudioRef.current;
      if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
      setPreviewReference({ path: '', url: null, filename: '', role: '' });
      return;
    }
    setPreviewReference((cur) => cur.url === nextUrl ? cur : { ...cur, url: nextUrl });
  }, [referenceAudioUrls, previewReference.path]);

  useEffect(() => {
    if (!liveFullPreviewReference.path) return;
    const nextUrl = referenceAudioUrls[liveFullPreviewReference.path];
    if (!nextUrl) {
      const audio = liveFullPreviewAudioRef.current;
      if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
      setLiveFullPreviewReference({ path: '', url: null, filename: '', role: '' });
      return;
    }
    setLiveFullPreviewReference((cur) => cur.url === nextUrl ? cur : { ...cur, url: nextUrl });
  }, [referenceAudioUrls, liveFullPreviewReference.path]);

  useEffect(() => {
    if (!previewReference.url) {
      const audio = referencePreviewAudioRef.current;
      if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
      return;
    }
    const audio = referencePreviewAudioRef.current;
    if (audio && audio.getAttribute('src') !== previewReference.url) { audio.src = previewReference.url; audio.load(); }
  }, [previewReference.url]);

  useEffect(() => {
    if (!liveFullPreviewReference.url) {
      const audio = liveFullPreviewAudioRef.current;
      if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
      return;
    }
    const audio = liveFullPreviewAudioRef.current;
    if (audio && audio.getAttribute('src') !== liveFullPreviewReference.url) { audio.src = liveFullPreviewReference.url; audio.load(); }
  }, [liveFullPreviewReference.url]);

  useEffect(() => {
    if (trainingAudioFiles.length > 0) return;
    const audio = referencePreviewAudioRef.current;
    if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
    const liveFullAudio = liveFullPreviewAudioRef.current;
    if (liveFullAudio) { liveFullAudio.pause(); liveFullAudio.removeAttribute('src'); liveFullAudio.load(); }
    setPreviewReference({ path: '', url: null, filename: '', role: '' });
    setLiveFullPreviewReference({ path: '', url: null, filename: '', role: '' });
    setReferenceAudioUrls({}); setLoadingPreviewPath('');
  }, [trainingAudioFiles.length]);

  useEffect(() => { return () => { referencePreviewAudioRef.current?.pause(); liveFullPreviewAudioRef.current?.pause(); }; }, []);

  useEffect(() => {
    if (loadingPreviewPath !== 'all') return;
    const id = window.setTimeout(() => { if (loadingPreviewPath === 'all') setLoadingPreviewPath(''); }, 8000);
    return () => window.clearTimeout(id);
  }, [loadingPreviewPath]);

  // Faculty only. Failure is shown in the panel rather than thrown: not knowing
  // which voices you own must never stop the rest of the kiosk working.
  useEffect(() => {
    if (!canEditInstructions) return undefined;
    let ignore = false;
    setMyVoicesLoading(true);
    setMyVoicesError('');
    getMyVoiceProfiles(myVoicesScope)
      .then((res) => {
        if (ignore) return;
        setMyVoices(Array.isArray(res.data?.voices) ? res.data.voices : []);
        setStandardVoices(Array.isArray(res.data?.standardVoices) ? res.data.standardVoices : []);
        setMyVoicesAdmin(res.data?.isAdmin === true);
        // The server decides the scope it actually served; trust that, not the request.
        setMyVoicesScope(res.data?.scope === 'all' ? 'all' : 'mine');
      })
      .catch((err) => {
        if (ignore) return;
        setMyVoices([]);
        setStandardVoices([]);
        setMyVoicesError(
          err?.response?.status === 401
            ? 'Sign in to see your voices.'
            : err?.response?.data?.error || err?.message || 'Could not load your voices.',
        );
      })
      .finally(() => { if (!ignore) setMyVoicesLoading(false); });
    return () => { ignore = true; };
  }, [canEditInstructions, myVoicesScope, myVoicesReloadToken]);

  useEffect(() => {
    const initialVoiceKey = resolveInitialVoiceKey({
      search: window.location.search,
      envVoiceId: import.meta.env.VITE_CHATBOT_VOICE_PROFILE_ID,
    });
    if (initialVoiceKey) urlVoiceKeyRef.current = initialVoiceKey;
    // The first fetchModels/checkStatus/loadActiveVoiceProfile now fires from the
    // GPU-readiness-gated effect below, so we don't hit a cold backend on mount.
  }, []);

  // Kick off the first model/status/profile load only once the GPU worker is
  // ready — this is what keeps the "loading" UI from running before the GPU has
  // started (and what avoids the cold-start 503/404 banners).
  useEffect(() => {
    if (!backendQueryable) return;
    if (initialBackendLoadRef.current) return;
    initialBackendLoadRef.current = true;
    fetchModels(); checkStatus(); loadActiveVoiceProfile();
  }, [backendQueryable]);

  // Self-heal: while the GPU is up and we're not mid-conversation, re-sync the
  // inference status periodically. If the loaded-model state ever goes stale it
  // recovers on its own instead of needing a manual page refresh.
  useEffect(() => {
    if (!backendQueryable) return undefined;
    if (isConversationActive) return undefined;
    const id = window.setInterval(() => { checkStatus(); }, 12000);
    return () => window.clearInterval(id);
  }, [backendQueryable, isConversationActive]);

  // The GPU node worker can report ready while the Python inference server — the
  // process that actually serves /models/select — hasn't been spawned yet. That's
  // the root of the 500s on model-select and "it never auto-loads": serverReady
  // (from /inference/status) stays false, so the auto-load below never fires.
  // Boot the inference server and keep nudging (start() is idempotent) until it
  // reports ready; then the normal smart auto-select/auto-load runs unchanged.
  useEffect(() => {
    if (!backendQueryable) return undefined;
    if (serverReady) return undefined;
    if (isConversationActive) return undefined;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        await startInferenceServer();
      } catch {
        // Still warming (proxy 503 / cold Python start) — the next tick retries.
      }
      if (!cancelled) await checkStatus();
    };
    tick();
    const id = window.setInterval(tick, 6000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [backendQueryable, serverReady, isConversationActive]);

  // Shared-GPU awareness (live-fast only): the box holds a single loaded model, so
  // another session loading a different voice will change the loaded weights out
  // from under us. Detect that transition and tell the user, rather than silently
  // showing "not loaded".
  useEffect(() => {
    if (!isLiveFastBuild) return;
    // A pinned selection reloads its own weights for every request, so another
    // site swapping the shared model is no longer something this user has to act
    // on — telling them to "reload yours to continue" would be plainly wrong.
    if (selectedVoicePinsOwnWeights) return;
    const sig = `${loadedGPTPath}::${loadedSoVITSPath}`;
    const prev = observedLoadedSigRef.current;
    observedLoadedSigRef.current = sig;
    if (prev === null) return;            // first observation — establish a baseline
    if (sig === prev) return;
    if (!loadedGPTPath && !loadedSoVITSPath) return; // full unload (e.g. GPU restart)
    if (loadingModel) return;             // our own in-flight load
    if (loadedGPTPath === selectedGPT && loadedSoVITSPath === selectedSoVITS) return; // our load landed
    setGpuNotice({
      tone: 'info',
      title: 'Shared voice model changed',
      message: 'Another session loaded a different voice on the shared GPU. Only one model can be active at a time — reload yours to continue.',
    });
  }, [isLiveFastBuild, loadedGPTPath, loadedSoVITSPath, loadingModel, selectedGPT, selectedSoVITS, selectedVoicePinsOwnWeights]);

  useEffect(() => {
    if (!modelsFetched || availableProfiles.length === 0) return;
    if (urlVoiceKeyRef.current) {
      const match = availableProfiles.find((p) => p.key === urlVoiceKeyRef.current);
      if (match) { urlVoiceKeyRef.current = ''; setSelectedPersonKey(match.key); autoLoadAttemptKeyRef.current = ''; return; }
    }
    if (loadingActiveVoiceProfile) return;
    if (availableProfiles.some((p) => p.key === selectedPersonKey)) return;
    // Faculty defaults to the signed-in lecturer's own voice, not to whatever
    // the build pins or the backend happens to have active. Waiting for the
    // ownership answer first matters: picking a fallback now and correcting it
    // afterwards would load one voice onto the shared GPU just to replace it.
    if (canEditInstructions) {
      if (myVoicesLoading) return;
      const ownVoice = myVoices.find((voice) => voice.isMine !== false);
      const ownMatch = ownVoice
        ? availableProfiles.find((p) => p.key === normalizeVoiceKey(ownVoice.displayName))
        : null;
      if (ownMatch) {
        setSelectedPersonKey(ownMatch.key);
        autoLoadAttemptKeyRef.current = '';
        // The default voice needs the same saved record as a hand-picked one.
        if (ownVoice.hasSavedProfile === false && ensuredVoiceRef.current !== ownVoice.displayName) {
          ensuredVoiceRef.current = ownVoice.displayName;
          ensureVoiceProfile(ownVoice.displayName)
            .then(() => setMyVoices((voices) => voices.map((item) => (
              item.voiceProfileId === ownVoice.voiceProfileId ? { ...item, hasSavedProfile: true } : item
            ))))
            .catch(() => { /* selection still works through the pre-loaded path */ });
        }
        return;
      }
      // No voice of their own: select nothing. The old fallback landed on the
      // pinned/active profile, which meant a lecturer who had never trained got
      // a kiosk that spoke in another lecturer's cloned voice. Better to stay
      // silent until they pick — their own voice, or a standard one.
      return;
    }
    const activeMatchKey = findSavedVoiceProfileKey(availableProfiles, activeVoiceProfile?.voiceProfileId || '');
    setSelectedPersonKey(activeMatchKey || availableProfiles[0].key);
  }, [
    modelsFetched,
    availableProfiles,
    selectedPersonKey,
    loadedGPTPath,
    loadedSoVITSPath,
    loadingActiveVoiceProfile,
    activeVoiceProfile,
    canEditInstructions,
    myVoices,
    myVoicesLoading,
  ]);

  useEffect(() => {
    // A stock voice speaks without the GPU, so loading weights for whatever
    // cloned voice happens to still be selected would occupy the shared GPU for
    // a model this session is not going to use.
    if (usingStandardVoice) return;
    if (loadedVoiceConfigsProfileId !== selectedVoiceProfileId) return;
    if (!shouldLoadSelectedProfile({ serverReady, selectedProfile, loadedGPTPath, loadedSoVITSPath, isConversationActive, loadingModel })) return;
    const loadKey = `${selectedProfile.gptModel.path}::${selectedProfile.sovitsModel.path}`;
    if (autoLoadAttemptKeyRef.current === loadKey) return;
    autoLoadAttemptKeyRef.current = loadKey;
    loadSelectedModel();
  }, [
    serverReady,
    selectedProfile,
    selectedVoiceProfileId,
    loadedVoiceConfigsProfileId,
    loadedGPTPath,
    loadedSoVITSPath,
    isConversationActive,
    loadingModel,
    usingStandardVoice,
  ]);

  useEffect(() => {
    if (!selectedExpName) {
      setTrainingAudioFiles([]);
      setLoadedTrainingAudioSourceKey('');
      return;
    }
    let ignore = false;
    setTrainingAudioFiles([]);
    setLoadedTrainingAudioSourceKey('');
    setLoadingTrainingAudio(true);
    getTrainingAudioFiles(selectedExpName)
      .then((res) => {
        if (!ignore) {
          setTrainingAudioFiles(res.data.files || []);
          setLoadedTrainingAudioSourceKey(selectedExpName);
        }
      })
      .catch(() => {
        if (!ignore) {
          setTrainingAudioFiles([]);
          setLoadedTrainingAudioSourceKey('');
          setReferenceMessage('Could not load reference clips.');
        }
      })
      .finally(() => { if (!ignore) setLoadingTrainingAudio(false); });
    return () => { ignore = true; };
  }, [selectedExpName]);

  // A scored-strict reference pick needs measured clip quality scores (clip-scores.json)
  // and ASR transcripts, which can still be landing for a while after training. Until
  // such a pick is possible we deliberately do NOT lock or persist a fallback set.
  const referenceSelectionReady = useMemo(() => (
    Array.isArray(trainingAudioFiles)
    && trainingAudioFiles.length > 0
    && Boolean(chooseBestReferenceSet(trainingAudioFiles).ready)
  ), [trainingAudioFiles]);

  // Loop: while the selected model has clips loaded but no scored-strict pick yet,
  // re-fetch training audio on an interval so the auto-select upgrades (and finally
  // persists) the moment quality scores / transcripts become available. If a
  // scored-strict pick never materialises after a bounded number of attempts, stop
  // polling and tell the user the training audio isn't good enough, instead of
  // waiting (and re-fetching) forever.
  useEffect(() => {
    if (!selectedExpName) return undefined;
    if (loadedTrainingAudioSourceKey !== selectedExpName) return undefined;
    if (loadingTrainingAudio || referenceSelectionReady) return undefined;
    // When a saved config #1 / restorable profile governs the reference, the
    // auto-select isn't running, so there's nothing to upgrade — don't poll and
    // don't nag about training audio quality.
    if (
      canRestoreActiveVoiceProfile
      && voiceConfigs.length > 0
      && !isAutoManagedLiveFastConfig(voiceConfigs[0], selectedExpName)
    ) return undefined;
    let ignore = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 10; // ~60s at the 6s cadence below
    const interval = window.setInterval(() => {
      attempts += 1;
      getTrainingAudioFiles(selectedExpName)
        .then((res) => {
          if (ignore) return;
          const nextFiles = res.data.files || [];
          // Only commit a new array when the clips actually changed (e.g. scores or
          // transcripts landed). Replacing it unconditionally every 6s churns
          // re-renders and re-runs the auto-select for no reason.
          setTrainingAudioFiles((prev) => (
            JSON.stringify(prev) === JSON.stringify(nextFiles) ? prev : nextFiles
          ));
          // Give up after MAX_ATTEMPTS if the freshly-fetched clips still can't
          // produce a scored-strict pick. (If they can, the effect's
          // referenceSelectionReady dependency flips and cleans this interval up.)
          if (attempts >= MAX_ATTEMPTS && !chooseBestReferenceSet(nextFiles).ready) {
            window.clearInterval(interval);
            setReferenceMessage('Training audio not good enough for a strict reference yet — clips need measured quality scores and a clean 3-9s sentence. Retrain or add cleaner clips.');
          }
        })
        .catch(() => {});
    }, 6000);
    return () => { ignore = true; window.clearInterval(interval); };
  }, [selectedExpName, loadedTrainingAudioSourceKey, loadingTrainingAudio, referenceSelectionReady, canRestoreActiveVoiceProfile, voiceConfigs.length]);

  // A new voice must never inherit the previous voice's clips: drop them as soon as the
  // dataset changes, then let the saved config / profile restore / best pick refill them.
  useEffect(() => {
    clearReferenceSelection();
    setLiveFullRefAudioPath('');
    setLiveFullPromptText('');
    setLiveFullAuxRefAudios([]);
    restoredActiveVoiceProfileKeyRef.current = '';
    autoReferenceKeyRef.current = '';
    autoDefaultConfigKeyRef.current = '';
    autoLoadedLiveFastConfigProfileRef.current = '';
    liveFullDefaultKeyRef.current = '';
  }, [selectedExpName]);

  useEffect(() => {
    restoredActiveVoiceProfileKeyRef.current = '';
    autoReferenceKeyRef.current = '';
    autoDefaultConfigKeyRef.current = '';
    autoLoadedLiveFastConfigProfileRef.current = '';
    liveFullDefaultKeyRef.current = '';
    liveFullAutoDefaultSaveKeyRef.current = '';
  }, [selectedVoiceProfileId, selectedGPT, selectedSoVITS]);

  useEffect(() => {
    loadVoiceConfigs(selectedVoiceProfileId);
  }, [selectedVoiceProfileId, selectedExpName]);

  useEffect(() => {
    liveFullDefaultKeyRef.current = '';
    liveFullAutoDefaultSaveKeyRef.current = '';
    setLoadedLiveFullConfigId('');
    setLiveFullMessage('');
  }, [selectedVoiceProfileId]);

  useEffect(() => {
    loadTrainingRunMetadata(selectedExpName);
  }, [selectedExpName]);

  useEffect(() => {
    if (
      loadingVoiceConfigs
      || voiceConfigs.length > 0
      || !selectedVoiceProfileId
      || !selectedProfile
      || !selectedGPT
      || !selectedSoVITS
      || !refAudioPath
      || loadingTrainingAudio
      || isConversationActive
    ) {
      return;
    }
    const key = `${selectedVoiceProfileId}:${refAudioPath}:${auxRefAudios.map((item) => item.path).join(',')}`;
    if (autoDefaultConfigKeyRef.current === key) return;
    autoDefaultConfigKeyRef.current = key;
    saveCurrentVoiceConfig({
      configId: 'default',
      configName: `${selectedProfile.displayName} default`,
      rank: 1,
      sample: {},
    }, { referenceMode: 'auto' });
  }, [
    loadingVoiceConfigs,
    voiceConfigs.length,
    selectedVoiceProfileId,
    selectedProfile,
    selectedGPT,
    selectedSoVITS,
    refAudioPath,
    auxRefAudios,
    loadingTrainingAudio,
    isConversationActive,
  ]);

  useEffect(() => {
    if (loadingVoiceConfigs || loadingTrainingAudio || !selectedVoiceProfileId) return;
    const savedLiveFullConfig = liveFullConfigs[0];
    if (!savedLiveFullConfig) return;
    const key = `${selectedVoiceProfileId}:liveFull:${savedLiveFullConfig.configId || 'default'}`;
    if (liveFullDefaultKeyRef.current === key) return;
    liveFullDefaultKeyRef.current = key;
    applyLiveFullConfig(savedLiveFullConfig, { silent: true });
  }, [
    loadingVoiceConfigs,
    loadingTrainingAudio,
    selectedVoiceProfileId,
    liveFullConfigs,
  ]);

  useEffect(() => {
    if (
      loadingVoiceConfigs
      || loadingTrainingAudio
      || liveFullConfigs.length > 0
      || voiceConfigs.length === 0
      || !selectedVoiceProfileId
      || !selectedProfile
      || savingLiveFullConfigId
      || streamingRoute !== null
    ) {
      return;
    }

    const rankOneConfig = voiceConfigs[0];
    const key = `${selectedVoiceProfileId}:${rankOneConfig?.configId || 'default'}`;
    if (liveFullAutoDefaultSaveKeyRef.current === key) return;
    liveFullAutoDefaultSaveKeyRef.current = key;
    saveCurrentLiveFullConfig({
      configId: 'live-full-default',
      configName: `${selectedProfile.displayName} full default`,
      rank: 1,
      sample: {},
    });
  }, [
    loadingVoiceConfigs,
    loadingTrainingAudio,
    liveFullConfigs.length,
    voiceConfigs,
    selectedVoiceProfileId,
    selectedProfile,
    savingLiveFullConfigId,
    streamingRoute,
  ]);

  useEffect(() => {
    return () => {
      Object.values(configSampleUrlsRef.current).forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  useEffect(() => {
    return () => {
      ttsHistoryRef.current.forEach((item) => {
        if (item.url) URL.revokeObjectURL(item.url);
      });
    };
  }, []);

  useEffect(() => {
    if (!canRestoreActiveVoiceProfile || !activeVoiceProfileRestoreKey) {
      return;
    }
    if (loadingActiveVoiceProfile || loadingTrainingAudio) {
      return;
    }
    if (selectedExpName && loadedTrainingAudioSourceKey !== selectedExpName) {
      return;
    }
    if (restoredActiveVoiceProfileKeyRef.current === activeVoiceProfileRestoreKey) {
      return;
    }
    if (voiceConfigsRef.current.length > 0) {
      restoredActiveVoiceProfileKeyRef.current = activeVoiceProfileRestoreKey;
      return;
    }

    const primaryPath = String(activeVoiceProfile?.ref_audio_path || '').trim();
    if (!primaryPath) {
      return;
    }

    if (matchesSavedVoiceProfileReferenceSelection({
      profile: activeVoiceProfile,
      refAudioPath,
      auxRefAudioPaths: auxRefAudios.map((item) => item.path),
    })) {
      restoredActiveVoiceProfileKeyRef.current = activeVoiceProfileRestoreKey;
      return;
    }

    restoredActiveVoiceProfileKeyRef.current = activeVoiceProfileRestoreKey;
    pendingAutoSyncFingerprintRef.current = '';
    autoSyncRequestFingerprintRef.current = '';

    const auxMatches = Array.isArray(activeVoiceProfile?.aux_ref_audio_paths)
      ? activeVoiceProfile.aux_ref_audio_paths
        .map((path) => String(path || '').trim())
        .filter(Boolean)
        .filter((path) => path !== primaryPath)
        .slice(0, 5)
        .map((path) => trainingAudioFiles.find((file) => file.path === path) || {
          filename: fallbackName(path),
          path,
          transcript: '',
          lang: '',
        })
      : [];

    setRefAudioPath(primaryPath);
    setPromptText(String(activeVoiceProfile.prompt_text || ''));
    setPromptLang(normalizeReferenceLanguage(activeVoiceProfile.prompt_lang));
    setAuxRefAudios(auxMatches);
    setSelectedLanguage(normalizeLiveLanguage(activeVoiceProfile.text_lang || 'en'));
    setSpeed(Number.isFinite(activeVoiceProfile?.defaults?.speed_factor) ? activeVoiceProfile.defaults.speed_factor : DEFAULT_LIVE_FAST_SETTINGS.speed);
    setTopK(Number.isFinite(activeVoiceProfile?.defaults?.top_k) ? activeVoiceProfile.defaults.top_k : DEFAULT_LIVE_FAST_SETTINGS.topK);
    setTopP(Number.isFinite(activeVoiceProfile?.defaults?.top_p) ? activeVoiceProfile.defaults.top_p : DEFAULT_LIVE_FAST_SETTINGS.topP);
    setTemperature(Number.isFinite(activeVoiceProfile?.defaults?.temperature) ? activeVoiceProfile.defaults.temperature : DEFAULT_LIVE_FAST_SETTINGS.temperature);
    setRepPenalty(Number.isFinite(activeVoiceProfile?.defaults?.repetition_penalty) ? activeVoiceProfile.defaults.repetition_penalty : DEFAULT_LIVE_FAST_SETTINGS.repPenalty);
    setLiveFastOutputGainDb(Number.isFinite(activeVoiceProfile?.defaults?.output_gain_db) ? activeVoiceProfile.defaults.output_gain_db : DEFAULT_LIVE_FAST_SETTINGS.outputGainDb);
    const chunkSettings = normalizeLiveFastSettings({
      maxChunkWords: activeVoiceProfile?.defaults?.max_chunk_words,
      maxSentencesPerChunk: activeVoiceProfile?.defaults?.max_sentences_per_chunk,
    });
    setLiveFastMaxChunkWords(chunkSettings.maxChunkWords);
    setLiveFastMaxSentences(chunkSettings.maxSentencesPerChunk);
    setPreviewReference({ path: '', url: null, filename: '', role: '' });
    setReferenceMessage(`Restored saved voice profile ${activeVoiceProfile.displayName || activeVoiceProfile.voiceProfileId}.`);
  }, [
    canRestoreActiveVoiceProfile,
    activeVoiceProfileRestoreKey,
    activeVoiceProfile,
    loadingActiveVoiceProfile,
    loadingTrainingAudio,
    selectedExpName,
    loadedTrainingAudioSourceKey,
    trainingAudioFiles,
    refAudioPath,
    auxRefAudios,
  ]);

  useEffect(() => {
    if (loadingActiveVoiceProfile || loadingVoiceConfigs) return;
    if (
      canRestoreActiveVoiceProfile
      && voiceConfigs.length > 0
      && !isAutoManagedLiveFastConfig(voiceConfigs[0], selectedExpName)
    ) return;

    if (!shouldAutoApplyBestReferenceSet({
      selectedSourceKey: selectedExpName,
      loadedSourceKey: loadedTrainingAudioSourceKey,
      loading: loadingTrainingAudio,
      fileCount: trainingAudioFiles.length,
      lastAppliedSourceKey: autoReferenceKeyRef.current,
    })) return;
    const selection = applyBestReference(trainingAudioFiles, { markForAutoSync: true });
    // Only treat this source as "auto-applied" once we get a scored-strict pick. A
    // fallback pick - or a strict pick made before clip quality scores landed - is
    // left un-locked so a later trainingAudioFiles re-fetch with scores can upgrade
    // and persist it, instead of blindly freezing a not-yet-scored set.
    if (selection?.ready) {
      autoReferenceKeyRef.current = selectedExpName;
    }
  }, [
    selectedExpName,
    loadedTrainingAudioSourceKey,
    loadingTrainingAudio,
    trainingAudioFiles,
    loadingActiveVoiceProfile,
    loadingVoiceConfigs,
    canRestoreActiveVoiceProfile,
    voiceConfigs.length,
  ]);

  useEffect(() => {
    if (!autoSyncRequestFingerprint) {
      return;
    }

    const requestFingerprint = autoSyncRequestFingerprint;
    const requestDisplayName = selectedProfile?.displayName || '';
    autoSyncRequestFingerprintRef.current = requestFingerprint;
    setSavingProfile(true);
    setModelError('');

    persistLiveFastAutoSync()
      .then(({ displayName, voiceProfileId }) => {
        if (autoSyncRequestFingerprintRef.current !== requestFingerprint) return;
        lastAutoSyncedFingerprintRef.current = requestFingerprint;
        pendingAutoSyncFingerprintRef.current = '';
        setReferenceMessage(
          `Active voice profile synced to ${displayName || requestDisplayName} (${voiceProfileId}).`,
        );
      })
      .catch((err) => {
        if (autoSyncRequestFingerprintRef.current !== requestFingerprint) return;
        pendingAutoSyncFingerprintRef.current = '';
        setModelError(err.response?.data?.error || err.message || 'Could not sync this voice profile.');
      })
      .finally(() => {
        if (autoSyncRequestFingerprintRef.current === requestFingerprint) {
          autoSyncRequestFingerprintRef.current = '';
          setSavingProfile(false);
        }
      });
  }, [
    autoSyncRequestFingerprint,
    selectedProfile,
  ]);

  useEffect(() => {
    async function handleGpuReady() {
      fetchModels();
      checkStatus();
      // A GPU restart can leave the active voice profile holding a stale fallback
      // reference set (the inference worker pre-warms on a cold GPU before clip
      // scores/ASR are ready, freezing a mediocre ref + padded 5 aux onto the
      // profile). The rank #1 saved config is the real source of truth, so re-push
      // it to the profile *before* re-fetching - otherwise the restore effect would
      // blindly re-apply the broken set and silently revert the saved config.
      const rankOneConfig = voiceConfigsRef.current[0] || null;
      if (rankOneConfig && !isAutoManagedLiveFastConfig(rankOneConfig, selectedExpNameRef.current)) {
        try {
          await syncRankOneConfigToVoiceProfile(rankOneConfig, { context: 'gpu-ready rank #1 config' });
        } catch {
          // Best effort: still re-fetch below so the UI reflects the server state.
        }
      }
      loadActiveVoiceProfile();
    }
    window.addEventListener('voice-cloning-gpu-ready', handleGpuReady);
    return () => window.removeEventListener('voice-cloning-gpu-ready', handleGpuReady);
  }, []);

  // A failed or not-ready /inference/status response (cold Lambda, network blip,
  // api_v2 busy with a warm synth) flips serverReady off while the loaded paths
  // stay matching — so the auto-load effect never re-fires and, without this,
  // nothing else re-checks status: the page would sit on "Loading the voice"
  // until a manual refresh. Re-poll until the server reports ready again.
  useEffect(() => {
    if (serverReady || !modelsFetched) return undefined;
    const id = window.setInterval(() => { checkStatus(); }, 8000);
    return () => window.clearInterval(id);
  }, [serverReady, modelsFetched]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [liveSpeech.messages.length, liveSpeech.phase]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!playbackReady) { audio.pause(); audio.removeAttribute('src'); audio.load(); return; }
    if (audio.getAttribute('src') !== liveSpeech.audioSrc) { audio.src = liveSpeech.audioSrc; audio.load(); }
    audio.play().catch(() => {});
  }, [liveSpeech.audioSrc, liveSpeech.selectedReplyId, playbackReady]);

  // The reply plays as a chain of audio clips that only advances on the `ended`
  // event. If one clip fails to load/decode (a transient hiccup), `ended` never
  // fires and the whole reply would stall — the voice "cuts off" and only a
  // manual replay recovers. Retry the failed clip once, then skip it so the rest
  // of the reply keeps playing.
  const audioErrorStateRef = useRef({ src: '', retried: false });
  function handleLiveAudioError() {
    const audio = audioRef.current;
    // Ignore errors that aren't from an active reply clip (e.g. clearing the src
    // during interruption/teardown fires an error on an empty element).
    if (!audio || liveSpeech.phase !== 'speaking') return;
    const { action, retryState } = nextAudioErrorAction(audioErrorStateRef.current, liveSpeech.audioSrc);
    audioErrorStateRef.current = retryState;
    if (action === 'retry') {
      try { audio.load(); audio.play().catch(() => { liveSpeech.onAudioEnded(); }); }
      catch { liveSpeech.onAudioEnded(); }
    } else if (action === 'skip') {
      liveSpeech.onAudioEnded();
    }
  }

  const selectedModelLoaded = isSelectedModelLoaded({
    serverReady, selectedGPT, selectedSoVITS, loadedGPTPath, loadedSoVITSPath,
  });
  // What the voice indicator reports. A pinned voice does not need its weights
  // resident ahead of time, so the shared GPU holding someone else's model is no
  // reason to show this user "Loading..." — the distinction the banner below
  // draws is weights-vs-references, and with pinning only references remain.
  const voiceModelReady = selectedModelLoaded
    || (serverReady && selectedVoicePinsOwnWeights);
  // A stock voice needs no weights on the GPU and no reference clip, so it is
  // ready the moment it is picked — which is also why it keeps the kiosk usable
  // while the GPU is cold or the inference group is still scaling up. The rest of
  // the rule, including why the loaded-model report no longer gates this page,
  // lives with isVoiceReadyToSynthesize in lib/modelLoading.js.
  const isReady = isVoiceReadyToSynthesize({
    usingStandardVoice,
    serverReady,
    selectedModelLoaded,
    pinsOwnWeights: selectedVoicePinsOwnWeights,
    resolvesPerRequest: selectedVoiceResolvesPerRequest,
    hasReferenceParams: Boolean(liveRefParams),
  });
  // Faculty users without an owned or explicitly selected voice are intentionally
  // left unselected. That is an idle choice state, not an in-progress model load.
  const waitingForFacultyVoiceSelection = canEditInstructions
    && modelsFetched
    && !selectedProfile
    && !usingStandardVoice;
  // Scoped to the cloned-voice pipeline: the TTS panel's reference picking,
  // per-chunk regeneration and pronunciation dictionary are all GPT-SoVITS
  // machinery with no ElevenLabs equivalent.
  const ttsReady = isReady && !usingStandardVoice;
  // Last line of defence against a raw CloudFront/nginx 503/404 page ever rendering
  // as an error banner — strip HTML and swallow bare gateway errors.
  const displayModelError = useMemo(() => sanitizeBackendError(modelError), [modelError]);
  const isTtsMode = mode === 'tts';

  // Generation pre-warm now lives on the inference worker: every model load fires a
  // throwaway synth via /ref-audio/warm, so the first real clip is hot for all
  // consumers (this TTS tab and external callers like the chatbot). No client-side
  // warm-up needed here.
  const ttsFastHistory = getTtsHistoryByRoute(ttsHistory, 'fast');
  const ttsFullHistory = getTtsHistoryByRoute(ttsHistory, 'full');
  const isListening = liveSpeech.isMicInputEnabled && (liveSpeech.phase === 'listening' || liveSpeech.phase === 'thinking');
  const canBargeIn = liveSpeech.isMicInputEnabled || liveSpeech.isBargeInArmed;
  const meterActive = (liveSpeech.isMicInputEnabled && (liveSpeech.phase === 'listening' || liveSpeech.phase === 'thinking'))
    || (canBargeIn && liveSpeech.phase === 'speaking');
  const buttonDisabled = !isReady || liveSpeech.phase === 'connecting' || liveSpeech.phase === 'stopping';
  // Typing is the way in for anyone without a working microphone. Sending opens
  // the conversation by itself, so it is live from idle too; it only closes off
  // while a reply is being generated or the session is coming up or going down.
  const canSendText = isReady && !['connecting', 'thinking', 'stopping'].includes(liveSpeech.phase);

  const phaseLabel = {
    idle: 'Start', connecting: 'Connecting',
    listening: liveSpeech.isMicInputEnabled ? 'Mic on' : 'Mic off',
    thinking: liveSpeech.isMicInputEnabled ? 'Mic on' : 'Mic off',
    speaking: liveSpeech.isMicInputEnabled ? 'Mic on' : 'Mic off',
    stopping: 'Stopping',
  }[liveSpeech.phase] || 'Start';

  // Typing and the mic share one composer row — the same treatment the gi
  // composer got in 81fd3c7. The mic is a 44px circle matching the send button
  // instead of the old 64px hero stacked above the input, so the two ways of
  // asking read as equal and the transcript gets the height back.
  const micButton = (
    <button
      type="button"
      className={cn(
        'inline-flex size-11 shrink-0 items-center justify-center rounded-full transition active:scale-95',
        buttonDisabled
          ? 'cursor-not-allowed bg-slate-100 text-slate-300'
          : isListening
            // Listening is the one state that must read as live at this size,
            // so it keeps a ring now that the old pulsing halo is gone.
            ? 'text-white shadow-sm ring-2 ring-red-300/50 [background:linear-gradient(135deg,hsl(0,84%,60%)_0%,hsl(340,82%,55%)_100%)]'
            : isConversationActive
              ? 'bg-slate-200 text-slate-600 hover:bg-slate-300'
              : 'text-white shadow-sm shadow-primary/35 hover:opacity-90 [background:linear-gradient(135deg,hsl(224,85%,58%)_0%,hsl(250,80%,62%)_100%)]'
      )}
      onClick={liveSpeech.toggle}
      disabled={buttonDisabled}
      aria-pressed={liveSpeech.isMicInputEnabled}
      title={phaseLabel}
    >
      <span className="sr-only">{phaseLabel}</span>
      {liveSpeech.isMicInputEnabled || liveSpeech.phase === 'idle'
        ? <Mic size={18} />
        : <MicOff size={18} />}
    </button>
  );

  const statusText = liveSpeech.notice
    || (!liveSpeech.isMicInputEnabled && isConversationActive && liveSpeech.phase !== 'speaking' ? 'Mic off — voice chat still open.' : '')
    || {
      idle: 'Tap the mic to start.',
      connecting: 'Connecting...',
      listening: liveSpeech.isMicInputEnabled ? 'Listening...' : 'Mic off — voice chat still open.',
      thinking: 'Thinking...',
      speaking: liveSpeech.audioSrc ? (canBargeIn ? 'Speaking — speak to interrupt.' : 'Playing voice...') : 'Preparing voice...',
      stopping: 'Stopping...',
    }[liveSpeech.phase] || 'Tap the mic to start.';

  function handleChatbotSystemPromptChange(value) {
    setChatbotSystemPrompt(value);
    persistChatbotSystemPrompt(value, { category: chatbotCategory });
  }

  /**
   * Switch the panel to another lecture's assistant.
   *
   * The panel's contents are replaced from that category's own browser-local
   * draft, or left empty for the load effect to fill from what is deployed.
   * Nothing carries over: text left on screen from the previous lecture would be
   * published under this one's name on the next click of Publish.
   */
  function handleSelectChatbotCategory(value) {
    const next = normalizeChatbotCategory(value);
    if (!next) {
      setChatbotDeployState({
        status: 'error',
        message: 'Use lowercase letters, numbers and hyphens for the lecture id.',
      });
      return;
    }
    setChatbotCategory(next);
    setNewChatbotCategory('');
    setAddingChatbotCategory(false);
    setChatbotDeployState({ status: 'idle', message: '' });
    setChatbotDocError('');
    setChatbotSystemPrompt(
      hasStoredChatbotSystemPrompt({ category: next })
        ? resolveChatbotSystemPrompt({ category: next })
        : '',
    );
    setChatbotDocuments(
      hasStoredChatbotDocuments({ category: next })
        ? resolveChatbotDocuments({ category: next })
        : [],
    );
  }

  async function handleResetChatbotSystemPrompt() {
    // The GI bleeding lesson prompt — a known-good, fully worked example for a
    // lecturer to read and edit down, not a subject the platform imposes.
    //
    // Deliberately NOT getBundledChatbotSystemPrompt(): that constant is the
    // fallback the lecture site runs when the deployed-prompt fetch comes back
    // empty, so it has to stay subject-free. A neurology lecture that lost its
    // fetch must not start teaching gastroenterology. Reset is a human action on
    // the authoring site, so it can hand back a specimen prompt safely.
    //
    // Loaded on click rather than imported at the top because main.jsx imports
    // App.jsx statically, so this page is bundled into the lecture build too; a
    // static import would put ~30KB of GI text in a bundle that can never reach
    // this handler (the editor is hidden there — see appMode showInstructionsEditor).
    const envOverride = (import.meta.env?.VITE_CHATBOT_SYSTEM_PROMPT || '').trim();
    const { GI_BLEEDING_PROMPT_TEMPLATE } = await import('@/lib/giBleedingPromptTemplate');
    const next = envOverride || GI_BLEEDING_PROMPT_TEMPLATE;
    clearChatbotSystemPrompt({ category: chatbotCategory });
    setChatbotSystemPrompt(next);
    setChatbotDeployState({ status: 'idle', message: '' });
  }

  async function handleDeployChatbotSystemPrompt() {
    setChatbotDeployState({ status: 'deploying', message: 'Publishing…' });
    try {
      // Both halves of the panel ship together: the typed instructions and the
      // uploaded PDFs they refer to. Deploying the text alone is what used to
      // leave students with a prompt citing papers the model never received.
      const result = await deployChatbotSystemPrompt({
        prompt: chatbotSystemPrompt,
        documents: chatbotDocuments,
        // The voice the lecturer is listening to is the voice students get.
        // Publishing the prompt without it would leave the lecture site on
        // whatever its build pinned — the lecturer would hear one voice while
        // approving a lecture that speaks in another.
        voiceProfileId: speakingVoiceProfileId,
        category: chatbotCategory,
      });
      // The panel's contents are now the shared default, so a "Reset to default"
      // here returns to what was just deployed rather than the bundled constant.
      setDeployedChatbotSystemPrompt(chatbotSystemPrompt);
      setDeployedChatbotDocuments(chatbotDocuments);
      clearChatbotSystemPrompt({ category: chatbotCategory });
      clearChatbotDocuments({ category: chatbotCategory });
      setChatbotDeployState({
        status: 'deployed',
        message: result?.updatedAt
          ? `Published ${chatbotCategory} ${new Date(result.updatedAt).toLocaleTimeString()}`
          : `Published ${chatbotCategory}`,
      });
      // A first deploy is what creates a lecture, so the picker only learns about
      // it now.
      refreshChatbotCategories();
    } catch (error) {
      setChatbotDeployState({ status: 'error', message: error?.message || 'Publish failed.' });
    }
  }

  async function handleAddChatbotDocuments(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    setChatbotDocError('');
    let next = chatbotDocuments;
    for (const file of files) {
      if (file.type !== 'application/pdf') {
        setChatbotDocError(`${file.name}: not a PDF.`);
        continue;
      }
      try {
        const doc = await extractPdfText(file);
        if (!doc.text) {
          setChatbotDocError(`${file.name}: no extractable text (scanned image?).`);
          continue;
        }
        next = addChatbotDocument(next, doc);
      } catch {
        setChatbotDocError(`${file.name}: could not read PDF.`);
      }
    }
    setChatbotDocuments(next);
    const { ok } = persistChatbotDocuments(next, { category: chatbotCategory });
    if (!ok) setChatbotDocError('Documents too large to save; kept for this session only.');
  }

  function handleRemoveChatbotDocument(name) {
    const next = removeChatbotDocument(chatbotDocuments, name);
    setChatbotDocuments(next);
    persistChatbotDocuments(next, { category: chatbotCategory });
  }

  // Live Fast / Live Full engine toggle — shared so it can render in both the
  // full-app top bar and the kiosk (where the rest of the top-bar chrome is hidden).
  const engineToggle = (
    <div className="flex items-center gap-2">
      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-widest text-slate-400">Engine</span>
      <div className="inline-flex rounded-xl border border-slate-200 bg-white p-0.5">
        {[
          { value: 'fast', label: 'Live Fast' },
          // Live Full is kept wired up but hidden from the UI for now — flip
          // hidden to false to expose it again.
          { value: 'full', label: 'Live Full', hidden: true },
        ].filter((option) => !option.hidden).map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setLiveEngine(option.value)}
            className={cn(
              'rounded-lg px-3 py-1 text-xs font-medium transition-colors',
              liveEngine === option.value
                ? 'bg-primary/10 text-primary'
                : 'text-slate-500 hover:text-slate-800'
            )}
            title={option.value === 'full'
              ? 'Higher-accuracy /inference route; queues each phrase as soon as it is generated.'
              : 'Fastest first-word latency; live sentence route.'}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    /* flex-1 + min-h-0 lets this fill the main flex column */
    <div className="animate-fade-in flex min-h-0 flex-1 flex-col gap-3">

      {/* ── Top bar: title + compact controls ── */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl">
          <span className="bg-gradient-to-br from-slate-900 via-slate-800 to-primary/80 bg-clip-text text-transparent">
            {isTtsMode ? 'Text to Speech' : 'Live Voice Chat'}
          </span>
        </h1>

        {/* Kiosk: expose only the engine toggle (the rest of the top bar is hidden). */}
        {kiosk && !isTtsMode && (
          <div className="flex flex-1 flex-wrap items-center gap-3">
            {engineToggle}
            {/* Mobile: open the Assistant-instructions drawer (in-flow sidebar at lg+). */}
            {canEditInstructions && (
            <button
              type="button"
              onClick={() => setShowInstructions(true)}
              className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 lg:hidden"
            >
              <Pencil size={13} />
              Instructions
            </button>
            )}
          </div>
        )}

        {!kiosk && (
        <div className="flex flex-1 flex-wrap items-center gap-3">
          {/* Voice model selector */}
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-[11px] font-semibold uppercase tracking-widest text-slate-400">Voice</span>
                  <Select
                    value={selectedPersonKey}
                    onValueChange={handleVoiceSelection}
                    disabled={isConversationActive || savingProfile || availableProfiles.length === 0}
                  >
              <SelectTrigger className="h-9 w-44 rounded-xl border-slate-200 bg-white text-sm shadow-none">
                <SelectValue placeholder={modelsFetched ? 'Select model' : 'Loading...'} />
              </SelectTrigger>
              <SelectContent>
                {availableProfiles.map((p) => (
                  <SelectItem key={p.key} value={p.key}>{p.displayName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Language selector */}
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-[11px] font-semibold uppercase tracking-widest text-slate-400">Language</span>
            <Select value={liveLanguage} onValueChange={setSelectedLanguage} disabled={isConversationActive}>
              <SelectTrigger className="h-9 w-32 rounded-xl border-slate-200 bg-white text-sm shadow-none">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LIVE_LANGUAGE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Synthesis engine toggle (chat only) — Live Fast vs Live Full */}
          {!isTtsMode && engineToggle}

          {/* Model status + refresh */}
          <div className="ml-auto flex flex-col items-end gap-1.5">
            <div className="flex items-center gap-3">
              <span className={cn(
                'flex items-center gap-1.5 text-xs',
                modelSelectionOnly ? 'text-blue-600' : voiceModelReady ? 'text-emerald-600' : loadingModel || selectedProfile || !modelsFetched ? 'text-blue-500' : 'text-slate-400'
              )}>
                {/* A selected-but-not-loaded profile is about to auto-load, so show
                    it as loading rather than the confusing "No model". */}
                {loadingModel || (!voiceModelReady && (selectedProfile || !modelsFetched))
                  ? <Loader2 size={11} className="animate-spin" />
                  : <span className={cn('h-2 w-2 rounded-full', modelSelectionOnly ? 'bg-blue-500' : voiceModelReady ? 'bg-emerald-500' : 'bg-slate-300')} />
                }
                {modelSelectionOnly ? 'Selected' : voiceModelReady ? 'Ready' : loadingModel || selectedProfile || !modelsFetched ? 'Loading...' : 'No model'}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={saveSelectedVoiceProfile}
                disabled={!ttsReady || isConversationActive || loadingModel || savingProfile}
                className="h-8 rounded-xl border-slate-200 bg-white shadow-none"
              >
                {savingProfile ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                {savingProfile ? 'Saving...' : 'Save voice'}
              </Button>
              <button
                type="button"
                onClick={() => { autoLoadAttemptKeyRef.current = ''; fetchModels(); checkStatus(); loadActiveVoiceProfile(); }}
                disabled={isConversationActive || loadingModel || savingProfile || loadingActiveVoiceProfile}
                title="Refresh models"
                className="text-slate-400 transition-colors hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <RefreshCw size={13} />
              </button>
            </div>
            <div className="max-w-full text-right text-[11px]">
              {activeVoiceProfileError ? (
                <span className="text-red-500">{activeVoiceProfileError}</span>
              ) : (
                <span className="inline-flex flex-wrap items-center justify-end gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-slate-500">
                  <span className="uppercase tracking-widest text-slate-400">Active voice profile</span>
                  <span className="font-medium text-slate-700">
                    {loadingActiveVoiceProfile ? 'Loading...' : formatActiveVoiceProfileSummary(activeVoiceProfile)}
                  </span>
                </span>
              )}
            </div>
          </div>
        </div>
        )}
      </div>

      <FloatingNotice notice={gpuNotice} onClose={() => setGpuNotice(null)} />

      {displayModelError && (
        <p className="rounded-xl border border-red-100 bg-red-50 px-4 py-2.5 text-sm text-red-600">{displayModelError}</p>
      )}

      {!isReady && !displayModelError && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-100 bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
          {/* The whole startup sequence (fetch models -> auto-select -> auto-load ->
              pick references) runs by itself, so just say "loading" instead of
              surfacing each internal step as if the user had to act on it. */}
          {modelsFetched && availableProfiles.length === 0 ? (
            'No trained models found. Train a voice first, then return here.'
          ) : waitingForFacultyVoiceSelection ? (
            'Select a voice to begin.'
          ) : (
            <>
              <Loader2 size={14} className="shrink-0 animate-spin" />
              {!voiceModelReady
                ? 'Loading the voice — this may take a moment.'
                : 'Almost ready — preparing the voice references.'}
            </>
          )}
        </div>
      )}

      {!isTtsMode && !liveSpeech.speechApiAvailable && (
        <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-2.5 text-sm text-red-600">
          This browser does not support live audio processing.
        </div>
      )}

      {isTtsMode ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px] xl:grid-cols-[minmax(0,1fr)_420px]">
          <section className="rounded-2xl border border-slate-100 bg-white p-5 shadow-[0_4px_32px_-8px_rgba(0,0,0,0.09)]">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-800">Input text</p>
                <p className="mt-1 text-xs text-slate-400">
                  {speakingProfile?.displayName || 'Selected voice'} · {liveLanguageConfig.label} · {loadedConfigId || 'current config'}
                </p>
              </div>
              <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-medium text-slate-500">
                Browser download only
              </span>
            </div>
            <Textarea
              value={ttsText}
              onChange={(event) => {
                setTtsText(event.target.value);
                setFullOovAcknowledgedKey('');
                setTtsWarning('');
              }}
              disabled={!ttsReady || ttsFastGenerating || streamingRoute !== null}
              placeholder={
                ttsReady
                  ? 'Type the text to synthesize.'
                  : usingStandardVoice
                    ? 'Text to Speech needs a trained voice — standard voices work in the chat only.'
                    : 'Load a voice profile first.'
              }
              className="mt-4 min-h-[220px] rounded-xl border-slate-200 bg-white text-sm leading-6 shadow-none"
            />
            {ttsError && (
              <p className="mt-3 rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-600">{ttsError}</p>
            )}
            {ttsWarning && (
              <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{ttsWarning}</p>
            )}
            {ttsFastGenerating && (
              <div className="mt-3 rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                <p>
                  {ttsFastProgress.total > 0
                    ? `Synthesizing sentence ${Math.min(ttsFastProgress.current, ttsFastProgress.total)} of ${ttsFastProgress.total}...`
                    : 'Preparing Live Fast sentences...'}
                </p>
                {ttsFastProgress.text && (
                  <p className="mt-1 line-clamp-2 text-xs text-emerald-700/80">{ttsFastProgress.text}</p>
                )}
              </div>
            )}
            {streamingRoute && (
              <p className="mt-3 rounded-xl border border-sky-100 bg-sky-50 px-3 py-2 text-sm text-sky-700">
                {ttsInference.totalChunks > 0
                  ? `Full Inference: evaluating up to five takes for chunk ${Math.min(ttsInference.completedChunks + 1, ttsInference.totalChunks)} of ${ttsInference.totalChunks}…`
                  : 'Preparing Full Inference maximum-quality synthesis…'}
              </p>
            )}
            <audio ref={queuedTtsAudioRef} className="hidden" onEnded={handleQueuedTtsEnded} />
            {queuePlayback.active && (
              <div className="mt-3 flex items-center gap-2 rounded-xl border border-indigo-100 bg-indigo-50 px-3 py-2 text-sm text-indigo-700">
                <span className="font-medium">
                  {queuePlayback.paused ? 'Queue paused' : 'Playing queue…'}
                </span>
                <div className="ml-auto flex items-center gap-2">
                  {queuePlayback.paused ? (
                    <Button type="button" size="sm" variant="outline" onClick={resumeQueuedTtsPlayback} className="h-8 rounded-lg">
                      <PlayCircle size={14} /> Resume
                    </Button>
                  ) : (
                    <Button type="button" size="sm" variant="outline" onClick={pauseQueuedTtsPlayback} className="h-8 rounded-lg">
                      <Square size={14} /> Pause
                    </Button>
                  )}
                  <Button type="button" size="sm" variant="outline" onClick={stopQueuedTtsPlayback} className="h-8 rounded-lg">
                    <X size={14} /> Stop
                  </Button>
                </div>
              </div>
            )}
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Button
                type="button"
                onClick={() => generateTextToSpeech('fast')}
                disabled={!ttsReady || !ttsText.trim() || ttsFastGenerating || streamingRoute !== null}
                className="h-10 rounded-xl"
              >
                {(ttsFastGenerating || streamingRoute === 'fast') ? <Loader2 size={14} className="animate-spin" /> : <Volume2 size={14} />}
                Live Fast TTS
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => generateTextToSpeech('fastQueued')}
                disabled={!ttsReady || !ttsText.trim() || ttsFastGenerating || streamingRoute !== null}
                className="h-10 rounded-xl border-slate-200 bg-white shadow-none"
              >
                {ttsFastGenerating ? <Loader2 size={14} className="animate-spin" /> : <Volume2 size={14} />}
                Live Fast Queue
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => generateTextToSpeech('full')}
                disabled={!ttsReady || !ttsText.trim() || ttsFastGenerating || oovScanning || streamingRoute !== null}
                className="h-10 rounded-xl border-slate-200 bg-white shadow-none"
              >
                {(oovScanning || streamingRoute === 'full') ? <Loader2 size={14} className="animate-spin" /> : <PlayCircle size={14} />}
                Full Inference TTS
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => generateTextToSpeech('fullQueued')}
                disabled={!ttsReady || !ttsText.trim() || ttsFastGenerating || oovScanning || streamingRoute !== null}
                className="h-10 rounded-xl border-slate-200 bg-white shadow-none"
              >
                {(oovScanning || streamingRoute === 'fullQueued') ? <Loader2 size={14} className="animate-spin" /> : <PlayCircle size={14} />}
                Full Inference Queue
              </Button>
            </div>

            {/* Pronunciation pre-check: flags words the engine would pronounce by neural
                guess (not the dictionary), so an admin can add ARPAbet overrides before
                a demo instead of discovering them by ear. */}
            <div className="mt-4 rounded-xl border border-slate-100 bg-slate-50/60 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-800">Pronunciation check</p>
                  <p className="mt-0.5 text-xs text-slate-400">
                    Scan the script for words missing from the dictionary (likely mispronounced).
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleScanOovWords}
                  disabled={!ttsText.trim() || oovScanning}
                  className="h-9 shrink-0 rounded-lg border-slate-200 bg-white shadow-none"
                >
                  {oovScanning ? <Loader2 size={14} className="animate-spin" /> : <ScanSearch size={14} />}
                  Scan text
                </Button>
              </div>
              {oovScanError && (
                <p className="mt-2 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-600">{oovScanError}</p>
              )}
              {oovScan && !oovScanError && (
                oovScan.flagged.length === 0 ? (
                  <p className="mt-2 rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                    All {oovScan.totalWords} words resolve from the dictionary — nothing to add.
                  </p>
                ) : (
                  <div className="mt-2">
                    <p className="text-xs text-slate-500">
                      {oovScan.flagged.length} word{oovScan.flagged.length === 1 ? '' : 's'} not in the dictionary.
                      Click one to start an override below.
                      {!oovScan.dictionaryLoaded && ' (Warning: dictionary not loaded on the server — results may be unreliable.)'}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {oovScan.flagged.map((word) => (
                        <button
                          key={word}
                          type="button"
                          onClick={() => startOverrideForWord(word)}
                          title="Add a pronunciation override for this word"
                          className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 transition hover:border-amber-300 hover:bg-amber-100"
                        >
                          {word}
                        </button>
                      ))}
                    </div>
                  </div>
                )
              )}
            </div>

            <div className="hidden">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-800">Live Full settings</p>
                  <p className="mt-0.5 text-xs text-slate-400">
                    {loadedLiveFullConfigId || 'default from Live Fast #1 references'} · Full Inference only
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => saveCurrentLiveFullConfig()}
                  disabled={!selectedVoiceProfileId || !voiceConfigs[0] || Boolean(savingLiveFullConfigId)}
                  className="h-8 rounded-lg"
                >
                  {savingLiveFullConfigId && !liveFullConfigs.some((item) => item.configId === savingLiveFullConfigId)
                    ? <Loader2 size={13} className="animate-spin" />
                    : <Check size={13} />}
                  Save new
                </Button>
              </div>

              <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
                <div className="space-y-4">
                  <div>
                    <Label className="mb-2 block text-[11px] font-semibold uppercase tracking-widest text-slate-400">Primary reference</Label>
                    <Select
                      value={liveFullRefAudioPath}
                      onValueChange={handleLiveFullPrimaryReferenceChange}
                      disabled={loadingTrainingAudio || trainingAudioFiles.length === 0 || streamingRoute !== null}
                    >
                      <SelectTrigger className="h-10 rounded-xl border-slate-200 bg-white shadow-none">
                        <SelectValue placeholder={loadingTrainingAudio ? 'Loading...' : 'Select primary'} />
                      </SelectTrigger>
                      <SelectContent>
                        {trainingAudioFiles.map((f) => {
                          const candidate = referenceCandidateMap[f.path];
                          return (
                            <SelectItem key={f.path} value={f.path}>
                              <span className="flex min-w-0 items-center gap-2">
                                <span className="truncate">{f.filename}</span>
                                {candidate && <span className="text-[10px] text-slate-400">{Math.round(candidate.score)}</span>}
                              </span>
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <Label className="mb-2 block text-[11px] font-semibold uppercase tracking-widest text-slate-400">Auxiliary clips</Label>
                    <div className="max-h-40 overflow-y-auto rounded-xl border border-slate-200 bg-white p-2">
                      {trainingAudioFiles.length === 0 ? (
                        <p className="px-2 py-1 text-xs text-slate-400">{loadingTrainingAudio ? 'Loading...' : 'No clips found.'}</p>
                      ) : (
                        trainingAudioFiles.filter((f) => f.path !== liveFullRefAudioPath).map((f) => {
                          const checked = liveFullAuxRefAudios.some((item) => item.path === f.path);
                          return (
                            <div key={f.path} className="flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-50">
                              <Checkbox
                                checked={checked}
                                onCheckedChange={(v) => handleLiveFullAuxToggle(f, Boolean(v))}
                                disabled={streamingRoute !== null || (!checked && liveFullAuxRefAudios.length >= 5)}
                              />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-mono text-xs text-slate-700">{f.filename}</span>
                                {f.transcript && <span className="mt-0.5 block truncate text-xs text-slate-400">{f.transcript}</span>}
                              </span>
                            </div>
                          );
                        })
                      )}
                    </div>
                    <p className="mt-1.5 text-xs text-slate-400">
                      {liveFullAuxRefAudios.length}/5 auxiliary · Primary: {liveFullRefAudioPath ? fallbackName(liveFullRefAudioPath) : 'none'}
                    </p>
                  </div>

                  <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_140px]">
                    <div>
                      <Label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-widest text-slate-400">Primary transcript</Label>
                      <Textarea
                        className="min-h-[82px] rounded-xl border-slate-200 bg-white shadow-none leading-6"
                        value={liveFullPromptText}
                        onChange={(event) => {
                          setLiveFullPromptText(event.target.value);
                        }}
                        disabled={streamingRoute !== null}
                      />
                    </div>
                    <div>
                      <Label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-widest text-slate-400">Ref language</Label>
                      <Select
                        value={liveFullPromptLang}
                        onValueChange={(value) => {
                          setLiveFullPromptLang(value);
                        }}
                        disabled={streamingRoute !== null}
                      >
                        <SelectTrigger className="h-10 rounded-xl border-slate-200 bg-white shadow-none"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="en">English</SelectItem>
                          <SelectItem value="zh">Chinese</SelectItem>
                          <SelectItem value="ja">Japanese</SelectItem>
                          <SelectItem value="ko">Korean</SelectItem>
                          <SelectItem value="auto">Auto</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    {[
                      { label: 'Speed', display: liveFullSpeed.toFixed(1) + 'x', min: 0.5, max: 2.0, step: 0.1, val: liveFullSpeed, set: setLiveFullSpeed },
                      { label: 'Top K', display: String(liveFullTopK), min: 1, max: 50, step: 1, val: liveFullTopK, set: setLiveFullTopK },
                      { label: 'Top P', display: liveFullTopP.toFixed(2), min: 0, max: 1, step: 0.05, val: liveFullTopP, set: setLiveFullTopP },
                      { label: 'Temperature', display: liveFullTemperature.toFixed(2), min: 0, max: 1, step: 0.05, val: liveFullTemperature, set: setLiveFullTemperature },
                      { label: 'Max chunk words', display: liveFullMaxChunkWords === 0 ? 'Auto · 240 chars' : String(liveFullMaxChunkWords), min: 0, max: 100, step: 10, val: liveFullMaxChunkWords, set: setLiveFullMaxChunkWords },
                      { label: 'Max sentences / chunk', display: String(liveFullMaxSentences), min: 1, max: 5, step: 1, val: liveFullMaxSentences, set: setLiveFullMaxSentences },
                    ].map(({ label, display, min, max, step, val, set }) => (
                      <div key={label} className="space-y-3 rounded-xl border border-slate-200 bg-white p-3">
                        <div className="flex items-center justify-between">
                          <Label className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">{label}</Label>
                          <span className="font-mono text-sm font-semibold text-slate-700">{display}</span>
                        </div>
                        <Slider min={min} max={max} step={step} value={[val]} onValueChange={([v]) => set(v)} disabled={streamingRoute !== null} />
                      </div>
                    ))}
                    <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-3 md:col-span-2">
                      <div className="flex items-center justify-between">
                        <Label className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">Repetition Penalty</Label>
                        <span className="font-mono text-sm font-semibold text-slate-700">{liveFullRepPenalty.toFixed(2)}</span>
                      </div>
                      <Slider min={1.0} max={2.0} step={0.05} value={[liveFullRepPenalty]} onValueChange={([v]) => setLiveFullRepPenalty(v)} disabled={streamingRoute !== null} />
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="rounded-lg border border-slate-100 bg-white px-3 py-2 text-xs text-slate-500">
                    <p className="font-semibold text-slate-700">Current Live Full config</p>
                    <p className="mt-1 truncate">
                      Refs from Live Fast #1: {liveFastRankOneReferenceSummary.primaryName} - speed {liveFullSettings.speed.toFixed(1)} - temp {liveFullSettings.temperature.toFixed(2)}
                    </p>
                    <p className="mt-1 truncate">
                      top k {liveFullSettings.topK} · top p {liveFullSettings.topP.toFixed(2)} · rep {liveFullSettings.repPenalty.toFixed(2)}
                    </p>
                    <p className="mt-1 truncate">
                      chunks {liveFullSettings.maxChunkWords > 0 ? `${liveFullSettings.maxChunkWords} words` : 'auto (240 chars)'} · max {liveFullSettings.maxSentencesPerChunk} sentence{liveFullSettings.maxSentencesPerChunk === 1 ? '' : 's'}
                    </p>
                  </div>

                  <div className="rounded-lg border border-slate-100 bg-white p-2">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-slate-700">Saved Live Full configs</p>
                      <button
                        type="button"
                        onClick={() => loadVoiceConfigs(selectedVoiceProfileId)}
                        disabled={loadingVoiceConfigs || !selectedVoiceProfileId}
                        className="text-xs font-medium text-slate-500 hover:text-slate-800 disabled:opacity-40"
                      >
                        {loadingVoiceConfigs ? 'Loading...' : 'Refresh'}
                      </button>
                    </div>
                    {liveFullConfigs.length === 0 ? (
                      <p className="rounded-lg border border-amber-100 bg-amber-50 px-2 py-2 text-xs text-amber-700">
                        No saved Live Full configs yet. The current default uses Live Fast #1 references with Full defaults.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {liveFullConfigs.map((config, index) => {
                          const defaults = config.inferenceMetadata?.defaults || {};
                          const busy = savingLiveFullConfigId === config.configId;
                          const loaded = loadedLiveFullConfigId === config.configId;
                          return (
                            <div key={config.configId} className={cn('rounded-lg border bg-slate-50 p-2', loaded ? 'border-blue-200 ring-1 ring-blue-100' : 'border-slate-200')}>
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="truncate text-xs font-semibold text-slate-800">#{index + 1} {config.configName || config.configId}</p>
                                  <p className="mt-0.5 truncate text-[11px] text-slate-500">
                                    Refs from Live Fast #1: {liveFastRankOneReferenceSummary.primaryName} ·
                                    speed {defaults.speed_factor ?? 'n/a'} · temp {defaults.temperature ?? 'n/a'}
                                  </p>
                                </div>
                                <div className="flex shrink-0 flex-wrap justify-end gap-1">
                                  <button type="button" onClick={() => loadSavedLiveFullConfig(config)} disabled={busy || streamingRoute !== null} className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-40">Load</button>
                                  <button type="button" onClick={() => saveCurrentLiveFullConfig(config)} disabled={busy || !loaded} className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-40">Update</button>
                                  <button type="button" onClick={() => deleteSavedLiveFullConfig(config.configId)} disabled={busy} className="rounded-md border border-red-100 bg-white px-2 py-1 text-[11px] text-red-500 hover:bg-red-50 disabled:opacity-40">Delete</button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  {liveFullMessage && <p className="rounded-lg border border-slate-100 bg-white px-3 py-2 text-xs text-slate-500">{liveFullMessage}</p>}
                </div>
              </div>
            </div>

            <div className="mt-5 rounded-xl border border-slate-100 bg-slate-50 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-800">Pronunciation dictionary</p>
                  <p className="mt-0.5 text-xs text-slate-400">Globally unique English ARPAbet entries, organized by category.</p>
                </div>
                <Select value={pronunciationCategory} onValueChange={setPronunciationCategory}>
                  <SelectTrigger className="h-8 w-[130px] rounded-lg border-slate-200 bg-white text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRONUNCIATION_CATEGORIES.map((category) => (
                      <SelectItem key={category} value={category}>{category}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <form onSubmit={searchPronunciationEntries} className="mt-3 flex gap-2">
                <Input
                  value={pronunciationSearch}
                  onChange={(event) => {
                    setPronunciationSearch(event.target.value);
                    if (!event.target.value.trim()) setPronunciationSearchResults(null);
                  }}
                  placeholder="Search words across all categories"
                  aria-label="Search pronunciation dictionary across all categories"
                  className="h-9 rounded-lg bg-white"
                />
                {pronunciationSearchResults && (
                  <Button type="button" size="sm" variant="ghost" onClick={clearPronunciationSearch} disabled={pronunciationSearching} className="h-9 rounded-lg px-2 text-slate-500">
                    <X size={14} />
                    Clear
                  </Button>
                )}
                <Button type="submit" size="sm" variant="outline" disabled={pronunciationSearching || !pronunciationSearch.trim()} className="h-9 rounded-lg border-slate-200 bg-white">
                  {pronunciationSearching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                  Search
                </Button>
              </form>
              {pronunciationSearchResults && (
                <p className="mt-1 text-xs text-slate-400">
                  {pronunciationSearchResults.totalMatches} match{pronunciationSearchResults.totalMatches === 1 ? '' : 'es'} across all categories
                  {pronunciationSearchResults.truncated ? ' · showing first 100' : ''}
                </p>
              )}
              <div className="mt-3">
                <Input ref={pronunciationWordInputRef} value={pronunciationWord} onChange={(event) => setPronunciationWord(event.target.value)} placeholder="Word" className="h-9 rounded-lg bg-white" />
              </div>
              <Input value={pronunciationArpabet} onChange={(event) => setPronunciationArpabet(event.target.value)} placeholder="ARPAbet, e.g. EH1 N Z AY0 M" className="mt-2 h-9 rounded-lg bg-white font-mono text-xs" />
              <Input
                value={pronunciationSynthesisAlias}
                onChange={(event) => setPronunciationSynthesisAlias(event.target.value)}
                placeholder="Synthesis spelling (optional), e.g. stereo chemistry"
                className="mt-2 h-9 rounded-lg bg-white text-xs"
              />
              <p className="mt-1 text-xs text-slate-400">
                Only this exact saved word is rewritten for speech and verification. Use a reviewed multi-part English spelling.
              </p>
              <label className="mt-2 flex items-start gap-2 rounded-lg border border-slate-100 bg-white px-3 py-2">
                <Checkbox
                  checked={pronunciationVerifyPhonemes}
                  onCheckedChange={(checked) => setPronunciationVerifyPhonemes(checked === true)}
                  disabled={!pronunciationArpabet.trim()}
                  className="mt-0.5"
                />
                <span className="text-xs text-slate-600">
                  <span className="block font-medium text-slate-700">Strict phoneme verification (Live Fast + Full)</span>
                  <span className="mt-0.5 block text-slate-400">Use only for difficult reviewed terms. Uncertain results stay advisory.</span>
                </span>
              </label>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={generatePronunciation}
                  disabled={pronunciationBusy || pronunciationGenerating || !pronunciationWord.trim()}
                  className="h-8 rounded-lg border-slate-200 bg-white"
                >
                  {pronunciationGenerating ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                  Generate
                </Button>
                <Button type="button" size="sm" onClick={savePronunciation} disabled={pronunciationBusy || pronunciationGenerating} className="h-8 rounded-lg">
                  <Check size={13} />
                  {editingPronunciationWord ? 'Update entry' : 'Save entry'}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => testPronunciation()}
                  disabled={pronunciationBusy || pronunciationGenerating || Boolean(pronunciationTestingWord) || !ttsReady}
                  className="h-8 rounded-lg border-slate-200 bg-white"
                >
                  {pronunciationTestingWord === pronunciationWord.trim() ? <Loader2 size={13} className="animate-spin" /> : <PlayCircle size={13} />}
                  Test
                </Button>
                {editingPronunciationWord && (
                  <Button type="button" size="sm" variant="outline" onClick={clearPronunciationForm} disabled={pronunciationBusy} className="h-8 rounded-lg border-slate-200 bg-white">
                    <X size={13} />
                    Cancel
                  </Button>
                )}
                <Button type="button" size="sm" variant="outline" onClick={exportPronunciationCsv} disabled={pronunciationBusy || pronunciationEntries.length === 0} className="h-8 rounded-lg border-slate-200 bg-white">
                  <Download size={13} />
                  Export CSV
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => pronunciationImportInputRef.current?.click()} disabled={pronunciationBusy} className="h-8 rounded-lg border-slate-200 bg-white">
                  <Upload size={13} />
                  Import CSV
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={pronunciationReloadPending ? 'default' : 'outline'}
                  onClick={loadPendingPronunciationChanges}
                  disabled={pronunciationBusy || !pronunciationReloadPending}
                  className={cn(
                    'h-8 rounded-lg',
                    pronunciationReloadPending ? '' : 'border-slate-200 bg-white',
                  )}
                >
                  {pronunciationBusy && pronunciationReloadPending ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                  Load changes
                </Button>
                <input ref={pronunciationImportInputRef} type="file" accept=".csv,text/csv" onChange={importPronunciationCsv} className="hidden" />
              </div>
              {pronunciationMessage && <p className="mt-2 text-xs text-slate-500">{pronunciationMessage}</p>}
              {(pronunciationSearchResults ? pronunciationSearchResults.entries : pronunciationEntries).length > 0 && (
                <div className="mt-3 max-h-40 overflow-auto rounded-lg border border-slate-100 bg-white">
                  {(pronunciationSearchResults ? pronunciationSearchResults.entries : pronunciationEntries).map((entry) => (
                    <div key={entry.id || entry.word} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-slate-50 px-2 py-1.5 text-xs last:border-b-0">
                      <button
                        type="button"
                        onClick={() => editPronunciation(entry)}
                        className="min-w-0 text-left"
                        disabled={pronunciationBusy}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-medium text-slate-700">{entry.word}</span>
                          {pronunciationSearchResults && (
                            <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{entry.category}</span>
                          )}
                        </span>
                        <span className="block truncate font-mono text-slate-400">
                          {entry.arpabet}{entry.verifyPhonemes ? ' · strict phoneme' : ''}
                        </span>
                        {entry.synthesisAlias && (
                          <span className="block truncate text-slate-400">speaks as: {entry.synthesisAlias}</span>
                        )}
                      </button>
                      <div className="flex items-center gap-1">
                        <Button type="button" size="icon" variant="ghost" onClick={() => testPronunciation(entry)} disabled={pronunciationBusy || Boolean(pronunciationTestingWord) || !ttsReady} className="h-7 w-7 rounded-lg text-blue-500">
                          {pronunciationTestingWord === entry.word ? <Loader2 size={13} className="animate-spin" /> : <PlayCircle size={13} />}
                        </Button>
                        <Button type="button" size="icon" variant="ghost" onClick={() => editPronunciation(entry)} disabled={pronunciationBusy} className="h-7 w-7 rounded-lg text-slate-500">
                          <Pencil size={13} />
                        </Button>
                        <Button type="button" size="icon" variant="ghost" onClick={() => deletePronunciation(entry)} disabled={pronunciationBusy} className="h-7 w-7 rounded-lg text-red-500">
                          <Trash2 size={13} />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {pronunciationSearchResults && pronunciationSearchResults.entries.length === 0 && (
                <p className="mt-3 rounded-lg border border-slate-100 bg-white px-3 py-2 text-xs text-slate-400">No matching dictionary words.</p>
              )}
            </div>
          </section>

          <aside className="space-y-4">
            {[
              {
                title: 'Live Fast output',
                description: '/api/live/tts-sentence',
                items: ttsFastHistory,
              },
              {
                title: 'Full inference output',
                description: '/api/inference',
                items: ttsFullHistory,
              },
            ].map((item) => (
              <div key={item.title} className="rounded-2xl border border-slate-100 bg-white p-4 shadow-[0_4px_32px_-12px_rgba(0,0,0,0.08)]">
                <p className="text-sm font-semibold text-slate-800">{item.title}</p>
                <p className="mt-1 text-xs text-slate-400">{item.description}</p>
                {item.items.length > 0 ? (
                  <div className="mt-3 space-y-3">
                    {item.items.map((result, index) => (
                      <div key={result.id} className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                        <div className="mb-2 flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-xs font-semibold text-slate-700">
                              {index === 0 ? 'Latest' : new Date(result.createdAt).toLocaleTimeString()}
                            </p>
                            <p className="mt-0.5 truncate text-[11px] text-slate-400">
                              {result.voiceName || 'Selected voice'} · {result.languageLabel || liveLanguageConfig.label}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <a
                              href={result.url}
                              download={result.filename}
                              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-600 hover:bg-slate-50 active:scale-[0.98]"
                            >
                              <Download size={12} /> WAV
                            </a>
                            <Button
                              type="button"
                              size="icon"
                              variant="outline"
                              onClick={() => deleteTtsHistoryItem(result)}
                              className="h-8 w-8 rounded-lg border-red-100 bg-white text-red-500 hover:bg-red-50 hover:text-red-600 active:scale-[0.98]"
                              title="Remove this output from browser history"
                            >
                              <Trash2 size={12} />
                            </Button>
                          </div>
                        </div>
                        <audio className="w-full" controls src={result.url} />
                        {result.text && (
                          <p className="mt-2 max-h-10 overflow-hidden text-xs leading-5 text-slate-500">{result.text}</p>
                        )}
                        {item.title === 'Full inference output' && result.sessionId && result.chunks?.length > 0 && (
                          <div className="mt-3 space-y-2 border-t border-slate-200 pt-3">
                            <div>
                              <p className="text-xs font-semibold text-slate-700">Review audio chunks</p>
                              <p className="mt-0.5 text-[11px] leading-4 text-slate-400">
                                Chunks target {liveFullSettings.maxSentencesPerChunk} sentences; a very short chunk may take one more for context. Regenerating replaces one chunk; deleting it removes its audio and stitches the rest together.
                              </p>
                            </div>
                            {renderFullChunkInsert(result, 0)}
                            {result.chunks.map((chunk) => {
                              const busyKey = `${result.id}:${chunk.index}`;
                              const busy = regeneratingFullChunk === busyKey;
                              const revision = result.revision || '';
                              const draftText = fullChunkDrafts[busyKey] ?? chunk.text ?? '';
                              return (
                                <div key={`chunk-slot-${chunk.index}`} className="space-y-2">
                                <div className="rounded-lg border border-slate-200 bg-white p-2.5">
                                  <div className="mb-2 min-w-0">
                                    <div className="mb-1.5 flex items-center justify-between gap-2">
                                      <Label
                                        htmlFor={`full-chunk-${result.id}-${chunk.index}`}
                                        className="block text-[11px] font-semibold text-slate-500"
                                      >
                                        Chunk {chunk.index + 1}
                                      </Label>
                                      <div className="flex shrink-0 items-center gap-1.5">
                                        <Button
                                          type="button"
                                          size="sm"
                                          variant="outline"
                                          onClick={() => regenerateFullChunk(result, chunk)}
                                          disabled={Boolean(regeneratingFullChunk) || streamingRoute !== null || !draftText.trim()}
                                          className="h-8 shrink-0 rounded-md px-2.5 text-[11px] active:scale-[0.98]"
                                        >
                                          {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                                          {busy ? 'Rebuilding' : 'Regenerate'}
                                        </Button>
                                        <Button
                                          type="button"
                                          size="icon"
                                          variant="outline"
                                          onClick={() => deleteFullChunk(result, chunk)}
                                          disabled={Boolean(regeneratingFullChunk) || streamingRoute !== null || result.chunks.length <= 1}
                                          className="h-8 w-8 shrink-0 rounded-md border-red-100 text-red-500 hover:bg-red-50 hover:text-red-600 active:scale-[0.98]"
                                          title={result.chunks.length <= 1 ? 'The only remaining chunk cannot be deleted' : 'Delete this chunk and rebuild the full audio'}
                                        >
                                          <Trash2 size={12} />
                                        </Button>
                                      </div>
                                    </div>
                                      <Textarea
                                        id={`full-chunk-${result.id}-${chunk.index}`}
                                        value={draftText}
                                        onChange={(event) => setFullChunkDrafts((current) => ({
                                          ...current,
                                          [busyKey]: event.target.value,
                                        }))}
                                        disabled={busy}
                                        rows={3}
                                        className="min-h-[92px] w-full resize-y rounded-md border-slate-200 bg-white px-3 py-2.5 text-sm leading-5 shadow-none focus-visible:ring-1"
                                        aria-describedby={`full-chunk-help-${result.id}-${chunk.index}`}
                                      />
                                      <p
                                        id={`full-chunk-help-${result.id}-${chunk.index}`}
                                        className="mt-1 text-[10px] leading-4 text-slate-400"
                                      >
                                        Edit the text, then regenerate to replace this chunk. Clearing text does not delete its existing audio.
                                      </p>
                                      {chunk.fallback && (
                                        <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] leading-4 text-amber-800">
                                          <span className="font-semibold">Best effort — verification did not pass.</span>
                                          {chunk.fallbackReason && <span className="ml-1">{chunk.fallbackReason}</span>}
                                        </div>
                                      )}
                                  </div>
                                  <audio
                                    key={`${result.sessionId}:${chunk.index}:${revision}`}
                                    className="h-8 w-full"
                                    controls
                                    preload="metadata"
                                    src={getInferenceChunkPreviewUrl(result.sessionId, chunk.index, revision)}
                                  />
                                  {Array.isArray(chunk.versions) && chunk.versions.length > 0 && (
                                    <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-2">
                                      <p className="mb-1.5 text-[11px] font-semibold text-slate-600">
                                        Previous generations ({chunk.versions.length})
                                      </p>
                                      <div className="space-y-2">
                                        {chunk.versions.map((version, versionIndex) => (
                                          <div key={version.id} className="rounded-md border border-slate-200 bg-white p-2">
                                            <div className="mb-1.5 flex items-center justify-between gap-2">
                                              <span className="min-w-0 truncate text-[10px] text-slate-500">
                                                Version {chunk.versions.length - versionIndex}
                                                {version.createdAt ? ` · ${new Date(version.createdAt).toLocaleTimeString()}` : ''}
                                              </span>
                                              <Button
                                                type="button"
                                                size="sm"
                                                variant="outline"
                                                onClick={() => restoreFullChunk(result, chunk, version)}
                                                disabled={Boolean(regeneratingFullChunk) || streamingRoute !== null}
                                                className="h-7 shrink-0 rounded-md px-2 text-[10px] active:scale-[0.98]"
                                              >
                                                <Undo2 size={11} />
                                                Restore
                                              </Button>
                                            </div>
                                            <audio
                                              className="h-8 w-full"
                                              controls
                                              preload="metadata"
                                              src={getInferenceChunkVersionUrl(result.sessionId, chunk.index, version.id)}
                                            />
                                            {version.fallback && (
                                              <p className="mt-1 text-[10px] text-amber-700">
                                                Best effort{version.fallbackReason ? ` — ${version.fallbackReason}` : ''}
                                              </p>
                                            )}
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </div>
                                {renderFullChunkInsert(result, chunk.index + 1)}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 rounded-xl border border-slate-100 bg-slate-50 px-3 py-3 text-sm text-slate-400">
                    No audio generated yet.
                  </p>
                )}
              </div>
            ))}
          </aside>
        </div>
      ) : (
      <div className={cn('flex min-h-0 flex-1 gap-3', kiosk ? 'flex-row' : 'flex-col')}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-[0_4px_32px_-8px_rgba(0,0,0,0.09)]">

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-5 py-5">
          {liveSpeech.messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center py-16 text-center">
                <p className="text-base font-semibold text-slate-800">Ready to listen</p>
              <p className="mt-1.5 max-w-xs text-sm text-slate-400">
                {isReady
                  ? `Press the mic and speak in ${liveLanguageConfig.label} — or type your question below.`
                  : 'Select a voice model above to get started.'}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {liveSpeech.messages.map((message) => (
                <ChatBubble
                  key={message.id}
                  message={message}
                  selected={liveSpeech.selectedReply?.id === message.id && liveSpeech.phase === 'speaking'}
                  selectedPart={liveSpeech.selectedReply?.id === message.id ? liveSpeech.selectedAudioPart : null}
                  onPlay={liveSpeech.playReply}
                  audioRef={audioRef}
                />
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {liveSpeech.error && (
          <div className={cn(
            'border-t px-5 py-2.5 text-sm',
            liveSpeech.errorTone === 'waiting'
              ? 'border-amber-100 bg-amber-50 text-amber-700'
              : 'border-red-100 bg-red-50 text-red-600',
          )}>
            {liveSpeech.error}
          </div>
        )}

        {/* ── Bottom control bar ── */}
        <div className="border-t border-slate-100 px-6 pb-6 pt-4">
          {/* Waveform — centered, only visible when mic is active */}
          <div className="mb-3 flex h-7 items-end justify-center">
            <MicLevelMeter level={liveSpeech.audioLevel} active={meterActive} />
          </div>

          <div className="mx-auto flex w-full max-w-lg flex-col items-center gap-2">
            {/* Session controls ride above the composer row rather than flanking
                the mic: the row keeps the same shape whether or not a
                conversation is running, so the input never shifts sideways
                mid-sentence as these appear and disappear between clips. */}
            {(playbackReady || isConversationActive) && (
              <div className="flex shrink-0 flex-wrap items-center justify-center gap-2">
                {playbackReady && (
                  <button
                    type="button"
                    onClick={liveSpeech.stopVoicePlayback}
                    title="Stop voice"
                    className="flex h-8 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 text-xs font-medium text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-800"
                  >
                    <VolumeX size={13} />Stop voice
                  </button>
                )}

                {isConversationActive && (
                  <button
                    type="button"
                    onClick={liveSpeech.stop}
                    className="flex h-8 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 text-xs font-medium text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-800"
                  >
                    <Square size={11} />End
                  </button>
                )}
              </div>
            )}

            {/* Typing and the mic share one row, with no Voice/Text toggle:
                a visitor whose microphone does not work should not have to find
                a setting before they can ask anything. Either control opens the
                conversation on its own. */}
            <ChatTextInput
              onSend={liveSpeech.sendTextMessage}
              disabled={!canSendText}
              trailing={micButton}
            />
          </div>

          {/* Status text — centered below mic */}
          <div className="mt-4 text-center">
            <p className="text-sm font-medium text-slate-700">{statusText}</p>
            <p className="mt-0.5 text-xs text-slate-400">
              {speakingProfile?.displayName || '—'} · {liveLanguageConfig.label}
            </p>
          </div>
        </div>
      </div>
      {canEditInstructions && (
        <>
        {/* Mobile-only backdrop for the instructions drawer. */}
        {showInstructions && (
          <div
            className="fixed inset-0 z-40 bg-slate-900/40 lg:hidden"
            onClick={() => setShowInstructions(false)}
            aria-hidden="true"
          />
        )}
        <aside
          className={cn(
            'min-h-0 flex-col overflow-hidden border border-slate-100 bg-white shadow-[0_4px_32px_-8px_rgba(0,0,0,0.09)]',
            // lg+: normal in-flow sidebar
            'lg:static lg:z-auto lg:flex lg:w-[380px] lg:shrink-0 lg:rounded-2xl',
            // mobile: right-anchored slide-over overlay
            'fixed inset-y-0 right-0 z-50 w-[86%] max-w-[380px] rounded-l-2xl',
            // display toggle (no off-screen transform → no horizontal-scroll risk)
            showInstructions ? 'flex' : 'hidden',
          )}
        >
          <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">
              Assistant instructions
            </span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleDeployChatbotSystemPrompt}
                // Either half is publishable on its own — documents with no typed
                // instructions is a valid assistant, and the frontends supply
                // their neutral built-in instructions when the prompt is empty.
                disabled={isConversationActive
                  || chatbotDeployState.status === 'deploying'
                  || (!chatbotSystemPrompt.trim() && chatbotDocuments.length === 0)}
                title={
                  speakingProfile?.displayName
                    ? `Publish these instructions, reference documents, and the ${speakingProfile.displayName} voice to every chatbot frontend`
                    : 'Publish these instructions and reference documents to every chatbot frontend'
                }
                className="rounded-full bg-primary px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-primary/90 disabled:opacity-40"
              >
                {chatbotDeployState.status === 'deploying' ? 'Publishing…' : 'Publish'}
              </button>
              <button
                type="button"
                onClick={handleResetChatbotSystemPrompt}
                disabled={isConversationActive}
                className="text-xs font-medium text-slate-400 transition-colors hover:text-slate-700 disabled:opacity-40"
              >
                Reset to default
              </button>
              <button
                type="button"
                onClick={() => setShowInstructions(false)}
                className="text-slate-400 transition-colors hover:text-slate-700 lg:hidden"
                aria-label="Close instructions"
              >
                <X size={16} />
              </button>
            </div>
          </div>
          <MyVoicesPanel
            voices={myVoices}
            standardVoices={standardVoices}
            isAdmin={myVoicesAdmin}
            scope={myVoicesScope}
            loading={myVoicesLoading}
            error={myVoicesError}
            selectedVoiceName={usingStandardVoice ? '' : (selectedProfile?.displayName || '')}
            selectedVoiceProfileId={selectedStandardVoiceId}
            disabled={isConversationActive}
            trainingUrl={TRAINING_APP_URL}
            onSelectVoice={handleSelectMyVoice}
            onScopeChange={setMyVoicesScope}
            onRetry={() => setMyVoicesReloadToken((token) => token + 1)}
          />
          {/* Pairs with the voice row above it: one bordered block, two rows. */}
          <div className="border-b border-slate-100 px-4 pb-3 pt-2">
            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-[11px] font-semibold uppercase tracking-widest text-slate-400">
                Lecture
              </span>
              <Select
                value={chatbotCategory}
                onValueChange={(value) => {
                  if (value === ADD_CHATBOT_CATEGORY) {
                    setAddingChatbotCategory(true);
                    focusNewChatbotCategoryRef.current = true;
                    return;
                  }
                  handleSelectChatbotCategory(value);
                }}
                disabled={isConversationActive}
              >
                <SelectTrigger className="h-8 flex-1 rounded-lg border-slate-200 bg-white text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent
                  onCloseAutoFocus={(event) => {
                    if (!focusNewChatbotCategoryRef.current) return;
                    focusNewChatbotCategoryRef.current = false;
                    event.preventDefault();
                    requestAnimationFrame(() => newChatbotCategoryRef.current?.focus());
                  }}
                >
                  {chatbotCategoryOptions.map((category) => (
                    <SelectItem key={category} value={category} className="text-xs">{category}</SelectItem>
                  ))}
                  <SelectSeparator className="bg-slate-200" />
                  <SelectItem value={ADD_CHATBOT_CATEGORY} className="text-xs text-slate-500">
                    + New lecture…
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            {addingChatbotCategory && (
              <form
                className="mt-2 flex items-center gap-2"
                onSubmit={(e) => { e.preventDefault(); handleSelectChatbotCategory(newChatbotCategory); }}
              >
                <Input
                  ref={newChatbotCategoryRef}
                  value={newChatbotCategory}
                  onChange={(e) => setNewChatbotCategory(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape') setAddingChatbotCategory(false); }}
                  disabled={isConversationActive}
                  placeholder="e.g. gi-bleeding"
                  className="h-8 flex-1 rounded-lg border-slate-200 text-xs"
                />
                <button
                  type="submit"
                  disabled={isConversationActive || !newChatbotCategory.trim()}
                  className="rounded-full border border-slate-200 px-3 py-1 text-xs font-medium text-slate-500 transition-colors hover:text-slate-800 disabled:opacity-40"
                >
                  Add
                </button>
              </form>
            )}
            <p className="mt-2 text-[11px] leading-4 text-slate-400">
              {chatbotCategory === DEFAULT_CHATBOT_CATEGORY
                ? 'The fallback assistant, used wherever no lecture of its own is set up.'
                : `Students on /lesson/${chatbotCategory} get these instructions and documents.`}
            </p>
          </div>
          {chatbotDeployState.message && (
            <p
              className={cn(
                'border-b border-slate-100 px-4 py-2 text-[11px]',
                chatbotDeployState.status === 'error' ? 'text-red-500' : 'text-slate-400',
              )}
              role="status"
            >
              {chatbotDeployState.message}
            </p>
          )}
          <Textarea
            value={chatbotSystemPrompt}
            onChange={(e) => handleChatbotSystemPromptChange(e.target.value)}
            disabled={isConversationActive}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none rounded-none border-0 bg-white px-4 py-3 text-xs leading-5 text-slate-700 shadow-none focus-visible:ring-0"
          />
          <div className="border-t border-slate-100 px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">
                Reference documents
              </span>
              <label
                className={cn(
                  'cursor-pointer text-xs font-medium text-primary hover:text-primary/80',
                  isConversationActive && 'pointer-events-none opacity-40',
                )}
              >
                + Add PDF
                <input
                  type="file"
                  accept="application/pdf"
                  multiple
                  className="hidden"
                  disabled={isConversationActive}
                  onChange={(e) => { handleAddChatbotDocuments(e.target.files); e.target.value = ''; }}
                />
              </label>
            </div>
            {chatbotDocuments.length > 0 && (
              <ul className="mt-2 space-y-1">
                {chatbotDocuments.map((doc) => (
                  <li key={doc.name} className="flex items-center justify-between gap-2 text-[11px] text-slate-600">
                    <span className="truncate">{doc.name}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="text-slate-400">{doc.chars.toLocaleString()} chars</span>
                      <button
                        type="button"
                        onClick={() => handleRemoveChatbotDocument(doc.name)}
                        disabled={isConversationActive}
                        className="text-slate-400 hover:text-red-500 disabled:opacity-40"
                      >
                        ✕
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {buildDocumentsContext(chatbotDocuments).totalChars > 0 && (
              <p
                className={cn(
                  'mt-2 text-[11px]',
                  buildDocumentsContext(chatbotDocuments).totalChars > MAX_DOCUMENTS_CHARS
                    ? 'text-amber-600'
                    : 'text-slate-400',
                )}
              >
                {buildDocumentsContext(chatbotDocuments).totalChars.toLocaleString()}
                {' / '}
                {MAX_DOCUMENTS_CHARS.toLocaleString()} chars
                {buildDocumentsContext(chatbotDocuments).totalChars > MAX_DOCUMENTS_CHARS ? ' — will be truncated.' : ''}
              </p>
            )}
            {chatbotDocError && (
              <p className="mt-2 text-[11px] text-red-500">{chatbotDocError}</p>
            )}
          </div>
          <p className="border-t border-slate-100 px-4 py-2 text-[11px] text-slate-400">
            Applied to the next conversation. Locked while a chat is active.
          </p>
        </aside>
        </>
      )}
      </div>
      )}

      {/* ── Advanced settings collapsible (hidden from end users; settings still applied) ── */}
      {SHOW_ADVANCED_SETTINGS && (
      <Collapsible open={showSettings} onOpenChange={setShowSettings}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-1.5 text-sm text-slate-400 transition-colors hover:text-slate-700"
          >
            <ChevronDown size={14} className={cn('transition-transform', showSettings && 'rotate-180')} />
            {showSettings ? 'Hide' : 'Show'} advanced settings
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="mt-4 grid gap-5 rounded-2xl border border-slate-100 bg-slate-50 p-5 lg:grid-cols-2">

            {/* Reference clips */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-800">Reference clips</p>
                <Button
                  type="button" variant="outline" size="sm"
                  className="h-8 rounded-xl border-slate-200 bg-white shadow-none"
                  onClick={() => applyBestReference()}
                  disabled={loadingTrainingAudio || trainingAudioFiles.length === 0 || isConversationActive}
                >
                  <Check size={13} />Use best
                </Button>
              </div>

              <div>
                <Label className="mb-2 block text-[11px] font-semibold uppercase tracking-widest text-slate-400">Primary reference</Label>
                <div className="grid grid-cols-[minmax(0,1fr)_40px] gap-2">
                  <Select
                    value={refAudioPath} onValueChange={handlePrimaryReferenceChange}
                    disabled={loadingTrainingAudio || trainingAudioFiles.length === 0 || isConversationActive}
                  >
                    <SelectTrigger className="h-10 rounded-xl border-slate-200 bg-white shadow-none">
                      <SelectValue placeholder={loadingTrainingAudio ? 'Loading...' : 'Select primary'} />
                    </SelectTrigger>
                    <SelectContent>
                      {trainingAudioFiles.map((f) => {
                        const candidate = referenceCandidateMap[f.path];
                        return (
                          <SelectItem key={f.path} value={f.path}>
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="truncate">{f.filename}</span>
                              <span className={cn(
                                'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                                candidate?.eligible ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'
                              )}>
                                {formatReferenceScore(candidate)}
                              </span>
                            </span>
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                  {(() => {
                    const pi = selectedReferenceItems.find((item) => item.role === 'primary');
                    const pUrl = pi ? referenceAudioUrls[pi.path] : null;
                    const pLoading = Boolean(pi) && loadingPreviewPath === 'all' && !pUrl;
                    return (
                      <button
                        type="button" onClick={() => handlePreviewReference(pi)}
                        disabled={!pi || !pUrl || pLoading}
                        className={cn(
                          'flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition-colors hover:border-slate-300 disabled:cursor-wait disabled:opacity-50',
                          previewReference.path === pi?.path && 'border-slate-300 bg-slate-50'
                        )}
                      >
                        {pLoading ? <Loader2 size={14} className="animate-spin" /> : <PlayCircle size={15} />}
                      </button>
                    );
                  })()}
                </div>
              </div>

              <div>
                <Label className="mb-2 block text-[11px] font-semibold uppercase tracking-widest text-slate-400">Auxiliary clips</Label>
                <div className="max-h-44 overflow-y-auto rounded-xl border border-slate-200 bg-white p-2">
                  {trainingAudioFiles.length === 0 ? (
                    <p className="px-2 py-1 text-xs text-slate-400">{loadingTrainingAudio ? 'Loading...' : 'No clips found.'}</p>
                  ) : (
                    trainingAudioFiles.filter((f) => f.path !== refAudioPath).map((f) => {
                      const checked = auxRefAudios.some((item) => item.path === f.path);
                      const fUrl = referenceAudioUrls[f.path];
                      const loading = (loadingPreviewPath === 'all' && !fUrl) || loadingPreviewPath === f.path;
                      const pi2 = { role: checked ? 'auxiliary' : 'preview', path: f.path, filename: f.filename, transcript: f.transcript || '' };
                      return (
                        <div key={f.path} className="flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-50">
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(v) => handleAuxToggle(f, Boolean(v))}
                            disabled={isConversationActive || (!checked && auxRefAudios.length >= 5)}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="block truncate font-mono text-xs text-slate-700">{f.filename}</span>
                              {referenceCandidateMap[f.path] && (
                                <span className={cn(
                                  'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                                  referenceCandidateMap[f.path].eligible
                                    ? 'bg-emerald-50 text-emerald-700'
                                    : 'bg-slate-100 text-slate-500'
                                )}>
                                  {Math.round(referenceCandidateMap[f.path].score)}
                                </span>
                              )}
                            </span>
                            {f.transcript && <span className="mt-0.5 block truncate text-xs text-slate-400">{f.transcript}</span>}
                            {referenceCandidateMap[f.path]?.reasons?.[0] && (
                              <span className="mt-0.5 block truncate text-[11px] text-amber-600">{referenceCandidateMap[f.path].reasons[0]}</span>
                            )}
                          </span>
                          <button
                            type="button" onClick={() => handlePreviewReference(pi2)}
                            disabled={!selectedExpName || !fUrl || loading}
                            className={cn(
                              'mt-0.5 flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-400 transition-colors hover:border-slate-300 hover:text-slate-700 disabled:cursor-wait disabled:opacity-50',
                              previewReference.path === f.path && 'border-slate-300 text-slate-700'
                            )}
                          >
                            {loading ? <Loader2 size={11} className="animate-spin" /> : <PlayCircle size={12} />}
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
                <p className="mt-1.5 text-xs text-slate-400">
                  {auxRefAudios.length}/5 auxiliary · Primary: {refAudioPath ? fallbackName(refAudioPath) : 'none'}
                </p>
                {currentReferenceMetadata.primary && (
                  <div className="mt-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium text-slate-700">Primary reference score</span>
                      <span className={cn(
                        'rounded-full px-2 py-0.5 text-[11px] font-semibold',
                        currentReferenceMetadata.primary.eligible ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
                      )}>
                        {Math.round(currentReferenceMetadata.primary.score)} · {currentReferenceMetadata.mode}
                      </span>
                    </div>
                    <p className="mt-1 truncate">
                      {currentReferenceMetadata.primary.eligible
                        ? 'Passed strict duration, sentence, cleanliness, loudness, and steady-tone checks.'
                        : currentReferenceMetadata.primary.reasons.join(' ')}
                    </p>
                  </div>
                )}
              </div>

              <div className={cn(!previewReference.url && 'hidden')}>
                {previewReference.url && (
                  <p className="mb-1 truncate text-[11px] text-slate-400">
                    Previewing {previewReference.role}: {previewReference.filename}
                  </p>
                )}
                <audio ref={referencePreviewAudioRef} className="w-full" controls preload="metadata"
                  onError={() => { if (previewReference.filename) setReferenceMessage(`Could not play ${previewReference.filename}.`); }}
                  onPlay={() => setReferenceMessage('')}
                />
              </div>

              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_150px]">
                <div>
                  <Label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-widest text-slate-400">Primary transcript</Label>
                  <Textarea
                    className="min-h-[90px] rounded-xl border-slate-200 bg-white shadow-none leading-6"
                    value={promptText} onChange={(e) => setPromptText(e.target.value)} disabled={isConversationActive}
                  />
                </div>
                <div>
                  <Label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-widest text-slate-400">Ref language</Label>
                  <Select value={promptLang} onValueChange={setPromptLang} disabled={isConversationActive}>
                    <SelectTrigger className="h-10 rounded-xl border-slate-200 bg-white shadow-none"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="en">English</SelectItem>
                      <SelectItem value="zh">Chinese</SelectItem>
                      <SelectItem value="ja">Japanese</SelectItem>
                      <SelectItem value="ko">Korean</SelectItem>
                      <SelectItem value="auto">Auto</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {referenceMessage && (
                <p className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500">{referenceMessage}</p>
              )}
            </div>

            {/* Inference controls */}
            <div className="space-y-4">
              <p className="text-sm font-semibold text-slate-800">Inference controls</p>
              <div className="rounded-xl border border-slate-200 bg-white p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-slate-800">Current config</p>
                    <p className="mt-0.5 truncate text-xs text-slate-500" title={`${currentLiveFastMetadata.configName} · ${currentReferenceMetadata.primary ? fallbackName(currentReferenceMetadata.selectedPaths.primary) : 'no reference'}`}>
                      {currentLiveFastMetadata.configName} · {currentReferenceMetadata.primary ? fallbackName(currentReferenceMetadata.selectedPaths.primary) : 'no reference'}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => saveCurrentVoiceConfig()}
                    disabled={!selectedProfile || !selectedGPT || !selectedSoVITS || !refAudioPath || isConversationActive || loadingModel || Boolean(savingConfigId)}
                    className="h-8 shrink-0 whitespace-nowrap rounded-xl border-slate-200 bg-white shadow-none"
                  >
                    {savingConfigId && !voiceConfigs.some((item) => item.configId === savingConfigId)
                      ? <Loader2 size={13} className="animate-spin" />
                      : <Check size={13} />}
                    {savingConfigId && !voiceConfigs.some((item) => item.configId === savingConfigId) ? 'Saving...' : 'Save new'}
                  </Button>
                </div>
                <div className="mt-3 grid gap-2 text-xs text-slate-500 sm:grid-cols-2">
                  <p className="rounded-lg bg-slate-50 px-2 py-1.5">
                    Speed {speed.toFixed(1)} · Top K {topK} · Top P {topP.toFixed(2)}
                  </p>
                  <p className="rounded-lg bg-slate-50 px-2 py-1.5">
                    Temp {temperature.toFixed(2)} · Rep {repPenalty.toFixed(2)} · chunks {liveFastSettings.maxChunkWords > 0 ? `${liveFastSettings.maxChunkWords} words` : 'auto (280 chars)'} · max {liveFastSettings.maxSentencesPerChunk} sentence{liveFastSettings.maxSentencesPerChunk === 1 ? '' : 's'} · {liveLanguageConfig.label}
                  </p>
                </div>
                <div className="mt-3 rounded-lg border border-slate-100 bg-slate-50 px-2 py-2 text-xs text-slate-500">
                  <p className="font-semibold text-slate-700">Training metadata</p>
                  {trainingRunMetadata ? (
                    <>
                      <p className="mt-1">
                        Engine {trainingRunMetadata.engineVersion || 'unknown'} ·
                        denoise {trainingRunMetadata.training?.skipDenoise ? 'skipped' : 'enabled'} ·
                        batch {trainingRunMetadata.training?.batchSize ?? 'n/a'}
                      </p>
                      <p className="mt-1">
                        SoVITS {trainingRunMetadata.training?.sovitsEpochs ?? 'n/a'} ep ·
                        GPT {trainingRunMetadata.training?.gptEpochs ?? 'n/a'} ep ·
                        raw files {trainingRunMetadata.sourceDatasetStats?.rawFileCount ?? 'n/a'}
                      </p>
                    </>
                  ) : (
                    <p className="mt-1 text-amber-700">
                      {trainingRunMetadataError || 'Training metadata has not loaded yet.'}
                    </p>
                  )}
                </div>
                <div className="mt-3 rounded-lg border border-slate-100 bg-slate-50 p-2">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-slate-700">Saved configs for this person</p>
                    <button
                      type="button"
                      onClick={() => loadVoiceConfigs(selectedVoiceProfileId)}
                      disabled={loadingVoiceConfigs || !selectedVoiceProfileId}
                      className="text-xs font-medium text-slate-500 hover:text-slate-800 disabled:opacity-40"
                    >
                      {loadingVoiceConfigs ? 'Loading...' : 'Refresh'}
                    </button>
                  </div>
                  {voiceConfigError && <p className="mb-2 text-xs text-red-500">{voiceConfigError}</p>}
                  {voiceConfigs.length === 0 ? (
                    <p className="rounded-lg border border-amber-100 bg-amber-50 px-2 py-2 text-xs text-amber-700">
                      No saved configs yet. Click Save new after choosing references and inference settings.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {voiceConfigs.map((config, index) => {
                        const defaults = config.inferenceMetadata?.defaults || {};
                        const reference = config.referenceMetadata || {};
                        const sampleUrl = configSampleUrls[config.configId];
                        const busy = savingConfigId === config.configId || generatingSampleConfigId === config.configId;
                        const loaded = reorderingConfigRef.current
                          ? index === 0
                          : loadedConfigId === config.configId;
                        return (
                          <div
                            key={config.configId}
                            className={cn(
                              'rounded-lg border bg-white p-2 transition-opacity',
                              loaded ? 'border-blue-200 ring-1 ring-blue-100' : 'border-slate-200',
                              draggingConfigId === config.configId && 'opacity-50'
                            )}
                            draggable={!busy}
                            onDragStart={(event) => {
                              event.dataTransfer.effectAllowed = 'move';
                              event.dataTransfer.setData('text/plain', config.configId);
                              setDraggingConfigId(config.configId);
                            }}
                            onDragOver={(event) => {
                              event.preventDefault();
                              event.dataTransfer.dropEffect = 'move';
                            }}
                            onDrop={(event) => {
                              event.preventDefault();
                              handleConfigDrop(config.configId);
                            }}
                            onDragEnd={() => setDraggingConfigId('')}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="flex min-w-0 items-center gap-2">
                                  <span className="shrink-0 cursor-grab text-xs text-slate-400" title="Drag to reorder">#{index + 1}</span>
                                  <input
                                    className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 py-0.5 text-xs font-semibold text-slate-800 outline-none transition-colors hover:border-slate-200 focus:border-blue-200 focus:bg-white"
                                    defaultValue={config.configName || config.configId}
                                    disabled={busy}
                                    onKeyDown={(event) => {
                                      if (event.key === 'Enter') event.currentTarget.blur();
                                      if (event.key === 'Escape') {
                                        event.currentTarget.value = config.configName || config.configId;
                                        event.currentTarget.blur();
                                      }
                                    }}
                                    onBlur={(event) => renameVoiceConfig(config, event.currentTarget.value)}
                                  />
                                  {loaded && <span className="shrink-0 rounded-full bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700">loaded</span>}
                                </div>
                                <p className="mt-0.5 truncate text-[11px] text-slate-500">
                                  Ref {fallbackName(reference.selectedPaths?.primary || reference.primary?.path)} ·
                                  speed {defaults.speed_factor ?? 'n/a'} · temp {defaults.temperature ?? 'n/a'} · chunks {(defaults.max_chunk_words ?? DEFAULT_LIVE_FAST_SETTINGS.maxChunkWords) > 0 ? `${defaults.max_chunk_words} words` : 'auto'} · max {defaults.max_sentences_per_chunk ?? DEFAULT_LIVE_FAST_SETTINGS.maxSentencesPerChunk} sentence{(defaults.max_sentences_per_chunk ?? DEFAULT_LIVE_FAST_SETTINGS.maxSentencesPerChunk) === 1 ? '' : 's'}
                                </p>
                                {config.trainingMetadata?.engineVersion && (
                                  <p className="mt-0.5 truncate text-[11px] text-slate-400">
                                    Trained {config.trainingMetadata.engineVersion} · denoise {config.trainingMetadata.skipDenoise ? 'skipped' : 'enabled'} · batch {config.trainingMetadata.batchSize ?? 'n/a'}
                                  </p>
                                )}
                              </div>
                              <div className="flex shrink-0 flex-wrap justify-end gap-1">
                                <button type="button" onClick={() => loadSavedVoiceConfig(config)} disabled={busy || isConversationActive} className="rounded-md border border-slate-200 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-40">Load</button>
                                <button type="button" onClick={() => saveCurrentVoiceConfig(config)} disabled={busy || !loaded} className="rounded-md border border-slate-200 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-40">Update</button>
                                <button type="button" onClick={() => generateConfigSample(config)} disabled={busy || isConversationActive} className="rounded-md border border-slate-200 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-40">
                                  {generatingSampleConfigId === config.configId ? 'Generating' : 'Sample'}
                                </button>
                                <button type="button" onClick={() => deleteSavedVoiceConfig(config.configId)} disabled={busy} className="rounded-md border border-red-100 px-2 py-1 text-[11px] text-red-500 hover:bg-red-50 disabled:opacity-40">Delete</button>
                              </div>
                            </div>
                            {sampleUrl ? (
                              <audio className="mt-2 w-full" controls src={sampleUrl} />
                            ) : config.sample?.generatedAt ? (
                              <p className="mt-2 text-[11px] text-slate-400">
                                Sample metadata saved {new Date(config.sample.generatedAt).toLocaleString()}, regenerate to listen in this browser.
                              </p>
                            ) : (
                              <p className="mt-2 text-[11px] text-slate-400">No sample recording yet.</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {[
                  { label: 'Speed', display: speed.toFixed(1) + 'x', min: 0.5, max: 2.0, step: 0.1, val: speed, set: setSpeed },
                  { label: 'Top K', display: String(topK), min: 1, max: 50, step: 1, val: topK, set: setTopK },
                  { label: 'Top P', display: topP.toFixed(2), min: 0, max: 1, step: 0.05, val: topP, set: setTopP },
                  { label: 'Temperature', display: temperature.toFixed(2), min: 0, max: 1, step: 0.05, val: temperature, set: setTemperature },
                ].map(({ label, display, min, max, step, val, set }) => (
                  <div key={label} className="space-y-3 rounded-xl border border-slate-200 bg-white p-3">
                    <div className="flex items-center justify-between">
                      <Label className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">{label}</Label>
                      <span className="font-mono text-sm font-semibold text-slate-700">{display}</span>
                    </div>
                    <Slider min={min} max={max} step={step} value={[val]} onValueChange={([v]) => set(v)} disabled={isConversationActive} />
                  </div>
                ))}
                <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-3 md:col-span-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">Repetition Penalty</Label>
                    <span className="font-mono text-sm font-semibold text-slate-700">{repPenalty.toFixed(2)}</span>
                  </div>
                  <Slider min={1.0} max={2.0} step={0.05} value={[repPenalty]} onValueChange={([v]) => setRepPenalty(v)} disabled={isConversationActive} />
                </div>
                <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-3 md:col-span-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">Saved output gain</Label>
                    <span className="font-mono text-sm font-semibold text-slate-700">{liveFastOutputGainDb > 0 ? '+' : ''}{liveFastOutputGainDb.toFixed(1)} dB</span>
                  </div>
                  <Slider min={-6} max={6} step={0.5} value={[liveFastOutputGainDb]} onValueChange={([v]) => setLiveFastOutputGainDb(v)} disabled={isConversationActive} />
                  <p className="text-xs leading-5 text-slate-400">Changes delivered Fast TTS volume after verification; pronunciation and retry behavior stay unchanged.</p>
                </div>
                <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-3 md:col-span-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">Max chunk words</Label>
                    <span className="font-mono text-sm font-semibold text-slate-700">
                      {liveFastSettings.maxChunkWords === 0 ? 'Auto · 280 chars' : liveFastSettings.maxChunkWords}
                    </span>
                  </div>
                  <Slider
                    min={0}
                    max={100}
                    step={10}
                    value={[liveFastSettings.maxChunkWords]}
                    onValueChange={([value]) => setLiveFastMaxChunkWords(value)}
                    disabled={isConversationActive}
                  />
                  <p className="text-xs leading-5 text-slate-400">
                    Auto keeps the 280-character limit. A selected 10–100 word limit takes priority over it.
                  </p>
                </div>
                <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-3 md:col-span-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">Max sentences per chunk</Label>
                    <span className="font-mono text-sm font-semibold text-slate-700">{liveFastSettings.maxSentencesPerChunk}</span>
                  </div>
                  <Slider
                    min={1}
                    max={5}
                    step={1}
                    value={[liveFastSettings.maxSentencesPerChunk]}
                    onValueChange={([value]) => setLiveFastMaxSentences(value)}
                    disabled={isConversationActive}
                  />
                  <p className="text-xs leading-5 text-slate-400">
                    Takes priority over the default. A chunk below eight words may absorb one extra sentence for stable voice context.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-5 rounded-2xl border border-slate-100 bg-slate-50 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-800">Live Full settings</p>
                <p className="mt-0.5 text-xs text-slate-400">
                  {loadedLiveFullConfigId || 'default full config'} · Full Inference only
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => saveCurrentLiveFullConfig()}
                  disabled={!selectedVoiceProfileId || !voiceConfigs[0] || Boolean(savingLiveFullConfigId)}
                  className="h-8 rounded-xl"
                >
                  {savingLiveFullConfigId && !liveFullConfigs.some((item) => item.configId === savingLiveFullConfigId)
                    ? <Loader2 size={13} className="animate-spin" />
                    : <Check size={13} />}
                  Save new
                </Button>
              </div>
            </div>

            <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
              <div className="space-y-4">
                <div className="rounded-xl border border-blue-100 bg-white px-3 py-2 text-xs text-slate-500">
                  <p className="font-semibold text-slate-700">References from Live Fast #1</p>
                  {liveFastRankOneReferenceSummary.primaryPath ? (
                    <>
                      <p className="mt-1 truncate">
                        {liveFastRankOneReferenceSummary.config?.configName || liveFastRankOneReferenceSummary.config?.configId || 'Rank #1'} - {liveFastRankOneReferenceSummary.primaryName}
                      </p>
                      <p className="mt-1 text-slate-400">
                        {liveFastRankOneReferenceSummary.auxPaths.length}/5 auxiliary clips. Full load, sample, and TTS use this reference set.
                      </p>
                    </>
                  ) : (
                    <p className="mt-1 text-amber-600">
                      No Live Fast rank #1 config yet. The app will auto-save best refs as rank #1 once clips are loaded.
                    </p>
                  )}
                </div>

                <div className="hidden">
                  <Label className="mb-2 block text-[11px] font-semibold uppercase tracking-widest text-slate-400">Primary reference</Label>
                  <div className="grid grid-cols-[minmax(0,1fr)_40px] gap-2">
                    <Select
                      value={liveFullRefAudioPath}
                      onValueChange={handleLiveFullPrimaryReferenceChange}
                      disabled={loadingTrainingAudio || trainingAudioFiles.length === 0 || streamingRoute !== null}
                    >
                      <SelectTrigger className="h-10 rounded-xl border-slate-200 bg-white shadow-none">
                        <SelectValue placeholder={loadingTrainingAudio ? 'Loading...' : 'Select primary'} />
                      </SelectTrigger>
                      <SelectContent>
                        {trainingAudioFiles.map((f) => {
                          const candidate = referenceCandidateMap[f.path];
                          return (
                            <SelectItem key={f.path} value={f.path}>
                              <span className="flex min-w-0 items-center gap-2">
                                <span className="truncate">{f.filename}</span>
                                <span className={cn(
                                  'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                                  candidate?.eligible ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'
                                )}>
                                  {formatReferenceScore(candidate)}
                                </span>
                              </span>
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                    {(() => {
                      const pi = selectedLiveFullReferenceItems.find((item) => item.role === 'primary');
                      const pUrl = pi ? referenceAudioUrls[pi.path] : null;
                      const pLoading = Boolean(pi) && loadingPreviewPath === 'all' && !pUrl;
                      return (
                        <button
                          type="button"
                          onClick={() => handlePreviewLiveFullReference(pi)}
                          disabled={!pi || !pUrl || pLoading}
                          className={cn(
                            'flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition-colors hover:border-slate-300 disabled:cursor-wait disabled:opacity-50',
                            liveFullPreviewReference.path === pi?.path && 'border-slate-300 bg-slate-50'
                          )}
                        >
                          {pLoading ? <Loader2 size={14} className="animate-spin" /> : <PlayCircle size={15} />}
                        </button>
                      );
                    })()}
                  </div>
                </div>

                <div className="hidden">
                  <Label className="mb-2 block text-[11px] font-semibold uppercase tracking-widest text-slate-400">Auxiliary clips</Label>
                  <div className="max-h-40 overflow-y-auto rounded-xl border border-slate-200 bg-white p-2">
                    {trainingAudioFiles.length === 0 ? (
                      <p className="px-2 py-1 text-xs text-slate-400">{loadingTrainingAudio ? 'Loading...' : 'No clips found.'}</p>
                    ) : (
                      trainingAudioFiles.filter((f) => f.path !== liveFullRefAudioPath).map((f) => {
                        const checked = liveFullAuxRefAudios.some((item) => item.path === f.path);
                        const fUrl = referenceAudioUrls[f.path];
                        const loading = (loadingPreviewPath === 'all' && !fUrl) || loadingPreviewPath === f.path;
                        const pi2 = { role: checked ? 'live full auxiliary' : 'live full preview', path: f.path, filename: f.filename, transcript: f.transcript || '' };
                        return (
                          <div key={f.path} className="flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-50">
                            <Checkbox
                              checked={checked}
                              onCheckedChange={(v) => handleLiveFullAuxToggle(f, Boolean(v))}
                              disabled={streamingRoute !== null || (!checked && liveFullAuxRefAudios.length >= 5)}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="flex min-w-0 items-center gap-2">
                                <span className="block truncate font-mono text-xs text-slate-700">{f.filename}</span>
                                {referenceCandidateMap[f.path] && (
                                  <span className={cn(
                                    'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                                    referenceCandidateMap[f.path].eligible
                                      ? 'bg-emerald-50 text-emerald-700'
                                      : 'bg-slate-100 text-slate-500'
                                  )}>
                                    {Math.round(referenceCandidateMap[f.path].score)}
                                  </span>
                                )}
                              </span>
                              {f.transcript && <span className="mt-0.5 block truncate text-xs text-slate-400">{f.transcript}</span>}
                              {referenceCandidateMap[f.path]?.reasons?.[0] && (
                                <span className="mt-0.5 block truncate text-[11px] text-amber-600">{referenceCandidateMap[f.path].reasons[0]}</span>
                              )}
                            </span>
                            <button
                              type="button"
                              onClick={() => handlePreviewLiveFullReference(pi2)}
                              disabled={!selectedExpName || !fUrl || loading}
                              className={cn(
                                'mt-0.5 flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-400 transition-colors hover:border-slate-300 hover:text-slate-700 disabled:cursor-wait disabled:opacity-50',
                                liveFullPreviewReference.path === f.path && 'border-slate-300 text-slate-700'
                              )}
                            >
                              {loading ? <Loader2 size={11} className="animate-spin" /> : <PlayCircle size={12} />}
                            </button>
                          </div>
                        );
                      })
                    )}
                  </div>
                  <p className="mt-1.5 text-xs text-slate-400">
                    {liveFullAuxRefAudios.length}/5 auxiliary · Primary: {liveFullRefAudioPath ? fallbackName(liveFullRefAudioPath) : 'none'}
                  </p>
                  {currentLiveFullReferenceMetadata.primary && (
                    <div className="mt-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-medium text-slate-700">Primary reference score</span>
                        <span className={cn(
                          'rounded-full px-2 py-0.5 text-[11px] font-semibold',
                          currentLiveFullReferenceMetadata.primary.eligible ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
                        )}>
                          {Math.round(currentLiveFullReferenceMetadata.primary.score)} · {currentLiveFullReferenceMetadata.mode}
                        </span>
                      </div>
                      <p className="mt-1 truncate">
                        {currentLiveFullReferenceMetadata.primary.eligible
                          ? 'Passed strict duration, sentence, cleanliness, loudness, and steady-tone checks.'
                          : currentLiveFullReferenceMetadata.primary.reasons.join(' ')}
                      </p>
                    </div>
                  )}
                </div>

                <div className="hidden">
                  {liveFullPreviewReference.url && (
                    <p className="mb-1 truncate text-[11px] text-slate-400">
                      Previewing {liveFullPreviewReference.role}: {liveFullPreviewReference.filename}
                    </p>
                  )}
                  <audio ref={liveFullPreviewAudioRef} className="w-full" controls preload="metadata"
                    onError={() => { if (liveFullPreviewReference.filename) setLiveFullMessage(`Could not play ${liveFullPreviewReference.filename}.`); }}
                    onPlay={() => setLiveFullMessage('')}
                  />
                </div>

                <div className="hidden">
                  <div>
                    <Label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-widest text-slate-400">Primary transcript</Label>
                    <Textarea
                      className="min-h-[82px] rounded-xl border-slate-200 bg-white shadow-none leading-6"
                      value={liveFullPromptText}
                      onChange={(event) => setLiveFullPromptText(event.target.value)}
                      disabled={streamingRoute !== null}
                    />
                  </div>
                  <div>
                    <Label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-widest text-slate-400">Ref language</Label>
                    <Select value={liveFullPromptLang} onValueChange={setLiveFullPromptLang} disabled={streamingRoute !== null}>
                      <SelectTrigger className="h-10 rounded-xl border-slate-200 bg-white shadow-none"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="en">English</SelectItem>
                        <SelectItem value="zh">Chinese</SelectItem>
                        <SelectItem value="ja">Japanese</SelectItem>
                        <SelectItem value="ko">Korean</SelectItem>
                        <SelectItem value="auto">Auto</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  {[
                    { label: 'Speed', display: liveFullSpeed.toFixed(1) + 'x', min: 0.5, max: 2.0, step: 0.1, val: liveFullSpeed, set: setLiveFullSpeed },
                    { label: 'Top K', display: String(liveFullTopK), min: 1, max: 50, step: 1, val: liveFullTopK, set: setLiveFullTopK },
                    { label: 'Top P', display: liveFullTopP.toFixed(2), min: 0, max: 1, step: 0.05, val: liveFullTopP, set: setLiveFullTopP },
                    { label: 'Temperature', display: liveFullTemperature.toFixed(2), min: 0, max: 1, step: 0.05, val: liveFullTemperature, set: setLiveFullTemperature },
                    { label: 'Saved output gain', display: `${liveFullOutputGainDb > 0 ? '+' : ''}${liveFullOutputGainDb.toFixed(1)} dB`, min: -6, max: 6, step: 0.5, val: liveFullOutputGainDb, set: setLiveFullOutputGainDb },
                    { label: 'Max chunk words', display: liveFullMaxChunkWords === 0 ? 'Auto · 240 chars' : String(liveFullMaxChunkWords), min: 0, max: 100, step: 10, val: liveFullMaxChunkWords, set: setLiveFullMaxChunkWords },
                    { label: 'Max sentences / chunk', display: String(liveFullMaxSentences), min: 1, max: 5, step: 1, val: liveFullMaxSentences, set: setLiveFullMaxSentences },
                  ].map(({ label, display, min, max, step, val, set }) => (
                    <div key={label} className="space-y-3 rounded-xl border border-slate-200 bg-white p-3">
                      <div className="flex items-center justify-between">
                        <Label className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">{label}</Label>
                        <span className="font-mono text-sm font-semibold text-slate-700">{display}</span>
                      </div>
                      <Slider min={min} max={max} step={step} value={[val]} onValueChange={([v]) => set(v)} disabled={streamingRoute !== null} />
                    </div>
                  ))}
                  <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-3 md:col-span-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">Repetition Penalty</Label>
                      <span className="font-mono text-sm font-semibold text-slate-700">{liveFullRepPenalty.toFixed(2)}</span>
                    </div>
                    <Slider min={1.0} max={2.0} step={0.05} value={[liveFullRepPenalty]} onValueChange={([v]) => setLiveFullRepPenalty(v)} disabled={streamingRoute !== null} />
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <div className="rounded-lg border border-slate-100 bg-white px-3 py-2 text-xs text-slate-500">
                  <p className="font-semibold text-slate-700">Current Live Full config</p>
                  <p className="mt-1 truncate">
                    Refs from Live Fast #1: {liveFastRankOneReferenceSummary.primaryName} - speed {liveFullSettings.speed.toFixed(1)} - temp {liveFullSettings.temperature.toFixed(2)}
                  </p>
                  <p className="mt-1 truncate">
                    top k {liveFullSettings.topK} · top p {liveFullSettings.topP.toFixed(2)} · rep {liveFullSettings.repPenalty.toFixed(2)} · gain {liveFullSettings.outputGainDb > 0 ? '+' : ''}{liveFullSettings.outputGainDb.toFixed(1)} dB
                  </p>
                  <p className="mt-1 truncate">
                    chunks {liveFullSettings.maxChunkWords > 0 ? `${liveFullSettings.maxChunkWords} words` : 'auto (240 chars)'} · max {liveFullSettings.maxSentencesPerChunk} sentence{liveFullSettings.maxSentencesPerChunk === 1 ? '' : 's'}
                  </p>
                </div>

                <div className="rounded-lg border border-slate-100 bg-white p-2">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-slate-700">Saved Live Full configs</p>
                    <button
                      type="button"
                      onClick={() => loadVoiceConfigs(selectedVoiceProfileId)}
                      disabled={loadingVoiceConfigs || !selectedVoiceProfileId}
                      className="text-xs font-medium text-slate-500 hover:text-slate-800 disabled:opacity-40"
                    >
                      {loadingVoiceConfigs ? 'Loading...' : 'Refresh'}
                    </button>
                  </div>
                  {liveFullConfigs.length === 0 ? (
                    <p className="rounded-lg border border-amber-100 bg-amber-50 px-2 py-2 text-xs text-amber-700">
                      No saved Live Full configs yet. A default metadata preset will be saved after Live Fast rank #1 exists.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {liveFullConfigs.map((config, index) => {
                        const defaults = config.inferenceMetadata?.defaults || {};
                        const busy = savingLiveFullConfigId === config.configId
                          || generatingLiveFullSampleConfigId === config.configId;
                        const loaded = loadedLiveFullConfigId === config.configId;
                        return (
                          <div key={config.configId} className={cn('rounded-lg border bg-white p-2', loaded ? 'border-blue-200 ring-1 ring-blue-100' : 'border-slate-200')}>
                            <div className="space-y-2">
                              <div className="min-w-0">
                                <p className="truncate text-xs font-semibold text-slate-800" title={config.configName || config.configId}>
                                  #{index + 1} {config.configName || config.configId}
                                  {loaded && <span className="ml-1 rounded-full bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700">loaded</span>}
                                </p>
                                <p className="mt-0.5 truncate text-[11px] text-slate-500" title={liveFastRankOneReferenceSummary.primaryName}>
                                  Refs from Live Fast #1: {liveFastRankOneReferenceSummary.primaryName}
                                </p>
                                <p className="mt-0.5 truncate text-[11px] text-slate-400">
                                  speed {defaults.speed_factor ?? 'n/a'} · top k {defaults.top_k ?? 'n/a'} · temp {defaults.temperature ?? 'n/a'}
                                </p>
                              </div>
                              <div className="flex flex-wrap gap-1">
                                <button type="button" onClick={() => moveLiveFullConfig(config.configId, -1)} disabled={busy || index === 0} title="Move up" className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-40">Up</button>
                                <button type="button" onClick={() => moveLiveFullConfig(config.configId, 1)} disabled={busy || index === liveFullConfigs.length - 1} title="Move down" className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-40">Down</button>
                                <button type="button" onClick={() => loadSavedLiveFullConfig(config)} disabled={busy || streamingRoute !== null} className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-40">Load</button>
                                <button type="button" onClick={() => saveCurrentLiveFullConfig(config)} disabled={busy || !loaded} className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-40">Update</button>
                                <button type="button" onClick={() => generateLiveFullConfigSample(config)} disabled={busy || streamingRoute !== null} className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-40">
                                  {generatingLiveFullSampleConfigId === config.configId ? 'Generating' : 'Sample'}
                                </button>
                                <button type="button" onClick={() => deleteSavedLiveFullConfig(config.configId)} disabled={busy} className="rounded-md border border-red-100 bg-white px-2 py-1 text-[11px] text-red-500 hover:bg-red-50 disabled:opacity-40">Delete</button>
                              </div>
                            </div>
                            {config.sample?.generatedAt && (
                              <p className="mt-2 text-[11px] text-slate-400">
                                Sample metadata saved {new Date(config.sample.generatedAt).toLocaleString()}.
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
                {liveFullMessage && <p className="rounded-lg border border-slate-100 bg-white px-3 py-2 text-xs text-slate-500">{liveFullMessage}</p>}
              </div>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
      )}

      <audio ref={audioRef} className="hidden" onEnded={liveSpeech.onAudioEnded} onError={handleLiveAudioError} />
    </div>
  );
}
