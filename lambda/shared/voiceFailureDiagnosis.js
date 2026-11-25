// Why a voice cannot speak, in words an admin can act on (owner 2026-11-25:
// surface the root cause, e.g. "too short", not just "tts failed").
// Reads what training left behind: the voice profile names the model, the
// model names its training run, and the run's quality report says how much
// clean speech it was trained on.

// Minimum recorded speech before a voice may be submitted for training, and
// what "too short" means here (owner 2026-11-25: "min 10 min").
export const MIN_TRAINING_AUDIO_SECONDS = 10 * 60;

export function trainingRunName(profile = {}) {
  const key = String(profile.gptKey || profile.gptPath || '');
  const match = key.match(/([^/]+?)-e\d+\.ckpt$/u);
  return match ? match[1] : '';
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  if (value < 90) return `${value} s`;
  return `${Math.round(value / 60)} min`;
}

/**
 * { reason, action: 'rerecord' | 'retrain', trainedSeconds, runName }.
 * `readJson(key)` returns the parsed object at an S3 key or null.
 */
export async function diagnoseVoiceFailure(voiceProfileId, { readJson, error = '' } = {}) {
  const fallback = {
    reason: 'The voice model loads but produces no speech.',
    action: 'retrain',
    trainedSeconds: null,
    runName: '',
    ...(error ? { detail: String(error).slice(0, 300) } : {}),
  };
  if (!voiceProfileId || typeof readJson !== 'function') return fallback;
  let profile = null;
  try {
    profile = await readJson(`voice-profiles/${voiceProfileId}.json`);
  } catch {
    return fallback;
  }
  const runName = trainingRunName(profile || {});
  if (!runName) return fallback;
  let report = null;
  try {
    report = await readJson(`training/datasets/${runName}/training-quality-report.json`);
  } catch {
    report = null;
  }
  const trainedSeconds = Number(report?.keptDurationSeconds);
  if (Number.isFinite(trainedSeconds) && trainedSeconds < MIN_TRAINING_AUDIO_SECONDS) {
    return {
      ...fallback,
      runName,
      trainedSeconds,
      action: 'rerecord',
      reason: `Training audio too short: the voice was trained on only ${formatDuration(trainedSeconds)} of clean speech (at least ${formatDuration(MIN_TRAINING_AUDIO_SECONDS)} is needed). Re-record and retrain.`,
    };
  }
  return {
    ...fallback,
    runName,
    trainedSeconds: Number.isFinite(trainedSeconds) ? trainedSeconds : null,
    reason: Number.isFinite(trainedSeconds)
      ? `The voice model (trained on ${formatDuration(trainedSeconds)} of speech) loads but produces no speech. Retrain it; if that fails, re-record.`
      : fallback.reason,
  };
}
