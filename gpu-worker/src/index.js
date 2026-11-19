import express from 'express';
import cors from 'cors';
import { WORKER_PORT, WORKER_HOST } from './config.js';
import trainingRoutes from './routes/training.js';
import transcribeRoutes from './routes/transcribe.js';
import artifactRoutes from './routes/artifacts.js';
import activityRoutes from './routes/activity.js';
import { processManager } from './services/processManager.js';
import { recordTrainingLog } from './services/trainingLogger.js';
import { checkEmailLogin } from './services/emailService.js';
import { buildCorsOriginOption } from './services/corsOrigin.js';
import {
  clearStartupModelCache,
  clearStartupRefAudioCache,
} from './services/startupCleanup.js';

clearStartupRefAudioCache({ log: console.log });
clearStartupModelCache({ log: console.log });

const app = express();

processManager.on('log', ({ sessionId, stream, data }) => {
  recordTrainingLog(sessionId, { stream, data });
});
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
app.use(cors({ origin: buildCorsOriginOption(CORS_ORIGIN) }));
app.use(express.json());

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, service: 'gpu-worker', timestamp: Date.now() });
});

app.use('/', trainingRoutes);
app.use('/', transcribeRoutes);
app.use('/', artifactRoutes);
app.use('/', activityRoutes);

const server = app.listen(WORKER_PORT, WORKER_HOST, () => {
  void checkEmailLogin();
  console.log(`[gpu-worker] Running on http://${WORKER_HOST}:${WORKER_PORT}`);
});

server.timeout = 0;
server.keepAliveTimeout = 0;

process.on('uncaughtException', (err) => console.error('[gpu-worker] UNCAUGHT', err));
process.on('unhandledRejection', (r) => console.error('[gpu-worker] UNHANDLED', r));

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`[gpu-worker] Received ${signal}, shutting down...`);
  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
