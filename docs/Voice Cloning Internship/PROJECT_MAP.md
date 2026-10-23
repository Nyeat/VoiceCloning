# Voice Cloning Project Map

## Project Memory Mirroring

- Primary vault: `C:\Users\User\Downloads\PC_SYNC\Projects\Voice Cloning Internship`
- Git mirror: `docs/Voice Cloning Internship` in the VoiceCloning repository.
- Apply every project-memory edit identically to both locations and verify parity.

## Start Here

- Frontend entry and routes: `client/src/App.jsx`; GI `/admin` routes: `client/src/GiApp.jsx`
- REST router: `lambda/router.js`
- Training worker entry: `gpu-worker/src/index.js`
- Inference worker entry: `gpu-inference-worker/src/index.js`
- Live WebSocket gateway entry: `live-gateway/src/index.js`

## Frontend (`client/`)

- `src/App.jsx`
  - User-facing routes are Training (`/`) and Live Fast (`/live-fast`).
  - Owns the GPU start/status button.
- `src/pages/TrainingPage.jsx`
  - Upload training audio, start/stop training, read training state.
- `src/pages/LivePage.jsx`; `src/pages/McSessionPage.jsx` (+ `src/lib/mcSession.js`) — staging-only Live MC page, build mode `mc`
  - Live chatbot UI, model selection, trained reference selection, cloned voice playback, Text to Speech tab, pronunciation admin panel.
- `src/pages/SupervisorDashboardPage.jsx` — dev `/admin` graph ranking and learner evidence; S3 index/evidence replays: `scripts/backfill-analytics-user-index.mjs`, `scripts/backfill-learner-evidence.mjs`.
- `src/hooks/useSSE.js` — Nine-step training SSE including speaker verification.
- `src/hooks/useInferenceSSE.js` — Long-text inference SSE.
- `src/hooks/useLiveSpeech.js` (mic capture: `src/lib/micCapture.js`, `src/lib/micResampler.js`)
  - Mic capture, streamed first-sentence TTS, cloned reply playback, barge-in behavior.
- `src/hooks/liveConversation.js`
  - Pure helpers for phrase splitting, playback selection, language-specific TTS params.
- `src/services/api.js` — REST client with signed JSON mutation support.
- `src/services/liveChatSocket.js` — WebSocket client for `/api/live/chat/realtime`.
- `src/lib/runtimeConfig.js`
  - Resolves API paths; `src/lib/appMode.js` handles split-build gating.
- `src/lib/referenceSelection.js`
  - Auto-picks primary and auxiliary reference clips from training audio.
  - Scoring now prefers clean names/transcripts and ideal clip length (~3-9s).
- `src/lib/pronunciationCsv.js` — Pronunciation dictionary CSV import/export.
- `vite.config.js`
  - Local dev server and proxy rules for `/api`, `/train/progress`, `/inference/progress`.

## Lambda REST Backend (`lambda/`)

- `index.js`
  - Lambda entrypoint.
- `router.js`
  - Maps `/api/*` routes to feature handlers.
- `config/`
  - Frontend runtime/storage mode config.
- `upload/`
  - Presign + confirm flows for training and reference audio.
- `training-library/`
  - Shared training file library CRUD + snapshot flows.
- `training/`
  - Start, stop, current training state.
- `models/`
  - Model list + model selection/loading orchestration.
- `inference/`
  - Long-text and synchronous inference flows, including inference start proxy.
- `pronunciation-dictionary/`
  - English custom pronunciation entry storage API backed by S3 category JSON files.
- `live/`
  - Fast short-phrase TTS endpoint for Live Fast mode.
- `transcribe/`
  - Reference audio transcription.
- `training-audio/`
  - Training clip and reference-audio browsing URLs.
- `voice-profile/`
  - Active voice profile selection/runtime helpers.
- `instance/`
  - GPU EC2 status, start, idle-check.
- `shared/`
  - Cross-cutting helpers for CORS, paths, S3, worker calls, artifacts, model selection.

## GPU Services

### Training Worker (`gpu-worker/`)

- `src/index.js`
  - Express server on port `3001`.
- `src/routes/training.js`
  - Training session start/stop/current + progress SSE.
- `src/routes/transcribe.js`
  - Worker-side transcription.
- `src/routes/artifacts.js`
  - Training audio and output artifact access.
- `src/routes/activity.js`
  - Busy/idle reporting for idle-stop logic.
- `src/services/`
  - Training pipeline, process management, SSE, S3 sync/storage, startup cleanup.
- `scripts/score_clips.py`
  - Standalone audio-quality scorer for ranking reference clips by cleanliness and usable length.

### Inference Worker (`gpu-inference-worker/`)

- `src/index.js`
  - Express server on port `3003`.
- `src/routes/inference.js`
  - Model readiness, synchronous inference, generation, cancel/current/progress.
- `src/services/textPronunciation.js`
  - Shared English normalization before synthesis.
- `src/services/runtimePronunciationDictionary.js`
  - Loads S3 admin pronunciation entries, applies readable overrides, and syncs ARPAbet entries into GPT-SoVITS `engdict-hot.rep`.
- `pronunciation/engdict-hot.additions.rep`
  - Version-controlled English hot-dictionary additions copied into GPT-SoVITS during deployment/startup.
- `scripts/sync_datamuse_pronunciations.js`
  - Free Datamuse maintenance sync for curated complex terms in `pronunciation/datamuse-terms.txt`.
- `src/routes/models.js`
  - Model listing and load/download flow.
- `src/routes/artifacts.js`
  - Result audio and reference/training artifact access.
- `src/routes/activity.js`
  - Inference activity state for idle-stop logic.

### Live Gateway (`live-gateway/`)
- `src/index.js`
  - Express + WebSocket host on port `3002`.
- `src/routes/liveChat.js`
  - Browser-facing `/api/live/chat/realtime` route.
- `src/services/openaiRealtimeBridge.js`
  - Backend WebSocket bridge to OpenAI Realtime.
- `src/services/openaiRealtimeEvents.js`
  - Session prompt/session event mapping.
- `src/services/textPreprocessor.js`
  - Assistant text cleanup before cloned TTS.
## Deployment / Infra Files
- `CLOUD_FRONTEND_FLOW_README(Outdated).md`
  - Historical browser -> CloudFront -> Lambda/ALB flow notes; no longer the current source of truth.
- `docs/complete_ai_handoff(Outdated).md`
  - Historical live chatbot deployment handoff.
- `docs/containerization-images-split.md`
  - Notes on the split container/runtime shape.
- `docs/external-chatbot-handoff.md`
  - Current chatbot integration handoff notes.
- `docs/lambda-serverless-gpu-worker-guide.md`
  - Detailed Lambda + ALB + EC2 deployment guide.
- `docker/gpu-worker/entrypoint.sh`
  - GPU worker container entrypoint.
- `docker/gpu-inference-worker/entrypoint.sh`
  - GPU inference worker container entrypoint.
- `systemd/gpu-inference-worker.service` — Checked-in inference worker unit.
- `systemd/target-optimizer-inference.service`
  - Pinned ALB Target Optimizer proxy; reads inference concurrency and exposes
    data/control ports 3103/3004.
- `scripts/deploy-client.ps1` / `scripts/deploy.config.json` — environment-aware GI build/deployment map, CloudFront, and S3 targets.
- `scripts/load-test-staging-chatbot.mjs` / `scripts/load-test-staging-tts.mjs`
  - Complete WebSocket-to-DeanVoice and closed-loop public TTS load rehearsals;
    capture keepalive, first-audio/completion, and backend timing evidence.
- `scripts/ensure-staging-live-gateway.ps1` / `scripts/set-staging-alb-idle-timeout.ps1`
  - Gateway health/start and admin-only ALB idle-timeout operations.
- `scripts/wait-staging-event-ready.ps1`
  - Requires capacity, target health, and fresh per-target public-prime evidence.
- `scripts/warm-staging-deanvoice.sh`
  - Loads the pinned model/references and validates the real TTS route before optimizer startup.
- `scripts/provision-staging-autoscaling.ps1` / `scripts/set-staging-asg-daily-schedule.ps1` / `scripts/staging-autoscaling.config.json`
  - Staging ASG provisioning plus its recurring 07:00/19:00 schedule. NOT a scale-to-zero: both live
    actions set `MinSize=1, MaxSize=192` and leave desired unchanged, so staging keeps one g6.xlarge
    running 24/7 (`offHoursMinCapacity: 1`). Verified live 2026-08-31.
- `docs/voice-model-evaluation.md` / `scripts/clone-bench/` — Oct 2026 TTS model shortlist, hosting plan, SIM+WER scorer.
- `docs/staging-architecture.md`
  - Authoritative live staging/dev resource map, rollout state, tests, and permissions.
- `docs/dev-environment-duplication-guide.md`
  - Current dev/staging boundary summary; the former duplication proposal is superseded.
## Good First Reads By Task
- Training flow issue:
  - `client/src/pages/TrainingPage.jsx`
  - `lambda/training/index.js`
  - `gpu-worker/src/routes/training.js`
- Live chatbot / pause / phrase playback issue:
  - `client/src/pages/LivePage.jsx`
  - `client/src/hooks/useLiveSpeech.js`
  - `client/src/hooks/liveConversation.js`
  - `live-gateway/src/routes/liveChat.js`
  - `live-gateway/src/services/openaiRealtimeEvents.js`
- Text to Speech / pronunciation issue:
  - `client/src/pages/LivePage.jsx`
  - `client/src/services/api.js`
  - `gpu-inference-worker/src/services/textPronunciation.js`
  - `gpu-inference-worker/src/services/runtimePronunciationDictionary.js`
  - `gpu-inference-worker/pronunciation/engdict-hot.additions.rep`
  - `lambda/pronunciation-dictionary/index.js`
- Model selection / voice profile issue:
  - `client/src/services/api.js`
  - `client/src/lib/referenceSelection.js`
  - `lambda/models/index.js`
  - `lambda/voice-profile/index.js`
  - `gpu-inference-worker/src/routes/models.js`
- Training quality / reference quality issue:
  - `client/src/pages/TrainingPage.jsx`
  - `client/src/hooks/useSSE.js`
  - `client/src/lib/referenceSelection.js`
  - `lambda/training/index.js`
  - `gpu-worker/src/config.js`
  - `gpu-worker/src/services/pipeline.js`
  - `gpu-worker/scripts/score_clips.py`
- Deployment / routing issue: `docs/lambda-serverless-gpu-worker-guide.md`
- Zero-shot lab: scripts/clone-bench/app.py, catalog.py, install_lab.py, run_model.py, start_lab.sh; smoke_lab.py, verify_lab.py and test_lab.py verify compatibility.
