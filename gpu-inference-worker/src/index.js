import express from 'express';
import cors from 'cors';
import { WORKER_PORT, WORKER_HOST, WARM_ON_BOOT } from './config.js';
import inferenceRoutes, { handleLiveTtsRequest } from './routes/inference.js';
import modelsRoutes from './routes/models.js';
import artifactRoutes from './routes/artifacts.js';
import activityRoutes from './routes/activity.js';
import coordinatorRoutes from './routes/coordinator.js';
import { inferenceServer } from './services/inferenceServer.js';
import { transcriptionVerifier } from './services/transcriptionVerifier.js';
import { speakerSimilarity } from './services/speakerSimilarity.js';
import { TRANSCRIPTION_VERIFY_ENABLED, SPEAKER_VERIFY_ENABLED } from './config.js';
import { buildCorsOriginOption } from './services/corsOrigin.js';
import {
  clearStartupModelCache,
  clearStartupRefAudioCache,
  clearStartupWorkerTemp,
} from './services/startupCleanup.js';
import { warmOnBoot, readActiveProfileWarmPayload } from './services/bootWarm.js';
import { warmReferenceAudioPaths } from './services/refAudioCache.js';
import { getObject } from './services/s3Storage.js';
import { ensureRequestVoiceModel, modelResidencyKey, readVoiceModelSnapshot } from './services/requestVoiceModel.js';
import { coordinatorState } from './services/coordinatorState.js';

clearStartupRefAudioCache({ log: console.log });
clearStartupModelCache({ log: console.log });
clearStartupWorkerTemp({ log: console.log });

const app = express();

const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
app.use(cors({ origin: buildCorsOriginOption(CORS_ORIGIN) }));
app.use(express.json());

// Liveness for routes that do not require the Python inference server, notably
// /inference/progress/:sessionId, which can relay shared S3 session state.
app.get('/livez', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'gpu-inference-worker',
    timestamp: Date.now(),
  });
});

app.get('/healthz', (_req, res) => {
  const relayOnly = process.env.HEALTH_CHECK_MODE === 'liveness';
  const ready = inferenceServer.ready;
  const healthy = relayOnly || ready;
  res.status(healthy ? 200 : 503).json({
    ok: healthy,
    ready,
    mode: relayOnly ? 'liveness' : 'readiness',
    service: 'gpu-inference-worker',
    timestamp: Date.now(),
  });
});

app.use('/', inferenceRoutes);
app.use('/', modelsRoutes);
app.use('/', artifactRoutes);
app.use('/', activityRoutes);
app.use('/', coordinatorRoutes);

const server = app.listen(WORKER_PORT, WORKER_HOST, () => {
  console.log(`[gpu-inference-worker] Running on http://${WORKER_HOST}:${WORKER_PORT}`);
  // Bring the ASR verification sidecar up at boot so its readiness (or failure)
  // is logged immediately, instead of silently no-op'ing on the first request.
  if (TRANSCRIPTION_VERIFY_ENABLED) {
    transcriptionVerifier.warmup().catch((err) => {
      console.warn(`[transcription] warmup failed: ${err.message}`);
    });
  } else {
    console.log('[transcription] verification DISABLED via TRANSCRIPTION_VERIFY_ENABLED');
  }
  if (SPEAKER_VERIFY_ENABLED) {
    speakerSimilarity.warmup().catch((err) => {
      console.warn(`[speaker] warmup failed: ${err.message}`);
    });
  } else {
    console.log('[speaker] similarity gate DISABLED via SPEAKER_VERIFY_ENABLED');
  }
  // Optional boot-time GPU pre-warm so the first request after a bare restart (no
  // model reload) is hot. OFF unless WARM_ON_BOOT is set — it force-starts python.
  if (WARM_ON_BOOT) {
    warmOnBoot({
      readActivePayload: () => readActiveProfileWarmPayload({ getObject, log: console.log }),
      startServer: () => inferenceServer.start(),
      warmReferences: (payload) => warmReferenceAudioPaths(payload),
      loadVoiceModel: (payload) => ensureRequestVoiceModel(payload),
      runSynth: handleLiveTtsRequest,
      onWarmed: (payload) => {
        const modelKey = modelResidencyKey(payload);
        if (modelKey) {
          coordinatorState.assign({
            modelKey,
            voiceProfileId: readVoiceModelSnapshot(payload).voiceProfileId,
            source: 'boot',
          });
        }
      },
      log: console.log,
    }).catch((err) => console.warn(`[boot-warm] unexpected: ${err.message}`));
  }
});

server.timeout = 0;
server.keepAliveTimeout = 0;

process.on('uncaughtException', (err) => console.error('[gpu-inference-worker] UNCAUGHT', err));
process.on('unhandledRejection', (r) => console.error('[gpu-inference-worker] UNHANDLED', r));

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[gpu-inference-worker] Received ${signal}, shutting down...`);
  inferenceServer.stop();
  server.close(() => { process.exit(0); });
  setTimeout(() => { process.exit(1); }, 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
