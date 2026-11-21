import { chooseBestReferenceSet as chooseSharedReferenceSet, describeReferenceCandidate } from './referenceSelection.js';
import path from 'path';
import { getObject, listObjects, uploadBuffer } from './s3.js';
import { loadClipQualityMetrics } from './clipScores.js';
import { gpuGet, inferenceGet, inferencePost } from './gpuWorker.js';
import { useGpuWorkerArtifacts } from './artifacts.js';
import { isSafePathSegment } from './paths.js';

const ACTIVE_PROFILE_KEY = 'voice-profiles/active.json';
const MIN_REUSABLE_AUX_REFS = 5;

export function modelSource() {
  return (process.env.MODEL_SOURCE || 's3').trim().toLowerCase();
}

export function useGpuWorkerModels() {
  return ['gpu-worker', 'gpu', 'local', 'gpt-sovits'].includes(modelSource());
}

function getBasename(filePath = '') {
  return String(filePath || '').replace(/\\/g, '/').split('/').pop() || '';
}

// Strict eligibility is the shared selector's verdict (shared/referenceSelection.js).
function isStrictReferenceCandidate(file) {
  return describeReferenceCandidate(withFilename(file)).eligible;
}

// Measured audio quality (SNR/clarity) from score_clips.py lands in clip-scores.json
// after training. Until at least one clip carries a finite qualityScore the ranking
// can't be trusted, so the caller should wait for the next pass rather than persist.
function hasMeasuredQualityScores(files) {
  return Array.isArray(files)
    && files.some((file) => Number.isFinite(Number(file?.qualityScore)));
}

// A selection is only "ready" (safe to use AND persist) when quality scores have
// landed and at least one clip passes strict eligibility. Anything short of this is
// a fallback we must not freeze - the frontend re-fetch loop and subsequent warms
// will retry until this becomes true.
function isScoredStrictSelectionReady(files) {
  return hasMeasuredQualityScores(files)
    && Array.isArray(files)
    && files.some((file) => isStrictReferenceCandidate(file));
}

// The same selector the pages use (shared/referenceSelection.js), so every
// surface picks the same clips for a voice. Callers only persist or use it once
// isScoredStrictSelectionReady(files) holds, when it always has a primary.
function chooseBestReferenceSet(files, { maxAux = 5 } = {}) {
  const selection = chooseSharedReferenceSet((Array.isArray(files) ? files : []).map(withFilename), { maxAux });
  return { primary: selection.primary || null, aux: selection.aux || [] };
}

function withFilename(file) {
  return file && !file.filename && file.path ? { ...file, filename: getBasename(file.path) } : file;
}

function extractExpNameFromModelRef(modelRef = '') {
  const basename = getBasename(modelRef);
  const match = basename.match(/^(.+?)[-_]e\d+(?:[_-]s\d+)?\.(?:ckpt|pth)$/i);
  return match ? match[1] : '';
}

function referenceSelectionBelongsToExperiment(selection, expName = '') {
  const normalizedExpName = String(expName || '').trim().toLowerCase();
  if (!normalizedExpName) return true;
  const normalized = normalizeReferenceWarmPayload(selection);
  if (!normalized) return true;
  return [normalized.ref_audio_path, ...normalized.aux_ref_audio_paths].every((referencePath) => (
    String(referencePath || '')
      .replace(/\\/gu, '/')
      .split('/')
      .filter(Boolean)
      .some((segment) => segment.toLowerCase() === normalizedExpName)
  ));
}

async function loadTrainingAudioFilesForExp(expName) {
  const normalizedExpName = String(expName || '').trim();
  if (!normalizedExpName || !isSafePathSegment(normalizedExpName)) {
    return [];
  }

  if (useGpuWorkerArtifacts()) {
    const response = await gpuGet(`/training-audio/${encodeURIComponent(normalizedExpName)}`);
    return Array.isArray(response?.files) ? response.files : [];
  }

  const denoisedPrefix = `training/datasets/${normalizedExpName}/denoised/`;
  const objects = await listObjects(denoisedPrefix);
  const wavFiles = objects
    .filter((object) => object.key.endsWith('.wav'))
    .map((object) => path.basename(object.key))
    .sort();

  const transcriptMap = new Map();
  try {
    const asrBuffer = await getObject(`training/datasets/${normalizedExpName}/asr/denoised.list`);
    for (const line of asrBuffer.toString('utf-8').split('\n').filter(Boolean)) {
      const parts = line.split('|');
      if (parts.length >= 4) {
        const filename = getBasename(parts[0]);
        transcriptMap.set(filename, {
          transcript: parts.slice(3).join('|'),
          lang: parts[2],
        });
      }
    }
  } catch {
    // ASR file may not exist yet.
  }

  const clipMetrics = await loadClipQualityMetrics(normalizedExpName);
  return wavFiles.map((filename) => {
    const info = transcriptMap.get(filename) || {};
    const qualityMetrics = clipMetrics.get(filename);
    return {
      filename,
      key: `${denoisedPrefix}${filename}`,
      path: `${denoisedPrefix}${filename}`,
      transcript: info.transcript || '',
      lang: info.lang || '',
      qualityScore: qualityMetrics?.score,
      qualityMetrics,
    };
  });
}

function normalizeReferenceWarmPayload({
  ref_audio_path = '',
  aux_ref_audio_paths = [],
  prompt_text = '',
  prompt_lang = '',
} = {}) {
  const refAudioPath = String(ref_audio_path || '').trim();
  if (!refAudioPath) {
    return null;
  }

  const promptText = String(prompt_text || '').replace(/\s+/gu, ' ').trim();
  const promptLang = String(prompt_lang || '').trim();

  return {
    ref_audio_path: refAudioPath,
    aux_ref_audio_paths: Array.isArray(aux_ref_audio_paths)
      ? aux_ref_audio_paths
        .map((item) => String(item || '').trim())
        .filter(Boolean)
      : [],
    ...(promptText ? { prompt_text: promptText } : {}),
    ...(promptLang ? { prompt_lang: promptLang } : {}),
  };
}

function sameReferenceWarmPayload(left, right) {
  const normalizedLeft = normalizeReferenceWarmPayload(left);
  const normalizedRight = normalizeReferenceWarmPayload(right);

  if (!normalizedLeft || !normalizedRight) {
    return normalizedLeft === normalizedRight;
  }

  return (
    normalizedLeft.ref_audio_path === normalizedRight.ref_audio_path
    && normalizedLeft.aux_ref_audio_paths.length === normalizedRight.aux_ref_audio_paths.length
    && normalizedLeft.aux_ref_audio_paths.every((path, index) => path === normalizedRight.aux_ref_audio_paths[index])
    && (normalizedLeft.prompt_text || '') === (normalizedRight.prompt_text || '')
    && (normalizedLeft.prompt_lang || '') === (normalizedRight.prompt_lang || '')
  );
}

function hasAuxiliaryReferenceSelection(profile = {}) {
  return Array.isArray(profile?.aux_ref_audio_paths)
    && profile.aux_ref_audio_paths
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .length >= MIN_REUSABLE_AUX_REFS;
}

function getProfileStorageKey(voiceProfileId) {
  return `voice-profiles/${voiceProfileId}.json`;
}

function getDefaultConfigKey(voiceProfileId) {
  return `voice-profile-configs/${voiceProfileId}/default.json`;
}

function normalizeSavedProfile(profile) {
  if (!profile || typeof profile !== 'object') {
    return null;
  }

  return {
    ...profile,
    ref_audio_path: String(profile.ref_audio_path || '').trim(),
    aux_ref_audio_paths: Array.isArray(profile.aux_ref_audio_paths)
      ? profile.aux_ref_audio_paths
        .map((item) => String(item || '').trim())
        .filter(Boolean)
      : [],
  };
}

function normalizeModelRef(value) {
  return String(value || '').trim();
}

function savedProfileMatchesModelPair(profile, {
  gptKey = '',
  gptPath = '',
  sovitsKey = '',
  sovitsPath = '',
} = {}) {
  const expectedGptRef = normalizeModelRef(gptKey || gptPath);
  const expectedSovitsRef = normalizeModelRef(sovitsKey || sovitsPath);
  const savedGptRef = normalizeModelRef(profile?.gptKey || profile?.gptPath);
  const savedSovitsRef = normalizeModelRef(profile?.sovitsKey || profile?.sovitsPath);

  if (expectedGptRef && savedGptRef && expectedGptRef !== savedGptRef) {
    return false;
  }
  if (expectedSovitsRef && savedSovitsRef && expectedSovitsRef !== savedSovitsRef) {
    return false;
  }

  return Boolean(
    (!expectedGptRef || !savedGptRef || expectedGptRef === savedGptRef)
    && (!expectedSovitsRef || !savedSovitsRef || expectedSovitsRef === savedSovitsRef)
  );
}

async function readSavedProfile(key, {
  readObject = getObject,
} = {}) {
  try {
    const raw = await readObject(key);
    if (!raw) return null;
    return normalizeSavedProfile(JSON.parse(raw.toString('utf-8')));
  } catch {
    return null;
  }
}

async function resolveSavedProfileWarmPayload({
  voiceProfileId = '',
  gptKey = '',
  gptPath = '',
  sovitsKey = '',
  sovitsPath = '',
} = {}, {
  readObject = getObject,
} = {}) {
  const normalizedVoiceProfileId = String(voiceProfileId || '').trim();
  if (normalizedVoiceProfileId && isSafePathSegment(normalizedVoiceProfileId)) {
    const profile = await readSavedProfile(getProfileStorageKey(normalizedVoiceProfileId), { readObject });
    if (!profile) {
      return null;
    }
    if (!savedProfileMatchesModelPair(profile, { gptKey, gptPath, sovitsKey, sovitsPath })) {
      return null;
    }
    const expName = extractExpNameFromModelRef(sovitsKey || sovitsPath || gptKey || gptPath);
    if (!referenceSelectionBelongsToExperiment(profile, expName)) return null;

    const warmPayload = normalizeReferenceWarmPayload(profile);
    return warmPayload && hasAuxiliaryReferenceSelection(profile) ? warmPayload : null;
  }

  const activeProfile = await readSavedProfile(ACTIVE_PROFILE_KEY, { readObject });
  if (!activeProfile) {
    return null;
  }
  if (!savedProfileMatchesModelPair(activeProfile, { gptKey, gptPath, sovitsKey, sovitsPath })) {
    return null;
  }
  const expName = extractExpNameFromModelRef(sovitsKey || sovitsPath || gptKey || gptPath);
  if (!referenceSelectionBelongsToExperiment(activeProfile, expName)) return null;

  const warmPayload = normalizeReferenceWarmPayload(activeProfile);
  return warmPayload && hasAuxiliaryReferenceSelection(activeProfile) ? warmPayload : null;
}

export async function resolveSavedProfileReferenceSelection(profile, {
  listTrainingAudioFiles = loadTrainingAudioFilesForExp,
} = {}) {
  const normalizedProfile = profile || {};
  const existingSelection = normalizeReferenceWarmPayload(normalizedProfile);
  if (existingSelection && hasAuxiliaryReferenceSelection(normalizedProfile)) {
    return existingSelection;
  }

  const expName = extractExpNameFromModelRef(
    normalizedProfile.sovitsKey
    || normalizedProfile.sovitsPath
    || normalizedProfile.gptKey
    || normalizedProfile.gptPath,
  );
  if (!expName) {
    return existingSelection;
  }

  const files = await listTrainingAudioFiles(expName);
  // Passive loop: only auto-select once quality scores have landed and a strictly
  // eligible clip exists. Otherwise keep whatever the profile already has so a cold
  // GPU warm can't freeze a fallback (mediocre ref + padded aux) onto the profile;
  // a later warm/model-load retries once scores are ready.
  if (!isScoredStrictSelectionReady(files)) {
    return existingSelection;
  }
  const selection = chooseBestReferenceSet(files);
  if (!selection.primary) {
    return existingSelection;
  }

  return normalizeReferenceWarmPayload({
    ref_audio_path: selection.primary.path,
    aux_ref_audio_paths: selection.aux.map((file) => file.path),
    prompt_text: selection.primary.transcript,
    prompt_lang: selection.primary.lang,
  }) || existingSelection;
}

async function resolveSavedProfileReferenceWarmState({
  voiceProfileId = '',
  gptKey = '',
  gptPath = '',
  sovitsKey = '',
  sovitsPath = '',
} = {}, {
  listTrainingAudioFiles = loadTrainingAudioFilesForExp,
  readObject = getObject,
} = {}) {
  const normalizedVoiceProfileId = String(voiceProfileId || '').trim();
  const profile = normalizedVoiceProfileId && isSafePathSegment(normalizedVoiceProfileId)
    ? await readSavedProfile(getProfileStorageKey(normalizedVoiceProfileId), { readObject })
    : await readSavedProfile(ACTIVE_PROFILE_KEY, { readObject });

  if (!profile) {
    return null;
  }
  if (!savedProfileMatchesModelPair(profile, { gptKey, gptPath, sovitsKey, sovitsPath })) {
    return null;
  }
  const expName = extractExpNameFromModelRef(sovitsKey || sovitsPath || gptKey || gptPath);
  if (!referenceSelectionBelongsToExperiment(profile, expName)) return null;

  const existingSelection = normalizeReferenceWarmPayload(profile);
  if (existingSelection && hasAuxiliaryReferenceSelection(profile)) {
    return {
      warmPayload: existingSelection,
      savedProfile: profile,
      shouldPersist: false,
    };
  }

  const resolvedSelection = await resolveSavedProfileReferenceSelection(profile, {
    listTrainingAudioFiles,
  });

  return {
    warmPayload: resolvedSelection || existingSelection,
    savedProfile: profile,
    shouldPersist: Boolean(
      resolvedSelection
      && profile?.voiceProfileId
      && !sameReferenceWarmPayload(existingSelection, resolvedSelection)
    ),
  };
}

async function resolveReferenceWarmState({
  voiceProfileId = '',
  gptKey = '',
  gptPath = '',
  sovitsKey = '',
  sovitsPath = '',
  ref_audio_path = '',
  aux_ref_audio_paths = [],
  refresh_auto_references = false,
} = {}, {
  listTrainingAudioFiles = loadTrainingAudioFilesForExp,
  readObject = getObject,
} = {}) {
  const explicit = normalizeReferenceWarmPayload({ ref_audio_path, aux_ref_audio_paths });
  if (explicit) {
    const expName = extractExpNameFromModelRef(sovitsKey || sovitsPath || gptKey || gptPath);
    if (!referenceSelectionBelongsToExperiment(explicit, expName)) {
      throw new Error(`Reference selection does not belong to selected experiment ${expName}`);
    }
    return {
      warmPayload: explicit,
      savedProfile: null,
      shouldPersist: false,
    };
  }

  if (refresh_auto_references) {
    const expName = extractExpNameFromModelRef(sovitsKey || sovitsPath || gptKey || gptPath);
    if (expName) {
      const files = await listTrainingAudioFiles(expName);
      if (isScoredStrictSelectionReady(files)) {
        const selection = chooseBestReferenceSet(files);
        const warmPayload = selection.primary
          ? normalizeReferenceWarmPayload({
            ref_audio_path: selection.primary.path,
            aux_ref_audio_paths: selection.aux.map((file) => file.path),
            prompt_text: selection.primary.transcript,
            prompt_lang: selection.primary.lang,
          })
          : null;
        if (warmPayload) {
          const normalizedVoiceProfileId = String(voiceProfileId || '').trim();
          const candidateProfile = normalizedVoiceProfileId && isSafePathSegment(normalizedVoiceProfileId)
            ? await readSavedProfile(getProfileStorageKey(normalizedVoiceProfileId), { readObject })
            : null;
          const savedProfile = candidateProfile && savedProfileMatchesModelPair(candidateProfile, {
            gptKey,
            gptPath,
            sovitsKey,
            sovitsPath,
          })
            ? candidateProfile
            : null;
          return {
            warmPayload,
            savedProfile,
            shouldPersist: Boolean(
              savedProfile
              && !sameReferenceWarmPayload(normalizeReferenceWarmPayload(savedProfile), warmPayload)
            ),
          };
        }
      }
    }
  }

  const savedProfileWarmState = await resolveSavedProfileReferenceWarmState({
    voiceProfileId,
    gptKey,
    gptPath,
    sovitsKey,
    sovitsPath,
  }, {
    listTrainingAudioFiles,
    readObject,
  });
  if (savedProfileWarmState?.warmPayload) {
    return savedProfileWarmState;
  }

  return {
    warmPayload: await resolveSavedProfileReferenceSelection({
      gptKey,
      gptPath,
      sovitsKey,
      sovitsPath,
      ref_audio_path,
      aux_ref_audio_paths,
    }, {
      listTrainingAudioFiles,
    }),
    savedProfile: null,
    shouldPersist: false,
  };
}

// force: write even when the profile already carries this selection (creating a
// new profile record, whose draft is built with the selection in it).
export async function persistSavedProfileReferenceSelection(profile, selection, {
  readObject = getObject,
  writeObject = uploadBuffer,
  now = () => new Date().toISOString(),
  force = false,
} = {}) {
  const normalizedProfile = normalizeSavedProfile(profile);
  const normalizedSelection = normalizeReferenceWarmPayload(selection);
  const voiceProfileId = String(normalizedProfile?.voiceProfileId || '').trim();

  if (!voiceProfileId || !normalizedSelection) {
    return false;
  }

  const existingSelection = normalizeReferenceWarmPayload(normalizedProfile);
  if (!force && sameReferenceWarmPayload(existingSelection, normalizedSelection) && hasAuxiliaryReferenceSelection(normalizedProfile)) {
    return false;
  }

  const updatedAt = now();
  const {
    activatedAt: _ignoredActivatedAt,
    ...baseProfile
  } = normalizedProfile;
  const updatedProfile = {
    ...baseProfile,
    ...normalizedSelection,
    updatedAt,
  };

  await writeObject(
    getProfileStorageKey(voiceProfileId),
    Buffer.from(JSON.stringify(updatedProfile), 'utf-8'),
    'application/json',
  );

  const activeProfile = await readSavedProfile(ACTIVE_PROFILE_KEY, { readObject });
  const shouldWriteActiveProfile = String(activeProfile?.voiceProfileId || '').trim() === voiceProfileId
    || Boolean(normalizedProfile?.activatedAt);
  if (shouldWriteActiveProfile) {
    const activeBaseProfile = normalizeSavedProfile(activeProfile || normalizedProfile) || normalizedProfile;
    const updatedActiveProfile = {
      ...activeBaseProfile,
      ...updatedProfile,
      activatedAt: String(activeBaseProfile?.activatedAt || normalizedProfile?.activatedAt || updatedAt),
      updatedAt,
    };
    await writeObject(
      ACTIVE_PROFILE_KEY,
      Buffer.from(JSON.stringify(updatedActiveProfile), 'utf-8'),
      'application/json',
    );
  }

  return true;
}

export async function writeDefaultVoiceProfileConfig(profile, selection, {
  writeObject = uploadBuffer,
  now = () => new Date().toISOString(),
} = {}) {
  const normalizedProfile = normalizeSavedProfile(profile);
  const normalizedSelection = normalizeReferenceWarmPayload(selection);
  const voiceProfileId = String(normalizedProfile?.voiceProfileId || '').trim();

  if (!voiceProfileId || !normalizedSelection) {
    return false;
  }

  const configName = `${normalizedProfile.displayName || voiceProfileId} default`;
  const config = {
    schemaVersion: 1,
    voiceProfileId,
    configId: 'default',
    configName,
    rank: 1,
    selected: true,
    trainingMetadata: normalizedProfile.metadata?.training || {},
    inferenceMetadata: {
      configName,
      selected: true,
      rank: 1,
      language: normalizedProfile.text_lang || normalizedProfile.prompt_lang || 'en',
      preferredRoute: normalizedProfile.preferredRoute || 'sentence',
      defaults: normalizedProfile.defaults || {},
    },
    referenceMetadata: {
      mode: 'auto',
      selectedPaths: {
        primary: normalizedSelection.ref_audio_path,
        aux: normalizedSelection.aux_ref_audio_paths || [],
      },
      primary: {
        path: normalizedSelection.ref_audio_path,
        transcript: normalizedSelection.prompt_text || '',
        lang: normalizedSelection.prompt_lang || '',
      },
      aux: (normalizedSelection.aux_ref_audio_paths || []).map((item) => ({ path: item })),
    },
    sample: {},
    updatedAt: now(),
  };

  await writeObject(
    getDefaultConfigKey(voiceProfileId),
    Buffer.from(JSON.stringify(config), 'utf-8'),
    'application/json',
  );
  return true;
}

async function warmModelReferences(payload, {
  postInference = inferencePost,
  listTrainingAudioFiles = loadTrainingAudioFilesForExp,
  readObject = getObject,
  writeObject = uploadBuffer,
  now = () => new Date().toISOString(),
} = {}) {
  try {
    const {
      warmPayload,
      savedProfile,
      shouldPersist,
    } = await resolveReferenceWarmState(payload, {
      listTrainingAudioFiles,
      readObject,
    });
    if (!warmPayload) {
      return null;
    }
    if (savedProfile && shouldPersist) {
      await persistSavedProfileReferenceSelection(savedProfile, warmPayload, {
        readObject,
        writeObject,
        now,
      });
      await writeDefaultVoiceProfileConfig(savedProfile, warmPayload, {
        writeObject,
        now,
      });
    }
    await postInference('/ref-audio/warm', warmPayload);
    return warmPayload;
  } catch (error) {
    const target = String(payload?.ref_audio_path || payload?.sovitsKey || payload?.sovitsPath || payload?.gptKey || payload?.gptPath || '').trim();
    console.warn(`[modelSelection] ref-audio warm failed for ${target || 'unknown model selection'}: ${error.message}`);
    return null;
  }
}

export async function loadModelPair({
  voiceProfileId = '',
  gptKey = '',
  gptPath = '',
  sovitsKey = '',
  sovitsPath = '',
  ref_audio_path = '',
  aux_ref_audio_paths = [],
  refresh_auto_references = false,
} = {}, {
  postInference = inferencePost,
  listTrainingAudioFiles = loadTrainingAudioFilesForExp,
  readObject = getObject,
  writeObject = uploadBuffer,
  now = () => new Date().toISOString(),
} = {}) {
  const resolvedGptKey = gptKey || gptPath;
  const resolvedSovitsKey = sovitsKey || sovitsPath;
  const warmPayload = {
    voiceProfileId,
    gptKey,
    gptPath,
    sovitsKey,
    sovitsPath,
    ref_audio_path,
    aux_ref_audio_paths,
    refresh_auto_references,
  };

  let lastStatus = null;
  if (useGpuWorkerModels()) {
    lastStatus = await postInference('/inference/weights/pair', {
      gptPath: resolvedGptKey,
      sovitsPath: resolvedSovitsKey,
    });
    const warmedReferences = await warmModelReferences(warmPayload, {
      postInference,
      listTrainingAudioFiles,
      readObject,
      writeObject,
      now,
    });
    return {
      message: 'Models loaded successfully',
      loaded: lastStatus?.loaded || {},
      ...(warmedReferences ? { warmedReferences } : {}),
    };
  }

  const [localGpt, localSovits] = await Promise.all([
    resolvedGptKey
      ? postInference('/models/download', { s3Key: resolvedGptKey })
      : null,
    resolvedSovitsKey
      ? postInference('/models/download', { s3Key: resolvedSovitsKey })
      : null,
  ]);
  lastStatus = await postInference('/inference/weights/pair', {
    gptPath: localGpt?.localPath || '',
    sovitsPath: localSovits?.localPath || '',
  });
  const warmedReferences = await warmModelReferences(warmPayload, {
    postInference,
    listTrainingAudioFiles,
    readObject,
    writeObject,
    now,
  });

  return {
    message: 'Models loaded successfully',
    loaded: lastStatus?.loaded || {},
    ...(warmedReferences ? { warmedReferences } : {}),
  };
}

export async function ensureProfileModelsLoaded(profile, {
  getStatus = inferenceGet,
  loadModels = loadModelPair,
} = {}) {
  const gptRef = String(profile?.gptKey || profile?.gptPath || '').trim();
  const sovitsRef = String(profile?.sovitsKey || profile?.sovitsPath || '').trim();

  if (!gptRef && !sovitsRef) {
    return { message: 'No model references provided', loaded: {} };
  }

  if (useGpuWorkerModels()) {
    const status = await getStatus('/inference/status');
    const loaded = status?.loaded || {};
    if (loaded.gptPath === gptRef && loaded.sovitsPath === sovitsRef) {
      return {
        message: 'Models already loaded',
        loaded,
      };
    }
  }

  return loadModels(profile);
}
