import fs from 'fs';
import path from 'path';
import { LOCAL_TEMP_ROOT } from '../config.js';

// The last successful warm payload is persisted at the ROOT of worker_temp — NOT
// under ref_audio_cache/ or model_cache/, both of which startupCleanup wipes on every
// boot. Keeping it here lets warmOnBoot replay it after a restart. The stored ref path
// may be an S3 key: warmReferenceAudioPaths re-downloads it, so replay survives the
// cache wipe.
export const WARM_STATE_PATH = path.join(LOCAL_TEMP_ROOT, 'last_warm.json');

// The activated voice profile, written by the Lambda on /api/voice-profile/activate.
// S3 is the shared source of truth, so a freshly launched instance can read it
// without calling the API or holding a token.
export const ACTIVE_PROFILE_KEY = 'voice-profiles/active.json';

// Autoscaled instances launch from an AMI with no local warm history, so the
// persisted payload only ever helps a restart of a machine that has already served
// traffic. Falling back to the *active* profile is what makes a scale-out warm:
// whichever voice is currently on demand gets loaded, rather than a hard-coded one.
// Scale-out is driven by demand for that profile, so it is the right thing to warm.
export function warmPayloadFromProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const refAudioPath = String(profile.ref_audio_path || '').trim();
  if (!refAudioPath) return null;

  const gptRef = String(profile.gptKey || profile.gptPath || '').trim();
  const sovitsRef = String(profile.sovitsKey || profile.sovitsPath || '').trim();

  return {
    voiceProfileId: String(profile.voiceProfileId || '').trim(),
    ref_audio_path: refAudioPath,
    aux_ref_audio_paths: Array.isArray(profile.aux_ref_audio_paths)
      ? profile.aux_ref_audio_paths.filter((item) => String(item || '').trim())
      : [],
    prompt_text: String(profile.prompt_text || ''),
    prompt_lang: String(profile.prompt_lang || 'en'),
    text_lang: String(profile.text_lang || profile.prompt_lang || 'en'),
    warm_text: 'Ready.',
    // Shape ensureRequestVoiceModel expects, so the warm loads this profile's
    // weights instead of leaving whatever the server booted with.
    ...(gptRef || sovitsRef
      ? { voice_model: { voiceProfileId: String(profile.voiceProfileId || ''), gptRef, sovitsRef, revision: String(profile.updatedAt || '') } }
      : {}),
  };
}

/** Best-effort read of the active profile from S3; null when absent or unreadable. */
export async function readActiveProfileWarmPayload({ getObject, log = () => {} } = {}) {
  if (typeof getObject !== 'function') return null;
  try {
    const body = await getObject(ACTIVE_PROFILE_KEY);
    const payload = warmPayloadFromProfile(JSON.parse(body.toString('utf-8')));
    if (!payload) log('[boot-warm] active profile has no ref_audio_path — cannot warm from it');
    return payload;
  } catch (err) {
    log(`[boot-warm] no active voice profile to warm from: ${err.message}`);
    return null;
  }
}

// Persist the fields warmOnBoot needs to replay a warm. Best-effort: a write failure
// must never break the live warm request that triggered it.
export function recordWarmPayload(payload, {
  statePath = WARM_STATE_PATH,
  fsModule = fs,
  // A reference-only warm (the legacy /ref-audio/warm route) must not erase a
  // record that names the resident weights, or the next boot cannot reclaim them.
  preserveResidentVoice = false,
} = {}) {
  try {
    if (preserveResidentVoice && !payload?.voice_model) {
      const existing = readWarmPayload({ statePath, fsModule });
      if (existing?.voice_model) return false;
    }
    const {
      ref_audio_path, aux_ref_audio_paths = [], text_lang = 'en', warm_text,
      prompt_text, prompt_lang, voice_model, voiceProfileId,
    } = payload || {};
    if (!ref_audio_path) return false;
    fsModule.mkdirSync(path.dirname(statePath), { recursive: true });
    // voice_model is what lets a boot reload the exact weight pair and claim it
    // as residency; without it the boot warm heats whatever the server loaded.
    fsModule.writeFileSync(
      statePath,
      JSON.stringify({
        ref_audio_path, aux_ref_audio_paths, text_lang, warm_text, prompt_text, prompt_lang,
        ...(voice_model && typeof voice_model === 'object' ? { voice_model } : {}),
        ...(voiceProfileId ? { voiceProfileId } : {}),
      }),
    );
    return true;
  } catch {
    return false;
  }
}

let lastRememberedVoiceKey = '';

// Remember the voice this worker now holds, so a restart reloads exactly it.
// Written only when the resident weight pair changes, not on every request.
export function rememberResidentVoice(payload, options = {}) {
  const model = payload?.voice_model;
  if (!model || typeof model !== 'object' || !payload?.ref_audio_path) return false;
  const key = [String(model.gptRef || '').trim(), String(model.sovitsRef || '').trim()].join('|');
  if (key === '|' || key === lastRememberedVoiceKey) return false;
  const written = recordWarmPayload(payload, options);
  if (written) lastRememberedVoiceKey = key;
  return written;
}

export function readWarmPayload({ statePath = WARM_STATE_PATH, fsModule = fs } = {}) {
  try {
    if (!fsModule.existsSync(statePath)) return null;
    const parsed = JSON.parse(fsModule.readFileSync(statePath, 'utf-8'));
    return parsed && parsed.ref_audio_path ? parsed : null;
  } catch {
    return null;
  }
}

// Replay the persisted warm at boot so the first real request after a restart is hot.
// All collaborators are injected so this stays pure and testable and avoids importing
// the heavy inference route graph directly (index.js wires the real deps).
//
// Best-effort throughout: any failure is logged and swallowed — a cold-start is a
// slower first clip, never a crash. Returns true only when a warm synth actually ran.
export async function warmOnBoot({
  readPayload = readWarmPayload,
  readActivePayload = null, // () => Promise<payload|null> — the on-demand profile from S3
  startServer,        // () => Promise<status> — force the python server up (loads default model)
  warmReferences,     // (payload) => Promise<{ ref_audio_path, aux_ref_audio_paths }>
  loadVoiceModel = null, // (payload) => Promise<...> — load this profile's weight pair
  runSynth,           // (body) => Promise<...> — the tiny throwaway synth (handleLiveTtsRequest)
  onWarmed = null,    // (payload) => void — record the warmed weights as this worker's residency
  log = () => {},
} = {}) {
  let payload = readPayload();
  let source = 'persisted payload';
  if (!payload && readActivePayload) {
    payload = await readActivePayload();
    source = 'active voice profile';
  }
  if (!payload) {
    log('[boot-warm] no persisted payload and no active profile — skipping (first load will warm normally)');
    return false;
  }

  try {
    const status = await startServer();
    if (!status?.ready) {
      log('[boot-warm] inference server not ready after start — skipping warm');
      return false;
    }

    // Load the profile's own weights before synthesising. Without this the warm
    // heats whatever model the server booted with, and the first real request for
    // this profile still pays the weight-load cost — the exact cost we are here to
    // remove.
    if (loadVoiceModel && payload.voice_model) {
      await loadVoiceModel(payload);
    }

    const warmed = await warmReferences(payload);
    await runSynth({
      ...payload,
      ref_audio_path: warmed.ref_audio_path,
      aux_ref_audio_paths: warmed.aux_ref_audio_paths,
      text: payload.warm_text || 'Ready.',
      text_lang: payload.text_lang || 'en',
      // Same defaults readInferenceParams would apply; handleLiveTtsRequest skips
      // it, so without these the python /tts rejects the warm with 400.
      prompt_lang: payload.prompt_lang || 'en',
      prompt_text: payload.prompt_text || '',
    });
    // Without this the coordinator sees a worker with no model, answers the first
    // request with "switching" and reloads weights that are already resident.
    if (onWarmed && payload.voice_model) onWarmed(payload);
    log(`[boot-warm] GPU path pre-warmed from ${source}${payload.voiceProfileId ? ` (${payload.voiceProfileId})` : ''}`);
    return true;
  } catch (err) {
    log(`[boot-warm] failed (non-fatal, first request will be cold): ${err.message}`);
    return false;
  }
}
