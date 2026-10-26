# Voice Cloning Project Handoff

Last updated: 2026-10-26

## Current State

- 2026-10-23: Seoul zero-shot lab running with ten working models (Fish Drama 3 and S2-Pro added); FireRed needs a <=12 s reference ending on a full sentence. Emotion panel live for IndexTTS 2.5, VoxCPM2, Fish S2-Pro/Drama 3; only IndexTTS shifts emotion strongly from a calm reference. Raon blocked by vocabulary mismatch. Lab instance stopped 2026-10-23. See docs/deployment.md.
- 2026-10-26: Singapore run. Staging voice cs-tengyu-liu_2 trained on 30 min of Tong Yee (TEDxSingapore + lecture); Live Fast OK (voice match 0.90, WER 4%), Live Full rejected every take (dropped words + 15 chars/s pace check). 8 zero-shot models scored in "Singapore Voice Clone Shootout". Audiobook voice cs-tengyuliu-v1 had Dean's reference clips; profile repaired in S3, now 0.94 Live Fast / 0.97 Live Full (Live Full passes). Singapore Live Full failed 18/18 on the pace check. All GPUs shut down 2026-10-26 (ASG 0/0/0, protection removed, fixed EC2 + lab stopped).
- One application tree. Dev `separate-containers-new` and Staging `codex/staging-multi-user-scaling`
  must point at the same commit; runtime config owns the deliberate differences (Staging hides
  advanced settings, Dev does not autoscale, Dev has no Faculty).
- 2026-10-09: Staging restarted in manual mode: fixed EC2 running; ASG min/desired/max 1.
  Daily actions postponed to non-recurring January 2099 entries (suspend/delete denied).
  Staging Lambda schedule disabled and idle-stop 0; coordinator autoscale for ASG discovery.
  Gateway healthy; inference target still unhealthy after startup polling. Dev was not changed.
  Shutdown: ASG min/desired/max 0, then stop fixed EC2; see docs/deployment.md.
- 2026-10-06: Live MC capture/VAD/duplex overhaul, strict turns and capture sliders deployed to staging (`mc` + gateway). All uncommitted.
- Staging remains the sole authoring surface via Faculty. Publishing mirrors only the selected
  cloned-voice snapshot and category to Dev; training, analytics and transcripts stay isolated.
- ElevenLabs stock voices bypass the cloned-voice coordinator. A signed-in Faculty Alice response
  played while cloned Nathanael requests still had 23.1s queue waits and one timeout.

## Verification Status (read this first)

PROVEN LIVE, 2026-08-31:

- Routing to a GPU already holding the voice; two concurrent requests fill its two slots without
  scaling. Selecting a voice/lecture prepares it on TTS, Faculty and lectures.
- An idle GPU holding another voice is switched, not scaled past — including inside its 30s grace.
- Three concurrent same-voice requests: two route, the third QUEUES and is still served (~8.6s,
  `queuedAdmission: true`), and exactly one overflow GPU is prepared
  (route -> route -> queue -> post-admission scale).
- Concurrent different-voice selections during an in-flight switch neither scale nor thrash.
- Natural scale-in 2 -> 1 on the 15-minute no-traffic alarm; Dev routing-only simulation message,
  then a real reassign and a real WAV on the fixed GPU.

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

FIXED LOCALLY, NOT DEPLOYED:
- A scoped DynamoDB lease plus expiring request rows serializes fleet selection. Tests pack six
  requests 2/2/2, spread queues across workers, stop at depth two, and automatically retry preserved
  queue/lease codes. Both local branches share one commit; AWS deployment/live proof is blocked by
  expired `VCS_AWS_*`, and remote push is blocked by unavailable GitHub authentication.
- Still not isolated end to end: frontend 15-second retry and Faculty Dev/Staging publish mirroring.

CONTRADICTION: the lecture badge showed `cs-nathanael-ng` while `client/env/staging/gi.env` pins
`deanvoice-v1`. Settle which wins after a faculty publish.

## Deployment State

- Deployed 2026-09-01: staging coordinator, Faculty and lecture bundles for truthful completed-boot,
  scale/reassignment, automatic-retry and stale-banner behavior. Prior changes are in CHANGELOG.
- Local tests: Lambda 335/335, coordinator 54/54, client 499/499, inference worker 259/259 and
  gateway 180/180; default/Live Fast/GI builds pass. `lambda/model-coordinator` needs
  its own `npm install`, or the Lambda suite fails on a missing `@aws-sdk/client-lambda`.
- No worker/AMI change needed: the worker's `SYNTHESIS_MAX_QUEUE_DEPTH` is 100, so the coordinator
  ceiling binds. Image `ami-07236b80dcdb93bcb`, launch-template v40.
- Staging manual capacity and shutdown controls: see current state above and docs/deployment.md.

## Queue and Scaling Contract

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
