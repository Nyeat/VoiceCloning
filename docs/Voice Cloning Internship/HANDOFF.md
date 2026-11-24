# Voice Cloning Project Handoff

Last updated: 2026-11-23

## Current State

- 11-17..11-20 (details in CHANGELOG): training login redesign, GPU wait popups everywhere, coordinator overflow/8 s dwell/
  boot-at-registration/lost-boot retry, per-GPU scale-in 30 min (fixed GPU idle-off 40; scale-in IAM granted 11-23),
  10 min switch protection (removed 11-23), GPU_PAUSED switch, voice names, LT v42 default (v41 rollback).
- 11-20 (64d34f7, deployed all): first-GPU hold, one GPU per account (training site), honest/live GPU status, keep-alive, naming.
- 11-20/21 Voice Studio live (10cd835, 2d37a57): sessions->queue->QC->test slots, calendars, email sign-in, fixtures.
- 11-21 7b8c964 DEPLOYED (dev+staging Lambdas, coordinators, training clients): training site = GPU belongs to the account that started it; own voices switch it (wait if busy), other accounts get their own GPU (no first-GPU hold, no taking a just-warmed GPU); load still scales. Test page shows saved names. Next: two-account live test.
- 11-21 Voice Studio, ALL DEPLOYED dev+staging through 07b0494/4227e31 (see CHANGELOG 11-21): auto sign-up email login
  (Google hidden until client ID); staged lecturer page (one booking/one submission); VoiceTestBench (own Chat + mic,
  Read aloud progress/download, one dictionary); reminders + QC email; Gmail SMTP (needs app password:
  scripts/set-email-password.ps1); console: stages, Run by, withdraw confirm + Restore; fixtures only for
  STUDIO_FIXTURE_VIEWERS; owner Gmail super user (STUDIO_PASSWORD_SUPERUSERS). GPU: slot hold 20 min/whole slot/<1 h
  bridge, released after; super-user lockout on all GPU routes (shared/studioGpuGuard); coordinator owners
  "reserved:studio" (hard) / "held:studio" (soft 10 min); fixed GPU demand for slots, training, 30 min after super-user
  testing. Fixed: /voice-profile/ensure never saved new profiles. Next: live slot warm-up -> release; chat/mic check.
- 11-23 Voice Studio redesign + later fixes (CHANGELOG 11-23, through 93835dd): approved voice before test slot, upload for someone, open recording, edit moves slot GPU, warm-up ensures profile, past slots hidden.
  11-23 later (32f6e35, DEPLOYED dev+staging 17:25 SGT): Staff availability (override + taken/free-again emails, hand-off, undo), Upload for anyone, Delete stale uploads, 12 dummies re-seeded. Staging again has open recording.
  Dev has all; STAGING was overwritten 16:33 SGT by a teammate's unpushed tree ("To record" list) -> his work merged in 5acac14; redeploy staging next. Email needs the LKC mailbox (TODO).
- 11-24: availability calendar (55ecf6a) deployed dev+staging; one-time recording page + lecturer status flow after it (CHANGELOG 11-24).
- One tree: Dev `separate-containers-new` = Staging `codex/staging-multi-user-scaling` (same commit); runtime
  config owns the differences (Staging hides advanced settings, Dev does not autoscale, Dev has no Faculty).
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
Also open (BUGS.md): the Faculty full-screen "Starting the GPU" modal blocks authoring while capacity warms.
