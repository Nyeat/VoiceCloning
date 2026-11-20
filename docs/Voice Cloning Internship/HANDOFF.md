# Voice Cloning Project Handoff

Last updated: 2026-11-20

## Current State

- 2026-11-17: deployed f84faa0 (both branches) to dev + staging: both Lambdas/coordinators, all clients. Training
  login redesigned (LKCMedicine photo, privacy popup on arrival); "Training GPU" badge hidden on Test your voice;
  dismissible GPU wait popup with estimates on every site. Coordinator: overflow = all slots taken -> switch/add while
  queueing ("may be slower"); 8 s visible-tab dwell before any switch or boot (Dev too); boot done when READY with the
  voice; lost boots retried; 30 min per-GPU scale-in (fixed GPU idle-off 40, since 11-19), spare copies by own activity, swept from idle-check too; legacy
  `no-traffic-15m` alarm actions disabled. One reference selector (lambda/shared). All chatbots use Live MC Medium mic
  preset. Profile/config saves strip presigned URLs (8 KB WAF). 11-17 later: 2 GB training uploads (s3Sync undeployed).
- 2026-11-19 (7d22b21, all deployed dev + staging): scale-in IAM still MISSING (fallback: all-idle fleet shrinks);
  new GPUs released at warm registration; same GPU popups/off screen on every site (GPU_PAUSED switch); idle-off 40
  / scale-in 30 min; voice names. Late (289832d+127deed): switch only a GPU unused/unselected 10 min, else add;
  queue codes reach the browser; waits/popups/voice survive reload; training prewarm. 056dd32 deployed. 11-20: ASG GPUs + LT default v42 on c4d928a (v41 rollback); admin cleanup in TODO.
- 11-20 (64d34f7, deployed all): first-GPU hold, one GPU per account (training site), honest/live GPU status, keep-alive, naming.
- 11-20 Voice Studio LIVE (10cd835, dev+staging, one site): sessions->queue->QC->test slots; any MS account; no E2E/SMTP yet.
- 11-21 Voice Studio 2d37a57 (Lambdas+clients): calendars, email sign-in, fixtures, gateway; email = training Gmail.
- One application tree. Dev `separate-containers-new` and Staging `codex/staging-multi-user-scaling`
  must point at the same commit; runtime config owns the deliberate differences (Staging hides
  advanced settings, Dev does not autoscale, Dev has no Faculty).
- Staging remains the sole authoring surface via Faculty. Publishing mirrors only the selected
  cloned-voice snapshot and category to Dev; training, analytics and transcripts stay isolated.
- ElevenLabs stock voices bypass the cloned-voice coordinator.

## Verification Status (read this first)

PROVEN LIVE, 2026-08-31:

- Routing to a GPU already holding the voice; two concurrent requests fill its two slots without
  scaling. Selecting a voice/lecture prepares it on TTS, Faculty and lectures.
- An idle GPU holding another voice is switched, not scaled past — including inside its 30s grace.
- Three concurrent same-voice requests: two route, the third QUEUES and is still served (~8.6s,
  `queuedAdmission: true`), and exactly one overflow GPU is prepared
  (route -> route -> queue -> post-admission scale).
- Concurrent different-voice selections during an in-flight switch neither scale nor thrash.
- Dev routing-only simulation message, then a real reassign and a real WAV on the fixed GPU.

PROVEN LIVE/DEPLOYED, 2026-09-01:

- A real lecture request saturated the resident voice, scaled desired capacity 1 -> 2 exactly once,
  and the new worker later reached `READY`; repeated prepare polls did not scale again.
- The coordinator clears completed boots and distinguishes pending scale-out from reassignment copy.
  Faculty and lectures retry only the generated reply's speech every 15 seconds for at most 20 minutes;
  success clears stale wait banners. A signed-in browser turn confirmed the copy tracks reassignment
  versus scale-out and clears automatically at READY; one answer became playable without reprompt,
  although the frontend retry was not isolated from the backend's shorter retry window.
- Concurrent Dean/Nathanael RIFFs routed separately with zero queue wait; Live Full cancellation
  cleared its slot, and scale-in reduced 5 -> 1 newest-first, leaving the oldest baseline worker.

FAILED LIVE ON THE CURRENT DEPLOYMENT — do not call it fixed yet:
- Distributed queueing/ceiling under a simultaneous burst. Six requests with three matching READY
  GPUs stacked five onto the oldest worker, briefly exceeded the configured queue ceiling, returned
  one capacity-starting response, and unnecessarily scaled 4 -> 5 while two matching GPUs were idle.

DEPLOYED SINCE (2026-11-03 onward): the scoped lease + request rows (6 requests pack 2/2/2, queues spread,
depth 2). The burst above has not been re-run live on it.

CONTRADICTION: the lecture badge showed `cs-nathanael-ng` while `client/env/staging/gi.env` pins
`deanvoice-v1`. Settle which wins after a faculty publish.

## Deployment State

- Deployed 2026-09-01: staging coordinator, Faculty and lecture bundles for truthful completed-boot,
  scale/reassignment, automatic-retry and stale-banner behavior. Prior changes are in CHANGELOG.
- Local tests: Lambda 335/335, coordinator 54/54, client 499/499, inference worker 259/259 and
  gateway 180/180; default/Live Fast/GI builds pass. `lambda/model-coordinator` needs
  its own `npm install`, or the Lambda suite fails on a missing `@aws-sdk/client-lambda`.
- No worker/AMI change needed: the worker's `SYNTHESIS_MAX_QUEUE_DEPTH` is 100, so the coordinator
  ceiling binds. Image `ami-0642b66fa3ae46b4f`, launch-template v41 (rollback v40 `ami-07236b80dcdb93bcb`).
- Staging manual capacity and shutdown controls: see current state above and docs/deployment.md.

## Queue and Scaling Contract

- RISK (2026-11-20): all sites share one GPU pool; TTS/training-site fast switches can take a lecture GPU (DECISIONS).
- Selecting a voice PREPARES it. TTS, Faculty and lecture opening run one preflight: route to a
  resident free slot, else reassign a truly idle worker, else scale.
- Guard 1 (fleet in motion): never scale on selection while any live reassignment, pending boot or
  non-READY worker exists. Per-model short-circuits cannot see a DIFFERENT model transition — the
  blind spot behind the incident.
- Guard 2 (promised worker): a worker already committed to a reassignment is not offered to another
  selection, or concurrent selections all target the same idle-looking GPU and thrash it.
- Guard 3: the 30s anti-thrash grace may DELAY a switch, never justify scaling; if the grace alone
  blocks a reassignment, defer.
- Switching/warming reserves a worker but claims no slot and does not enter the queue.
- One Fast or Full request = one slot; a two-slot GPU runs two and the next matching request queues.
  Occupying the last slot does not itself scale — overflow needs a real queued/rejected request or
  explicit event prewarm.
- Queueing IS distributed: least-loaded matching worker, bounded by `MODEL_MAX_QUEUED_PER_WORKER` (2).
  Past the ceiling, retryable 503 `MODEL_QUEUE_FULL`, scaling only if no boot is already pending.
- A short fleet-wide lease plus request reservations prevents independent Lambdas from selecting the
  same stale snapshot. The lease is released before synthesis; only occupancy remains reserved.
- No GPU has the model: reassign an idle GPU and return retry, or scale if none is safely
  reassignable; the HTTP request is never held through a cold start.
- Routing packs older matching capacity so newer overflow GPUs go idle and scale in. Not round-robin.
- Event mode: minimum resident workers for the event voice cannot be reassigned. Scale-in stays
  independent of model selection.

## Operating Rules

- Read user-level `VCS_AWS_*`, map only to process `AWS_*`, assume the project role, verify account
  identity before AWS writes. Never print or persist credentials.
- Lambda deployment merges tracked environment files into live variables; never replace the map.
- Keep project-memory edits byte-identical between the vault and `docs/Voice Cloning Internship`.
- Preserve unrelated source changes and the user's dirty working tree.

## Next Session

1. Refresh user-level `VCS_AWS_*`, deploy both coordinators/main Lambdas and affected clients from one
   commit, then repeat the six-request three-GPU and super-overflow tests with no idle-capacity scale.
2. Isolate the deployed frontend retry path with a synthesis failure lasting beyond the backend retry
   window; require one answer bubble, automatic speech, and no stale banner or second prompt.
3. Faculty publishing: start the Dev GPU, publish two profiles across two lecture categories, confirm
   Dev and Staging resolve the same pair, then settle the `gi.env` vs lecture-badge contradiction.
4. Open Dev GI after starting its GPU; ask an administrator for CloudTrail attribution and orphan cleanup.
Also open (BUGS.md): the Faculty full-screen "Starting the GPU" modal blocks authoring while capacity
warms.
