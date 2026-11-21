# Setup Notes

## Package Roots

These folders each have their own `package.json` and should be installed separately:

- `client/`
- `lambda/`
- `gpu-worker/`
- `gpu-inference-worker/`
- `live-gateway/`

## Useful Commands

### Frontend

- Local dev: `npm run dev`
- Training-only build: `npm run build:training`
- Live Fast build: `npm run build:live-fast`

Notes:

- Vite proxy target defaults to `http://localhost:3000` in `client/vite.config.js`.
- Local proxy covers `/api`, `/train/progress`, and `/inference/progress`.

### Lambda

- Tests: `npm test`
- Packaging script: `npm run package:function-url`

### Live Gateway

- Dev/watch: `npm run dev`
- Tests: `npm test`

### GPU Workers

- Training worker: `npm start` in `gpu-worker/`
- Inference worker: `npm start` in `gpu-inference-worker/`

## Local Environment Expectations

- Full local training/inference still depends on external runtime configuration and GPT-SoVITS availability.
- Current training flow expects the GPT-SoVITS install used by `gpu-worker/` to include the `v2ProPlus` assets and `prepare_datasets/2-get-sv.py`.
- The GPU worker config now also expects the speaker-verification checkpoint at `GPT_SoVITS/pretrained_models/sv/pretrained_eres2netv2w24s4ep4.ckpt`.
- For cloud-connected frontend work, the repo docs use the Vite app locally while pointing API/SSE/WSS traffic at deployed cloud infrastructure.

## Detailed Repo Docs

- `docs/lambda-serverless-gpu-worker-guide.md`
- `docs/containerization-images-split.md`
- `docs/external-chatbot-handoff.md`

Historical only:

- `CLOUD_FRONTEND_FLOW_README(Outdated).md`
- `docs/complete_ai_handoff(Outdated).md`
- `docs/gpu-ec2-from-scratch-setup(Outdated).md`

## Voice Studio email (2026-11-21)
- Gmail SMTP: EMAIL_HOST=smtp.gmail.com, EMAIL_PORT=465, EMAIL_USER/EMAIL_FROM in lambda/.env.deployment*.
- EMAIL_PASS = Gmail app password (https://myaccount.google.com/apppasswords, needs 2-Step Verification), set only on
  the live Lambda: `.scriptsset-email-password.ps1 -Env staging` (hidden prompt, merges env). Test: overview button.
