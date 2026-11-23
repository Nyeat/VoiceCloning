import path from 'path';
import { listObjects } from '../shared/s3.js';
import { inferencePost, inferenceGet } from '../shared/gpuWorker.js';
import { loadModelPair, useGpuWorkerModels } from '../shared/modelSelection.js';
import { createVoiceProfileResolver } from '../shared/voiceProfileRuntime.js';
import {
  prepareCoordinatedModel, siteOwnerOption,
} from '../shared/modelCoordinator.js';
import { studioRequestAccess } from '../shared/studioGpuGuard.js';
import { createLiveAuthGuard } from '../shared/liveAuth.js';
import { ok, err, preflight, parseJsonBody } from '../shared/cors.js';
import { readVoiceLabels } from '../shared/voiceLabels.js';

function isWorkerUnavailableError(error) {
  const message = error?.message || '';
  return error instanceof TypeError
    || /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|GPU_WORKER_URL env var|INFERENCE_WORKER_URL/u.test(message);
}

export function toModelSummary(object) {
  const lastModified = object.lastModified instanceof Date
    ? object.lastModified.toISOString()
    : object.lastModified || null;
  const mtimeMs = object.lastModified instanceof Date
    ? object.lastModified.getTime()
    : Date.parse(object.lastModified || '');

  return {
    name: path.basename(object.key),
    key: object.key,
    path: object.key,
    ...(typeof object.size === 'number' ? { size: object.size } : {}),
    ...(lastModified ? { lastModified } : {}),
    ...(Number.isFinite(mtimeMs) ? { mtimeMs } : {}),
  };
}

export function createHandler({
  loadPair = loadModelPair,
  resolveSynthesisBody = createVoiceProfileResolver(),
  prepareModel = prepareCoordinatedModel,
  authGuard = createLiveAuthGuard(),
  studioAccess = studioRequestAccess,
  voiceLabels = readVoiceLabels,
} = {}) {
  return async function handler(event) {
    if (event.requestContext?.http?.method === 'OPTIONS') {
      return preflight();
    }

    const method = event.requestContext?.http?.method;
    const routePath = event.rawPath || '';

    try {
      if (method === 'GET' && routePath.endsWith('/models')) {
        // Saved voice names, so every voice picker shows "Lecture voice" rather than cs-name_7.
        const labels = voiceLabels().catch(() => ({}));
        if (useGpuWorkerModels()) {
          try {
            return ok({ ...(await inferenceGet('/models')), labels: await labels });
          } catch (error) {
            if (!isWorkerUnavailableError(error)) throw error;
            return ok({
              gpt: [],
              sovits: [],
              workerAvailable: false,
              message: error.message,
              labels: await labels,
            });
          }
        }

        const [gptObjects, sovitsObjects] = await Promise.all([
          listObjects('models/user-models/gpt/'),
          listObjects('models/user-models/sovits/'),
        ]);
        const gpt = gptObjects
          .filter((object) => object.key.endsWith('.ckpt'))
          .map(toModelSummary);
        const sovits = sovitsObjects
          .filter((object) => object.key.endsWith('.pth'))
          .map(toModelSummary);
        return ok({ gpt, sovits, labels: await labels });
      }

      if (method === 'POST' && routePath.endsWith('/models/select')) {
        let body;
        try {
          body = parseJsonBody(event);
        } catch {
          return err(400, 'Invalid JSON body');
        }
        const voiceProfileId = String(body.voiceProfileId || '').trim();
        // Voice Studio: only voices this person may use now, on their own GPU
        // (super users: the QC GPU; a lecturer in their slot: the slot GPU).
        const { refusal, ownerKey: studioOwner } = await studioAccess(event, { authGuard, voiceProfileId });
        if (refusal) return err(refusal.status, refusal.message, event);
        if (voiceProfileId && String(process.env.MODEL_COORDINATOR_FUNCTION_NAME || '').trim()) {
          const synthesisBody = await resolveSynthesisBody({
            voiceProfileId,
            text: 'Voice preparation check.',
            ref_audio_path: String(body.ref_audio_path || '').trim(),
            aux_ref_audio_paths: Array.isArray(body.aux_ref_audio_paths) ? body.aux_ref_audio_paths : [],
            voice_model: {
              voiceProfileId,
              gptRef: String(body.gptKey || body.gptPath || '').trim(),
              sovitsRef: String(body.sovitsKey || body.sovitsPath || '').trim(),
            },
          });
          const loaded = {
            gptPath: String(body.gptKey || body.gptPath || synthesisBody.voice_model?.gptRef || ''),
            sovitsPath: String(body.sovitsKey || body.sovitsPath || synthesisBody.voice_model?.sovitsRef || ''),
          };
          const resolvedReferences = {
            ref_audio_path: String(synthesisBody.ref_audio_path || ''),
            aux_ref_audio_paths: Array.isArray(synthesisBody.aux_ref_audio_paths)
              ? synthesisBody.aux_ref_audio_paths
              : [],
            prompt_text: String(synthesisBody.prompt_text || ''),
            prompt_lang: String(synthesisBody.prompt_lang || ''),
          };
          if (body.prepareCapacity === false) {
            return ok({
              message: 'Voice selected; GPU capacity will be prepared by synthesis',
              loaded,
              resolvedReferences,
              selectionOnly: true,
            });
          }
          // Selecting a voice prepares it. The coordinator still short-circuits
          // on a live reassignment or pending boot for this model, so scaling
          // happens only when no matching slot, no warming GPU and no idle GPU
          // can serve the selection.
          // Training site: one person, one GPU (their other voice's GPU switches).
          const coordinatorCapacity = await prepareModel(synthesisBody, {
            allowScale: true,
            source: 'models-select',
            // Every site's GPU has an owner; only that owner switches it.
            ...await siteOwnerOption(event, { authGuard, studioOwner, voiceProfileId }),
          });
          return ok({
            message: coordinatorCapacity.canStartConversation
              ? 'Voice capacity is ready'
              : 'Voice capacity is preparing',
            loaded,
            resolvedReferences,
            coordinatorCapacity,
          });
        }
        if (!String(body.gptPath || body.gptKey || body.sovitsPath || body.sovitsKey || '').trim()) {
          return err(400, 'voiceProfileId, gptPath or sovitsPath is required');
        }
        return ok(await loadPair(body));
      }

      return err(404, 'Not found');
    } catch (error) {
      return err(500, error.message);
    }
  };
}

export const handler = createHandler();
