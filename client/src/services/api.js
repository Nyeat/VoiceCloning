import axios from 'axios';
import { acquireApiToken, acquireApiTokenSilent, shouldAttachApiToken } from '@/auth/msalClient';
import {
  createVoiceProfileBrowserDebugSummary,
  writeVoiceProfileBrowserDebug,
} from '../lib/voiceProfileDebug.js';
import { isGpuOfflineResponse, synthesisResponseError } from '../lib/synthesisResponse.js';
import { API_BASE_URL, resolveApiPath, getStorageMode, isS3Mode } from '@/lib/runtimeConfig';
import { APP_MODE_CONFIG } from '@/lib/appMode';

const api = axios.create({
  baseURL: API_BASE_URL,
});

const METHODS_REQUIRING_PAYLOAD_HASH = new Set(['post', 'put', 'patch', 'delete']);

// Shown instead of raw nginx "503 Service Temporarily Unavailable" HTML when the
// GPU inference worker is offline. The gi kiosk renders no GPU chrome at all
// (App.jsx gives it neither the Start GPU button nor the starting overlay), so
// telling a student to press a button that isn't on their screen is a dead end —
// there the instance auto-starts and waiting is the actual remedy.
export const GPU_OFFLINE_MESSAGE = APP_MODE_CONFIG.gi
  ? 'The voice engine is still starting up — please try again in a moment.'
  : 'GPU not started — press Start GPU to begin.';

export { isGpuOfflineResponse };

// The same 502/503/504 covers a stopped instance, a voice model mid-load, and a
// synthesis-queue timeout — all recoverable. Callers must be able to tell that
// apart from a hard failure, and the message alone cannot say it: rewriting the
// body to GPU_OFFLINE_MESSAGE is exactly what silently disabled the live-reply
// retry, which classified errors by matching "503" in their text.
export function gpuOfflineError(status) {
  const error = new Error(GPU_OFFLINE_MESSAGE);
  error.code = 'GPU_OFFLINE';
  error.status = Number(status) || 503;
  return error;
}

// Decode a non-200 body from a synthesis route. Every such route must go through
// this one call: a route that decodes its own body is how Live Fast came to
// relabel a loading voice model as "GPU not started".
function synthesisError(text, status) {
  return synthesisResponseError(text, status, { gpuOfflineMessage: GPU_OFFLINE_MESSAGE });
}

function isSpecialBody(data) {
  return (
    (typeof FormData !== 'undefined' && data instanceof FormData)
    || (typeof Blob !== 'undefined' && data instanceof Blob)
    || (typeof File !== 'undefined' && data instanceof File)
    || (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer)
    || (typeof URLSearchParams !== 'undefined' && data instanceof URLSearchParams)
  );
}

function isJsonBody(data) {
  if (data == null) return true;
  if (isSpecialBody(data)) return false;
  if (typeof data === 'string') return true;
  if (typeof data === 'number' || typeof data === 'boolean') return true;
  if (Array.isArray(data)) return true;
  return Object.prototype.toString.call(data) === '[object Object]';
}

function serializeJsonBody(data) {
  if (data == null) return '';
  if (typeof data === 'string') return data;
  return JSON.stringify(data);
}

function setHeader(headers, name, value) {
  if (typeof headers.set === 'function') {
    headers.set(name, value);
    return;
  }
  headers[name] = value;
}

async function sha256Hex(text) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto SHA-256 is unavailable; cannot sign Lambda Function URL POST body');
  }

  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

api.interceptors.request.use(async (config) => {
  config.headers = config.headers || {};
  const optionalAuth = config.vcsOptionalAuth === true;
  delete config.vcsOptionalAuth;
  if (shouldAttachApiToken()) {
    // Model discovery/loading is a background operation against endpoints that
    // are intentionally public in the current backend. A transient MSAL refresh
    // failure must not turn that background warm into a misleading HTTP 403.
    const token = optionalAuth ? await acquireApiTokenSilent() : await acquireApiToken();
    if (!token && !optionalAuth) throw new Error('Authentication token is unavailable. Please sign in again.');
    // CloudFront signs the Lambda origin request with SigV4, which owns the
    // standard Authorization header. This separate header reaches Lambda intact.
    if (token) setHeader(config.headers, 'X-VCS-Entra-Token', token);
  }

  const method = String(config.method || 'get').toLowerCase();
  if (!METHODS_REQUIRING_PAYLOAD_HASH.has(method) || !isJsonBody(config.data)) {
    return config;
  }

  const body = serializeJsonBody(config.data);
  config.data = body;
  config.transformRequest = [(data) => data];
  setHeader(config.headers, 'Content-Type', 'application/json');
  setHeader(config.headers, 'x-amz-content-sha256', await sha256Hex(body));
  return config;
});

// Initialize storage mode on first import (non-blocking)
getStorageMode();

// S3 presigned upload helpers

async function getPresignedUploadUrls(expName, files) {
  const fileList = files.map(f => ({ name: f.name, type: f.type, size: f.size }));
  const res = await api.post('/upload/presign', { expName, files: fileList });
  return res.data;
}

async function uploadFileToS3(presignedUrl, file) {
  const response = await fetch(presignedUrl, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': file.type || 'audio/wav' },
  });
  if (!response.ok) {
    throw new Error(`S3 upload failed (${response.status})`);
  }
}

async function confirmUpload(expName, keys) {
  const res = await api.post('/upload/confirm', { expName, keys });
  return res.data;
}

function assertConfirmedUpload(expectedCount, confirmation, messagePrefix) {
  if (Number(confirmation?.confirmed) !== Number(expectedCount)) {
    throw new Error(`${messagePrefix} confirmed ${confirmation?.confirmed || 0} of ${expectedCount} uploaded file(s).`);
  }
}

// Training audio upload

export async function uploadFiles(expName, files) {
  await getStorageMode();

  if (isS3Mode()) {
    const { uploads } = await getPresignedUploadUrls(expName, Array.from(files));
    await Promise.all(uploads.map(({ url }, i) => uploadFileToS3(url, files[i])));
    const keys = uploads.map(u => u.key);
    const confirmation = await confirmUpload(expName, keys);
    assertConfirmedUpload(keys.length, confirmation, 'Training upload');
    return { data: { message: `${confirmation.confirmed} file(s) uploaded`, files: confirmation.files } };
  }

  const formData = new FormData();
  formData.append('expName', expName);
  for (const file of files) {
    formData.append('files', file);
  }
  return api.post('/upload', formData);
}

// Reference audio upload

export async function uploadRefAudio(file) {
  await getStorageMode();

  if (isS3Mode()) {
    const presignRes = await api.post('/upload-ref/presign', {
      filename: file.name,
      type: file.type,
    });
    const { url, key } = presignRes.data;
    await uploadFileToS3(url, file);
    const confirmRes = await api.post('/upload-ref/confirm', { key });
    return { data: { path: confirmRes.data.key, filename: confirmRes.data.filename } };
  }

  const formData = new FormData();
  formData.append('file', file);
  return api.post('/upload-ref', formData);
}

export async function getTrainingLibraryFiles() {
  await getStorageMode();
  if (!isS3Mode()) {
    return { data: { files: [] } };
  }
  return api.get('/training-library');
}

export async function uploadTrainingLibraryFile(file) {
  await getStorageMode();
  if (!isS3Mode()) {
    throw new Error('Shared training storage requires S3 mode.');
  }

  const presignRes = await api.post('/training-library/presign', {
    filename: file.name,
    type: file.type,
  });
  const { id, key, url, filename } = presignRes.data;
  await uploadFileToS3(url, file);
  return api.post('/training-library/confirm', {
    id,
    key,
    filename,
    contentType: file.type || 'audio/wav',
  });
}

export async function replaceTrainingLibraryFile(fileId, file) {
  await getStorageMode();
  if (!isS3Mode()) {
    throw new Error('Shared training storage requires S3 mode.');
  }

  const presignRes = await api.post(`/training-library/${encodeURIComponent(fileId)}/replace-presign`, {
    filename: file.name,
    type: file.type,
  });
  const { key, url, filename } = presignRes.data;
  await uploadFileToS3(url, file);
  return api.post(`/training-library/${encodeURIComponent(fileId)}/replace-confirm`, {
    key,
    filename,
    contentType: file.type || 'audio/wav',
  });
}

export async function deleteTrainingLibraryFile(fileId) {
  await getStorageMode();
  if (!isS3Mode()) {
    throw new Error('Shared training storage requires S3 mode.');
  }
  return api.delete(`/training-library/${encodeURIComponent(fileId)}`);
}

export async function snapshotTrainingLibraryFiles(expName, fileIds) {
  await getStorageMode();
  if (!isS3Mode()) {
    throw new Error('Shared training storage requires S3 mode.');
  }
  return api.post('/training-library/snapshot', { expName, fileIds });
}

// Training

export function startTraining(params) {
  return api.post('/train', params);
}

// The run's name is allocated by the server, not guessed here: the audio is
// uploaded to training/datasets/<expName>/raw/ before training starts, so the
// name has to be settled first and must never land on an existing voice.
export function allocateTrainingVoiceName(email) {
  return api.post('/train/next-name', { email });
}

export function stopTraining(sessionId) {
  return api.post('/train/stop', { sessionId });
}

export function getCurrentTraining() {
  return api.get('/train/current');
}

export function getTrainingRunMetadata(expName) {
  return api.get(`/train/metadata/${encodeURIComponent(expName)}`);
}

// Models

export function getModels() {
  return api.get('/models', { vcsOptionalAuth: true });
}

export function selectModels(gptPath, sovitsPath, options = {}) {
  const refAudioPath = String(options?.ref_audio_path || '').trim();
  const voiceProfileId = String(options?.voiceProfileId || '').trim();
  const refreshAutoReferences = options?.refresh_auto_references === true;
  const prepareCapacity = options?.prepareCapacity !== false;
  const auxRefAudioPaths = Array.isArray(options?.aux_ref_audio_paths)
    ? options.aux_ref_audio_paths.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 5)
    : [];

  if (isS3Mode()) {
    return api.post('/models/select', {
      gptKey: gptPath,
      sovitsKey: sovitsPath,
      ...(voiceProfileId ? { voiceProfileId } : {}),
      ...(!prepareCapacity ? { prepareCapacity: false } : {}),
      ...(refreshAutoReferences ? { refresh_auto_references: true } : {}),
      ...(refAudioPath ? {
        ref_audio_path: refAudioPath,
        aux_ref_audio_paths: auxRefAudioPaths,
      } : {}),
    }, { vcsOptionalAuth: true });
  }
  return api.post('/models/select', {
    gptPath,
    sovitsPath,
    ...(voiceProfileId ? { voiceProfileId } : {}),
    ...(!prepareCapacity ? { prepareCapacity: false } : {}),
    ...(refreshAutoReferences ? { refresh_auto_references: true } : {}),
    ...(refAudioPath ? {
      ref_audio_path: refAudioPath,
      aux_ref_audio_paths: auxRefAudioPaths,
    } : {}),
  }, { vcsOptionalAuth: true });
}

export function activateVoiceProfile(profile) {
  const requestDebug = createVoiceProfileBrowserDebugSummary({
    context: 'activate request',
    voiceProfileId: profile?.voiceProfileId,
    displayName: profile?.displayName,
    refAudioPath: profile?.ref_audio_path,
    promptText: profile?.prompt_text,
    promptLang: profile?.prompt_lang,
    textLang: profile?.text_lang,
    auxRefAudioPaths: profile?.aux_ref_audio_paths,
    defaults: profile?.defaults,
  });
  writeVoiceProfileBrowserDebug('activate request', requestDebug);

  return api.post('/voice-profile/activate', profile)
    .then((response) => {
      writeVoiceProfileBrowserDebug('activate response', createVoiceProfileBrowserDebugSummary({
        context: 'activate response',
        voiceProfileId: profile?.voiceProfileId,
        displayName: profile?.displayName,
        refAudioPath: profile?.ref_audio_path,
        promptText: profile?.prompt_text,
        promptLang: profile?.prompt_lang,
        textLang: profile?.text_lang,
        auxRefAudioPaths: profile?.aux_ref_audio_paths,
        defaults: profile?.defaults,
        summary: response?.data || null,
      }));
      return response;
    })
    .catch((error) => {
      writeVoiceProfileBrowserDebug('activate error', {
        ...requestDebug,
        context: 'activate error',
        error: error?.response?.data?.error || error?.message || 'Unknown error',
        status: error?.response?.status || null,
      });
      throw error;
    });
}

export function getActiveVoiceProfile() {
  return api.get('/voice-profile/active');
}

export function getFullActiveVoiceProfile() {
  return api.get('/voice-profile/active', {
    params: { full: 1 },
  });
}

export function getPinnedVoiceProfile(voiceProfileId) {
  return api.get(`/voice-profile/pinned/${encodeURIComponent(voiceProfileId)}`);
}

export function prepareVoiceCapacity(voiceProfileId) {
  return api.post('/voice-profile/capacity', { voiceProfileId });
}

// The voices the signed-in lecturer owns. The server resolves ownership from
// the token's email — never from anything the browser sends — and only honours
// scope=all for an admin.
export function getMyVoiceProfiles(scope = 'mine') {
  return api.get('/voice-profile/mine', { params: scope === 'all' ? { scope: 'all' } : {} });
}

// Creates the saved profile record for a trained voice that has none. Synthesis
// resolves a voice per request by id and reads that record, so without it a
// freshly trained voice cannot be spoken at all.
export function ensureVoiceProfile(voiceName) {
  return api.post('/voice-profile/ensure', { voiceName });
}

export function getVoiceProfileConfigs(voiceProfileId) {
  return api.get(`/voice-profile/configs/${encodeURIComponent(voiceProfileId)}`);
}

export function saveVoiceProfileConfig(voiceProfileId, configId, config) {
  return api.post(
    `/voice-profile/configs/${encodeURIComponent(voiceProfileId)}/${encodeURIComponent(configId)}`,
    config,
  );
}

export function deleteVoiceProfileConfig(voiceProfileId, configId) {
  return api.post(`/voice-profile/configs/${encodeURIComponent(voiceProfileId)}/${encodeURIComponent(configId)}`, {
    delete: true,
  });
}

// Transcription

export function transcribeAudio(filePath, language = 'auto') {
  return api.post('/transcribe', { filePath, language });
}

// Inference

export async function synthesize(params) {
  const res = await api.post('/inference', params, {
    responseType: 'blob',
    validateStatus: () => true,
  });

  if (res.status !== 200) {
    throw synthesisError(await res.data.text(), res.status);
  }

  return {
    blob: new Blob([res.data], { type: 'audio/wav' }),
  };
}

// `replyToken` travels as a header, never in `params`: the body is forwarded
// verbatim to the GPT-SoVITS Python API, which must not receive unknown fields.
// It lets barge-in release this clip's GPU queue slot (see cancelLiveReply).
export async function synthesizeSentence(params, { replyToken = '' } = {}) {
  const res = await api.post('/live/tts-sentence', params, {
    responseType: 'blob',
    validateStatus: () => true,
    ...(replyToken ? { headers: { 'X-VCS-Reply-Token': replyToken } } : {}),
  });

  if (res.status !== 200) {
    throw synthesisError(await res.data.text(), res.status);
  }

  // A standard (ElevenLabs) voice returns mp3, the GPU returns wav. Assuming wav
  // here made the mp3 clips silently unplayable in some browsers.
  return {
    blob: new Blob([res.data], { type: res.headers?.['content-type'] || 'audio/wav' }),
  };
}

export async function startGeneration(params) {
  try {
    return await api.post('/inference/generate', params);
  } catch (err) {
    if (isGpuOfflineResponse(err?.response?.status, err?.response?.data)) {
      throw gpuOfflineError(err?.response?.status);
    }
    throw err;
  }
}

export function regenerateInferenceChunk(sessionId, index, text = '', previous = {}) {
  return api.post('/inference/regenerate-chunk', {
    sessionId,
    index,
    ...(String(text || '').trim() ? { text: String(text).trim() } : {}),
    ...(String(previous.text || '').trim() ? { previousText: String(previous.text).trim() } : {}),
    previousFallback: previous.fallback === true,
    previousFallbackReason: String(previous.fallbackReason || ''),
  });
}

export function restoreInferenceChunk(sessionId, index, versionId, current = {}) {
  return api.post('/inference/restore-chunk', {
    sessionId,
    index,
    versionId,
    currentText: String(current.text || ''),
    currentFallback: current.fallback === true,
    currentFallbackReason: String(current.fallbackReason || ''),
  });
}

export function deleteInferenceChunk(sessionId, index) {
  return api.post('/inference/delete-chunk', { sessionId, index });
}

export function insertInferenceChunk(sessionId, index, text) {
  return api.post('/inference/insert-chunk', { sessionId, index, text: String(text || '').trim() });
}

export function getCurrentInference() {
  return api.get('/inference/current');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchGeneratedAudio(url, { attempts = 8, delayMs = 500 } = {}) {
  let lastStatus = 0;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const audioRes = await fetch(url);
    lastStatus = audioRes.status;

    if (audioRes.ok) {
      const blob = await audioRes.blob();
      return new Blob([blob], { type: 'audio/wav' });
    }

    const canRetry = [403, 404, 409, 425].includes(audioRes.status);
    if (!canRetry || attempt === attempts) {
      break;
    }

    await sleep(delayMs * attempt);
  }

  throw new Error(`Generated audio is not ready yet (${lastStatus || 'network error'})`);
}

export async function getGenerationResultSource(sessionId) {
  await getStorageMode();

  if (isS3Mode()) {
    return {
      url: resolveApiPath(`/api/inference/result/${encodeURIComponent(sessionId)}?audio=1`),
      revoke: false,
    };
  }

  const res = await api.get(`/inference/result/${sessionId}`, {
    responseType: 'blob',
    validateStatus: () => true,
  });
  if (res.status !== 200) {
    if (isGpuOfflineResponse(res.status)) throw gpuOfflineError(res.status);
    throw new Error(`Generated audio is not ready yet (${res.status})`);
  }
  const contentType = String(res.headers?.['content-type'] || '');
  if (contentType.includes('application/json')) {
    const data = JSON.parse(await res.data.text());
    if (data?.url) return { url: data.url, revoke: false };
    throw new Error('Generated audio response did not include a playable URL.');
  }
  return { url: URL.createObjectURL(new Blob([res.data], { type: 'audio/wav' })), revoke: true };
}

export async function getGenerationResult(sessionId) {
  await getStorageMode();

  if (isS3Mode()) {
    const res = await api.get(`/inference/result/${sessionId}`);
    const { url } = res.data;
    return fetchGeneratedAudio(url);
  }

  const res = await api.get(`/inference/result/${sessionId}`, {
    responseType: 'blob',
    validateStatus: () => true,
  });
  if (res.status !== 200) {
    if (isGpuOfflineResponse(res.status)) throw gpuOfflineError(res.status);
    throw new Error(`Generated audio is not ready yet (${res.status})`);
  }
  const contentType = String(res.headers?.['content-type'] || '');
  if (contentType.includes('application/json')) {
    const data = JSON.parse(await res.data.text());
    if (data?.url) return fetchGeneratedAudio(data.url);
    throw new Error('Generated audio response did not include a playable URL.');
  }
  return new Blob([res.data], { type: 'audio/wav' });
}

export function getPronunciationDictionary(category = 'general') {
  return api.get('/pronunciation-dictionary', { params: { category } });
}

export function searchPronunciationDictionary(search) {
  return api.get('/pronunciation-dictionary', { params: { search } });
}

export function savePronunciationEntry(entry) {
  return api.post('/pronunciation-dictionary', entry);
}

export function deletePronunciationEntry(entry) {
  return api.post('/pronunciation-dictionary', { ...entry, action: 'delete' });
}

// Scan input text for words the engine would pronounce by neural guess (not from the
// dictionary) — i.e. words that likely need an ARPAbet override. Returns
// { flagged: string[], totalWords, coveredWords, dictionaryLoaded }.
export function scanOovWords(text) {
  return api.post('/inference/scan-oov', { text });
}

export async function getInferenceChunk(sessionId, index) {
  const res = await axios.get(resolveApiPath(
    `/api/inference/chunk/${encodeURIComponent(sessionId)}/${encodeURIComponent(index)}`,
  ), {
    responseType: 'blob',
    validateStatus: () => true,
  });
  if (res.status !== 200) {
    if (isGpuOfflineResponse(res.status)) throw gpuOfflineError(res.status);
    throw new Error(`Chunk not available (${res.status})`);
  }
  return new Blob([res.data], { type: 'audio/wav' });
}

export function getInferenceChunkPreviewUrl(sessionId, index, revision = '') {
  const base = resolveApiPath(`/api/inference/chunk-preview/${encodeURIComponent(sessionId)}/${encodeURIComponent(index)}`);
  return revision ? `${base}?v=${encodeURIComponent(revision)}` : base;
}

export function getInferenceChunkVersionUrl(sessionId, index, versionId) {
  return resolveApiPath(`/api/inference/chunk-version/${encodeURIComponent(sessionId)}/${encodeURIComponent(index)}/${encodeURIComponent(versionId)}`);
}

export function cancelGeneration(sessionId) {
  return api.post('/inference/cancel', { sessionId });
}

// Barge-in: drop any clips of an abandoned reply that are still queued for the GPU.
// Best-effort — a clip already synthesizing cannot be stopped, and a failed cancel
// costs one wasted clip, so callers must never surface an error from this.
export function cancelLiveReply(replyToken) {
  return api.post('/live/cancel', { replyToken });
}

export function getInferenceStatus() {
  return api.get('/inference/status');
}

export function startInferenceServer() {
  return api.post('/inference/start');
}

export function stopInferenceServer() {
  return api.post('/inference/stop');
}

export function getInstanceStatus() {
  return api.get('/instance/status');
}

export function startInstance() {
  return api.post('/instance/start');
}

// Training audio browser

// Clip URLs handed out by the list call, reused until shortly before they expire.
const trainingAudioUrlCache = new Map();
const TRAINING_AUDIO_URL_SAFETY_MS = 10 * 60 * 1000;

function trainingAudioCacheKey(expName, filename) {
  return `${expName}
${filename}`;
}

export async function getTrainingAudioFiles(expName) {
  const response = await api.get(`/training-audio/${encodeURIComponent(expName)}`);
  const lifetimeMs = Number(response?.data?.urlExpiresInSeconds || 0) * 1000;
  if (lifetimeMs > TRAINING_AUDIO_URL_SAFETY_MS && Array.isArray(response?.data?.files)) {
    const expiresAt = Date.now() + lifetimeMs - TRAINING_AUDIO_URL_SAFETY_MS;
    for (const file of response.data.files) {
      if (file?.filename && file?.url) {
        trainingAudioUrlCache.set(trainingAudioCacheKey(expName, file.filename), { url: file.url, expiresAt });
      }
    }
  }
  return response;
}

export async function getTrainingAudioUrl(expName, filename) {
  const cached = trainingAudioUrlCache.get(trainingAudioCacheKey(expName, filename));
  if (cached && cached.expiresAt > Date.now()) return cached.url;

  await getStorageMode();

  if (isS3Mode()) {
    const res = await api.get(`/training-audio/file/${encodeURIComponent(expName)}/${encodeURIComponent(filename)}`);
    return res.data.url;
  }

  return resolveApiPath(`/api/training-audio/file/${encodeURIComponent(expName)}/${encodeURIComponent(filename)}`);
}

export async function getUploadedRefAudioUrl(filePath) {
  await getStorageMode();

  if (isS3Mode()) {
    const res = await api.get('/ref-audio', { params: { filePath } });
    return res.data.url;
  }

  return resolveApiPath(`/api/ref-audio?filePath=${encodeURIComponent(filePath)}`);
}
