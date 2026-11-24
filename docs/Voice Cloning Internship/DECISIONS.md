# Technical Decisions

## Architecture

- Live MC turn-taking (2026-10-06): server VAD (threshold 0.5, 700ms silence, 500ms prefix, far-field
  noise reduction) sent per session via `session.init`; chosen from `scripts/vad-bench-mc.mjs` because
  semantic VAD's 3-5s tail felt broken on stage. Defaults: 0.7s pause, threshold 0.65 + far-field
  (user sliders adjust). Turn-based is strictly half duplex (a reply is never cancelled); continuous is
  full duplex and OpenAI's VAD drives barge-in. Transcript bubbles use gpt-4o-transcribe with no prompt
  (context prompts leak). Other live clients keep the gateway default until re-measured.
- Capacity preparation and synthesis admission are distinct. Voice selection and page preflight may
  route or reassign existing idle capacity but must never increase ASG desired capacity. Only a real
  synthesis admission or an explicitly authorized event-prewarm request may scale. Model warming
  reserves a worker but does not claim a synthesis slot or enter the TTS queue.
- TTS and Faculty dropdown selection is metadata-only: resolve and pin the immutable model/reference
  snapshot, but do not prepare or switch a GPU. Lecture opening retains non-scaling preflight because
  it deliberately gates conversation readiness before the learner starts.
- Event prewarm protects a minimum resident pool for the event voice. The oldest matching workers up
  to that minimum are unavailable for other-model reassignment; capacity above the minimum remains
  reusable so the lock does not freeze the whole fleet or prevent scale-in.
- Filling the final free slot is not unmet demand and must not by itself launch overflow. Scale-out
  begins only when a synthesis request is actually queued/rejected or event prewarm explicitly asks
  for capacity. Coordination rows in the shared DynamoDB table are environment-scoped; Dev and
  Staging may share storage but never pending boots, reassignments, demand leases, or event locks.
- Lecture preflight has a 30-second preparation-only residency grace to stop two polling pages from
  switching one idle GPU back and forth. Real synthesis keeps immediate idle reassignment; the grace
  is not a synthesis slot, queue entry, user priority, or long-lived model pin.

- The app is split into separate runtime roles instead of one monolith:
  - `lambda/` handles browser-facing REST orchestration.
  - `gpu-worker/` handles training-oriented GPU work.
  - `gpu-inference-worker/` handles model loading and inference-oriented GPU work.
  - `live-gateway/` owns the browser WebSocket and OpenAI Realtime bridge.

## Frontend Deployment Shape

- The deployed frontend is expected to use same-origin CloudFront paths rather than calling raw backend origins directly.
- `/api/*` goes through Lambda Function URL.
- Browser SSE and the live WebSocket go through the GPU ALB.
- Entra tokens for authenticated Lambda REST calls use `X-VCS-Entra-Token`, not `Authorization`:
  Lambda-origin OAC always signs with SigV4 and owns the standard header. Gateway/WebSocket auth
  keeps its bearer/frame transport because those paths do not traverse Lambda OAC.

## Storage Model

- S3 is the canonical shared storage for uploaded audio, training assets, and model artifacts.
- GPU EC2 local disk is treated as working cache/scratch space, not source of truth.

## Lesson Behavior Analytics

- Dev GI uses same-origin Lambda ingestion with small client batches written as
  gzip NDJSON under hourly S3 partitions. Firehose/Kinesis is deferred until measured
  volume requires buffering; Glue/Athena and a dashboard are separate query-layer work.
- Current batches are session-anonymous and exclude mock-auth identity. Future SSO
  identity must be derived from a backend-validated token, not a browser field.
- The dev-first identified design is implemented locally: Lambda validates the token,
  writes only verified `oid` as the analytics subject, maps video times through an authored
  lesson concept map, and aggregates cautious evidence in a dev-only DynamoDB table.
- Learner summaries use conservative support-signal thresholds and may use a structured OpenAI response;
  API failure or missing credentials falls back to deterministic wording. The chatbot gets
  only the compact summary, never another user's history or an unsupported formal grade.
- Derived support signals are per learner, lesson, and concept in a rolling 30-day window.
  Rewinds contribute `0.5` at most twice and clarification requests contribute `1` at most
  twice; the internal support score caps at `3` and retained qualifying count caps at four.
  Long pauses and transcript scrolling remain only in the immutable event log and contribute
  nothing to the support state. Event IDs are idempotent and reads recalculate recency.
  Positive mastery remains unimplemented until a trustworthy correctness signal exists.
- Supervisor reads require an Entra `Supervisor` app role (with an explicit OID allowlist
  only as a temporary provisioning bridge), and query a user index rather than scanning.
  Supervisors may reset one learner concept; the backend rebuilds the affected summary.
- Rewinds, skips, and long transcript pauses are ambiguous signals. They may calibrate
  a relevant chatbot answer or prompt a check for understanding, but cannot establish
  that a learner is confused, clear, attentive, or has mastered the material.
- Explanation style is separate from concept support. A detailed current-turn request such as
  “explain like I am nine while preserving medical terms” must be followed as written; a
  generic simplification request supports only generic simplification. Persistent style
  preferences require a separate learner-controlled model and are future work, alongside
  learner confirmation prompts and concept knowledge checks.
- Concept ranking is supervisor presentation only. The chatbot ignores `focusConcepts`, receives
  every concept with a current support state, first resolves the concept in the current question,
  and applies only the matching entry; an
  unrelated higher-ranked concept must never redirect the answer.
- Supervisor cohort ranking counts distinct identified learners per concept. Primary rank is the
  number reaching the current maximum support-signal score (`3`); support-recommended and possible-
  support learner counts break ties. Event volume and uncapped score sums never determine rank.
  Report the learner denominator and percentage, and describe this as support signals rather than
  proven uncertainty or objective concept difficulty.

## Pronunciation Dictionary

- Admin pronunciation entries require ARPAbet. Legacy `readable` fields remain ignored, but an optional validated `synthesisAlias` may rewrite one exact saved word into a reviewed multi-part English spelling. ASR must verify the rewritten tokens, and strict phoneme mode must score the full alias span against the entry's ARPAbet so aliases cannot bypass verification.
- Category is organizational metadata, not part of pronunciation identity. A normalized English word has one global entry; saving moves/replaces it across categories and runtime defensively selects the newest legacy record.

## Live Audio Strategy

- OpenAI Realtime is used for text conversation/transcription behavior.
- GPT-SoVITS is the only audible assistant voice in Live Fast.
- The staging Lambda eagerly initializes the Live handler at 512 MB. GI freezes the
  active profile's GPT/SoVITS refs into each conversation so synthesis does not reread
  S3 per clip. This is payload-driven rather than a global resolver bypass: regular
  Live Fast/Full already supplies its selected-model snapshot, while ID-only direct
  inference/TTS callers continue through saved-profile resolution. Provisioned
  concurrency/versioned aliases remain optional future work.
- Live Fast playback is phrase-based, so punctuation quality in assistant text is operationally important.
- The first Live Fast/chatbot reply clip deliberately sets `skip_verify=true` to
  protect time-to-first-audio (`6cd6de0`, backend support `4e37c58`). This bypasses
  ASR/phoneme/speaker verification for that first clip only; later clips retain live
  verification and Live Full/Queue remains fully verified. This is distinct from a
  missing verification dependency. Public-prime probes no longer use `skip_verify`.
- In staging Live Fast phrase mode, a multi-sentence reply may begin TTS after a
  conservative streamed boundary: the first sentence is complete and following
  sentence text has begun. This avoids speaking unstable punctuation. Single-sentence,
  Live Full, and non-phrase replies retain completion-based behavior.

## Multi-user GPU Strategy

- Voice/model identity is immutable per request and per active browser conversation;
  a global UI/profile change must never mutate an in-flight user's voice.
- The inference worker owns one bounded scheduler. Same-model work may use the tested
  physical concurrency (currently 2 on g6.xlarge); model changes are atomic and wait
  for the active batch to drain.
- Full-inference session state, events, chunks, cancellation, and final artifacts use
  S3 as shared state so any horizontally-routed target can continue the session.
- Training remains a separate serial queued service on the fixed training target.
- One coordinator owns cloned-model preparation and initial synthesis admission for lectures,
  TTS, and Faculty. Live Fast, synchronous Full, and initial asynchronous Full use it; Full session
  follow-up edits stay on the durable session-aware path.
- When an exact resident model has no free slot, the coordinator admits work to that worker's
  bounded priority/FIFO queue and asks for overflow capacity concurrently. It never switches a busy
  worker to another model. Matching work packs onto older workers first so newer overflow workers can
  become idle and scale in.
- Dev runs the same decision code in `routing-only` mode over two explicit fixed instance IDs. It
  performs no ASG, start, stop, or instance-protection action and reports the Staging action it would
  have taken. Staging alone runs `autoscale` mode.
- Staging scales one shared EC2 inference ASG through the model coordinator. There is
  no ASG or minimum GPU per voice. Legacy ALB occupancy scale-out alarms are telemetry
  only; SageMaker endpoint migration remains deferred.
- Capacity choice is ordered: matching READY free slot; otherwise a different-model
  worker with zero active/queued work and at least five minutes of both worker and
  resident-model demand idleness; otherwise ASG desired +1, capped at 192. DynamoDB
  conditional ownership deduplicates reassignment and scale requests. New instances
  claim the oldest pending model and deep-warm it; unclaimed baseline boots use Dean.
- Lecture click prepares capacity but does not scale while any matching slot is free.
  After real synthesis admission, the coordinator scales or reassigns only when a
  worker is live-saturated and a fresh fleet read confirms no matching free slot.
  Idle scale-in removes capacity after the configured fifteen-minute inactivity window.
- Treat capacity admission and network transit as separate latency domains. The final
  150-user first-turn p95 was dominated by retry backoff, while two later maxima were
  mostly outside Lambda. Scale on high-resolution capacity pressure; use client and
  edge timing to investigate transit. Provisioned concurrency addresses neither.
- Faculty publishing stores a validated `voiceProfileId` in the authenticated deployed
  lecture-category record. The lecture loads that binding with its prompt/documents and
  gives it precedence over legacy course/build fallbacks. Standard `elevenlabs:` voices
  bypass GPU capacity; cloned profiles resolve to an immutable snapshot and use the
  coordinator. The browser is never the authority for the mapping.
- The saved profile is resolved at request/conversation start into an immutable model,
  reference, and settings snapshot. Existing conversations keep that snapshot; future
  conversations follow the latest saved profile unless the faculty feature explicitly
  persists a profile revision. Different profile IDs with the same exact GPT+SoVITS
  weights share a resident model pool.
- The GI student client must not load/warm the shared voice when every student enters.
  Each ASG node owns preparation and exposes Target Optimizer only after loading the
  model, caching the primary plus auxiliary references, running throwaway synthesis,
  and validating two concurrent real-route RIFF syntheses before advertising its two
  slots. This prevents a redundant user-entry warm burst and single-slot false readiness.
- Scheduled prewarming is the event safety mechanism. Reactive scaling is retained for
  sustained unforeseen demand but cannot hide the several-minute GPU launch/model-load
  delay from the burst that triggered it.
- A public prime marker proves that each node originated and received a valid public
  synthesis, not that ALB routed that request back to the same node. Strict per-target
  public readiness requires a separate warm target group/route and promotion lifecycle.

## Evaluated Scaling Improvements

- Keep the current scheduled EC2 prewarm for the event. It is already production-shaped
  and tested, but running GPUs cost money during the scheduled window and the fleet is
  currently single-AZ.
- A faster Lambda retry with short jitter may use newly freed slots sooner. It also
  increases Lambda/ALB attempts, cost, reject noise, and thundering-herd risk, and it
  still cannot guarantee global retry ordering.
- A durable shared dispatcher can provide true global priority and buffer bursts. It
  requires an asynchronous job contract, persistence, idempotency, completion delivery,
  and fairness rules so retries cannot starve new users.
- SageMaker Asynchronous Inference is a post-event research option for managed queueing
  and scale-to-zero. It is near-real-time, uses S3 request/result objects, and would
  require migrating the current worker/container and redesigning immediate first-audio
  playback; it is not a drop-in replacement for the synchronous chatbot route.
- A SageMaker real-time endpoint offers managed hosting/autoscaling but still has cold
  scale-out delay, ongoing GPU cost, and migration risk for model switching, reference
  caches, local scheduling, and shared Live Full state.
- A stopped EC2 warm pool may retain initialized EBS blocks and lifecycle state, but it
  loses RAM/GPU model state and still requires service/model startup. It adds EBS cost
  and lifecycle-hook complexity and must beat the measured 272-275 second final-AMI
  launch before adoption. A running warm pool is faster but costs nearly the same as
  scheduled active GPUs. Hibernation/CUDA restoration must be proven, not assumed.
- EBS Fast Snapshot Restore or deliberate block pre-reading may reduce snapshot
  first-read cost, but adds per-AZ cost/operations and cannot remove Python/model load.
- High-resolution custom capacity publishing could represent continuous fullness more
  accurately than sampled Target Optimizer metrics, but adds a publisher, alarm failure
  semantics, monitoring cost, and maintenance.
- Because future user turns cannot be predicted and a new GPU takes several minutes
  to prepare, evaluate proactive scale-out at roughly 50-75% utilization for three
  consecutive 10-second samples. Busy means an occupied synthesis slot: one generation
  uses one of the deployed GPU's two slots, so that GPU is 50% occupied rather than
  full. Prefer fleet-wide occupied slots divided by total slots so the rule adapts to
  fleet size; use 10-30 busy GPUs only as an optional minimum guard. This requires a
  high-resolution custom metric because the current one-minute Target Optimizer metric
  cannot provide a true 30-second window. Require a cooldown, slow scale-in, cost/
  latency measurements, and rehearsal before replacing the strict alarm.
- Multi-AZ private capacity improves resilience and capacity availability, but adds
  networking/NAT cost, duplicate caches, routing work, and additional permissions.
- WebSocket reconnect/resume is the relevant improvement for the two code-1006 test
  losses. It adds conversation-resume, duplicate-event, and idempotency complexity and
  is separate from GPU autoscaling.

## Future Multi-user Training and Live Full

- The current in-memory serial training queue is admission control, not horizontal
  scaling. A restart can lose queued jobs and one fixed GPU remains the bottleneck.
- Multi-user training should use durable job records, immutable per-job S3 prefixes,
  leases, idempotent completion, checkpoints, cancellation, quotas, and explicit model
  activation. Candidate platforms are a queue-backed training ASG/AWS Batch or one
  SageMaker Training Job per user. The first reuses more code but keeps EC2 operations;
  the second provides managed isolation but requires a full training-container,
  progress, quota, cache/startup, and cost migration.
- Training autoscaling should consider estimated remaining GPU work, not only queue
  length, because training durations vary substantially.
- Shared S3 hydration makes Live Full recoverable across inference targets, but does not
  by itself make concurrent session mutation safe. Worker-local leases must be replaced
  or supplemented with a distributed lease/fencing token and conditional manifest
  revisions before multiple targets can edit one session.
- The first horizontally safe Live Full design should keep one session owned by one GPU
  at a time and use durable asynchronous job/progress state. Chunk-level parallelism is
  optional later: it may reduce completion time, but increases GPU use per user and can
  create cross-GPU prosody, loudness, ordering, retry, cancellation, and reconstruction
  inconsistencies.

## Frontend Surface Split

- Training and Live Fast are the current user-facing surfaces.
- App-mode gating supports separate training and live-fast builds from the same frontend codebase.

## Training Quality Strategy

- The GPU training pipeline now targets GPT-SoVITS `v2ProPlus`, including the speaker-verification embedding extraction step it requires.
- `Skip denoise` is kept as an operator-controlled training option for already-clean recordings because denoise can introduce artifacts that hurt timbre similarity.
- Reference selection should prefer cleaner clips in the ~3-9 second range; the frontend now follows that rule and `gpu-worker/scripts/score_clips.py` exists to validate or inspect candidate clips offline.

## Unified Code, Environment-Specific Deployment

- `separate-containers-new` (Dev) and `codex/staging-multi-user-scaling` (staging) are
  deployment pointers to the same reviewed application commit. A feature must not be
  deployed from one pointer while the other contains a conflicting implementation.
- Both route sets and all feature modules remain in one tree. Environment files and AWS
  configuration decide what is active: Dev uses its fixed on-demand GPU and learner table;
  staging enables the coordinator, shared inference ASG, faculty site, and staging-only auth/
  origin settings. Code presence does not imply a feature is enabled in both environments.
- Staging faculty is the sole lecture-authoring surface. A publish mirrors only the category and
  exact selected cloned-voice artifacts into Dev's S3 prefix; transcripts, analytics, training
  state, active profiles, and other environment data remain isolated. Artifacts copy first and
  the Dev category pointer changes last, preventing it from naming an absent model.
- Dev's original GPU remains activity-managed (`GPU_IDLE_STOP_MINUTES=30`, schedule off). A separate
  second inference GPU is manual-only; neither belongs to an ASG or coordinator. A dedicated ALB
  activity path reports only the original GPU so the shared two-target inference group cannot stop it
  based on the comparison GPU's idle state.
- Staging keeps one ASG baseline and immediately reuses any ready idle worker for a different model.
  It scales out only when every eligible worker is occupied/unavailable and terminates newest overflow
  first. Explicit event mode may opt into a positive model-residency window and scheduled prewarming.
- Promotion order is: merge/test one commit, fast-forward both remote pointers without force,
  deploy each target with its own `-Env`, then verify Lambda package hashes, client assets,
  worker commits, and environment-specific infrastructure independently.

### Divergence that is not in git

These live in runtime configuration and will not appear in any branch diff:

- Staging live-gateway `.env` and staging Lambda env exempt only the staff tools from sign-in
  (`LIVE_AUTH_EXEMPT_ORIGINS`: live-fast `dfzrfr93t2ruf`, MC `d32nzk2gacfhag`); GI and Faculty stay signed.
  Kept in the tracked staging env files so deploys do not wipe it. Dev uses `LIVE_AUTH_DEMO_ONLY` instead.
- Both prefixes hold the published lecture category; staging faculty owns it and Dev receives the
  publish-time mirror. Other application state remains environment-specific.
- Staging ASG instances run `warm-staging-deanvoice.sh` from a systemd drop-in
  (`gpu-inference-worker.service.d/staging-warm.conf`) and keep several deploy scripts
  truncated to zero bytes on the fleet image. Neither applies to dev.

## 2026-11-17 — GPU capacity and mic defaults
- Overflow = all slots of the voice's GPUs taken: switch an idle GPU or add one while new requests wait in
  the bounded queue with a "may be slower" notice. Selections wait ~8 s (tab visible) before switching or
  starting a GPU, Dev too. Idle voice GPUs scale in after 40 min.
- One reference-clip selector (lambda/shared/referenceSelection.js) for pages and server.
- The coordinator owns idle scale-in; the legacy CloudWatch `vcs-staging-inference-no-traffic-15m` actions
  are disabled.
- Every chatbot uses Live MC's Medium mic preset unless Live MC's sliders override it.

## 2026-11-19 — Switch vs add a GPU
- A GPU belongs to whoever messaged, switched or selected its voice in the last 10 min on staging: another
  voice gets a new GPU rather than taking it (selection protects only the voice's last copy). A loaded voice
  adds GPUs only through real queue overflow, never on page open. Fixed-GPU Dev keeps 3 min and waits.
- Every coordinator capacity code must reach the browser unchanged (one shared Lambda helper); a bare 503
  reads as "engine not ready" and is not auto-retried.

## 2026-11-20 — Per-site GPU rules on one shared GPU pool (owner decision; RISK)

- Rules: lectures/faculty follow the published voice and autoscale on demand; training site = one GPU per
  signed-in account (its own GPU switches as soon as nothing runs on it, else the pick waits; never a 2nd GPU; another account never waits for or takes a GPU started for someone else inside 10 min — 11-21); admin TTS site = switch an idle GPU on selection
  with no 10 min wait, add only when no GPU exists; Live MC = on demand, fixed Dean voice. While the first GPU is
  starting nothing adds another; a warmed-up, never-used GPU is idle at once.
- RISK: every site shares ONE coordinator, ONE ASG (max 3) and the same worker addresses; the per-site flags come
  only from the request Origin. A fast-switch rule on one site can take a GPU another site is using: a TTS or
  training-site selection may switch a GPU lecture students used seconds earlier (only "nothing running/queued"
  protects it), and their next reply waits for a switch or a new GPU. Origin is client-supplied, so a script can
  claim the TTS/training behaviour. Revisit (separate pools per site or a minimum resident lecture GPU via
  residency locks) if lecture users see unexpected waits.

## 2026-11-20 — Voice Studio: lecturer onboarding as a separate workflow (owner decisions)

- One site (studio CloudFront per env; old record URLs forward). Two slot kinds: in-person recording sessions
  (published, lecturer picks one; recorder unlocks only then) and GPU test slots (super user allocates after QC; one
  person, no overlap; GPU warm + voice preload + reminder 15 min before; super-user testing locked during it).
- Training queue is server-side and fair (a person's sets back to back), headless on the training GPU; QC by super
  users; reject retrains a NEW voice version with a reason-driven recipe (max 3 attempts unless forced).
- State = one S3 JSON (`studio/state.json`) with ETag conditional writes, not DynamoDB: low volume, atomic clash
  checks. Advanced by the scheduled idle-check and by page requests.
- Access: Voice Studio accepts ANY Microsoft account (personal incl. Gmail-made) via a multi-tenant verifier keyed on
  page Origin; NTU addresses only from NTU's tenant. Other sites stay NTU-only. Super users only via
  STUDIO_SUPERUSERS (lkc-digitallearning@ntu.edu.sg, cs-tengyu.liu@assoc.main.ntu.edu.sg) plus in-app additions.
- Pronunciation is per voice: sounds-like respellings per request; ARPAbet joins the hot dictionary when the voice is
  applied (engine reload). Email via SMTP from the Lambda, pending an NTU IT mailbox; every event is also in-app.

## 2026-11-21 — Voice Studio: email + password accounts and test fixtures

- Owner wants "any Gmail, we don't care": studio-only email + password accounts beside Microsoft. Addresses are not
  verified, so they are never super users and cannot claim NTU or Microsoft-used addresses. Tokens are Ed25519
  (signer key only on the Lambda; verifiers incl. the gateway hold the public key, safe in git). No email
  verification or reset yet (needs SMTP).
- Test fixtures are first-class (`fixture: true`, @voice-studio.test): shown in the UI, never touch the GPU or
  real lecturers, so the live staging state can hold them safely.
- Guided reading is one continuous recording (pause allowed), uploaded as one file, not per-section fragments.

- 2026-11-21 Voice Studio fixtures are visible only to fixture accounts and STUDIO_FIXTURE_VIEWERS testers; all other
  super users see real work only, so the console reflects the real world.
- 2026-11-21 Voice Studio GPU: a test slot holds the inference GPU from 20 min before to its end (bridged if the next
  slot starts < 1 h later); super users are locked out for that whole window (server-enforced); otherwise super-user
  testing is on-demand with the normal 30 min idle scale-in.
- 2026-11-21 Voice Studio owns its inference GPU (coordinator owner "reserved:studio"): other sites never switch it while
  in use (35 min); inside the studio one GPU serves super users and slots, a slot takes it over at once.
- 2026-11-21 Voice Studio GPU kinds: a lecturer's test-slot GPU is hard-reserved (never idles off or gets switched during
  the slot; released right after unless a slot follows within 1 h); the super users' GPU is soft-held (other sites may
  switch it after 10 min unused; 30 min idle scale-in).
- 2026-11-21 (supersedes the two lines above) Voice Studio has TWO GPUs, two owners that never take or switch each other:
  lecturer test slots `reserved:studio-slot` (warm 20 min before; hard-reserved; released at slot end OR when the
  lecturer presses "I'm done", unless another slot starts within 1 h) and super users' QC GPU `held:studio-qc` (any
  voice, any time, picks switch at once; other sites may take it after 10 min unused). No super-user lockout. A
  reserved owner never takes another owner's held GPU. Owner follows the signed-in role (studioGpuAccess).

## 2026-11-23 — Voice Studio: super users run it; Google sign-in; one person, one GPU (owner decisions)

- Sign-in: Google for lecturers' Gmail, Microsoft for NTU staff (button restored same day: NTU addresses are not
  Google accounts); no passwords. Super users = STUDIO_SUPERUSERS / in-app list on the verified address.
- Recording sessions are booked by super users for a named person (time agreed in person); lecturers never book.
- Each tester gets their own hard-reserved GPU (lecturer per person, super users one shared); no other site or person
  switches it while used. Test slots 20 min, several people may share a time. Lecturers may test outside a slot (cold
  start). Sending feedback ends a lecturer's testing. Supersedes the 2026-11-21 two-GPU slot/QC split.
- No GPU kept on between a person's slots (no 1 h bridge): released at slot end; a deleted/moved slot's GPU at once.
- 2026-11-23 (owner): no idle protection before a voice switch on ANY site — a GPU not mid-reply switches at once
  (supersedes the 11-19 10-min rule). Accepts the RISK above: a TTS/training pick can take a lecture GPU between replies.
- 2026-11-23 (owner, supersedes the line above's RISK): every GPU in use is owned and hard-reserved — no site, person
  or voice switches another's; the owner switches its own at once. Lectures are owned per voice. Cost: more GPUs.
- 2026-11-23 (owner): ownership does not lapse on staging — an unused owned GPU is scaled in, never handed over.
  Relies on per-GPU scale-in (terminate permission granted 2026-11-23).
- 2026-11-23 (owner) — wording: test slots are **assigned**, never "booked". Super users assign each approved
  lecturer a test slot; lecturers never book or pick one. All UI copy, emails and docs say "assign test slot"
  (super-user console step 5 of the train-line flow is "Assign test slot"). Still to rename when the train-line
  console is implemented: `StudioApp.jsx` "Approved — book a test slot" and the super-users blurb "book GPU
  slots", the `scheduled` pill "Ready · slot booked" (`StudioChrome.jsx`), and `lambda/studio/mailer.js` copy
  ("book their test slot", "book test slots"). Internal identifiers (`slotBooked` email kind, `'booked'` tone)
  may stay.
- 2026-11-23 (owner) — recording flow for the train-line console: the lecturer records in their in-person session,
  then a **super user uploads that audio** for the lecturer, which sends the set to training. Stop 2 lists only
  people to record (with "Upload audio" once recorded) and "Submitted, moving on to training"; no live "recording
  now" card and no "record a reference voice" tool in the console. Uses the "upload for someone" feature
  (`e707c44`, `forEmail`/`forName` on `createSubmission`): "Upload audio" opens `/record?for=<email>&name=<name>`
  with the lecturer prefilled.
- 2026-11-23 (owner) — quality check is the super user's check before the lecturer hears the voice, and has exactly
  two outcomes: **Approve** (→ assign test slot) or **Retrain** on the same audio (reasons ticked adjust the recipe).
  The current "Ask for new recordings" action in `ReviewForm` (`requestRecordings`) is dropped from QC in the
  train-line console.
- 2026-11-23 (owner) — recording sessions: the lecturer's email and name are **optional**. Blank = a free session
  (green on the calendar, nobody emailed); an email filled in = booked for that lecturer (red); dashed outline =
  draft. A given email must look like one (the server used to accept "asd"). "Run by" holds **several staff**
  (`hostNames[]`, max 8, each with a stable colour, like calendar guests); `hostName` is kept as the joined list
  for older readers.
- 2026-11-24 (owner): recording bookings go to the staff member free then who marked the time first; they confirm
  or hand it to another free staff member before it publishes. Calendar staff are super users only.
- 2026-11-24 (owner): the staff availability calendar is account based: each super user marks only their own free
  time, and only the host (first to mark the time) confirms or hands on a booking on it.
