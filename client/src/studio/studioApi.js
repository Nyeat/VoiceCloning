// Voice Studio REST calls (lambda/studio). Uses the shared axios client so
// every call carries the Microsoft token and the signed-body headers.
import { apiClient as api } from '@/services/api.js';

const enc = encodeURIComponent;

export const getMe = () => api.get('/studio/me').then((res) => res.data);

// consent: the record the lecturer accepted (super users send none).
export async function createSubmission({ label, name, consent = null, trainingConfig = null, forPerson = null }) {
  return (await api.post('/studio/submissions', {
    label, name, ...(consent ? { consent } : {}), ...(trainingConfig ? { trainingConfig } : {}),
    ...(forPerson?.email ? { forEmail: forPerson.email, forName: forPerson.name || '' } : {}),
  })).data;
}

/** "Sign in with Google": credential is the Google ID token from Google Identity Services. */
export async function googleSignIn(credential) {
  return (await api.post('/studio/auth/google', { credential }, { vcsOptionalAuth: true })).data;
}

/**
 * Uploads the files straight to S3 (presigned PUT), then submits the set,
 * which queues training. onProgress(fraction) reports overall bytes sent.
 */
export async function uploadAndSubmit(jobId, items, { onProgress } = {}) {
  const files = items.map((item) => item.file);
  const { uploads } = (await api.post(`/studio/submissions/${enc(jobId)}/presign`, {
    files: files.map((file) => ({ name: file.name, type: file.type || 'audio/wav', size: file.size })),
  })).data;
  const total = files.reduce((sum, file) => sum + file.size, 0) || 1;
  const sentByIndex = new Array(files.length).fill(0);
  const report = () => onProgress?.(sentByIndex.reduce((a, b) => a + b, 0) / total);

  // Three at a time: fast, without saturating a lecturer's uplink.
  let next = 0;
  async function worker() {
    while (next < uploads.length) {
      const index = next;
      next += 1;
      await putWithProgress(uploads[index].url, files[index], (loaded) => { sentByIndex[index] = loaded; report(); });
      sentByIndex[index] = files[index].size;
      report();
    }
  }
  await Promise.all([worker(), worker(), worker()]);

  const sources = {};
  uploads.forEach((upload, index) => { sources[upload.key] = items[index].source; });
  return (await api.post(`/studio/submissions/${enc(jobId)}/submit`, { keys: uploads.map((u) => u.key), sources })).data;
}

function putWithProgress(url, file, onLoaded) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type || 'audio/wav');
    xhr.upload.onprogress = (event) => onLoaded(event.loaded);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload of ${file.name} failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error(`Upload of ${file.name} failed — check your connection`));
    xhr.send(file);
  });
}

export const withdrawSubmission = (jobId) => api.post(`/studio/submissions/${enc(jobId)}/cancel`, {}).then((res) => res.data);
// feedback: { rating, likeness, issues[], words, comment }. Sending it ends the lecturer's testing; returns their fresh view.
export const sendFeedback = (jobId, feedback) => api.post(`/studio/submissions/${enc(jobId)}/feedback`, feedback).then((res) => res.data);

export const getVoiceAccess = (voice) => api.get(`/studio/voices/${enc(voice)}/access`).then((res) => res.data);
export const getPronunciations = (voice) => api.get(`/studio/voices/${enc(voice)}/pronunciations`).then((res) => res.data);
export const savePronunciation = (voice, entry) => api.post(`/studio/voices/${enc(voice)}/pronunciations`, entry).then((res) => res.data);
// DELETE never carries a body: CloudFront's signed Lambda origin rejects a DELETE
// with one (403 "signature does not match"), so arguments go in the query string.
export const deletePronunciation = (voice, word) => api.delete(`/studio/voices/${enc(voice)}/pronunciations`, { params: { word } }).then((res) => res.data);
export const applyPronunciations = (voice) => api.post(`/studio/voices/${enc(voice)}/pronunciations/apply`, {}).then((res) => res.data);

export const getOverview = () => api.get('/studio/admin/overview').then((res) => res.data);
export const runTick = () => api.post('/studio/admin/tick', {}).then((res) => res.data);
export const reviewJob = (jobId, body) => api.post(`/studio/admin/jobs/${enc(jobId)}/review`, body).then((res) => res.data);
// Slots belong to people. Super users draft, edit and publish; lecturers never book.
// A test slot may carry assignees: [{ email, name }] — one slot (and GPU) each.
export const addSlot = (slot) => api.post('/studio/admin/slots', slot).then((res) => res.data);
export const editSlot = (id, changes) => api.put(`/studio/admin/slots/${enc(id)}`, changes).then((res) => res.data);
export const deleteSlot = (id) => api.delete(`/studio/admin/slots/${enc(id)}`).then((res) => res.data);
export const publishSlots = () => api.post('/studio/admin/slots/publish', {}).then((res) => res.data);
export const retryJob = (jobId) => api.post(`/studio/admin/jobs/${enc(jobId)}/retry`, {}).then((res) => res.data);
export const cancelJob = (jobId) => api.post(`/studio/admin/jobs/${enc(jobId)}/cancel`, {}).then((res) => res.data);
export const recordTestActivity = () => api.post('/studio/admin/test-activity', {}).then((res) => res.data);
export const recordVoiceActivity = (voiceName) => api.post(`/studio/voices/${enc(voiceName)}/activity`, {}).then((res) => res.data);
export const sendTestEmail = () => api.post('/studio/admin/test-email', {}).then((res) => res.data);
export const restoreJob = (jobId) => api.post(`/studio/admin/jobs/${enc(jobId)}/restore`, {}).then((res) => res.data);
export const requestRecordings = (jobId, notes) => api.post(`/studio/admin/jobs/${enc(jobId)}/request-recordings`, { notes }).then((res) => res.data);
export const addSuperuser = (email, name) => api.post('/studio/admin/superusers', { email, name }).then((res) => res.data);
export const renameSuperuser = (email, name) => api.put(`/studio/admin/superusers/${enc(email)}`, { name }).then((res) => res.data);
export const removeSuperuser = (email) => api.delete(`/studio/admin/superusers/${enc(email)}`).then((res) => res.data);

export function errorText(error, fallback = 'Something went wrong') {
  return error?.response?.data?.error || error?.message || fallback;
}

const SGT = 'Asia/Singapore';
export function formatSgt(value, { withDate = true } = {}) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const time = new Intl.DateTimeFormat('en-SG', { timeZone: SGT, hour: 'numeric', minute: '2-digit' }).format(date);
  if (!withDate) return time;
  const day = new Intl.DateTimeFormat('en-SG', { timeZone: SGT, weekday: 'short', day: 'numeric', month: 'short' }).format(date);
  return `${day}, ${time}`;
}

export function formatRange(start, end) {
  return `${formatSgt(start)} – ${formatSgt(end, { withDate: false })} SGT`;
}

/** "2026-11-20" + "13:00" in Singapore time -> ISO string. */
export function sgtToIso(dateText, timeText) {
  if (!dateText || !timeText) return '';
  const date = new Date(`${dateText}T${timeText}:00+08:00`);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

export function relativeFromNow(value, now = Date.now()) {
  const minutes = Math.round((new Date(value).getTime() - now) / 60000);
  if (!Number.isFinite(minutes)) return '';
  if (minutes <= 1) return 'any minute now';
  if (minutes < 60) return `in about ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `in about ${hours} h${rest >= 10 ? ` ${rest} min` : ''}`;
}
