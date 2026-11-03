import React, { useState, useEffect, useRef } from 'react';
import AudioPlayer from '../components/AudioPlayer.jsx';
import FloatingNotice from '../components/FloatingNotice.jsx';
import ReferencePresetLibrary from '../components/ReferencePresetLibrary.jsx';
import RefAudioPlayer from '../components/RefAudioPlayer.jsx';
import Spinner from '../components/Spinner.jsx';
import VoiceProfileSelector from '../components/VoiceProfileSelector.jsx';
import { getModels, selectModels, uploadRefAudio, transcribeAudio, getInferenceStatus, startGeneration, synthesize, getGenerationResult, cancelGeneration, getTrainingAudioFiles, getTrainingAudioUrl, getCurrentInference, getUploadedRefAudioUrl, activateVoiceProfile, getFullActiveVoiceProfile } from '../services/api.js';
import { useInferenceSSE } from '../hooks/useInferenceSSE.js';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Activity, ChevronRight, RefreshCw, Upload, Play, X, Check, Pencil, Mic } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getStorageMode } from '@/lib/runtimeConfig';
import {
  INFERENCE_REFERENCE_PRESETS_KEY,
  buildReferencePreset,
  createReferencePresetName,
  createReferencePresetSignature,
  parseStoredReferencePresets,
} from '@/lib/referencePresets';
import {
  chooseBestReferenceSet,
  shouldAutoApplyBestReferenceSet,
} from '@/lib/referenceSelection';
import { formatActiveVoiceProfileSummary } from '@/lib/activeVoiceProfile';
import {
  buildModelSelectWarmPayload,
  extractModelSelectWarmedReferenceSelection,
  resolveInferenceStatusState,
} from '@/lib/modelLoading';
import { buildVoiceProfiles, extractExpName } from '@/lib/voiceProfiles';
import { buildVoiceProfileId, buildVoiceProfilePayload } from '@/lib/voiceProfilePayload';
import {
  buildSavedVoiceProfileRestoreKey,
  findSavedVoiceProfileKey,
  hasRestorableSavedVoiceProfile,
  matchesSavedVoiceProfileReferenceSelection,
  matchesSavedVoiceProfileSelection,
} from '@/lib/savedVoiceProfile';
import {
  createAutoVoiceProfileSyncFingerprint,
  getAutoSyncRequestFingerprint,
} from '@/lib/autoVoiceProfileSync';

const INFERENCE_DRAFT_KEY = 'voice-cloning-inference-draft';
const NOTICE_TIMEOUT_MS = 4200;

function revokeIfBlobUrl(url) {
  if (url?.startsWith('blob:')) {
    URL.revokeObjectURL(url);
  }
}

function getFallbackReferenceName(filePath) {
  return (filePath || '').replace(/\\/g, '/').split('/').pop() || 'reference.wav';
}

function normalizeReferenceLanguage(lang) {
  const langMap = {
    ZH: 'zh',
    EN: 'en',
    JA: 'ja',
    KO: 'ko',
    AUTO: 'auto',
    zh: 'zh',
    en: 'en',
    ja: 'ja',
    ko: 'ko',
    auto: 'auto',
  };
  return langMap[lang] || 'en';
}

export default function InferencePage({ directMode = false }) {
  const [gptModels, setGptModels] = useState([]);
  const [sovitsModels, setSovitsModels] = useState([]);
  const [selectedPersonKey, setSelectedPersonKey] = useState('');
  const [selectedGPTPath, setSelectedGPTPath] = useState('');
  const [selectedSoVITSPath, setSelectedSoVITSPath] = useState('');
  const [modelsFetched, setModelsFetched] = useState(false);
  const [loadedGPTPath, setLoadedGPTPath] = useState('');
  const [loadedSoVITSPath, setLoadedSoVITSPath] = useState('');
  const [serverReady, setServerReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [savingVoiceProfile, setSavingVoiceProfile] = useState(false);
  const [activeVoiceProfile, setActiveVoiceProfile] = useState(null);
  const [loadingActiveVoiceProfile, setLoadingActiveVoiceProfile] = useState(true);
  const [activeVoiceProfileError, setActiveVoiceProfileError] = useState('');
  const [modelError, setModelError] = useState(null);

  const [refAudioPath, setRefAudioPath] = useState('');
  const [refAudioFile, setRefAudioFile] = useState(null);
  const [refAudioUrl, setRefAudioUrl] = useState(null);
  const [promptText, setPromptText] = useState('');
  const [promptLang, setPromptLang] = useState('en');
  const [transcribing, setTranscribing] = useState(false);

  const [uploadedRefFiles, setUploadedRefFiles] = useState([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);

  const [trainingAudioFiles, setTrainingAudioFiles] = useState([]);
  const [loadedTrainingAudioSourceKey, setLoadedTrainingAudioSourceKey] = useState('');
  const [auxRefAudios, setAuxRefAudios] = useState([]);
  const [loadingTrainingAudio, setLoadingTrainingAudio] = useState(false);
  const [refLocked, setRefLocked] = useState(false);
  const [previewAudioPath, setPreviewAudioPath] = useState('');
  const [previewAudioUrl, setPreviewAudioUrl] = useState(null);
  const [previewAudioName, setPreviewAudioName] = useState('');
  const [previewAudioRole, setPreviewAudioRole] = useState('primary');

  const [text, setText] = useState('');
  const [textLang, setTextLang] = useState('en');

  const [showSettings, setShowSettings] = useState(false);
  const [speed, setSpeed] = useState(1.0);
  const [topK, setTopK] = useState(5);
  const [topP, setTopP] = useState(0.85);
  const [temperature, setTemperature] = useState(0.7);
  const [repPenalty, setRepPenalty] = useState(1.35);

  const [audioBlob, setAudioBlob] = useState(null);
  const [inferError, setInferError] = useState(null);
  const [directSynthesizing, setDirectSynthesizing] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const [referencePresets, setReferencePresets] = useState([]);
  const [activeReferencePresetId, setActiveReferencePresetId] = useState('');
  const [notice, setNotice] = useState(null);
  const [referencePresetsRestored, setReferencePresetsRestored] = useState(false);
  const sessionIdRef = useRef(null);
  const restoredSessionRef = useRef(null);
  const noticeTimeoutRef = useRef(null);
  const skipNextCompletionToastRef = useRef(false);
  const autoLoadKeyRef = useRef('');
  const autoReferenceProfileRef = useRef('');
  const urlVoiceKeyRef = useRef('');
  const restoredActiveVoiceProfileKeyRef = useRef('');
  const pendingAutoSyncFingerprintRef = useRef('');
  const autoSyncRequestFingerprintRef = useRef('');
  const lastAutoSyncedFingerprintRef = useRef('');
  const statusRequestVersionRef = useRef(0);
  const loadedModelStateRef = useRef({ gptPath: '', sovitsPath: '' });

  const inference = useInferenceSSE();
  const voiceProfiles = buildVoiceProfiles(gptModels, sovitsModels);
  const selectedProfile = voiceProfiles.find(profile => profile.key === selectedPersonKey) || null;
  const selectedGPTCandidate = selectedProfile?.gptCandidates?.find(candidate => candidate.model.path === selectedGPTPath)
    || selectedProfile?.gptCandidates?.[0]
    || null;
  const selectedSoVITSCandidate = selectedProfile?.sovitsCandidates?.find(candidate => candidate.model.path === selectedSoVITSPath)
    || selectedProfile?.sovitsCandidates?.[0]
    || null;
  const selectedGPT = selectedGPTCandidate?.model?.path || '';
  const selectedSoVITS = selectedSoVITSCandidate?.model?.path || '';
  const currentExpName = selectedProfile?.expName || null;
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
  const selectionLoaded = Boolean(
    serverReady
      && selectedGPT
      && selectedSoVITS
      && loadedGPTPath === selectedGPT
      && loadedSoVITSPath === selectedSoVITS
  );
  const availableProfiles = voiceProfiles.filter(profile => profile.complete);
  const loadedProfileName = extractExpName(loadedSoVITSPath) || extractExpName(loadedGPTPath);
  const uploadedAuxRefFiles = uploadedRefFiles.filter(file => file.serverPath !== refAudioPath);
  const selectedAuxReferences = [
    ...auxRefAudios.map((file) => ({
      path: file.path,
      name: file.filename,
      source: 'training',
    })),
    ...uploadedAuxRefFiles.map((file) => ({
      path: file.serverPath,
      name: file.name,
      source: 'uploaded',
    })),
  ];
  const currentPrimaryReference = refAudioPath
    ? {
        path: refAudioPath,
        name: refAudioFile?.name || getFallbackReferenceName(refAudioPath),
        source: uploadedRefFiles.some((file) => file.serverPath === refAudioPath) ? 'uploaded' : 'training',
      }
    : null;
  const currentReferenceSignature = currentPrimaryReference
    ? createReferencePresetSignature({
        selectedPersonKey,
        selectedGPTPath,
        selectedSoVITSPath,
        primary: currentPrimaryReference,
        aux: selectedAuxReferences,
        promptText,
        promptLang,
      })
    : '';
  const currentAutoSyncFingerprint = createAutoVoiceProfileSyncFingerprint({
    sourceKey: currentExpName || '',
    selectedGPT,
    selectedSoVITS,
    refAudioPath,
    promptText,
    promptLang,
    textLang,
    preferredRoute: directMode ? 'sentence' : 'full',
    auxRefAudioPaths: selectedAuxReferences.map((reference) => reference.path),
    defaults: {
      top_k: topK,
      top_p: topP,
      temperature,
      repetition_penalty: repPenalty,
      speed_factor: speed,
    },
  });
  const autoSyncRequestFingerprint = getAutoSyncRequestFingerprint({
    pendingFingerprint: pendingAutoSyncFingerprintRef.current,
    currentFingerprint: currentAutoSyncFingerprint,
    lastSyncedFingerprint: lastAutoSyncedFingerprintRef.current,
    ready: selectionLoaded && refLocked && Boolean(refAudioPath),
    busy: loading,
    inFlightFingerprint: autoSyncRequestFingerprintRef.current,
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const voiceParam = params.get('voice');
    if (voiceParam) {
      urlVoiceKeyRef.current = voiceParam.toLowerCase().replace(/[\s_-]+/g, '');
    }

    restoreDraft();
    restoreReferencePresets();
    fetchModels();
    checkStatus();
    loadActiveVoiceProfile();
    restoreInferenceState();

    return () => {
      if (noticeTimeoutRef.current) {
        window.clearTimeout(noticeTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    function handleGpuReady() {
      autoLoadKeyRef.current = '';
      fetchModels();
      checkStatus();
      loadActiveVoiceProfile();
    }

    window.addEventListener('voice-cloning-gpu-ready', handleGpuReady);
    return () => window.removeEventListener('voice-cloning-gpu-ready', handleGpuReady);
  }, []);

  async function fetchModels() {
    try {
      const res = await getModels();
      setGptModels(res.data.gpt || []);
      setSovitsModels(res.data.sovits || []);
      setModelError(null);
    } catch (err) {
      setModelError(err.response?.data?.error || err.message || 'Failed to load model library');
    } finally {
      setModelsFetched(true);
    }
  }

  function applyInferenceStatusState(nextState = {}) {
    loadedModelStateRef.current = {
      gptPath: String(nextState.loadedGPTPath || '').trim(),
      sovitsPath: String(nextState.loadedSoVITSPath || '').trim(),
    };
    setServerReady(Boolean(nextState.serverReady));
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
      applyInferenceStatusState(resolveInferenceStatusState({
        status: res.data,
        fallbackLoadedGPTPath: loadedModelStateRef.current.gptPath,
        fallbackLoadedSoVITSPath: loadedModelStateRef.current.sovitsPath,
      }));
    } catch {
      if (statusRequestVersionRef.current !== requestVersion) {
        return;
      }
      applyInferenceStatusState(resolveInferenceStatusState({
        status: { ready: false },
        fallbackLoadedGPTPath: loadedModelStateRef.current.gptPath,
        fallbackLoadedSoVITSPath: loadedModelStateRef.current.sovitsPath,
      }));
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

  function restoreReferencePresets() {
    const raw = window.localStorage.getItem(INFERENCE_REFERENCE_PRESETS_KEY);
    setReferencePresets(parseStoredReferencePresets(raw));
    setReferencePresetsRestored(true);
  }

  function showNotice({ title, message = '', tone = 'success' }) {
    if (noticeTimeoutRef.current) {
      window.clearTimeout(noticeTimeoutRef.current);
    }

    const id = Date.now();
    setNotice({ id, title, message, tone });
    noticeTimeoutRef.current = window.setTimeout(() => {
      setNotice((current) => (current?.id === id ? null : current));
    }, NOTICE_TIMEOUT_MS);
  }

  async function restoreDraft() {
    try {
      const raw = window.localStorage.getItem(INFERENCE_DRAFT_KEY);
      if (!raw) return;

      const draft = JSON.parse(raw);
      setSelectedPersonKey(draft.selectedPersonKey || '');
      setSelectedGPTPath(draft.selectedGPTPath || '');
      setSelectedSoVITSPath(draft.selectedSoVITSPath || '');
      setRefAudioPath(draft.refAudioPath || '');
      setRefAudioFile(draft.refAudioFile || null);
      setPromptText(draft.promptText || '');
      setPromptLang(draft.promptLang || 'en');

      if (Array.isArray(draft.uploadedRefFiles)) {
        const restoredFiles = await Promise.all(
          draft.uploadedRefFiles.map(async (file) => ({
            ...file,
            localUrl: await getUploadedRefAudioUrl(file.serverPath),
          }))
        );
        setUploadedRefFiles(restoredFiles);
      }

      setAuxRefAudios(Array.isArray(draft.auxRefAudios) ? draft.auxRefAudios : []);
      setRefLocked(Boolean(draft.refLocked));
      setText(draft.text || '');
      setTextLang(draft.textLang || 'en');
      setSpeed(Number.isFinite(draft.speed) ? draft.speed : 1.0);
      setTopK(Number.isFinite(draft.topK) ? draft.topK : 5);
      setTopP(Number.isFinite(draft.topP) ? draft.topP : 0.85);
      setTemperature(Number.isFinite(draft.temperature) ? draft.temperature : 0.7);
      setRepPenalty(Number.isFinite(draft.repPenalty) ? draft.repPenalty : 1.35);
      setShowSettings(Boolean(draft.showSettings));
      setPreviewAudioPath(draft.previewAudioPath || '');
      setPreviewAudioName(draft.previewAudioName || '');
      setPreviewAudioRole(draft.previewAudioRole || 'primary');
    } catch {
      /* ignore invalid draft */
    } finally {
      setDraftRestored(true);
    }
  }

  async function restoreInferenceState() {
    try {
      const res = await getCurrentInference();
      const current = res.data;
      if (!current?.sessionId) return;

      sessionIdRef.current = current.sessionId;

      if (current.params) {
        const primaryRefPath = current.params.ref_audio_path || '';
        setText(current.params.text || '');
        setTextLang(current.params.text_lang || 'en');
        setRefAudioPath(primaryRefPath);
        if (primaryRefPath) {
          const fallbackName = primaryRefPath.replace(/\\/g, '/').split('/').pop();
          setRefAudioFile({ name: fallbackName });
          if (/TEMP[\\/]+ref_audio/i.test(primaryRefPath)) {
            setRefAudioUrl(await getUploadedRefAudioUrl(primaryRefPath));
          }
        }
        setPromptText(current.params.prompt_text || '');
        setPromptLang(current.params.prompt_lang || 'en');
        setSpeed(Number.isFinite(current.params.speed_factor) ? current.params.speed_factor : 1.0);
        setTopK(Number.isFinite(current.params.top_k) ? current.params.top_k : 5);
        setTopP(Number.isFinite(current.params.top_p) ? current.params.top_p : 0.85);
        setTemperature(Number.isFinite(current.params.temperature) ? current.params.temperature : 0.7);
        setRepPenalty(Number.isFinite(current.params.repetition_penalty) ? current.params.repetition_penalty : 1.35);
        setRefLocked(Boolean(current.params.ref_audio_path));
      }

      if (current.sessionId === restoredSessionRef.current) return;

      const nextState = {
        initialStatus: current.status || 'idle',
        initialTotalChunks: current.totalChunks || 0,
        initialCompletedChunks: current.completedChunks || 0,
        initialCurrentChunkText: current.currentChunkText || '',
        initialError: current.error || null,
      };

      if (current.status === 'waiting' || current.status === 'generating') {
        inference.connect(current.sessionId, nextState);
      } else {
        inference.disconnect();
        inference.hydrate(nextState);
      }

      if (current.status === 'complete' && current.resultReady) {
        skipNextCompletionToastRef.current = true;
        const blob = await getGenerationResult(current.sessionId);
        setAudioBlob(blob);
      }

      restoredSessionRef.current = current.sessionId;
    } catch (err) {
      console.error('Failed to restore inference state:', err);
    }
  }

  useEffect(() => {
    if (!modelsFetched) return;

    const profiles = buildVoiceProfiles(gptModels, sovitsModels);

    if (profiles.length === 0) {
      if (selectedPersonKey) {
        setSelectedPersonKey('');
      }
      return;
    }

    if (urlVoiceKeyRef.current) {
      const targetKey = urlVoiceKeyRef.current;
      const match = profiles.find(p => p.key === targetKey && p.complete);
      if (match) {
        urlVoiceKeyRef.current = '';
        setSelectedPersonKey(match.key);
        showNotice({
          title: `Voice "${match.displayName}" selected`,
          message: 'Loading model — this may take a moment.',
          tone: 'success',
        });
        return;
      }
      // Keep ref populated so a subsequent model refresh (fetchModels) can still auto-select
      showNotice({
        title: 'Voice not found yet',
        message: `"${targetKey}" may still be uploading to S3. Refresh in a moment.`,
        tone: 'error',
      });
    }

    if (loadingActiveVoiceProfile) {
      return;
    }

    const selectionStillValid = profiles.some(
      profile => profile.key === selectedPersonKey && profile.complete
    );

    if (!selectionStillValid) {
      const activeMatchKey = findSavedVoiceProfileKey(profiles, activeVoiceProfile?.voiceProfileId || '');
      const activeMatch = profiles.find(
        (profile) => profile.key === activeMatchKey && profile.complete,
      );
      const loadedMatch = profiles.find(
        profile => profile.complete
          && profile.gptModel?.path === loadedGPTPath
          && profile.sovitsModel?.path === loadedSoVITSPath
      );
      const fallback = activeMatch || loadedMatch || profiles.find(profile => profile.complete) || profiles[0];
      if (fallback?.key && fallback.key !== selectedPersonKey) {
        setSelectedPersonKey(fallback.key);
      }
    }
  }, [
    modelsFetched,
    gptModels,
    sovitsModels,
    selectedPersonKey,
    loadedGPTPath,
    loadedSoVITSPath,
    loadingActiveVoiceProfile,
    activeVoiceProfile,
  ]);

  useEffect(() => {
    if (!modelsFetched) return;

    if (!selectedProfile) {
      setSelectedGPTPath('');
      setSelectedSoVITSPath('');
      return;
    }

    const gptPathIsValid = selectedProfile.gptCandidates?.some(candidate => candidate.model.path === selectedGPTPath);
    const sovitsPathIsValid = selectedProfile.sovitsCandidates?.some(candidate => candidate.model.path === selectedSoVITSPath);

    const nextGPTPath = gptPathIsValid
      ? selectedGPTPath
      : (selectedProfile.gptCandidates?.find(candidate => candidate.model.path === loadedGPTPath)?.model.path
        || selectedProfile.gptCandidates?.[0]?.model.path
        || '');
    const nextSoVITSPath = sovitsPathIsValid
      ? selectedSoVITSPath
      : (selectedProfile.sovitsCandidates?.find(candidate => candidate.model.path === loadedSoVITSPath)?.model.path
        || selectedProfile.sovitsCandidates?.[0]?.model.path
        || '');

    if (nextGPTPath !== selectedGPTPath) {
      setSelectedGPTPath(nextGPTPath);
    }
    if (nextSoVITSPath !== selectedSoVITSPath) {
      setSelectedSoVITSPath(nextSoVITSPath);
    }
  }, [modelsFetched, selectedProfile, selectedGPTPath, selectedSoVITSPath, loadedGPTPath, loadedSoVITSPath]);

  useEffect(() => {
    if (!modelsFetched || !selectedProfile?.complete || !selectedGPT || !selectedSoVITS) return;

    const loadKey = `${selectedGPT}::${selectedSoVITS}`;
    if (!serverReady) {
      autoLoadKeyRef.current = '';
      return;
    }

    if (selectionLoaded) {
      autoLoadKeyRef.current = loadKey;
      return;
    }
    if (loading || autoLoadKeyRef.current === loadKey) return;

    autoLoadKeyRef.current = loadKey;
    handleLoadModels({ auto: true });
  }, [
    modelsFetched,
    selectedProfile,
    selectedGPT,
    selectedSoVITS,
    serverReady,
    selectionLoaded,
    loading,
  ]);

  useEffect(() => {
    if (!currentExpName) {
      setTrainingAudioFiles([]);
      setLoadedTrainingAudioSourceKey('');
      setLoadingTrainingAudio(false);
      return;
    }
    let ignore = false;
    setTrainingAudioFiles([]);
    setLoadedTrainingAudioSourceKey('');
    setLoadingTrainingAudio(true);
    getTrainingAudioFiles(currentExpName)
      .then((res) => {
        if (!ignore) {
          setTrainingAudioFiles(res.data.files || []);
          setLoadedTrainingAudioSourceKey(currentExpName);
        }
      })
      .catch(() => {
        if (!ignore) {
          setTrainingAudioFiles([]);
          setLoadedTrainingAudioSourceKey('');
        }
      })
      .finally(() => {
        if (!ignore) {
          setLoadingTrainingAudio(false);
        }
      });
    return () => {
      ignore = true;
    };
  }, [currentExpName]);

  useEffect(() => {
    if (loadingActiveVoiceProfile || canRestoreActiveVoiceProfile) return;

    const primaryIsUploaded = uploadedRefFiles.some(file => file.serverPath === refAudioPath);
    const keepConfirmedSelection = refLocked && (primaryIsUploaded || activeReferencePresetId);

    if (!shouldAutoApplyBestReferenceSet({
      selectedSourceKey: currentExpName || '',
      loadedSourceKey: loadedTrainingAudioSourceKey,
      loading: loadingTrainingAudio,
      fileCount: trainingAudioFiles.length,
      lastAppliedSourceKey: autoReferenceProfileRef.current,
    }) || keepConfirmedSelection) return;
    if (primaryIsUploaded) return;

    const selection = chooseBestReferenceSet(trainingAudioFiles);
    if (!selection.primary) return;

    autoReferenceProfileRef.current = currentExpName;
    const primary = selection.primary;
    const aux = selection.aux;

    getTrainingAudioUrl(currentExpName, primary.filename)
      .then((url) => {
        setRefAudioPath(primary.path);
        setRefAudioFile({ name: primary.filename });
        setRefAudioUrl(url);
        setPromptText(primary.transcript || '');
        setPromptLang(normalizeReferenceLanguage(primary.lang));
        setAuxRefAudios(aux);
        setRefLocked(true);
        setActiveReferencePresetId('');
        setPreview({
          path: primary.path,
          url,
          name: primary.filename,
          role: 'primary',
        });
      showNotice({
        title: 'Reference auto-selected',
        message: `${primary.filename} is ready with ${aux.length} auxiliary clip${aux.length === 1 ? '' : 's'}.`,
        tone: 'success',
      });
      pendingAutoSyncFingerprintRef.current = createAutoVoiceProfileSyncFingerprint({
        sourceKey: currentExpName || '',
        selectedGPT,
        selectedSoVITS,
        refAudioPath: primary.path,
        promptText: primary.transcript || '',
        promptLang: normalizeReferenceLanguage(primary.lang),
        textLang,
        preferredRoute: directMode ? 'sentence' : 'full',
        auxRefAudioPaths: aux.map((file) => file.path),
        defaults: {
          top_k: topK,
          top_p: topP,
          temperature,
          repetition_penalty: repPenalty,
          speed_factor: speed,
        },
      });
    })
      .catch(() => {
        // Keep manual selection available if preview URL resolution fails.
      });
  }, [
    currentExpName,
    loadedTrainingAudioSourceKey,
    loadingTrainingAudio,
    trainingAudioFiles,
    refLocked,
    uploadedRefFiles,
    refAudioPath,
    activeReferencePresetId,
    loadingActiveVoiceProfile,
    canRestoreActiveVoiceProfile,
  ]);

  useEffect(() => {
    if (!refAudioPath) return;

    (async () => {
      const uploadedMatch = uploadedRefFiles.find(file => file.serverPath === refAudioPath);
      if (uploadedMatch) {
        setRefAudioFile(prev => prev?.name ? prev : { name: uploadedMatch.name });
        if (!refAudioUrl) {
          const url = await getUploadedRefAudioUrl(uploadedMatch.serverPath);
          setRefAudioUrl(url);
        }
        if (!previewAudioPath) {
          const url = uploadedMatch.localUrl || await getUploadedRefAudioUrl(uploadedMatch.serverPath);
          setPreview({
            path: uploadedMatch.serverPath,
            url,
            name: uploadedMatch.name,
            role: 'primary',
          });
        }
        return;
      }

      const trainingMatch = trainingAudioFiles.find(file => file.path === refAudioPath);
      if (trainingMatch && currentExpName) {
        setRefAudioFile(prev => prev?.name ? prev : { name: trainingMatch.filename });
        if (!refAudioUrl) {
          const url = await getTrainingAudioUrl(currentExpName, trainingMatch.filename);
          setRefAudioUrl(url);
        }
        if (!previewAudioPath) {
          const url = await getTrainingAudioUrl(currentExpName, trainingMatch.filename);
          setPreview({
            path: trainingMatch.path,
            url,
            name: trainingMatch.filename,
            role: 'primary',
          });
        }
      }
    })();
  }, [refAudioPath, uploadedRefFiles, trainingAudioFiles, currentExpName, previewAudioPath]);

  useEffect(() => {
    if (!previewAudioPath) return;

    (async () => {
      const uploadedMatch = uploadedRefFiles.find(file => file.serverPath === previewAudioPath);
      if (uploadedMatch) {
        const url = uploadedMatch.localUrl || await getUploadedRefAudioUrl(uploadedMatch.serverPath);
        setPreview({
          path: uploadedMatch.serverPath,
          url,
          name: uploadedMatch.name,
          role: previewAudioPath === refAudioPath ? 'primary' : 'auxiliary',
        });
        return;
      }

      const trainingMatch = trainingAudioFiles.find(file => file.path === previewAudioPath);
      if (trainingMatch && currentExpName) {
        const url = await getTrainingAudioUrl(currentExpName, trainingMatch.filename);
        setPreview({
          path: trainingMatch.path,
          url,
          name: trainingMatch.filename,
          role: trainingMatch.path === refAudioPath ? 'primary' : 'auxiliary',
        });
      }
    })();
  }, [previewAudioPath, uploadedRefFiles, trainingAudioFiles, currentExpName, refAudioPath]);

  useEffect(() => {
    if (!draftRestored) return;

    const draft = {
      selectedPersonKey,
      selectedGPTPath,
      selectedSoVITSPath,
      refAudioPath,
      refAudioFile,
      promptText,
      promptLang,
      uploadedRefFiles: uploadedRefFiles.map(file => ({
        name: file.name,
        serverPath: file.serverPath,
      })),
      auxRefAudios,
      refLocked,
      text,
      textLang,
      speed,
      topK,
      topP,
      temperature,
      repPenalty,
      showSettings,
      previewAudioPath,
      previewAudioName,
      previewAudioRole,
    };

    window.localStorage.setItem(INFERENCE_DRAFT_KEY, JSON.stringify(draft));
  }, [
    draftRestored,
    selectedPersonKey,
    selectedGPTPath,
    selectedSoVITSPath,
    refAudioPath,
    refAudioFile,
    promptText,
    promptLang,
    uploadedRefFiles,
    auxRefAudios,
    refLocked,
    text,
    textLang,
    speed,
    topK,
    topP,
    temperature,
    repPenalty,
    showSettings,
    previewAudioPath,
    previewAudioName,
    previewAudioRole,
  ]);

  useEffect(() => {
    if (!referencePresetsRestored) return;
    window.localStorage.setItem(INFERENCE_REFERENCE_PRESETS_KEY, JSON.stringify(referencePresets));
  }, [referencePresets, referencePresetsRestored]);

  useEffect(() => {
    const matchingPreset = referencePresets.find((preset) => preset.signature === currentReferenceSignature);
    const nextId = matchingPreset?.id || '';
    setActiveReferencePresetId((current) => (current === nextId ? current : nextId));
  }, [referencePresets, currentReferenceSignature]);

  function setPreview({ path, url, name, role = 'primary' }) {
    setPreviewAudioPath(path || '');
    setPreviewAudioUrl(url || null);
    setPreviewAudioName(name || '');
    setPreviewAudioRole(role);
  }

  async function getReferenceUrl(reference, fallbackExpName = currentExpName) {
    if (!reference?.path) return null;
    if (reference.source === 'uploaded') {
      return getUploadedRefAudioUrl(reference.path);
    }

    const expName = fallbackExpName || extractExpName(reference.path);
    if (!expName) return null;
    return getTrainingAudioUrl(expName, reference.name || getFallbackReferenceName(reference.path));
  }

  async function ensureUploadedReferences(entries) {
    if (!entries.length) return;
    const newEntries = [];
    const existingPaths = new Set(uploadedRefFiles.map(f => f.serverPath));
    for (const entry of entries) {
      if (!entry?.path || existingPaths.has(entry.path)) continue;
      const localUrl = await getUploadedRefAudioUrl(entry.path);
      newEntries.push({
        name: entry.name || getFallbackReferenceName(entry.path),
        serverPath: entry.path,
        localUrl,
      });
    }
    if (newEntries.length > 0) {
      setUploadedRefFiles(prev => [...prev, ...newEntries]);
    }
  }

  async function applyReferencePreset(preset, { showLoadedNotice = true } = {}) {
    if (!preset?.primary?.path) return;

    const uploadedEntries = [preset.primary, ...(preset.aux || [])].filter((entry) => entry.source === 'uploaded');
    await ensureUploadedReferences(uploadedEntries);

    if (preset.selectedPersonKey) {
      setSelectedPersonKey(preset.selectedPersonKey);
    }
    setSelectedGPTPath(preset.selectedGPTPath || '');
    setSelectedSoVITSPath(preset.selectedSoVITSPath || '');

    revokeIfBlobUrl(refAudioUrl);
    setRefAudioPath(preset.primary.path);
    setRefAudioFile({ name: preset.primary.name || getFallbackReferenceName(preset.primary.path) });
    const primaryUrl = await getReferenceUrl(preset.primary, preset.expName);
    setRefAudioUrl(primaryUrl);
    setPromptText(preset.promptText || '');
    setPromptLang(preset.promptLang || 'en');
    setAuxRefAudios(
      (preset.aux || [])
        .filter((entry) => entry.source !== 'uploaded')
        .map((entry) => ({
          filename: entry.name || getFallbackReferenceName(entry.path),
          path: entry.path,
        }))
    );
    const previewUrl = await getReferenceUrl(preset.primary, preset.expName);
    setPreview({
      path: preset.primary.path,
      url: previewUrl,
      name: preset.primary.name || getFallbackReferenceName(preset.primary.path),
      role: 'primary',
    });
    setRefLocked(true);
    setActiveReferencePresetId(preset.id);
    if (showLoadedNotice) {
      showNotice({
        title: 'Reference set loaded',
        message: `Using ${preset.name} for the current inference setup.`,
        tone: 'success',
      });
    }
  }

  async function syncLoadedModelReferenceSelection(result = {}) {
    const selection = extractModelSelectWarmedReferenceSelection(result);
    if (!selection) {
      return null;
    }

    const trainingByPath = new Map(
      trainingAudioFiles
        .filter((file) => file?.path)
        .map((file) => [file.path, file]),
    );
    const selectedActiveProfile = selectedVoiceProfileId
      && activeVoiceProfile?.voiceProfileId === selectedVoiceProfileId
      ? activeVoiceProfile
      : null;
    const primaryPath = selection.refAudioPath;
    const primaryFile = trainingByPath.get(primaryPath) || null;
    const toReferenceEntry = (referencePath) => {
      const trainingMatch = trainingByPath.get(referencePath);
      const isTrainingReference = Boolean(trainingMatch) || String(referencePath || '').startsWith('training/');
      return {
        path: referencePath,
        name: trainingMatch?.filename || getFallbackReferenceName(referencePath),
        source: isTrainingReference ? 'training' : 'uploaded',
      };
    };

    const preset = buildReferencePreset({
      id: 'loaded-model-selection',
      name: `Loaded - ${selectedProfile?.displayName || 'Voice Profile'}`,
      selectedPersonKey,
      selectedGPTPath: selectedGPT,
      selectedSoVITSPath: selectedSoVITS,
      voiceLabel: selectedProfile?.displayName || selectedActiveProfile?.displayName || '',
      expName: currentExpName || extractExpName(primaryPath) || '',
      primary: toReferenceEntry(primaryPath),
      aux: selection.auxRefAudioPaths.map(toReferenceEntry),
      promptText: selectedActiveProfile
        ? String(selectedActiveProfile.prompt_text || '')
        : String(primaryFile?.transcript || promptText),
      promptLang: selectedActiveProfile
        ? normalizeReferenceLanguage(selectedActiveProfile.prompt_lang)
        : normalizeReferenceLanguage(primaryFile?.lang || promptLang),
    });
    if (!preset) {
      return null;
    }

    pendingAutoSyncFingerprintRef.current = '';
    autoSyncRequestFingerprintRef.current = '';
    await applyReferencePreset(preset, { showLoadedNotice: false });

    if (selectedActiveProfile) {
      setActiveVoiceProfile((current) => (
        current ? {
          ...current,
          ref_audio_path: primaryPath,
          aux_ref_audio_paths: selection.auxRefAudioPaths,
        } : current
      ));
    }

    return {
      ...selection,
      primaryFilename: primaryFile?.filename || getFallbackReferenceName(primaryPath),
    };
  }

  useEffect(() => {
    restoredActiveVoiceProfileKeyRef.current = '';
  }, [selectedVoiceProfileId, selectedGPT, selectedSoVITS]);

  useEffect(() => {
    if (!canRestoreActiveVoiceProfile || !activeVoiceProfileRestoreKey || !selectedProfile) {
      return;
    }
    if (loadingActiveVoiceProfile || loadingTrainingAudio) {
      return;
    }
    if (currentExpName && loadedTrainingAudioSourceKey !== currentExpName) {
      return;
    }
    if (restoredActiveVoiceProfileKeyRef.current === activeVoiceProfileRestoreKey) {
      return;
    }

    const primaryPath = String(activeVoiceProfile?.ref_audio_path || '').trim();
    if (!primaryPath) {
      return;
    }

    if (refLocked && matchesSavedVoiceProfileReferenceSelection({
      profile: activeVoiceProfile,
      refAudioPath,
      auxRefAudioPaths: selectedAuxReferences.map((reference) => reference.path),
    })) {
      restoredActiveVoiceProfileKeyRef.current = activeVoiceProfileRestoreKey;
      return;
    }

    const trainingPathSet = new Set(trainingAudioFiles.map((file) => file.path));
    const toReferenceEntry = (referencePath) => ({
      path: referencePath,
      name: getFallbackReferenceName(referencePath),
      source: trainingPathSet.has(referencePath) ? 'training' : 'uploaded',
    });

    const preset = buildReferencePreset({
      id: 'saved-active-profile',
      name: `Saved - ${activeVoiceProfile.displayName || selectedProfile.displayName || 'Voice Profile'}`,
      selectedPersonKey,
      selectedGPTPath: selectedGPT,
      selectedSoVITSPath: selectedSoVITS,
      voiceLabel: selectedProfile.displayName || activeVoiceProfile.displayName || '',
      expName: currentExpName || extractExpName(primaryPath) || '',
      primary: toReferenceEntry(primaryPath),
      aux: Array.isArray(activeVoiceProfile?.aux_ref_audio_paths)
        ? activeVoiceProfile.aux_ref_audio_paths
          .map((item) => String(item || '').trim())
          .filter(Boolean)
          .filter((path) => path !== primaryPath)
          .map(toReferenceEntry)
        : [],
      promptText: activeVoiceProfile.prompt_text || '',
      promptLang: normalizeReferenceLanguage(activeVoiceProfile.prompt_lang),
    });

    if (!preset) {
      return;
    }

    restoredActiveVoiceProfileKeyRef.current = activeVoiceProfileRestoreKey;
    pendingAutoSyncFingerprintRef.current = '';
    autoSyncRequestFingerprintRef.current = '';

    let cancelled = false;
    applyReferencePreset(preset, { showLoadedNotice: false })
      .then(() => {
        if (cancelled) return;
        setTextLang(String(activeVoiceProfile.text_lang || 'en').trim() || 'en');
        setSpeed(Number.isFinite(activeVoiceProfile?.defaults?.speed_factor) ? activeVoiceProfile.defaults.speed_factor : 1.0);
        setTopK(Number.isFinite(activeVoiceProfile?.defaults?.top_k) ? activeVoiceProfile.defaults.top_k : 5);
        setTopP(Number.isFinite(activeVoiceProfile?.defaults?.top_p) ? activeVoiceProfile.defaults.top_p : 0.85);
        setTemperature(Number.isFinite(activeVoiceProfile?.defaults?.temperature) ? activeVoiceProfile.defaults.temperature : 0.7);
        setRepPenalty(Number.isFinite(activeVoiceProfile?.defaults?.repetition_penalty) ? activeVoiceProfile.defaults.repetition_penalty : 1.35);
      })
      .catch(() => {
        if (cancelled) return;
        restoredActiveVoiceProfileKeyRef.current = '';
      });

    return () => {
      cancelled = true;
    };
  }, [
    canRestoreActiveVoiceProfile,
    activeVoiceProfileRestoreKey,
    activeVoiceProfile,
    loadingActiveVoiceProfile,
    loadingTrainingAudio,
    trainingAudioFiles,
    selectedProfile,
    selectedPersonKey,
    selectedGPT,
    selectedSoVITS,
    currentExpName,
    loadedTrainingAudioSourceKey,
    refLocked,
    refAudioPath,
    selectedAuxReferences,
    uploadedRefFiles,
  ]);

  function saveCurrentReferencePreset() {
    if (!currentPrimaryReference) return;

    const presetBase = buildReferencePreset({
      selectedPersonKey,
      selectedGPTPath,
      selectedSoVITSPath,
      voiceLabel: selectedProfile?.displayName || '',
      expName: currentExpName || '',
      primary: currentPrimaryReference,
      aux: selectedAuxReferences,
      promptText,
      promptLang,
    });

    if (!presetBase) return;

    let savedPreset = presetBase;

    setReferencePresets((prev) => {
      const existing = prev.find((preset) => preset.signature === presetBase.signature);
      if (existing) {
        savedPreset = {
          ...presetBase,
          id: existing.id,
          name: existing.name,
          createdAt: existing.createdAt,
          updatedAt: Date.now(),
        };

        return [savedPreset, ...prev.filter((preset) => preset.id !== existing.id)]
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      }

      savedPreset = {
        ...presetBase,
        name: createReferencePresetName(currentPrimaryReference.name, prev.length + 1),
      };

      return [savedPreset, ...prev]
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    });

    setActiveReferencePresetId(savedPreset.id);
    showNotice({
      title: 'Reference set saved',
      message: `Saved ${savedPreset.name} locally for quick reuse.`,
      tone: 'success',
    });
  }

  function handleRenameReferencePreset(presetId, nextName) {
    setReferencePresets((prev) => prev.map((preset) => (
      preset.id === presetId
        ? { ...preset, name: nextName, updatedAt: Date.now() }
        : preset
    )).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));

    showNotice({
      title: 'Reference set renamed',
      message: `Updated the saved label to ${nextName}.`,
      tone: 'success',
    });
  }

  function handleDeleteReferencePreset(presetId) {
    setReferencePresets((prev) => prev.filter((preset) => preset.id !== presetId));
    setActiveReferencePresetId((current) => (current === presetId ? '' : current));
    showNotice({
      title: 'Reference set removed',
      message: 'The saved local version has been deleted.',
      tone: 'success',
    });
  }

function handleSelectPerson(nextKey) {
  const primaryIsUploaded = uploadedRefFiles.some(file => file.serverPath === refAudioPath);

  setSelectedPersonKey(nextKey);
    setSelectedGPTPath('');
    setSelectedSoVITSPath('');
    setModelError(null);
  setRefLocked(false);
  setAuxRefAudios([]);
  autoReferenceProfileRef.current = '';
  autoLoadKeyRef.current = '';
  pendingAutoSyncFingerprintRef.current = '';
  setTrainingAudioFiles([]);
  setLoadedTrainingAudioSourceKey('');

  if (!primaryIsUploaded) {
      revokeIfBlobUrl(refAudioUrl);
      setRefAudioPath('');
      setRefAudioFile(null);
      setRefAudioUrl(null);
      setPromptText('');
      setPreview({ path: '', url: null, name: '', role: 'primary' });
    }
  }

  function handleSelectGPTPath(nextPath) {
    autoLoadKeyRef.current = '';
    setModelError(null);
    setSelectedGPTPath(nextPath);
  }

  function handleSelectSoVITSPath(nextPath) {
    autoLoadKeyRef.current = '';
    setModelError(null);
    setSelectedSoVITSPath(nextPath);
  }

  async function handleSelectTrainingAudio(file) {
    const url = await getTrainingAudioUrl(currentExpName, file.filename);
    setRefAudioPath(file.path);
    setRefAudioFile({ name: file.filename });
    setRefAudioUrl(url);
    setPromptText(file.transcript);
    setRefLocked(false);
    setActiveReferencePresetId('');
    setPreview({
      path: file.path,
      url,
      name: file.filename,
      role: 'primary',
    });
    if (file.lang) {
      setPromptLang(normalizeReferenceLanguage(file.lang));
    }
    setAuxRefAudios(prev => prev.filter(f => f.filename !== file.filename));
  }

  async function handleToggleAuxRef(file) {
    setRefLocked(false);
    setActiveReferencePresetId('');
    setAuxRefAudios(prev => {
      const exists = prev.some(f => f.filename === file.filename);
      if (exists) return prev.filter(f => f.filename !== file.filename);
      return [...prev, file];
    });
    const url = await getTrainingAudioUrl(currentExpName, file.filename);
    setPreview({
      path: file.path,
      url,
      name: file.filename,
      role: 'auxiliary',
    });
  }

  async function handleLoadModels({ auto = false } = {}) {
    if (!selectedGPT || !selectedSoVITS) {
      if (!auto) alert('Select a person with both GPT and SoVITS checkpoints');
      return;
    }
    setLoading(true);
    setModelError(null);
    try {
      const response = await selectModels(selectedGPT, selectedSoVITS, buildModelSelectWarmPayload({
        voiceProfileId: selectedVoiceProfileId,
      }));
      const syncedSelection = await syncLoadedModelReferenceSelection(response.data || {});
      statusRequestVersionRef.current += 1;
      applyInferenceStatusState({
        serverReady: true,
        loadedGPTPath: selectedGPT,
        loadedSoVITSPath: selectedSoVITS,
      });
      if (!auto) {
        showNotice({
          title: 'Voice profile loaded',
          message: syncedSelection
            ? `${syncedSelection.primaryFilename} is now the loaded reference set for inference.`
            : 'The selected GPT and SoVITS checkpoints are ready for inference.',
          tone: 'success',
        });
      }
    } catch (err) {
      setModelError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleRefUpload(e) {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;
    setUploadingFiles(true);

    const newEntries = [];
    for (const file of files) {
      try {
        const res = await uploadRefAudio(file);
        newEntries.push({
          name: file.name,
          serverPath: res.data.path,
          localUrl: URL.createObjectURL(file),
        });
      } catch (err) {
        alert('Failed to upload ' + file.name + ': ' + (err.response?.data?.error || err.message));
      }
    }

    if (newEntries.length > 0) {
      setUploadedRefFiles(prev => {
        const merged = [...prev, ...newEntries];
        if (!refAudioPath || prev.length === 0) {
          setRefAudioFile({ name: merged[0].name });
          revokeIfBlobUrl(refAudioUrl);
          setRefAudioUrl(merged[0].localUrl);
          setRefAudioPath(merged[0].serverPath);
          setRefLocked(false);
          setActiveReferencePresetId('');
        }
        return merged;
      });
    }
    setUploadingFiles(false);
    e.target.value = '';
  }

  function handleSetUploadedPrimary(entry) {
    setRefAudioFile({ name: entry.name });
    revokeIfBlobUrl(refAudioUrl);
    setRefAudioUrl(entry.localUrl);
    setRefAudioPath(entry.serverPath);
    setPromptText('');
    setRefLocked(false);
    setActiveReferencePresetId('');
    setPreview({
      path: entry.serverPath,
      url: entry.localUrl,
      name: entry.name,
      role: 'primary',
    });
  }

  function handleRemoveUploadedFile(entry) {
    setUploadedRefFiles(prev => {
      const remaining = prev.filter(f => f.serverPath !== entry.serverPath);
      if (entry.serverPath === previewAudioPath && entry.serverPath !== refAudioPath) {
        setPreview({ path: '', url: null, name: '', role: 'primary' });
      }
      if (entry.serverPath === refAudioPath) {
        if (remaining.length > 0) {
          setRefAudioFile({ name: remaining[0].name });
          setRefAudioUrl(remaining[0].localUrl);
          setRefAudioPath(remaining[0].serverPath);
          setRefLocked(false);
          setActiveReferencePresetId('');
          setPreview({
            path: remaining[0].serverPath,
            url: remaining[0].localUrl,
            name: remaining[0].name,
            role: 'primary',
          });
        } else {
          setRefAudioFile(null);
          revokeIfBlobUrl(refAudioUrl);
          setRefAudioUrl(null);
          setRefAudioPath('');
          setRefLocked(false);
          setActiveReferencePresetId('');
          setPreview({ path: '', url: null, name: '', role: 'primary' });
        }
        setPromptText('');
      }
      revokeIfBlobUrl(entry.localUrl);
      return remaining;
    });
  }

  async function handleTranscribe() {
    if (!refAudioPath) return alert('Upload reference audio first');
    setTranscribing(true);
    try {
      const res = await transcribeAudio(refAudioPath, promptLang);
      setPromptText(res.data.text);
      if (res.data.language) setPromptLang(res.data.language);
    } catch (err) {
      alert('Transcription failed: ' + (err.response?.data?.error || err.message));
    } finally {
      setTranscribing(false);
    }
  }

  async function handleGenerate() {
    if (!text.trim()) return alert('Enter text to synthesize');
    if (!refAudioPath) return alert('Select a reference audio first');
    if (!refLocked) return alert('Confirm your reference audio selection first');
    if (!selectionLoaded) return alert('Wait for the selected voice profile to finish loading first');

    setInferError(null);

    if (directMode) {
      setDirectSynthesizing(true);
      setAudioBlob(null);
      try {
        const { blob } = await synthesize({
          text,
          text_lang: textLang,
          ref_audio_path: refAudioPath,
          prompt_text: promptText,
          prompt_lang: promptLang,
          aux_ref_audio_paths: selectedAuxReferences.map((r) => r.path),
          top_k: topK,
          top_p: topP,
          temperature,
          repetition_penalty: repPenalty,
          speed_factor: speed,
        });
        setAudioBlob(blob);
      } catch (err) {
        setInferError(err.response?.data?.error || err.message);
      } finally {
        setDirectSynthesizing(false);
      }
      return;
    }

    try {
      const res = await startGeneration({
        text,
        text_lang: textLang,
        ref_audio_path: refAudioPath,
        prompt_text: promptText,
        prompt_lang: promptLang,
        aux_ref_audio_paths: selectedAuxReferences.map((reference) => reference.path),
        top_k: topK,
        top_p: topP,
        temperature,
        repetition_penalty: repPenalty,
        speed_factor: speed,
      });
      const { sessionId } = res.data;
      sessionIdRef.current = sessionId;
      restoredSessionRef.current = sessionId;
      inference.connect(sessionId, { initialStatus: 'waiting' });
    } catch (err) {
      setInferError(err.response?.data?.error || err.message);
    }
  }

async function handleCancel() {
  if (sessionIdRef.current) {
    try {
      await cancelGeneration(sessionIdRef.current);
    } catch { /* ignore */ }
  }
}

  async function persistSelectedVoiceProfile() {
  if (!selectedProfile || !selectedGPT || !selectedSoVITS || !refAudioPath) {
    throw new Error('Voice profile is not ready to save yet.');
  }

  const storageMode = await getStorageMode();
  const payload = buildVoiceProfilePayload({
    displayName: selectedProfile.displayName,
    selectedGPT,
    selectedSoVITS,
    refAudioPath,
    promptText,
    promptLang,
    textLang,
    preferredRoute: directMode ? 'sentence' : 'full',
    auxRefAudioPaths: selectedAuxReferences.map((reference) => reference.path),
    defaults: {
      top_k: topK,
      top_p: topP,
      temperature,
      repetition_penalty: repPenalty,
      speed_factor: speed,
    },
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

async function handleSaveVoiceProfile() {
  if (!selectedProfile) {
    return alert('Choose a voice profile first');
  }
    if (!selectionLoaded) {
      return alert('Wait for the selected voice profile to finish loading first');
    }
    if (!refLocked) {
      return alert('Confirm your reference audio selection first');
    }

  setSavingVoiceProfile(true);

  try {
    const { summary, payload } = await persistSelectedVoiceProfile();
    lastAutoSyncedFingerprintRef.current = currentAutoSyncFingerprint;
    pendingAutoSyncFingerprintRef.current = '';
    showNotice({
      title: 'Voice profile saved',
      message: `${summary.displayName || selectedProfile.displayName} is now saved as ${summary.voiceProfileId || payload.voiceProfileId}.`,
      tone: 'success',
      });
    } catch (err) {
      showNotice({
        title: 'Could not save voice profile',
        message: err.response?.data?.error || err.message || 'Saving failed.',
        tone: 'error',
      });
  } finally {
    setSavingVoiceProfile(false);
  }
}

useEffect(() => {
  if (!autoSyncRequestFingerprint) {
    return;
  }

  const requestFingerprint = autoSyncRequestFingerprint;
  const requestDisplayName = selectedProfile?.displayName || '';
  autoSyncRequestFingerprintRef.current = requestFingerprint;
  setSavingVoiceProfile(true);

  persistSelectedVoiceProfile()
    .then(({ summary, payload }) => {
      if (autoSyncRequestFingerprintRef.current !== requestFingerprint) return;
      lastAutoSyncedFingerprintRef.current = requestFingerprint;
      pendingAutoSyncFingerprintRef.current = '';
      showNotice({
        title: 'Active voice synced',
        message: `${summary.displayName || requestDisplayName} is now active as ${summary.voiceProfileId || payload.voiceProfileId}.`,
        tone: 'success',
      });
    })
    .catch((err) => {
      if (autoSyncRequestFingerprintRef.current !== requestFingerprint) return;
      pendingAutoSyncFingerprintRef.current = '';
      showNotice({
        title: 'Could not sync active voice',
        message: err.response?.data?.error || err.message || 'Saving failed.',
        tone: 'error',
      });
    })
    .finally(() => {
      if (autoSyncRequestFingerprintRef.current === requestFingerprint) {
        autoSyncRequestFingerprintRef.current = '';
        setSavingVoiceProfile(false);
      }
    });
}, [
  autoSyncRequestFingerprint,
  selectedProfile,
]);

useEffect(() => {
  if (inference.status === 'complete' && sessionIdRef.current) {
      getGenerationResult(sessionIdRef.current)
        .then((blob) => {
          setAudioBlob(blob);
          if (skipNextCompletionToastRef.current) {
            skipNextCompletionToastRef.current = false;
            return;
          }
          showNotice({
            title: 'Audio synthesized',
            message: 'Your generated voice clip is ready to preview and download.',
            tone: 'success',
          });
        })
        .catch(err => setInferError(err.message));
    }
    if (inference.status === 'error' || inference.status === 'cancelled') {
      setInferError(inference.error);
    }
  }, [inference.status, inference.error]);

  const auxCount = selectedAuxReferences.length;
  const isGenerationActive = directMode
    ? directSynthesizing
    : inference.status === 'waiting' || inference.status === 'generating';

  return (
    <div className="animate-fade-in space-y-8">
      <FloatingNotice notice={notice} onClose={() => setNotice(null)} />

      <section className="relative overflow-hidden rounded-[32px] border border-sky-200/50 bg-[linear-gradient(135deg,#0f172a_0%,#082f49_42%,#115e59_100%)] px-6 py-7 text-white shadow-[0_32px_90px_-45px_rgba(15,23,42,0.85)] sm:px-8 lg:px-10">
        <div className="absolute inset-y-0 right-0 w-1/2 bg-[radial-gradient(circle_at_top_right,rgba(56,189,248,0.35),transparent_55%)]" />
        <div className="absolute -left-16 top-8 h-40 w-40 rounded-full bg-cyan-300/20 blur-3xl" />
        <div className="absolute bottom-0 right-8 h-48 w-48 rounded-full bg-emerald-300/15 blur-3xl" />

        <div className="relative grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(260px,0.85fr)] lg:items-end">
          <div>
            <Badge className="border border-white/15 bg-white/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.28em] text-white shadow-none">
              Inference Studio
            </Badge>
            <h2 className="mt-5 max-w-3xl font-display text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              Use this page to choose a voice, confirm the right references, and turn your text into speech.
            </h2>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-white/72 sm:text-base">
              Start by choosing the speaker and the checkpoints you want, then confirm one main reference clip, add any supporting clips you need, and generate the final voice from your text.
            </p>

            <div className="mt-6 flex flex-wrap gap-3">
              <Badge className="border border-white/12 bg-white/10 px-3 py-1.5 text-white shadow-none">
                <Activity size={12} className="mr-1.5" />
                {selectionLoaded ? 'Selected voice is loaded' : serverReady ? 'Server online, reload needed' : 'Server offline'}
              </Badge>
              <Badge className="border border-white/12 bg-white/10 px-3 py-1.5 text-white shadow-none">
                Step 1: choose the voice and checkpoints
              </Badge>
              <Badge className="border border-white/12 bg-white/10 px-3 py-1.5 text-white shadow-none">
                Step 2: confirm your reference set, then generate
              </Badge>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
            <div className="rounded-[24px] border border-white/12 bg-white/10 p-4 shadow-[0_18px_50px_-32px_rgba(15,23,42,0.85)] backdrop-blur-sm">
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/60">Voice You’re Preparing</p>
              <p className="mt-3 text-2xl font-semibold tracking-tight">{selectedProfile?.displayName || 'No profile selected'}</p>
              <p className="mt-2 text-sm leading-6 text-white/72">
                {selectedProfile ? 'Choose the exact GPT and SoVITS pair you want; the server loads the selected profile automatically.' : 'Pick a speaker here before you move on to references and text.'}
              </p>
            </div>

            <div className="rounded-[24px] border border-white/12 bg-white/8 p-4 shadow-[0_18px_50px_-32px_rgba(15,23,42,0.85)] backdrop-blur-sm">
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/60">Ready On Server</p>
              <p className="mt-3 text-2xl font-semibold tracking-tight">{loadedProfileName || 'Nothing loaded'}</p>
              <p className="mt-2 text-sm leading-6 text-white/72">
                {selectionLoaded ? 'You can move straight to references, text, and generation.' : 'The selected profile will load automatically when the backend is reachable.'}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* 01 Models */}
      <Card className="overflow-hidden rounded-[28px] border border-sky-100/80 bg-white/88 shadow-[0_24px_70px_-45px_rgba(15,23,42,0.65)] backdrop-blur-sm">
        <CardHeader className="border-b border-slate-100/80 bg-[linear-gradient(180deg,rgba(248,250,252,0.95),rgba(255,255,255,0.75))]">
          <div className="flex items-center gap-3">
            <Badge variant="secondary" className="h-8 w-8 shrink-0 items-center justify-center rounded-full p-0 text-sm font-semibold">
              1
            </Badge>
            <div className="flex-1">
              <div className="flex items-center gap-3">
                <CardTitle className="font-display text-2xl">Voice Profile</CardTitle>
                <Badge variant={selectionLoaded ? 'success' : serverReady ? 'outline' : 'secondary'} className="text-[10px] uppercase tracking-[0.2em]">
                  <div className={cn(
                    "mr-1.5 h-1.5 w-1.5 rounded-full",
                    selectionLoaded ? "bg-success-foreground" : serverReady ? "bg-muted-foreground" : "bg-muted-foreground"
                  )} />
                  {selectionLoaded ? 'Loaded' : serverReady ? 'Needs reload' : 'Offline'}
                </Badge>
              </div>
              <CardDescription>Start by choosing the speaker, then keep the default checkpoints or switch to a different GPT or SoVITS model if you prefer.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5 p-6">
          <VoiceProfileSelector
            profiles={voiceProfiles}
            value={selectedPersonKey}
            onChange={handleSelectPerson}
            disabled={loading}
            selectedProfile={selectedProfile}
            selectedGPTPath={selectedGPTPath}
            selectedSoVITSPath={selectedSoVITSPath}
            onGPTChange={handleSelectGPTPath}
            onSoVITSChange={handleSelectSoVITSPath}
            selectedGPTCandidate={selectedGPTCandidate}
            selectedSoVITSCandidate={selectedSoVITSCandidate}
          />

          <div className="rounded-[22px] border border-slate-200/80 bg-slate-50/80 px-4 py-3 text-sm text-slate-500">
            {selectedProfile
              ? `The server will use GPT ${selectedGPTCandidate?.model?.name || 'not selected'} and SoVITS ${selectedSoVITSCandidate?.model?.name || 'not selected'} for this profile.`
              : 'Choose a speaker first; complete profiles are sorted newest first and load automatically for generation.'}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <span className={cn(
              "inline-flex h-11 items-center gap-2 rounded-2xl border px-4 text-sm font-semibold",
              selectionLoaded
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : loading
                  ? "border-sky-200 bg-sky-50 text-sky-700"
                  : "border-slate-200 bg-slate-50 text-slate-600"
            )}>
              {loading ? <Spinner size={14} /> : null}
              {loading ? 'Loading selected profile...' : selectionLoaded ? 'Profile ready' : 'Waiting for profile selection'}
            </span>

            <Button variant="outline" size="lg" onClick={fetchModels} className="rounded-2xl border-slate-200 px-5">
              <RefreshCw size={14} />
              Refresh Library
            </Button>

            {loadedProfileName && !selectionLoaded && (
              <span className="text-sm text-slate-500">
                Currently loaded: <span className="font-semibold text-slate-700">{loadedProfileName}</span>
              </span>
            )}

            {modelError && (
              <span className="inline-flex items-center gap-3 rounded-2xl border border-destructive/20 bg-destructive/5 px-4 py-2 text-sm text-destructive">
                {modelError}
                <button
                  type="button"
                  onClick={() => {
                    autoLoadKeyRef.current = '';
                    handleLoadModels();
                  }}
                  className="rounded-xl bg-white px-2.5 py-1 text-xs font-semibold text-destructive shadow-sm"
                >
                  Retry
                </button>
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 02 Reference Audio */}
      <Card className="overflow-hidden rounded-[28px] border border-sky-100/80 bg-white/88 shadow-[0_24px_70px_-45px_rgba(15,23,42,0.65)] backdrop-blur-sm">
        <CardHeader className="border-b border-slate-100/80 bg-[linear-gradient(180deg,rgba(248,250,252,0.95),rgba(255,255,255,0.75))]">
          <div className="flex items-center gap-3">
            <Badge variant="secondary" className="h-8 w-8 shrink-0 items-center justify-center rounded-full p-0 text-sm font-semibold">
              2
            </Badge>
            <div className="flex-1">
              <div className="flex items-center gap-3">
                <CardTitle className="font-display text-2xl">Reference Audio</CardTitle>
                {refLocked && (
                  <Badge variant="success" className="text-[10px] uppercase tracking-[0.2em]">
                    <Check size={10} className="mr-1" />
                    Confirmed
                  </Badge>
                )}
              </div>
              <CardDescription>
                {refLocked ? 'This reference set is ready to use for generation.' : 'Choose one primary reference, add any supporting clips you want, then confirm the set.'}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6 p-6">
          <ReferencePresetLibrary
            presets={referencePresets}
            activePresetId={activeReferencePresetId}
            onApply={applyReferencePreset}
            onRename={handleRenameReferencePreset}
            onDelete={handleDeleteReferencePreset}
          />

          {refLocked ? (
            /* Locked summary */
            <div>
              <div className="rounded-[24px] border border-emerald-100 bg-[linear-gradient(135deg,rgba(236,253,245,0.95),rgba(239,246,255,0.9))] p-5 shadow-sm">
                <div className="mb-2 flex flex-wrap items-center gap-2.5">
                  <div className="h-1.5 w-1.5 rounded-full bg-primary" />
                  <span className="font-mono text-sm text-foreground">
                    {refAudioFile?.name || 'Unknown'}
                  </span>
                  <Badge variant="default" className="text-[10px] uppercase tracking-[0.2em]">Primary</Badge>
                  {activeReferencePresetId && (
                    <Badge variant="outline" className="bg-white text-[10px] uppercase tracking-[0.18em]">
                      {referencePresets.find((preset) => preset.id === activeReferencePresetId)?.name || 'Saved set'}
                    </Badge>
                  )}
                </div>
                {promptText && (
                  <p className="ml-4 text-sm italic leading-7 text-muted-foreground">
                    &ldquo;{promptText}&rdquo;
                  </p>
                )}
                {auxCount > 0 && (
                  <div className="ml-4 mt-1 text-sm text-muted-foreground">
                    + {auxCount} auxiliary reference{auxCount !== 1 ? 's' : ''}
                  </div>
                )}
              </div>

              {refAudioUrl && <RefAudioPlayer src={refAudioUrl} filename={refAudioFile?.name} />}

              <Button
                variant="outline"
                size="sm"
                className="mt-4 rounded-xl"
                onClick={() => setRefLocked(false)}
              >
                <Pencil size={12} />
                Edit Reference
              </Button>
            </div>
          ) : (
            /* Unlocked selection UI */
            <div>
              <div className="grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,1.08fr)_minmax(300px,0.92fr)]">
                {/* Left: audio file list */}
                <div className="space-y-4">
                  <div className="mb-2 flex items-center justify-between">
                    <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Audio Files</Label>
                    {auxCount > 0 && (
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {auxCount} aux
                      </Badge>
                    )}
                  </div>

                  {/* Training audio list */}
                  {loadingTrainingAudio ? (
                    <div className="flex items-center gap-2 rounded-[22px] border border-slate-200 bg-slate-50 p-4 text-sm text-muted-foreground">
                      <Spinner /> Loading training audio...
                    </div>
                  ) : trainingAudioFiles.length > 0 ? (
                    <>
                      <div className="max-h-[300px] overflow-y-auto rounded-[22px] border border-slate-200 bg-slate-50/70">
                        {trainingAudioFiles.map((file) => {
                          const isPrimary = file.path === refAudioPath;
                          const isAux = auxRefAudios.some(f => f.filename === file.filename);
                          const isPreviewed = file.path === previewAudioPath;
                          return (
                            <div
                              key={file.filename}
                              className={cn(
                                "flex items-start gap-2.5 border-b px-4 py-3 transition-colors last:border-0",
                                isPrimary && "bg-primary/5",
                                isPreviewed && "ring-1 ring-inset ring-sky-200"
                              )}
                            >
                              <input
                                type="radio"
                                name="primary-ref"
                                checked={isPrimary}
                                onChange={() => handleSelectTrainingAudio(file)}
                                title="Set as primary reference"
                                className="h-4 w-4 shrink-0 cursor-pointer accent-[hsl(var(--primary))]"
                              />
                              <input
                                type="checkbox"
                                checked={isAux}
                                disabled={isPrimary}
                                onChange={() => handleToggleAuxRef(file)}
                                title={isPrimary ? 'Primary ref cannot also be auxiliary' : 'Toggle as auxiliary reference'}
                                className={cn(
                                  "h-4 w-4 shrink-0 accent-[hsl(var(--primary))]",
                                  isPrimary ? "cursor-not-allowed opacity-30" : "cursor-pointer"
                                )}
                              />
                              <button
                                type="button"
                                onClick={async () => {
                                  const url = await getTrainingAudioUrl(currentExpName, file.filename);
                                  setPreview({
                                    path: file.path,
                                    url,
                                    name: file.filename,
                                    role: isPrimary ? 'primary' : isAux ? 'auxiliary' : 'preview',
                                  });
                                }}
                                className="min-w-0 flex-1 text-left"
                              >
                                <div className="break-all font-mono text-xs text-foreground">
                                  {file.filename}
                                </div>
                                {file.transcript && (
                                  <div className="mt-1 text-sm leading-6 text-muted-foreground">
                                    {file.transcript}
                                  </div>
                                )}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                      <div className="mt-1.5 flex gap-3 text-[10px] text-muted-foreground">
                        <span>Radio = primary ref</span>
                        <span>Checkbox = auxiliary ref</span>
                      </div>
                      {auxRefAudios.length > 0 && (
                        <button
                          onClick={() => setAuxRefAudios([])}
                          className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
                        >
                          Clear auxiliary selections
                        </button>
                      )}
                    </>
                  ) : currentExpName ? (
                    <div className="rounded-[22px] border border-slate-200 bg-slate-50 p-4 text-center text-sm text-muted-foreground">
                      No training audio found for &ldquo;{currentExpName}&rdquo;
                    </div>
                  ) : (
                    <div className="rounded-[22px] border border-slate-200 bg-slate-50 p-4 text-center text-sm text-muted-foreground">
                      Choose a voice profile to browse matching training audio
                    </div>
                  )}

                  {/* Upload custom files */}
                  <div className="mt-4">
                    <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Or Upload Custom Audio</Label>
                    <div className="mt-2 flex items-center gap-2.5 rounded-[22px] border border-dashed border-sky-200 bg-[linear-gradient(135deg,rgba(240,249,255,0.95),rgba(248,250,252,0.95))] px-4 py-4">
                      <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white text-primary shadow-sm">
                        <Upload size={16} />
                      </div>
                      <input
                        type="file"
                        accept=".wav,.mp3,.ogg,.flac"
                        multiple
                        onChange={handleRefUpload}
                        className="flex-1 text-sm text-muted-foreground file:mr-3 file:rounded-xl file:border-0 file:bg-primary/10 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-primary hover:file:bg-primary/20"
                      />
                      {uploadingFiles && <Spinner />}
                    </div>
                  </div>

                  {/* Uploaded file list */}
                  {uploadedRefFiles.length > 0 && (
                    <ScrollArea className="mt-2 max-h-[180px] rounded-[22px] border border-slate-200 bg-white">
                      {uploadedRefFiles.map((entry) => {
                        const isPrimary = entry.serverPath === refAudioPath;
                        const isPreviewed = entry.serverPath === previewAudioPath;
                        return (
                          <div
                            key={entry.serverPath}
                            className={cn(
                              "flex items-center gap-2.5 border-b px-4 py-3 transition-colors last:border-0",
                              isPrimary && "bg-primary/5",
                              isPreviewed && "ring-1 ring-inset ring-sky-200"
                            )}
                          >
                            <input
                              type="radio"
                              name="primary-ref"
                              checked={isPrimary}
                              onChange={() => handleSetUploadedPrimary(entry)}
                              title="Set as primary reference"
                              className="h-4 w-4 shrink-0 cursor-pointer accent-[hsl(var(--primary))]"
                            />
                            <button
                              type="button"
                              onClick={async () => {
                                const url = entry.localUrl || await getUploadedRefAudioUrl(entry.serverPath);
                                setPreview({
                                  path: entry.serverPath,
                                  url,
                                  name: entry.name,
                                  role: isPrimary ? 'primary' : 'auxiliary',
                                });
                              }}
                              className="min-w-0 flex-1 text-left"
                            >
                              <div className="truncate font-mono text-xs text-foreground">
                                {entry.name}
                              </div>
                              <div className={cn(
                                "mt-1 text-[10px] uppercase tracking-[0.18em]",
                                isPrimary ? "font-semibold text-primary" : "text-muted-foreground"
                              )}>
                                {isPrimary ? 'Primary (uploaded)' : 'Auxiliary (uploaded)'}
                              </div>
                            </button>
                            <button
                              onClick={() => handleRemoveUploadedFile(entry)}
                              title="Remove"
                              className="shrink-0 rounded-xl p-2 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                            >
                              <X size={12} />
                            </button>
                          </div>
                        );
                      })}
                    </ScrollArea>
                  )}
                </div>

                {/* Right: transcript + language + player */}
                <div className="space-y-4">
                  <div className="rounded-[22px] border border-slate-200 bg-slate-50/80 p-5">
                    <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Primary Reference Transcript</Label>
                    <Textarea
                      className="mt-3 min-h-[120px] rounded-2xl border-slate-200 bg-white leading-7 shadow-sm"
                        placeholder="What the primary reference audio says..."
                        value={promptText}
                        onChange={(e) => setPromptText(e.target.value)}
                    />
                    <Button
                      variant="outline"
                      className="mt-3 w-full rounded-2xl border-slate-200"
                      onClick={handleTranscribe}
                      disabled={transcribing || !refAudioPath}
                    >
                      {transcribing ? <Spinner size={14} /> : <Mic size={14} />}
                      {transcribing ? 'Working...' : 'Auto-Transcribe'}
                    </Button>
                  </div>

                  <div className="rounded-[22px] border border-slate-200 bg-white p-5 shadow-sm">
                    <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Reference Language</Label>
                    <Select value={promptLang} onValueChange={setPromptLang}>
                      <SelectTrigger className="mt-3 h-12 rounded-2xl border-slate-200 bg-slate-50">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="en">English</SelectItem>
                        <SelectItem value="zh">Chinese</SelectItem>
                        <SelectItem value="ja">Japanese</SelectItem>
                        <SelectItem value="ko">Korean</SelectItem>
                        <SelectItem value="auto">Auto Detect</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="rounded-[22px] border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="flex items-center justify-between gap-3">
                      <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Preview</Label>
                      <Badge variant="outline" className="text-[10px] uppercase tracking-[0.18em]">
                        {previewAudioRole || 'primary'}
                      </Badge>
                    </div>
                    {previewAudioUrl ? (
                      <>
                        <p className="mt-3 truncate font-mono text-xs text-slate-500">
                          {previewAudioName || 'Selected audio'}
                        </p>
                        <RefAudioPlayer src={previewAudioUrl} />
                      </>
                    ) : (
                      <div className="mt-3 rounded-2xl border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-500">
                        Choose any primary or auxiliary clip to preview it here.
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Confirm button */}
              <div className="mt-6 flex flex-wrap gap-3">
                <Button
                  className="rounded-2xl px-6"
                  onClick={() => {
                    if (!refAudioPath) return alert('Select a primary reference audio first');
                    setRefLocked(true);
                    saveCurrentReferencePreset();
                  }}
                  disabled={!refAudioPath || savingVoiceProfile}
                >
                  <Check size={14} />
                  Confirm Selection
                </Button>
                <Button
                  variant="outline"
                  className="rounded-2xl border-slate-200 bg-white px-6"
                  onClick={handleSaveVoiceProfile}
                  disabled={!refLocked || !selectionLoaded || savingVoiceProfile}
                >
                  {savingVoiceProfile ? <Spinner size={14} /> : <Check size={14} />}
                  {savingVoiceProfile ? 'Saving...' : 'Save Voice Profile'}
                </Button>
              </div>
              <div className="mt-3 text-xs">
                {activeVoiceProfileError ? (
                  <span className="text-red-500">{activeVoiceProfileError}</span>
                ) : (
                  <span className="inline-flex flex-wrap items-center gap-1 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-slate-500">
                    <span className="uppercase tracking-widest text-slate-400">Active voice profile</span>
                    <span className="font-medium text-slate-700">
                      {loadingActiveVoiceProfile ? 'Loading...' : formatActiveVoiceProfileSummary(activeVoiceProfile)}
                    </span>
                  </span>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 03 Text Input */}
      <Card className="overflow-hidden rounded-[28px] border border-sky-100/80 bg-white/88 shadow-[0_24px_70px_-45px_rgba(15,23,42,0.65)] backdrop-blur-sm">
        <CardHeader className="border-b border-slate-100/80 bg-[linear-gradient(180deg,rgba(248,250,252,0.95),rgba(255,255,255,0.75))]">
          <div className="flex items-center gap-3">
            <Badge variant="secondary" className="h-8 w-8 shrink-0 items-center justify-center rounded-full p-0 text-sm font-semibold">
              3
            </Badge>
            <div>
              <CardTitle className="font-display text-2xl">Text to Synthesize</CardTitle>
              <CardDescription>Enter the text you want spoken in the cloned voice</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-6">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(260px,0.75fr)]">
            <div className="rounded-[22px] border border-slate-200 bg-slate-50/80 p-5">
              <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Text</Label>
              <Textarea
                className="mt-3 min-h-[180px] rounded-2xl border-slate-200 bg-white text-[15px] leading-7 shadow-sm"
                placeholder="Enter the text you want to synthesize..."
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              {text && (
                <p className="mt-1.5 text-right font-mono text-xs text-muted-foreground">
                  {text.length} chars
                </p>
              )}
            </div>
            <div className="space-y-4">
              <div className="rounded-[22px] border border-slate-200 bg-white p-5 shadow-sm">
                <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Language</Label>
                <Select value={textLang} onValueChange={setTextLang}>
                  <SelectTrigger className="mt-3 h-12 rounded-2xl border-slate-200 bg-slate-50">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="en">English</SelectItem>
                    <SelectItem value="zh">Chinese</SelectItem>
                    <SelectItem value="ja">Japanese</SelectItem>
                    <SelectItem value="ko">Korean</SelectItem>
                    <SelectItem value="auto">Auto Detect</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="rounded-[22px] border border-slate-200 bg-[linear-gradient(135deg,rgba(248,250,252,0.95),rgba(240,249,255,0.9))] p-5">
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">Current Setup</p>
                <div className="mt-4 space-y-3 text-sm text-slate-600">
                  <div className="grid grid-cols-[auto,minmax(0,1fr)] items-start gap-3">
                    <span>Voice</span>
                    <span className="min-w-0 text-right font-semibold text-slate-800">{selectedProfile?.displayName || 'None selected'}</span>
                  </div>
                  <div className="grid grid-cols-[auto,minmax(0,1fr)] items-start gap-3">
                    <span>Reference</span>
                    <span className="min-w-0 break-words text-right font-semibold leading-6 text-slate-800">{refAudioFile?.name || 'Not selected'}</span>
                  </div>
                  <div className="grid grid-cols-[auto,minmax(0,1fr)] items-start gap-3">
                    <span>Status</span>
                    <span className="min-w-0 text-right font-semibold text-slate-800">{selectionLoaded ? 'Ready' : 'Auto-loading voice'}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 04 Settings */}
      <Card className="overflow-hidden rounded-[28px] border border-sky-100/80 bg-white/88 shadow-[0_24px_70px_-45px_rgba(15,23,42,0.65)] backdrop-blur-sm">
        <CardHeader className="border-b border-slate-100/80 bg-[linear-gradient(180deg,rgba(248,250,252,0.95),rgba(255,255,255,0.75))]">
          <div className="flex items-center gap-3">
            <Badge variant="secondary" className="h-8 w-8 shrink-0 items-center justify-center rounded-full p-0 text-sm font-semibold">
              4
            </Badge>
            <div>
              <CardTitle className="font-display text-2xl">Generation Settings</CardTitle>
              <CardDescription>Fine-tune the synthesis parameters</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-6">
          <Collapsible open={showSettings} onOpenChange={setShowSettings}>
            <CollapsibleTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2 rounded-2xl border-slate-200 text-muted-foreground">
                <ChevronRight
                  size={14}
                  className={cn("transition-transform", showSettings && "rotate-90")}
                />
                {showSettings ? 'Hide' : 'Show'} parameters
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2 md:gap-x-10">
                {/* Speed */}
                <div className="space-y-3 rounded-[22px] border border-slate-200 bg-slate-50/80 p-4">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Speed</Label>
                    <span className="font-mono text-sm font-semibold">{speed.toFixed(1)}x</span>
                  </div>
                  <Slider
                    min={0.5} max={2.0} step={0.1}
                    value={[speed]}
                    onValueChange={([v]) => setSpeed(v)}
                  />
                </div>

                {/* Top K */}
                <div className="space-y-3 rounded-[22px] border border-slate-200 bg-slate-50/80 p-4">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Top K</Label>
                    <span className="font-mono text-sm font-semibold">{topK}</span>
                  </div>
                  <Slider
                    min={1} max={50} step={1}
                    value={[topK]}
                    onValueChange={([v]) => setTopK(v)}
                  />
                </div>

                {/* Top P */}
                <div className="space-y-3 rounded-[22px] border border-slate-200 bg-slate-50/80 p-4">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Top P</Label>
                    <span className="font-mono text-sm font-semibold">{topP.toFixed(2)}</span>
                  </div>
                  <Slider
                    min={0} max={1} step={0.05}
                    value={[topP]}
                    onValueChange={([v]) => setTopP(v)}
                  />
                </div>

                {/* Temperature */}
                <div className="space-y-3 rounded-[22px] border border-slate-200 bg-slate-50/80 p-4">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Temperature</Label>
                    <span className="font-mono text-sm font-semibold">{temperature.toFixed(2)}</span>
                  </div>
                  <Slider
                    min={0} max={1} step={0.05}
                    value={[temperature]}
                    onValueChange={([v]) => setTemperature(v)}
                  />
                </div>

                {/* Repetition Penalty */}
                <div className="space-y-3 rounded-[22px] border border-slate-200 bg-slate-50/80 p-4">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Repetition Penalty</Label>
                    <span className="font-mono text-sm font-semibold">{repPenalty.toFixed(2)}</span>
                  </div>
                  <Slider
                    min={1.0} max={2.0} step={0.05}
                    value={[repPenalty]}
                    onValueChange={([v]) => setRepPenalty(v)}
                  />
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </CardContent>
      </Card>

      {/* 05 Generate */}
      <Card className="overflow-hidden rounded-[28px] border border-sky-100/80 bg-white/88 shadow-[0_24px_70px_-45px_rgba(15,23,42,0.65)] backdrop-blur-sm">
        <CardHeader className="border-b border-slate-100/80 bg-[linear-gradient(180deg,rgba(248,250,252,0.95),rgba(255,255,255,0.75))]">
          <div className="flex items-center gap-3">
            <Badge variant="secondary" className="h-8 w-8 shrink-0 items-center justify-center rounded-full p-0 text-sm font-semibold">
              5
            </Badge>
            <div>
              <CardTitle className="font-display text-2xl">Generate</CardTitle>
              <CardDescription>Synthesize speech from your text</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-6">
          {!isGenerationActive ? (
            <div className={cn("flex flex-wrap items-center gap-4", audioBlob && "mb-6")}>
              <Button
                size="lg"
                className="rounded-2xl shadow-[0_20px_50px_-28px_rgba(14,165,233,0.75)]"
                disabled={!selectionLoaded || !refLocked || !refAudioPath || !text.trim()}
                onClick={() => { if (!directMode) inference.reset(); handleGenerate(); }}
              >
                <Play size={14} />
                Generate Speech
              </Button>

              {inference.connectionLost && (inference.status === 'waiting' || inference.status === 'generating') && (
                <span role="status" className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
                  Lost contact with the GPU progress stream. Reconnecting — the GPU may have stopped or still be starting. Your job has not been cancelled.
                </span>
              )}

              {inferError && (
                <span className="rounded-2xl border border-destructive/20 bg-destructive/5 px-4 py-2 text-sm text-destructive">
                  {inferError}
                </span>
              )}
            </div>
          ) : (
            /* Progress UI */
            <div className={cn(audioBlob && "mb-6")}>
              {directMode ? (
                <div className="flex items-center gap-3 rounded-[22px] border border-slate-200 bg-slate-50/80 px-4 py-4">
                  <Spinner size={16} />
                  <span className="text-sm text-muted-foreground">Synthesizing… this may take a moment</span>
                </div>
              ) : (
                <>
                  {/* Progress bar */}
                  <div className="mb-4 flex items-center gap-4 rounded-[22px] border border-slate-200 bg-slate-50/80 px-4 py-4">
                    <Progress
                      value={inference.totalChunks > 0 ? (inference.completedChunks / inference.totalChunks) * 100 : 0}
                      className="h-2 flex-1"
                    />
                    <span className="shrink-0 font-mono text-sm tabular-nums text-muted-foreground">
                      {inference.completedChunks} / {inference.totalChunks}
                    </span>
                  </div>

                  {inference.status === 'waiting' && !inference.currentChunkText && (
                    <div className="mb-4 rounded-[22px] border border-slate-200 bg-slate-50/80 px-4 py-3">
                      <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                        Preparing session
                      </span>
                      <p className="text-sm italic text-muted-foreground">
                        Reconnecting the stream and preparing chunk generation...
                      </p>
                    </div>
                  )}

                  {/* Current chunk text */}
                  {inference.currentChunkText && (
                    <div className="mb-4 rounded-[22px] border border-slate-200 bg-slate-50/80 px-4 py-3">
                      <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                        Synthesizing chunk {inference.completedChunks + 1}
                      </span>
                      <p className="text-sm italic text-muted-foreground">
                        {inference.currentChunkText}
                      </p>
                    </div>
                  )}

                  {/* Cancel button */}
                  <Button variant="outline" className="rounded-2xl border-slate-200" onClick={handleCancel}>
                    <Spinner size={14} />
                    Cancel Generation
                  </Button>
                </>
              )}
            </div>
          )}

          {audioBlob && <AudioPlayer audioBlob={audioBlob} />}

        </CardContent>
      </Card>
    </div>
  );
}
