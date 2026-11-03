// In S3 mode the client identifies models by S3 key while the worker reports the
// local file it downloaded the key to (model_cache/…), so the same loaded weights
// carry two different paths and identity has to come from the filename.
//
// The old /models/download path kept the key's basename verbatim. Per-conversation
// voice isolation resolves weights through a different one
// (gpu-inference-worker/src/services/requestVoiceModel.js), which caches as
// `<basename>-<12 hex digest><ext>` so two S3 keys with the same basename cannot
// collide on disk. Comparing raw basenames therefore stopped matching: the page
// never recognised its own model as loaded and sat on "Loading the voice" while
// re-issuing the load forever. Tolerate that one digest suffix on either side.
const CACHE_DIGEST_SUFFIX = /-[0-9a-f]{12}$/u;

export function canonicalWeightName(value) {
  const base = String(value || '').trim().split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const extension = dot > 0 ? base.slice(dot) : '';
  return `${stem.replace(CACHE_DIGEST_SUFFIX, '')}${extension}`;
}

export function sameLoadedWeights(selectedPath, loadedPath) {
  const selected = String(selectedPath || '').trim();
  const loaded = String(loadedPath || '').trim();
  if (!selected || !loaded) return false;
  if (selected === loaded) return true;
  return canonicalWeightName(selected) === canonicalWeightName(loaded);
}

export function isSelectedModelLoaded({
  serverReady,
  selectedGPT,
  selectedSoVITS,
  loadedGPTPath,
  loadedSoVITSPath,
}) {
  return Boolean(
    serverReady
      && sameLoadedWeights(selectedGPT, loadedGPTPath)
      && sameLoadedWeights(selectedSoVITS, loadedSoVITSPath)
  );
}

// A synthesis request that names both halves of the weight pair pins that voice
// on whichever instance serves it — the worker loads exactly those weights for
// exactly that call (gpu-inference-worker/src/services/requestVoiceModel.js ->
// ensureRequestVoiceModel). Both halves are required: a half-filled `voice_model`
// keys the worker's scheduler and then falls through to whatever the GPU held.
export function canPinVoicePerRequest({ voiceProfileId, selectedGPT, selectedSoVITS }) {
  return Boolean(
    String(voiceProfileId || '').trim()
      && String(selectedGPT || '').trim()
      && String(selectedSoVITS || '').trim()
  );
}

// Can this page synthesise right now?
//
// The old answer was `isSelectedModelLoaded(...) && refs`, which asks whether the
// shared GPU currently holds our voice. That is the wrong question once more than
// one page talks to the same backend: each page auto-loads its own voice over the
// other's, so /inference/status reports whoever wrote last and the loser waits on
// "Loading the voice" forever. With a pinned request the loaded model is not this
// page's concern — the selection plus its references is the whole condition.
//
// `pinsOwnWeights` still needs `serverReady`: pinning says which weights to load,
// not that there is anything up to load them.
export function isVoiceReadyToSynthesize({
  usingStandardVoice,
  serverReady,
  selectedModelLoaded,
  pinsOwnWeights,
  resolvesPerRequest,
  hasReferenceParams,
}) {
  if (usingStandardVoice) return true;
  if (selectedModelLoaded && hasReferenceParams) return true;
  if (!serverReady) return false;
  // A saved profile carries its own references, resolved server-side per request
  // (lambda/shared/voiceProfileRuntime.js), so it needs none from this page.
  if (resolvesPerRequest) return true;
  return Boolean(pinsOwnWeights && hasReferenceParams);
}

export function shouldLoadSelectedProfile({
  selectedProfile,
  loadedGPTPath,
  loadedSoVITSPath,
  isConversationActive,
  loadingModel,
}) {
  const gptPath = selectedProfile?.gptModel?.path || '';
  const sovitsPath = selectedProfile?.sovitsModel?.path || '';

  return Boolean(
    selectedProfile?.complete
      && gptPath
      && sovitsPath
      && !isConversationActive
      && !loadingModel
      && (!sameLoadedWeights(gptPath, loadedGPTPath) || !sameLoadedWeights(sovitsPath, loadedSoVITSPath))
  );
}

export function buildModelSelectWarmPayload({
  voiceProfileId = '',
  refAudioPath = '',
  auxRefAudioPaths = [],
  refreshAutoReferences = false,
  prepareCapacity = true,
} = {}) {
  const primaryPath = String(refAudioPath || '').trim();
  const normalizedVoiceProfileId = String(voiceProfileId || '').trim();
  if (!primaryPath) {
    return {
      ...(normalizedVoiceProfileId ? { voiceProfileId: normalizedVoiceProfileId } : {}),
      ...(refreshAutoReferences ? { refresh_auto_references: true } : {}),
      ...(!prepareCapacity ? { prepareCapacity: false } : {}),
    };
  }

  return {
    ...(normalizedVoiceProfileId ? { voiceProfileId: normalizedVoiceProfileId } : {}),
    ...(refreshAutoReferences ? { refresh_auto_references: true } : {}),
    ...(!prepareCapacity ? { prepareCapacity: false } : {}),
    ref_audio_path: primaryPath,
    aux_ref_audio_paths: Array.from(auxRefAudioPaths || [])
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .slice(0, 5),
  };
}

export function extractModelSelectWarmedReferenceSelection(result = {}) {
  const references = result?.resolvedReferences || result?.warmedReferences || {};
  const primaryPath = String(references.ref_audio_path || '').trim();
  if (!primaryPath) {
    return null;
  }

  return {
    refAudioPath: primaryPath,
    auxRefAudioPaths: Array.from(references.aux_ref_audio_paths || [])
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .filter((path) => path !== primaryPath)
      .slice(0, 5),
    promptText: String(references.prompt_text || '').trim(),
    promptLang: String(references.prompt_lang || '').trim(),
  };
}

export function resolveWarmedReferencePrompt(selection = {}, primaryFile = {}, activeProfile = {}) {
  const primaryPath = String(selection.refAudioPath || '').trim();
  const activeProfileMatchesPrimary = primaryPath
    && String(activeProfile?.ref_audio_path || '').trim() === primaryPath;
  return {
    promptText: String(
      selection.promptText
      || primaryFile?.transcript
      || (activeProfileMatchesPrimary ? activeProfile?.prompt_text : '')
      || '',
    ).trim(),
    promptLang: String(
      selection.promptLang
      || primaryFile?.lang
      || (activeProfileMatchesPrimary ? activeProfile?.prompt_lang : '')
      || '',
    ).trim(),
  };
}

// Weights filename, lower-cased, ignoring directory/format. The inference server
// may report an absolute filesystem path ("/opt/gpt-sovits/.../Dean-e10.ckpt")
// while the client tracks the S3 key ("models/user-models/gpt/Dean-e10.ckpt") for
// the same model — comparing basenames avoids a spurious "different model".
function weightsBasename(path) {
  return String(path || '').trim().split(/[\\/]/).pop().toLowerCase();
}

function reconcileLoadedPath(reported, fallback) {
  const reportedTrim = String(reported || '').trim();
  const fallbackTrim = String(fallback || '').trim();
  // Blank report → keep what we already know is loaded (benign blank, respawn,
  // different worker instance). This stopped the false "No model" flaps.
  if (!reportedTrim) return fallbackTrim;
  // Same model, different path format → keep the canonical value we selected so
  // the "is my selection loaded?" check still matches.
  if (fallbackTrim && weightsBasename(reportedTrim) === weightsBasename(fallbackTrim)) {
    return fallbackTrim;
  }
  // Genuinely different, populated model (e.g. another session switched it).
  return reportedTrim;
}

export function resolveInferenceStatusState({
  status = {},
  fallbackLoadedGPTPath = '',
  fallbackLoadedSoVITSPath = '',
} = {}) {
  return {
    serverReady: Boolean(status?.ready),
    loadedGPTPath: reconcileLoadedPath(status?.loaded?.gptPath, fallbackLoadedGPTPath),
    loadedSoVITSPath: reconcileLoadedPath(status?.loaded?.sovitsPath, fallbackLoadedSoVITSPath),
  };
}

export function shouldHoldReadyDuringTransientStatus({
  nextState = {},
  previousServerReady = false,
  hasKnownLoadedModel = false,
  consecutiveNotReady = 0,
  requiredConfirmations = 2,
} = {}) {
  return Boolean(
    !nextState.serverReady
      && previousServerReady
      && hasKnownLoadedModel
      && consecutiveNotReady < requiredConfirmations,
  );
}
