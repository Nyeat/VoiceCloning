# API Notes

## Lambda REST Surface (`/api/*`)

### Model capacity semantics

- `POST /api/models/select` and `POST /api/voice-profile/capacity` are non-scaling preparation
  checks. They may return `READY`, `WARMING` after idle-worker reassignment, or `ON_DEMAND` when
  the first real synthesis must prepare capacity. Dev may return `SIMULATED` because its coordinator
  has fixed workers and no ASG authority.
- Model switching does not consume a synthesis slot. Initial Fast/Full synthesis uses coordinator
  admission; exact-model contention may use the bounded worker queue. A cold model preparation is
  returned as retryable state rather than holding an HTTP request through GPU boot/model load.

Primary router: `lambda/router.js`

### Config and uploads

- `GET /api/config`
- `POST /api/upload/presign`
- `POST /api/upload/confirm`
- `POST /api/upload-ref/presign`
- `POST /api/upload-ref/confirm`

### Lesson analytics

- `POST /api/analytics/events`
  - Accepts schema version 1 with 1-50 allowlisted lesson events and requires a verified
    Entra token in dev. Immutable gzip NDJSON batches use verified-subject per-user/date/hour
    S3 partitions. The older global archive is retained but is no longer written or scanned.
  - Maintains a 30-day per-concept window with a 14-day evidence half-life and logarithmic
    diminishing returns per signal type. Scores have no hard cap; up to 20 events per signal are
    retained. Long pauses/transcript scrolling do not affect support state; IDs are idempotent.
  - Derived support rules:

    | Qualifying signal | Base weight | Retention | Condition |
    |---|---:|---:|---|
    | Rewatched segment | `0.5` | 20 | A backward seek assigned to the authored concept |
    | Clarification request | `1` | 20 | A delayed repeated/simplification request matched to the same concept |
    | Long pause | `0` | Not counted | Raw engagement analytics only |
    | Transcript scroll | `0` | Not counted | Raw engagement analytics only |

    Fresh score below `0.75` is `no_support_inference`; `0.75-1.54` is `possible_support`;
    and `1.55+` is `support_recommended`. One rewind alone is insufficient; two fresh rewinds
    or one clarification produce possible support, and two fresh clarifications produce
    support recommended. Scores then decay and repeated events add progressively less.
  - Every authenticated non-repeated question adds `concept_question` evidence at
    weight `0.5`. A repeated question receives only the independent weight-`1.0` clarification signal;
    its `question_asked` record remains available for history but is scoring-neutral. Question text is
    bounded to 500 characters in the per-user lake for analytics. The Admin Questions tab reads only
    retained DynamoDB conversation turns; S3 is not queried or merged for that list.
  - The first question establishes the comparison topic and adds no clarification evidence.
    Follow-up clarification detection requires at least eight seconds and the same mounted
    lesson page; refreshing starts a new browser-side comparison sequence. Wait at least ten
    seconds after the final action for the queued batch.
- `GET /api/learner/me?lesson=<slug>`
  - Recalculates and returns only the authenticated user's current rolling summary.
- `GET /api/supervisor/users`
- `GET /api/supervisor/concepts?lesson=<slug>`
  - Supervisor-only cohort ranking. Counts distinct identified learners reaching the maximum
    support threshold per concept and returns the denominator and percentage. Ranking data is
    never included in learner chatbot guidance.
  - Primary rank is distinct learners at score `3`. Learners at `2-3`, then `1-1.99`, are
    tie-breakers only. One learner can contribute at most once to each concept cohort count;
    event totals and summed uncapped scores do not determine rank.
- `GET /api/supervisor/users/<oid>`
  - Require the configured Entra supervisor app role; return profile and summary data.
- `DELETE /api/supervisor/users/<oid>/lessons/<slug>/concepts/<conceptId>`
  - Supervisor-only destructive reset for one learner concept; rebuilds or removes its
    lesson summary.
  - A reset removes derived concept support, not the profile, raw S3 analytics, or stored
    conversation/session rows. The concept row and `LESSON#<slug>#SUMMARY` row are separate
    expected records, not duplicate test results.

### Training library

- `GET /api/training-library`
- `POST /api/training-library/presign`
- `POST /api/training-library/confirm`
- `POST /api/training-library/snapshot`
- `DELETE /api/training-library/:id`
- `POST /api/training-library/:id/replace-presign`
- `POST /api/training-library/:id/replace-confirm`

### Training

- `POST /api/train`
- `POST /api/train/stop`
- `GET /api/train/current`

Notes:

- With `TRAINING_AUTH_REQUIRED=true` (dev + staging) every training route uses the signed-in account as owner
  (`X-VCS-Entra-Token`); typed emails are ignored. `/upload/presign|confirm` only accept the owner's voice.
- `POST /api/train/next-name` allocates the next voice name. `POST /api/train` returns 409 `TRAINING_BUSY` while any
  run is active and forwards `config.testVoiceUrl` (from `TRAINING_PUBLIC_URL`) for the completion email.
- `GET /api/train/current`: owner gets the full run (`mine: true`); others get `{busy, stepsDone, stepsTotal,
  currentStep, startedAt}` only. `POST /api/train/stop` is owner-only (403 otherwise).
- `POST /api/train` requires `expName`.
- Optional training config currently includes `batchSize`, `sovitsEpochs`, `gptEpochs`, `sovitsSaveEvery`, `gptSaveEvery`, `asrLanguage`, `asrModel`, and `skipDenoise`.
- Training SSE currently reports 9 steps and now includes `Extract Speaker Verification` between HuBERT and semantic extraction.

### Models and voice profile

- `GET /api/models`
- `POST /api/models/select`
  - For a cloned `voiceProfileId`, resolves the exact saved GPT/SoVITS/reference snapshot and asks
    the model coordinator to prepare capacity. It no longer sends model preparation through the
    ordinary inference ALB. The response includes `coordinatorCapacity`.
- `POST /api/voice-profile/activate`
- `GET /api/voice-profile/active`
- `POST /api/voice-profile/label` — signed-in owner names a trained voice (2026-11-19). Request
  `{ "voiceName": "cs-name_5", "label": "Lecture voice" }` (label <= 40 chars, cleaned; "" clears). 403 for
  another owner's voice. Stored at `voice-labels/<voiceName>.json`; `/mine` returns it as `label`. Display only.
- `POST /api/voice-profile/capacity` — authenticated lecture-voice preflight (also unsigned for
  LIVE_AUTH_EXEMPT_ORIGINS, i.e. Live MC). STARTING/WARMING answers carry `waitStartedAt` (ms) for the popup timer.
  - Request: `{ "voiceProfileId": "<safe saved profile ID>" }`. Lambda loads the
    saved profile and sends its immutable GPT/SoVITS snapshot to the staging model
    coordinator.
  - `READY`, `READY_SCALING`, and `READY_WARMING` allow conversation. A READY response
    with `capacityTight=true` has one matching slot left; click preflight alone does
    not scale it.
  - `BUSY_STARTING`/`BUSY_WARMING` mean the resident voice is currently full, capacity
    preparation is running, and existing capacity remains usable. `STARTING`/`WARMING`
    mean no resident matching voice is usable yet and block voice conversation.
    `LIMIT`/`BUSY_LIMIT` report the ASG maximum case.
  - Common fields: `canStartConversation`, `availableSlots`, `matchingWorkers`,
    `capacityAction` (`none`, `reassign`, or `scale`), `capacityStarted`,
    `retryAfterSeconds`, and `voiceProfileId`.

#### Lecture voice binding

- `GET /api/chatbot/system-prompt?category=<lecture>` returns the deployed prompt,
  documents, and authoritative published `voiceProfileId`. Authenticated faculty `PUT`
  validates and stores the selected completed trained profile or approved stock voice.
- The published value flows through `LessonPage`, `GiChatPanel`, and `useGiChatEngine` and
  overrides the legacy course/build pin. A cloned profile calls the capacity endpoint and
  coordinator; an `elevenlabs:<id>` stock voice bypasses GPU capacity and uses standard
  synthesis. Unpublished standalone lectures retain the legacy/build fallback.
- Profile resolution currently follows the latest saved profile at request/conversation
  start and creates an immutable in-flight snapshot. Persist a profile revision too if
  published lectures must retain a historical voice definition.

### Inference and live TTS

- `POST /api/inference`
- `POST /api/inference/generate`
  - Initial cloned-voice admission goes through the model coordinator. A free exact-model slot is
    direct; saturated resident capacity enters its bounded priority/FIFO queue while Staging asks
    for another GPU. Follow-up session edit routes remain direct because they operate on durable
    session state rather than creating a new initial admission.
  - Optional Live Full chunk overrides: `max_chunk_words` (10–100; omission keeps the 170-character default) and `max_sentences_per_chunk` (1–5; default 2).
- `GET /api/inference/result/:sessionId`
- `GET /api/inference/chunk/:sessionId/:index` — raw generated chunk used by progressive queue playback
- `GET /api/inference/chunk-preview/:sessionId/:index` — shared-loudness-normalized chunk preview matching the final Full WAV
- `POST /api/inference/regenerate-chunk` — regenerate one saved Full chunk by `sessionId` and `index`, then rebuild previews and the final WAV
- `POST /api/inference/insert-chunk` — synthesize text through the Full quality pipeline, insert it before `index` (`0..chunkCount`), reindex later chunks, then rebuild previews and the final WAV
- `POST /api/inference/delete-chunk` — delete one saved Full chunk by `sessionId` and `index`, reindex the remaining chunks, then rebuild previews and the final WAV; the only remaining chunk cannot be deleted
- `POST /api/inference/cancel`
- `GET /api/inference/current`
- `GET /api/inference/status`
- `POST /api/live/tts-sentence`
  - Cloned voices use the same coordinator and exact-model admission as lecture preflight. Model
    switching/preparation is not a synthesis slot; queued synthesis is a real worker queue slot.
  - A request with reference audio plus complete `voice_model.gptRef` and
    `voice_model.sovitsRef` uses that immutable snapshot without rereading the saved
    profile. A request that provides only `voiceProfileId`, or lacks a complete
    snapshot, still resolves the saved profile normally.
  - Staging timing response headers: `X-VCS-Profile-Resolve-Ms`,
    `X-VCS-Worker-Round-Trip-Ms`, `X-VCS-Lambda-Total-Ms`,
    `X-VCS-Capacity-Retry-Count`, and `X-VCS-Capacity-Retry-Sleep-Ms`.
  - `X-VCS-GPU-Queue-Wait-Ms` is optional; it was not observed through the current
    public Target Optimizer path, so consumers must preserve a missing value as null.

### Audio browsing and transcription

- `POST /api/transcribe`
- `GET /api/training-audio/:expName`
- `GET /api/training-audio/file/:expName/:filename`
- `GET /api/ref-audio`

### GPU instance control

- `GET /api/instance/status[?target=training|inference]` — adds `readinessTarget`, `autoStopMinutes`.
- `POST /api/instance/start`
- `GET /api/instance/idle-check`
- `POST /api/instance/idle-check`

### Learner and admin analytics (dev only)

- `POST /api/analytics/events` — authenticated lesson event ingestion; writes one verified-subject
  per-user S3 batch, then updates qualifying DynamoDB support evidence.
- `GET /api/learner/me?lesson=:slug` — current learner's rule-based support summary.
- `GET /api/supervisor/concepts?lesson=:slug` — admin cohort counts for every authored concept.
- `GET /api/supervisor/users` and `GET /api/supervisor/users/:oid` — admin learner list/detail.
- `GET /api/supervisor/users/:oid/events` — newest stored lesson actions for one learner; max 500
  events / 250 batches, with `truncated=true` when bounded. Never scans the retained global archive.
- `DELETE /api/supervisor/users/:oid/lessons/:slug/concepts/:conceptId` — reset evidence.
- All `/api/supervisor/*` routes require the configured Entra app role or OID allowlist.

## Streaming / Socket Paths

- Training SSE: `/train/progress/:sessionId`
- Inference SSE: `/inference/progress/:sessionId`
- Live WebSocket: `/api/live/chat/realtime`
- Gateway activity: `GET /api/live/session/activity` → `{busy, liveSessions, idleMs, lastActivityAt}` (idle check)
  - First frame `session.init` (`systemPrompt`) may also carry, all optional and validated/clamped by the
    gateway: `turnDetection` (`{type:'server_vad', threshold, silenceMs, prefixMs}` or
    `{type:'semantic_vad', eagerness}`), `noiseReduction` (`near_field`/`far_field`/`off`),
    `transcriptionModel` (`gpt-4o-transcribe` default, `gpt-transcribe`, `gpt-4o-mini-transcribe`),
    `transcriptionPrompt`, `turnEagerness`. Omitted fields keep the gateway default (Live MC sends
    its slider values; other clients send none).

## Main Source Files

- Frontend caller: `client/src/services/api.js`
- Live socket client: `client/src/services/liveChatSocket.js`
- REST router: `lambda/router.js`
- Training worker routes: `gpu-worker/src/routes/`
- Inference worker routes: `gpu-inference-worker/src/routes/`
- Live gateway route: `live-gateway/src/routes/liveChat.js`
