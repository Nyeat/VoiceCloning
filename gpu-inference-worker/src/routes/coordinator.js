import { Router } from 'express';
import { activityState } from '../services/activityState.js';
import { coordinatorState, registrationConflicts } from '../services/coordinatorState.js';
import { inferenceServer } from '../services/inferenceServer.js';
import { modelResidencyKey, readVoiceModelSnapshot, ensureRequestVoiceModel } from '../services/requestVoiceModel.js';
import { warmReferenceAudioPaths } from '../services/refAudioCache.js';
import { synthesisScheduler } from '../services/synthesisScheduler.js';
import { hasActiveInferenceSession } from '../services/longTextInference.js';
import { handleLiveTtsRequest } from './inference.js';
import { rememberResidentVoice } from '../services/bootWarm.js';

const router = Router();

function authorized(req) {
  const expected = String(process.env.MODEL_COORDINATOR_AUTH_TOKEN || '').trim();
  const actual = String(req.get('X-VCS-Coordinator-Token') || '').trim();
  return Boolean(expected && actual && actual === expected);
}

function statusPayload(now = Date.now()) {
  const queue = synthesisScheduler.getStats();
  const lastActivityAt = activityState.getLastActivityAt();
  return {
    ok: true,
    ...coordinatorState.snapshot(),
    ready: inferenceServer.ready && !coordinatorState.draining,
    active: queue.active,
    queued: queue.queued,
    maxSlots: queue.maxConcurrency,
    lastActivityAt,
    idleMs: Math.max(0, now - lastActivityAt),
    loaded: inferenceServer.getLoadedWeights(),
  };
}

router.get('/coordinator/status', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Coordinator authorization failed' });
  return res.json(statusPayload());
});

router.post('/coordinator/register', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Coordinator authorization failed' });

  const payload = req.body?.synthesisBody;
  const requestedKey = modelResidencyKey(payload);
  if (!payload?.ref_audio_path || !requestedKey) {
    return res.status(400).json({ error: 'A complete synthesisBody with model weights and reference audio is required' });
  }
  const before = statusPayload();
  if (!before.ready || before.active > 0 || before.queued > 0) {
    return res.status(409).json({ error: 'Worker is not idle and ready for residency registration', status: before });
  }
  // A boot pre-warm residency is provisional: the boot warm script loads the
  // pinned voice afterwards and must be able to register it.
  if (registrationConflicts(before, requestedKey)) {
    return res.status(409).json({ error: 'Worker already has a different registered model', status: before });
  }
  const model = readVoiceModelSnapshot(payload);
  coordinatorState.assign({ modelKey: requestedKey, voiceProfileId: model.voiceProfileId });
  return res.json({ registered: true, status: statusPayload() });
});

router.post('/coordinator/assign', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Coordinator authorization failed' });

  const payload = req.body?.synthesisBody;
  const requestedKey = modelResidencyKey(payload);
  if (!payload?.ref_audio_path || !requestedKey) {
    return res.status(400).json({ error: 'A complete synthesisBody with model weights and reference audio is required' });
  }

  const before = statusPayload();
  const requiredIdleMs = Math.max(0, Number(req.body?.requiredIdleMs) || 0);
  const changingModel = Boolean(before.modelKey && before.modelKey !== requestedKey);
  if (before.active > 0 || before.queued > 0 || hasActiveInferenceSession()) {
    return res.status(409).json({ error: 'Worker is busy and cannot be reassigned', status: before });
  }
  if (changingModel && before.idleMs < requiredIdleMs) {
    return res.status(409).json({
      error: 'Worker has not been idle long enough for reassignment',
      retryAfterMs: requiredIdleMs - before.idleMs,
      status: before,
    });
  }
  if (!coordinatorState.beginDrain()) {
    return res.status(409).json({ error: 'Worker is already changing models', status: before });
  }

  try {
    await inferenceServer.start();
    await ensureRequestVoiceModel(payload);
    const warmed = await warmReferenceAudioPaths(payload);
    await handleLiveTtsRequest({
      ...payload,
      ref_audio_path: warmed.ref_audio_path,
      aux_ref_audio_paths: warmed.aux_ref_audio_paths,
      text: payload.warm_text || 'Ready.',
      text_lang: payload.text_lang || 'en',
      prompt_lang: payload.prompt_lang || 'en',
      prompt_text: payload.prompt_text || '',
    });
    const model = readVoiceModelSnapshot(payload);
    coordinatorState.assign({ modelKey: requestedKey, voiceProfileId: model.voiceProfileId });
    rememberResidentVoice({ ...payload, ref_audio_path: warmed.ref_audio_path, aux_ref_audio_paths: warmed.aux_ref_audio_paths });
    activityState.mark();
    return res.json({ assigned: true, warmed: true, status: statusPayload() });
  } catch (error) {
    return res.status(500).json({ error: error.message, assigned: false });
  } finally {
    coordinatorState.finishDrain();
  }
});

export default router;
