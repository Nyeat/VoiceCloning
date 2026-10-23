# Changelog

## 2026-10-22 — Unsigned staging TTS; lab playback (repo only, not deployed)

- Staging Live Fast/TTS (`dfzrfr93t2ruf`) showed `Sign in to use the voice assistant`: staging Lambda
  has no `LIVE_AUTH_DEMO_ONLY`, and the tracked `lambda/.env.deployment.staging` set
  `LIVE_AUTH_EXEMPT_ORIGINS=` empty, which every deploy merges over runtime. Now lists the live-fast
  and MC origins (MC also added to `CORS_ORIGIN`); gateway staging env file matches. GI/Faculty stay signed.
- Zero-shot lab `app.py`: player gets an MP3 copy (~10x smaller than the WAV) to stop stalls and late
  display over the Gradio tunnel; lossless WAV + JSON are in the download list.
- Tests: MP3 copy round-trip checked locally (40 s, 24 kHz). `test_lab.py` not run — local Gradio import
  broken (huggingface_hub mismatch).
- Deployed same day: staging Lambda env merged (only exempt origins + CORS; `POST /api/live/tts-sentence`
  from `dfzrfr93t2ruf` now 400, not 401); gateway `.env` merged (backup `.env.bak.tts-exempt`), `/readyz` ok;
  lab `app.py` installed (backup `app.py.bak.mp3`), service active. No full synthesis or browser playback test.

## 2026-10-16 — Voice-clone model bake-off scorer (local, not run on audio)

- Added `scripts/clone-bench/score_clones.py` + `sentences.txt`: scores any folder of model outputs
  against reference clips with WavLM-SV SIM, resemblyzer SIM and faster-whisper large-v3 WER; writes
  `scores.csv` and a per-model summary. Only syntax-checked (`py_compile`); no audio scored yet.
- Added repo `docs/voice-model-evaluation.md`: verified/unverified benchmark table, ChatGPT comparison,
  8-model shortlist, hosting plan (6 GB local GPU too small for top models) and test protocol.

## 2026-09-01 — Atomic distributed GPU admission (local; deployment blocked)

- Replaced stale-snapshot synthesis selection with a short, scope-wide DynamoDB admission lease and
  expiring per-request occupancy rows. The lease covers only selection/reservation, not synthesis;
  worker refresh cannot overwrite reservations, and out-of-order completion releases capacity.
- Matching direct work packs oldest-first. Saturated matching work queues least-loaded with a hard
  two-per-worker ceiling while exactly one reassignment/scale claim prepares capacity. Super-overflow
  returns retryable `MODEL_QUEUE_FULL` instead of stacking deeper or buying one GPU per caller.
- Preserved queue-full, queue-timeout and admission-contention codes through the client 503 decoder;
  Live Fast retains the answer, retries the same speech request using the server hint, and clears the
  wait banner on success. ElevenLabs remains outside cloned-GPU admission.
- Added tests for 2/2/2 six-request packing, distributed overflow, queue ceiling, idle-GPU overflow
  reassignment, stale-probe bridging, out-of-order release, lease ownership and automatic retries.
  Coordinator 54/54 and the last full Lambda/client/worker/gateway suites plus three builds pass.
- No AMI change is needed because worker code did not change. AWS role assumption failed with
  `ExpiredToken` from user-level `VCS_AWS_*`; nothing was deployed or live-tested in this change.
- The fix is committed and both local Dev/Staging branch pointers are identical. Remote push failed
  because this shell could not obtain GitHub credentials; remote branches remain unchanged.

## 2026-09-01 — Targeted live capacity verification

- Signed-in lecture cold-state UI tracked the real action: idle Dean -> Nathanael showed reassignment
  copy at desired 1; a later occupied-worker burst showed scale-out copy, then available-with-extra-
  capacity-starting copy, and finally cleared the banner automatically when the claimed worker loaded
  `cs-nathanael-ng-v1`. One submitted answer became playable without a user reprompt. The exact
  frontend retry branch was not separated from the backend's shorter retry window.
- Six simultaneous Dean requests against three matching READY GPUs exposed a regression: five RIFFs
  all used the oldest worker (queue wait max 6.2s), one returned `MODEL_CAPACITY_STARTING`, desired
  changed 4 -> 5 despite two idle matching GPUs, and the row briefly reported queued 3 above the live
  configured ceiling 2. A later five-request one-GPU run returned one `MODEL_QUEUE_TIMEOUT`.
- Concurrent Dean and Nathanael requests passed on separate existing workers with HTTP 200 RIFF,
  zero queue wait, and no extra scale. Live Full generate/cancel returned a real session, routed one
  slot, returned `cancelled: true`, and all worker active/queued counters returned to zero.
- Faculty Alice returned and played the approved answer while cloned Nathanael load still had queue
  waits up to 23.1s. This is live evidence that ElevenLabs synthesis bypasses cloned-GPU contention.
- Idle scale-in passed 5 -> 4 -> 3 -> 2 -> 1. `NewestInstance` terminated `i-0cf3...`, `i-003...`,
  `i-076...`, then `i-064...`, leaving the oldest baseline `i-091...`.
- Code files changed: none. Project-memory files only. No broad unit/build suite was rerun.

## 2026-09-01 — Capacity waits track readiness and the actual fleet action

- Staging evidence separated a real cold start from stale UI state: the second ASG instance was
  `InService` before its selected voice was loaded, then later reported coordinator `READY`. Duplicate
  prepare polls correctly held desired capacity at two instead of scaling again.
- Fixed the remaining coordinator bug: `prepareCapacity` now consumes a `PENDING` boot marker only
  when the claimed/new worker is `READY`, matches the requested model, and has a free slot. Synthesis
  uses the same strict helper, so an older matching worker cannot incorrectly clear a new boot.
- Faculty Live Fast now keeps the generated assistant response and retries only its speech synthesis
  every 15 seconds for up to 20 minutes on `MODEL_CAPACITY_STARTING`. Ending/interruption cancels the
  wait; hard capacity limits and Dev simulation responses are not retried. The warning explicitly
  says retry is automatic, so the user does not need to repeat the question.
- A later live load test exposed a second presentation bug. Logs showed a real earlier reassignment,
  then scale-out from desired 2 -> 4; the lecture kept the old "idle GPU is switching" banner while
  successful audio played. Successful synthesis now clears any older capacity-wait banner. When both
  a pending scale-out and reassignment exist, the coordinator reports the stronger fleet-wide fact:
  "A new GPU is starting and loading this voice," not only the local switch.
- Deployed the staging coordinator plus Faculty and lecture bundles. Public lecture readback points
  at `assets/index-B4FJGUtb.js`; CloudFront invalidation completed. Coordinator SHA is
  `BO74OU/yOBFA8Wlk8emNO605aLFRrF3uFHopqFnqja8=`.
- Verified: coordinator 46/46 and Lambda 327/327; client targeted 32/32 and full 497/497; GI and
  Faculty production builds pass. A controlled authenticated browser turn through a fresh cold
  switch after the latest deployment remains unexercised.

## 2026-08-31 (concurrency testing) — burst requests skipped the queue entirely

- Ran three simultaneous same-voice synthesis requests against staging. Before the fix: two returned
  audio and the THIRD returned 503 `MODEL_CAPACITY_STARTING` with a ten-minute retry, while the
  worker's waiting list sat completely empty. Logs showed three `route` decisions then `scale`.
- Root cause: in a real burst every request reads the fleet before any slot is taken, so all three
  route optimistically. The third loses the race, the worker rejects it with 429/503, and the catch in
  `synthesize` deliberately fell through to `scale` — skipping the queue. The comment called this a
  rare live race; it is actually the COMMON path for the third caller in any burst, which is exactly
  the case the bounded queue was built for.
- Fix: the queued-admission logic is extracted into `admitQueued()` and is now reachable from the race
  path. On a 429/503 the coordinator re-probes the worker and, if its waiting list is under
  `MODEL_MAX_QUEUED_PER_WORKER`, admits the request there; only a genuinely full list falls through
  to scale.
- Verified live after deploy: all three requests returned 200 with audio (387,885 / 421,164 / 387,885
  bytes), the third carrying `queuedAdmission: true` and completing in 8.6s. Decision sequence is now
  route -> route -> queue -> post-admission scale, which is the intended contract: two slots serve two
  users, the third waits briefly and is still served, and exactly one overflow GPU is prepared.
- Tests: Lambda 324/324, coordinator 43/43.

## 2026-08-31 (schedule) — staging ASG now really stops at 19:00

- `vcs-staging-daily-stop` previously set `MinSize=1, MaxSize=192` with desired unchanged, so it
  stopped nothing and staging ran a g6.xlarge 24/7. It now sets `MinSize=0, DesiredCapacity=0`,
  matching the fixed GPUs' 07:00-19:00 SGT window. `set-staging-asg-daily-schedule.ps1` gained an
  `offHoursDesiredCapacity` config key, since a floor of 0 alone cannot reduce an existing desired
  capacity. Applied and read back live.
- Tradeoff reintroduced: work still running at 19:00 is now terminated. An event that must overrun
  needs its own scheduled action or a temporary suspension of this one.


## 2026-08-31 (browser testing) — selection-time scaling regression found and fixed

- Browser-tested Dev TTS and Staging lectures against the deployed selection-prepare change.
- Dev TTS passed end to end: switching AlexV1 -> DeanVoice showed the Dev simulation notice while the
  30-second grace held, then reassigned the fixed GPU and generated audio with DeanVoice.
- REGRESSION FOUND on Staging. Opening the `gi-bleeding` lecture (voice `cs-nathanael-ng-v1`) drove ASG
  desired 1 -> 2 and launched `i-0cadcf7b6efb07271`, even though the only GPU was idle holding
  `deanvoice-v1`. Coordinator logs show `lecture-preflight -> scale` then repeated `scale-pending`.
- Root cause: the preflight anti-thrash grace (`MODEL_PREFLIGHT_REASSIGN_IDLE_MS`, 30s) removes a
  recently-demanded worker from the reassignable set. With selection-time scaling enabled, the request
  then fell straight through to `scale`. The grace was only ever meant to delay a switch, never to
  justify buying a GPU — an idle worker inside its grace window is still idle capacity.
- Fix: `prepareCapacity` now compares the strict decision against the same decision with the grace
  removed. If the grace is the ONLY thing blocking a reassignment (`gracedOnly`), it defers with
  `WARMING` + "An idle GPU will switch to this voice shortly. No additional GPU is being started."
  instead of scaling. Deployed to both environments.
- Also fixed: coordinator error strings said "lecture voice" on every surface, so the Dev TTS page
  showed "An idle GPU is switching to this lecture voice." They are now domain-neutral.
- Post-fix canary at desired 2: a resident-voice prepare returned `READY`/none, and an immediate
  different-voice prepare returned `WARMING`/reassign `started=false` with no scale. Desired held at 2.
- Tests: Lambda 324/324, coordinator 43/43.

- Open findings, not yet addressed:
  - Faculty shows a full-screen blocking "Starting the GPU" modal while capacity warms, so a lecturer
    cannot write or edit instructions during the wait. Decide whether authoring should stay usable.
  - The lecture badge showed `cs-nathanael-ng` while `client/env/staging/gi.env` still sets
    `VITE_GI_VOICE_PROFILE_ID=deanvoice-v1`. Confirm which binding is authoritative after a faculty
    publish; the two disagree.
  - `voiceCapacity.js` maps `STARTING` to "allow up to 15 minutes" but `WARMING` (a reassignment,
    roughly a minute) to a separate message. The mapping is correct, but the 15-minute figure is what
    a user sees whenever a GPU is genuinely bought.
- Still unverified: Faculty authoring/publishing, Dev GI, ElevenLabs slot bypass, and the real
  concurrent-synthesis overflow path (`MODEL_QUEUE_FULL`).

## 2026-08-31 (later) — Voice selection now prepares capacity; two coordinator bugs fixed

- Policy change, agreed with the user: selecting a voice/lecture PREPARES it. `allowScale` is now
  `true` for `models-select` (`lambda/models/index.js`) and `lecture-preflight`
  (`lambda/voice-profile/index.js`), and the TTS/Faculty dropdown no longer sends
  `prepareCapacity: false` (`client/src/pages/LivePage.jsx`). The former metadata-only selection
  and its "this voice will load on demand" notice were the confusing frontend behaviour.
- Bug 1 (fleet-wide scale guard). The reassign/boot short-circuits in `prepareCapacity` are keyed to
  the REQUESTED model, so a transition running for a DIFFERENT model was invisible. With scaling
  re-enabled this reproduced the 1->2->3->4 incident. Added `fleetIsInMotion()` (`decision.js`):
  a selection defers with `WARMING` + "GPU capacity is already being prepared" instead of scaling
  while any live reassignment, pending boot, or non-READY worker exists. Synthesis is unaffected and
  still scales on real overlapping demand.
- Bug 2 (reassignment thrash). A worker stays idle READY until its switch actually begins, so three
  near-simultaneous selections each scheduled their own reassignment onto the SAME GPU; it would
  thrash through three models and two callers were told a GPU was warming for a voice it would never
  hold. `chooseCapacityAction` now takes `reassigningWorkerIds` and excludes already-promised workers
  (`promisedWorkerIds()` in `index.js`, wired into prepare, post-admission, and synthesis).
- Bounded, distributed overflow queue. `chooseQueuedMatchingWorker` takes `maxQueuedPerWorker`
  (`MODEL_MAX_QUEUED_PER_WORKER`, default 2, set explicitly in both coordinator env files). It already
  picked the least-loaded matching worker, so queueing was distributed — the previous handoff text
  claiming otherwise was wrong. Beyond the ceiling, `synthesize` returns retryable 503
  `MODEL_QUEUE_FULL` and only scales if no boot is already pending, per the user's rule that the first
  overflow has already asked for capacity. The worker's own `SYNTHESIS_MAX_QUEUE_DEPTH` is 100, so the
  coordinator ceiling is the real bound; no worker or AMI change was needed.
- Verified unchanged and correct: the busy/generating marker is real (`synthesisScheduler` increments
  `active` on admission and decrements in a `finally`), scale-in protection is held across assignment
  and synthesis (`SetInstanceProtection`), oldest-first packing by `firstSeenAt`, and the event
  residency-minimum lock.

- Files: `lambda/model-coordinator/decision.js`, `lambda/model-coordinator/index.js`,
  `lambda/models/index.js`, `lambda/voice-profile/index.js`, `client/src/pages/LivePage.jsx`,
  `lambda/.env.deployment.coordinator.{dev,staging}`, plus tests in
  `lambda/model-coordinator/decision.test.js`, `lambda/models/index.test.js`,
  `lambda/voice-profile/index.test.js`.
- Tests run: Lambda 322/322, coordinator 41/41, client 491/491. Note `lambda/model-coordinator`
  needs its own `npm install`; without it the whole Lambda suite fails on a missing
  `@aws-sdk/client-lambda`.
- Deployed 2026-08-31: both main Lambdas, both coordinators, and the Dev/Staging `live-fast`
  (TTS/Faculty) client bundles.
- Live evidence (staging, desired capacity 1 throughout): selecting deanvoice on an idle
  cs-nathanael GPU returned `WARMING`/`reassign` `started=true` and the GPU settled READY on
  deanvoice; two further alexv1 selections during that switch returned `started=false` with the
  "already being prepared" message. Desired stayed 1 before, during, and after. Dev reassigned its
  fixed GPU to alexv1 as expected.
- NOT yet verified: any browser flow, the queue/overflow and `MODEL_QUEUE_FULL` retry path under real
  concurrent synthesis, Dev's `SIMULATED` message (needs both Dev GPUs busy), ElevenLabs
  slot-bypass in the UI, and faculty publishing.

## 2026-08-31

- Diagnosed the signed-in two-user regression from live evidence. At 08:15:26Z and 08:15:27Z,
  `post-admission -> scale` changed Staging desired capacity 1->2->3 even though the two requests
  only filled the configured two slots. New instances' `active=2` state came from their two-request
  public-prime readiness work, not an inaccurate idle counter.
- Fixed locally, not deployed: direct successful admissions no longer speculatively prepare overflow;
  actual queued/rejected demand still does. Pending scale/reassignment/demand/event-lock records are
  environment-scoped, a pre-existing matching worker cannot clear a boot marker, and lecture preflight
  uses a 30-second reassignment grace while real synthesis can still reassign an idle GPU immediately.
- Tests: coordinator 31/31, full Lambda 312/312, model-coordinator package build, and diff check.
  Live deployment, signed-in Dev/Staging browser verification, and natural 3->1 cleanup are untested.
- Made TTS and Faculty voice selection metadata-only while preserving lecture non-scaling preflight.
  Deployed Dev/Staging TTS and GI plus Staging Faculty; public asset hashes were read back.
- Added event voice residency-minimum lock/unlock/status actions and decision enforcement. A live
  lock-one check protected the Dean baseline without launching or switching a GPU.
- Fixed Lambda deployment to upload coordinator code, not only its environment. Both Dev and Staging
  coordinators were redeployed and the new action was invoked successfully.
- Baked the hash-matched worker correction into `ami-07236b80dcdb93bcb`, promoted launch-template v40,
  canaried one worker to coordinator READY, and observed automatic 2->1 scale-in. The prior excess
  fleet also completed natural 4->3->2->1 scale-in.
- Verified 129,324-byte Staging and 183,084-byte original-Dev Dean RIFF synthesis. The manual Dev
  comparison worker stayed stopped during final Dev proof.
- Tests: Lambda 309/309, client 491/491, worker 259/259, affected builds, script parsing, bundle
  readback, live event-lock lifecycle, worker hash parity, coordinator readiness, and RIFF checks.
- Fixed selection-driven staging scale-out. Model selection and lecture capacity preflight now route
  or reassign an idle worker without changing ASG desired capacity; unavailable selection returns
  `ON_DEMAND`. Only real synthesis admission or explicit event prewarm may scale.
- Added structured route/queue/reassign/scale decision logs and corrected Dev simulated capacity so
  it no longer claims Staging is at its GPU limit.
- Fixed worker model reassignment to reuse a managed Python inference process while it is temporarily
  unresponsive during weight application instead of throwing `Inference server is already running`.
- Deployed both main Lambdas and coordinators plus all four then-current Staging worker runtimes.
  Live Dean/Alex/cs-nathanael selections kept desired capacity unchanged at 4. Client deployment,
  launch-image promotion, and final original-Dev-worker verification are pending expired credentials.
- Tests: Lambda 302/302, client 489/489 after merging concurrent lecture-outline work, worker 259/259,
  three client builds, diff check, and live
  AWS before/after selection verification.

## 2026-08-28

- Unified cloned-voice preparation and initial synthesis behind the model coordinator. TTS and
  Faculty `/models/select`, Live Fast, synchronous Full, and initial asynchronous Full admission
  now use the exact pinned model through one routing authority. Same-model saturation uses the
  worker's bounded priority/FIFO queue while Staging requests additional capacity in parallel.
- Added Dev routing-only coordination over fixed instances `i-03f258d470a2fa73f` and
  `i-0048470294e4ec518`. It uses the same routing code but has no ASG actions; unavailable capacity
  returns `DEV_CAPACITY_SIMULATED`. The original GPU retains 30-minute activity shutdown and the
  comparison GPU remains manual-only. Both were started for a pending two-worker live test.
- Deployed identical main Lambda package SHA `3CbOy8HC…` to Dev and Staging, the coordinator package
  to both coordinators, and new TTS/Faculty bundles. Live preflight proved Staging `READY` with two
  free Dean slots while desired capacity remained 1; Dev with both GPUs off returned the simulated
  scale message. Worker-level two-GPU proof remains pending because the refreshed user-level AWS
  session expired before SSM inspection.
- Tests: client 479/479, Lambda 288/288, focused cross-package 91/91, live-fast and Faculty builds,
  deployed bundle readback, exact Lambda SHA/config readback, and coordinator preflight. A separate
  Dev DynamoDB table could not be created by the deployment role; Dev safely shares the lease table
  but filters fleet discovery to its two unique fixed instance IDs.
- Merged and deployed concurrent published-lecture voice naming and failed scale-claim cleanup.
  Final environment pointers are `e993d81`; combined tests pass client 485/485 and Lambda 299/299.
- Live Dev bring-up exposed and fixed two missing prerequisites: unassigned base-ready workers were
  excluded from coordinator reassignment, and the Dev worker security group did not allow port 3003
  from the coordinator Lambda group. Both fixed GPUs now retain authenticated coordinator config.
- Proved fixed-GPU routing without Dev autoscaling: manual GPU loaded Dean and returned a 154,924-byte
  RIFF; after it was stopped, the original GPU loaded the same model and returned a 142,124-byte RIFF.
  A one-GPU three-request saturation canary returned three RIFFs; waits were 0/0/3,177 ms, proving the
  third request used the bounded worker queue. Final manual GPU state is stopped; original is running
  under its existing 30-minute activity stop. Staging remained min/desired 1 throughout.
- Added the complete Week 22 contribution report and tightened the next-session handoff. Corrected an
  obsolete deployment note: ordinary model reassignment is immediate when an eligible unassigned or
  differently loaded worker is idle; only explicit event configuration may impose a residency delay.
  No application or cloud runtime was changed by this documentation update.

## 2026-08-27

- Deployed the faculty empty-selection fix to `faculty.lkcmedicine.org`: once profile loading
  settles, the banner now says `Select a voice to begin.` without a spinner. Deployed the same
  reviewed tree to `lectures.lkcmedicine.org`; public bundle and category readback returned the
  new assets and `gi-bleeding -> deanvoice-v1`.
- Hardened lecture publishing so a cloned `voiceProfileId` must exist and belong to the lecturer,
  unless the caller has supervisor authority. Stock ElevenLabs IDs keep their existing path.
- Corrected coordinator admission to count active plus queued work and to pack matching requests
  onto the longest-lived worker first. The ASG now uses `NewestInstance`, making newer overflow
  workers the first scale-in candidates; min/desired stayed 1 and the sole worker stayed healthy.
- Removed the coordinator packager's redundant Windows staging copy of `node_modules`; both Lambda
  ZIPs packaged and were deployed with successful Lambda update status. Tests: client 447/447,
  Lambda 279/279, chatbot/GI/live-fast builds, PowerShell syntax, package inspection, public asset/
  category readback, ASG/Lambda readback, and authenticated faculty DOM verification. The faculty
  browser session still received API 401 and could not list voices, so real publish remains pending.

## 2026-08-25

- Completed unified runtime rollout after credential refresh. Fixed Dev and staging workers now
  run `30234eb` with all three services healthy. Baked tagged AMI `ami-0cf96ffb91690b17c`,
  promoted launch-template v39/default, and proved a fresh ASG boot at the exact commit with zero
  tracked/runtime drift plus inference/gateway readiness. Restored ELB health with 1,200-second
  grace and min/desired 1, max 192; old v38 workers entered termination.
- Documented two future improvements: authoritative faculty lecture-to-trained-profile
  publishing through the lectures API, and per-model deficit-based batch scaling with
  expiring demand reservations, event headroom, and multi-lecture burst acceptance tests.
- Corrected staging architecture, API, and decision docs to describe coordinator-owned
  per-model admission/reassignment/scale-out instead of the retired 70% ALB policy.
  Documented the current bundled lecture `voiceProfileId` source and the unimplemented
  authoritative faculty publish/API contract, including optional revision pinning.
- Deployed staging lecture-click voice capacity preparation, truthful ready/warming/busy UI,
  five-minute demand-idle model reassignment, and post-admission per-model scale-out. Concurrent
  live canary returned two valid RIFF WAVs, showed usable `BUSY_STARTING`, and atomically raised
  desired 1->2 exactly once. A final one-worker canary returned a 226,604-byte RIFF without scale.
- Fixed simultaneous-admission and duplicate-scale races with live post-admission saturation
  checks and conditional DynamoDB ownership. Rotated the exposed coordinator token without
  printing its replacement, restored missing public-prime auth, and pinned no-assignment boot and
  public prime to Dean while preserving coordinator-assigned autoscale voices.
- Fixed fresh workers warming successfully but remaining unroutable by adding authenticated
  residency registration after boot warm. Promoted tagged AMI `ami-0d58babf0106d7f52` as launch
  template v38/default. Fresh v38 readback proved Dean registration and public prime. Increased
  ASG health grace 600->1,200s after live evidence showed the old grace killed workers before
  the >10-minute deep-warm/prime path completed. Final ASG: min/desired 1, max 192, one healthy
  unprotected v38 Dean worker with two free slots.
- Tests: focused Lambda/coordinator 37/37, worker 32/32 plus earlier 35/35, client 8/8, Node/Bash/
  PowerShell syntax, staging GI build, deployed bundle/401 readback, live idle reassignment,
  concurrent saturation, atomic scale-out, fresh-AMI registration, public prime, scale-down, and
  final RIFF synthesis. Authenticated browser rendering of capacity notices remains unverified.
- Unified faculty voice publishing, ElevenLabs stock-voice support, coordinator routing, learner
  analytics, and crash handling in merge commit `21596bf`; both Dev and staging remote branches
  now point to it. Faculty-published voice is authoritative, stock voices bypass GPU capacity,
  and cloned voices use immutable-profile coordinator routing.
- Repaired staging deployment drift where a later faculty deploy had replaced the main Lambda and
  lecture bundle without the coordinator integration. Dev/staging main Lambdas now share one exact
  package SHA; all seven client targets were rebuilt, the coordinator was redeployed, and fixed
  staging worker services were updated from a recoverable server-side stash. AWS credentials expired
  after starting Dev, so Dev-worker deployment, fixed-worker full readiness, and ASG/AMI readback remain.
- Tests: client 436/436, Lambda 275/275, GPU worker 23/23, inference worker 258/258, live gateway
  180/180, four client builds, later crash/declaration tests 15/15, package inspection, public SPA/
  bundle readback, open category GET, and unauthenticated capacity POST 401. No authenticated browser
  or multi-lecture/two-profile end-to-end test was possible.

## 2026-08-24

- Live-tested the staging coordinator flow. A demand-idle Nathanael GPU reassigned to Dean and
  returned RIFF, a second Dean request reused the resident model, and a no-spare DeanV2 request
  returned `MODEL_CAPACITY_STARTING`, raised desired 1->2, and created an exact pending claim.
  Fresh launch-template v34 instance `i-03c1822c8745e271e` claimed DeanV2 without repair, loaded
  the weight pair in 260s, completed deep warm, registered READY with two slots, and returned a
  436,524-byte routed WAV in 9.57s. A saturation canary observed 2 active/0 queued/max 2; both
  admitted requests returned RIFF and the third was not queued, instead starting another GPU.
  The test exposed one remaining alarm mismatch: scale alarms still observed the bypassed Target
  Optimizer path. `scripts/provision-staging-autoscaling.ps1` now makes legacy ALB scale-out alarms
  telemetry-only and bases 15-minute scale-in on coordinator Lambda invocations. Local checks:
  coordinator 7/7, worker 18/18, Lambda 18/18, client 15/15, GI build, PowerShell syntax, and
  provisioner dry-run. Deployment/readback and final scale-in are blocked by expired `VCS_AWS_*`.
- Completed the staging-only model-aware coordinator rollout. Table
  `vcs-staging-model-workers`, coordinator Lambda, security groups, AMI
  `ami-0591726e79645b0cc`, launch-template v34, ASG, and new instances carry the required
  staging/Interns2026 tags. A fresh v33 node reclaimed and deeply warmed pending
  `deanv2-v1` in 689s, then a routed canary returned a 185,646-byte WAV from that exact
  worker with zero queue wait. A clean v34 node invoked non-executable boot scripts through
  Bash, deeply warmed the dynamic active profile in 599s, registered READY with two slots,
  and required no manual repair; v34 is latest/default and the ASG follows `$Default`.
  Test capacity was returned to desired 1 after idle/queue checks, retaining the ready v34 node.
  The coordinator-aware application Lambda and lectures GI bundle `index-9LY2pSHn.js` are
  deployed, `MODEL_COORDINATOR_FUNCTION_NAME` is enabled, and unauthenticated synthesis
  remains 401. Automated authenticated application audio was unavailable because staging has
  no exempt origin/load-test credential; browser verification remains. Tests: coordinator
  7/7, focused worker 18/18, focused Lambda 19/19, client 15/15, provisioner syntax/dry-run,
  GI build, direct coordinator WAV, fresh-boot warm, live bundle readback, and config canary.
- Canary evidence exposed and locally fixed a fresh-boot failure, but rollout is not complete.
  Coordinator scale-out 1->2 produced a manually updated Dean worker that claimed its pending
  assignment, warmed in 585s, and returned a routed 211,244-byte RIFF with zero queue wait.
  Tagged AMI `ami-0654f7cfed6571a70` and non-default launch-template v32 then launched
  `i-086c0f189f40a6167`, which autonomously claimed `deanv2-v1`; its hard-coded 300s Python
  startup timeout fired before readiness and the restart lost the claim, falling back to Dean.
  Commit `7e8a69d` doubles the worker startup allowance and lets the same instance reclaim a
  live assignment; 7/7 coordinator and 15/15 worker tests pass, and the coordinator Lambda has
  the fix. Worker hotfix upload was blocked when `VCS_AWS_*` expired. ASG is explicitly on v32
  at desired 3 while account default remains v31; routing is still disabled and rollback or
  hotfix deployment is required immediately after credentials refresh.
- Provisioned the staging coordinator foundation but did not enable traffic routing. Created
  deletion-protected on-demand table `vcs-staging-model-workers` with TTL, private coordinator
  SG `sg-0acbdd24318784b70`, and VPC Lambda
  `Liu_Teng_Yu_Intern2026-Voice_Cloning_Project-staging-coordinator`; all carry
  `CreatorId=INTERNS2026`, project, environment, and manager tags. The Lambda status canary
  accessed DynamoDB/ASG/EC2 and registered all five workers as expected-unreachable before
  worker rollout. Commit `60b2bc5` is local; GitHub push lacked credentials. Worker canary did
  not start because deployment role `Liu_Teng_Yu_Intern2026` was denied
  `autoscaling:SetInstanceProtection`; no worker was restarted or modified.
- Implemented but did not deploy the staging model-coordinator slice. A dedicated Lambda
  chooses a matching two-slot worker, otherwise reassigns only a zero-active/zero-queued
  worker after both worker activity and its resident model's demand have been idle for the
  configured interval, otherwise increases ASG desired capacity by one. Workers expose
  authenticated status/assignment routes, reject a hidden third coordinator request, and
  deep-warm an assigned weight pair before readiness. A new instance atomically claims the
  oldest pending model assignment before boot warm and falls back to the active Dean profile
  only when no assignment is pending or the coordinator is unavailable. The lecture client
  preserves a truthful model-starting message. Tests: coordinator decisions 4/4, focused
  Lambda 18/18, focused worker 16/16, client 89/89, staging GI build, both Lambda packages,
  and syntax checks; the new DynamoDB claim path is packaged but not integration-tested.
  Deployment is blocked because the assumed role remains denied `iam:PutRolePolicy` on
  `Liu_Teng_Yu_Intern2026-LambdaExecutionRole`; no coordinator cloud resources were created.
- Corrected staging's over-aggressive low-capacity autoscaling. The baseline alarm now
  requires three consecutive one-minute periods at 70% occupancy and scales to two
  GPUs instead of five; later occupancy steps also require 3/3 periods and add one GPU
  instead of ten. Live policy/alarm readback passed without changing desired capacity.
  Repo config parsing and `git diff --check` passed. Model-aware logical pools remain
  unimplemented: Lambda is outside the VPC, its role cannot manage the ASG, and the
  single Target Optimizer target group is round-robin/model-blind.
- Fixed the staging first-request model reload caused by two cache identities for the same
  S3 weight key. Added one key-derived hashed cache resolver shared by `/models/download`
  and request-time voice enforcement; deep route warm now also carries the complete
  production `voice_model` snapshot. Tests: 20/20 targeted inference/model/warm tests,
  Node syntax checks, Bash syntax check, and `git diff --check`.
- Rolled commit `5634303` across the five serving staging workers. Every worker passed its
  focused cache tests, completed ten two-slot route-warm rounds, reported both services active,
  and loaded identical hashed Dean paths; all five target-group members are healthy. Baked
  AMI `ami-09603b8ca5f8a228b`, promoted launch template v31 as latest/default, and proved a
  fresh v31 scale-out completed deep warm before becoming healthy. Restored desired capacity 5
  and ELB health authority. Authenticated browser first/second-turn timing remains unmeasured.

## 2026-08-21

- Root-caused staging Full's abnormal latency from durable SSE events and verifier code. Session
  `e163e730-aef7-4720-b763-f51fdc0681f1` spent 310.66 seconds on five first-chunk takes because
  lazy `large-v3` verification exceeded its deadline and returned unavailable; chunk two then
  spent 179.14 seconds on five more takes. Full now retains strict beam/timing/tail gates using
  the already-warm medium model by default, and an unavailable verifier keeps the first
  acoustically usable best-effort take instead of regenerating audio that cannot repair ASR.
  Deployed the exact fix to Dev and all five staging workers. The formerly problematic text
  completed directly on staging in 18 seconds with five takes, versus 490.19 seconds before.
- Diagnosed the claimed Dev/staging Full mismatch from live S3 manifests and worker process
  environments. The same passage used one 240-character chunk on Dev but two 170-character
  chunks on staging because Dev explicitly set `FULL_MAX_CHUNK_LENGTH=240` while staging fell
  back to 170. Changed the shared fallback and UI label to 240. Normalized staging DeanVoice's
  profile, rank-1 default, and rank-1 Live Full defaults to Dev values while preserving the exact
  primary and five auxiliary references; bucket versioning and an explicit backup retain rollback.
- Deployed unified commit `2807e1c` to both environment Lambdas; Dev Training/TTS/GI;
  staging Training/TTS/GI; and the staging-only faculty client. Public assets are Dev
  `index-Cc6cF0sB.js`, `index-CvBWG-Iy.js`, `index-B9gUM8Zv.js`; staging
  `index-BkPu5fIc.js`, `index-MsbyZc5S.js`, `index-B9gUM8Zv.js`; faculty
  `index-CdSgyAB-.js`. Every SPA shell returned HTTP 200 with no-store cache headers.
- Deployed the same inference, training-quality, and gateway source to both fixed hosts. Dev
  remains outside any ASG and alone configures `vcs-dev-transcripts`; staging alone retains
  inference-fleet readiness and faculty staff/associate policy with `vcs-staging-lecturers`.
  Dev alone shows advanced controls; deployed-bundle inspection proved staging compiled them out.
- Rolled unified inference quality/pronunciation/retry code across all five staging ASG workers
  under temporary EC2 health, then restored ELB health. All five matched source hashes, reported
  DeanVoice, phoneme and speaker verifiers ready, and were healthy targets. Direct staging worker
  TTS returned HTTP 200 RIFF in 2.28 seconds; Dev public TTS returned RIFF in 8.95 seconds after
  its restart/model load. This short smoke does not prove the prior Full latency tail is fixed.
- Baked AMI `ami-0fdeab564c09be219` with inference fix `331586a` and promoted launch template
  v30. AWS readback proves the AMI is available, v30 is latest/default, and the ASG follows
  `$Default`; a fresh v30 boot remains pending the next natural scale-out. GitHub push remains blocked.
- Unified the local Dev and staging branch tips at merge commit `c18691d`. Advanced TTS controls
  are now one shared implementation gated by `VITE_SHOW_ADVANCED_SETTINGS=true` on Dev and
  `false` on staging. Verified the other intended boundaries: only Dev configures
  `LEARNER_TABLE_NAME`; only staging configures `GPU_STATUS_READINESS_TARGET=inference`.
  Client 412/412, Lambda 200/200, and inference-worker 253/253 passed. Training-worker tests
  remained at the documented 21/22 because its email mock requires absent mail configuration.
  Both Live Fast builds and the Lambda ZIP were prepared, but nothing from this merge was deployed:
  `VCS_AWS_*` expired before rollout. Forty uncached staging current-session probes found no active
  Full request to cancel; the sole observed session was complete.
- Diagnosed screenshot session `8509fed4-c1cc-449c-9965-d8bbdcb9530d`: inference completed
  a valid 929,324-byte WAV in 460.03 seconds. Chunk 0 took 451.95 seconds and six attempts
  after whole-chunk failure triggered sentence fallback; chunk 1 took 7.68 seconds. Existing
  events do not identify which internal verifier/model stage dominated the first chunk.
- Fixed the post-refresh finalization failure at two layers. Added all four staging origins
  to the shared audio bucket CORS and verified the exact result returns HTTP 200, RIFF/WAVE,
  and the staging `Access-Control-Allow-Origin`. Terminal inference now clears worker-local
  SSE prepared state, forcing later reconnects through durable S3 replay. Worker tests passed
  253/253; the focused cleanup test passed on Dev and all five then-live staging workers.
- Rolling staging restarts initially caused two ASG replacements because ELB health remained
  authoritative during cold model loading. Recovery temporarily used EC2 health, patched and
  readied the replacement workers, then restored ELB health; five targets were healthy. Baked
  AMI `ami-0b843a377ac5c8412` and promoted launch template v28 as default. The healthy fleet
  was not recycled, so a fresh boot from v28 remains unverified.
- Investigated an exact staging Full request from the user's screenshot. Session
  `878ab6b4-ee76-48a7-8f23-46fb0204334b` took 429.11 seconds; chunk 0 used all five attempts
  and 312.86 seconds. Refresh created identical session
  `33adc6fc-61be-4da6-be55-768057873031`, which took 401.63 seconds and repeated a
  312.21-second first chunk. The observed ASG scale-out began about 34 minutes earlier under
  the baseline occupancy alarm, so this refresh did not trigger that scaling activity.
- Full and Full Queue generation now persists the accepted session per browser tab, restores
  text/chunks/progress after refresh, reconnects the same SSE stream without a second POST,
  warns before navigation, and synchronously blocks duplicate clicks. Progress explicitly
  names Full Inference. This does not provide cross-tab/device backend idempotency.
- Deployed Live Fast to staging as `index-DOi5z7E_.js` (invalidation
  `ICJUWF1RCYM56MU1GHVCW3VHP3`) and Dev as `index-BG18849o.js` (invalidation
  `I434CDARPHT2W7SJU573U68KIU`). Both invalidations completed and public bundle readback found
  the reconnect and progress copy. Tests: client 411/411 and Live Fast build. The browser
  runtime failed to initialize, so an actual mid-generation refresh remains unverified.
- Fixed a Dev reference-audio data-integrity regression. Auto selection could update the
  primary path while retaining a stale `prompt_text`; the live selected WAV's manifest said
  “a lot of technology that involves patients' data,” but the profile/UI showed unrelated
  COVID-19 text. Lambda now carries transcript/language with warmed references, persists them
  to the saved and active profile plus rank-1 default config, and treats same paths with stale
  prompt metadata as needing repair. The client uses the warmed/manifest prompt and accepts an
  active-profile fallback only when its primary path matches.
- Deployed Dev Lambda and Live Fast asset `index-Dg8e9UEi.js`; invalidation
  `I3UEHK4GOA8D0MNIN8BHX8SWWW` completed. Repaired live `dea-voice-version2-v1` and its
  auto-managed `default` rank-1 config. Public readback proved profile/config/manifest prompt
  equality, the same primary and five auxiliaries in exact order, and same-experiment paths.
  Staging remained on `index-hWSTVBvH.js`. Tests: client 408/408, Lambda 200/200, Live Fast
  build. Audible quality and fresh-browser preview remain unverified.
- Fixed two staging Live Fast UI failures. The shared GPU badge now uses an explicit
  staging-only inference-fleet `/models` liveness probe; Dev still checks its fixed
  worker `/healthz`. A first attempt to gate on loaded-model readiness was rejected
  during live verification because it would block the profile-driven model loader.
  Full output finalization now accepts a fully downloaded RIFF/WAVE blob while the
  tab is hidden instead of waiting for browser media events that Chrome may throttle.
  Deployed staging Lambda and Live Fast asset `index-hWSTVBvH.js`; invalidation
  `I6DAN0EKKBNFANJ5NI8ARCJN7M` completed. Live readback: badge ready, `/api/models`
  200 with 207 entries, inference ready, and Dev asset unchanged. Tests: staging
  client 367/367, Lambda 150/150, Live Fast build; background-tab browser repro pending.
- A user listening comparison reported worse Dev pronunciation/gibberish than staging.
  This is valid outcome evidence but not an isolated algorithm A/B: live staging used
  `deanvoice-v1`, while Dev used `dea-voice-version2-v1`. Do not promote the uncalibrated
  Dev selector/training/verifier work to staging; isolate weights, references, settings,
  and retry policy before deciding which change to revert.
- Fixed three dev client regressions: long current-config filenames no longer push Save new
  outside its card; public background model discovery/loading no longer depends on an
  interactive Entra token refresh (protected calls remain authenticated); and a document
  restored from browser history is reloaded instead of showing the obsolete faculty login.
  Repeated `/api/models/select` probes through Dev GI/Live Fast returned 200; the model Lambda
  itself cannot emit 403. Client tests passed 405/405 and the GI production build passed.
- Redeployed all three Dev clients only. Invalidations completed; HTTP readback returned
  Training `index-DSP9b2By.js`, Live Fast `index-DKYckGK7.js`, and GI `index-Bii-ZJZj.js`
  with `no-store, must-revalidate, no-cache`. The live GI bundle contains D25, `pageshow`,
  and optional model-auth code. No Lambda, GPU, staging, or faculty deployment changed.
- Fixed rank-1 reference lifecycle on dev. Model loading now waits for the selected
  profile's configs; curated/user-reordered rank 1 remains authoritative, while untouched
  auto defaults are recalculated only from the experiment derived from the selected model
  pair. Legacy default configs carrying another experiment's paths are migrated through the
  same safe auto path. Added client and Lambda model/reference ownership guards. The Load
  button changes only the current inference pipeline and no longer activates a profile.
- Repaired live `dea-voice-version2-v1`: its default/profile previously contained six
  `leehseinlongnew` paths. A deployed model-select refresh chose one primary and five aux
  under `dea-voice-version2`; S3 readback proved the profile/config sets are identical,
  all six paths belong to that experiment, rank is 1, and mode is `auto`.
- Client deployment now uploads `index.html` with `no-store, must-revalidate, no-cache`,
  preventing a first navigation from running the deleted faculty-style GI bundle before a
  refresh. Dev Lambda and all three clients were redeployed; invalidations completed and
  public readback returned HTTP 200 with assets `index-DfO-Y2BR.js`, `index-DeMzT9k8.js`,
  and `index-DzQsGqe4.js`. Tests: client 402/402; Lambda 197/197; diff check passed.
- Restored the dev GI login to the centered D25 staging presentation while keeping the
  faculty split-panel presentation explicit and separate. Added a regression test for
  that routing boundary and deployed only dev GI (`assets/index-B8cRtBnz.js`); CloudFront
  invalidation `IBVI7EWNF2UUHAOKXCIC9BE35Y` completed. The public bundle contains the
  D25 copy and dev analytics. Client tests passed 398/398 and the GI production build
  passed; screenshot-level browser verification remains pending because the local
  in-app browser connection failed.

## 2026-08-20

- Merged staging application source into dev while preserving learner analytics and
  explicitly keeping dev schedule/ASG activation off. Commit `5aeb30f` was deployed to
  the fixed dev GPU by Git bundle because GitHub credentials are unavailable locally;
  readback proved the exact SHA, no tracked drift, all services active, and all three
  health endpoints ready. Dev Lambda and training/Live Fast/GI clients were deployed;
  all CloudFront invalidations completed and each public site plus `/api/config` returned 200.
- Added pre-feature training quality gates with SNR, clipping, spectrum, silence, level,
  DC-offset, duration, transcript-density/repetition, duplicate-transcript, and conservative
  dataset-consistency evidence. The retained manifest and rejection report are uploaded.
- Passed full acoustic metadata into frontend/backend reference selection. Failed clips are
  ineligible; the primary remains quality-ranked and auxiliaries now balance quality with
  transcript/source-region diversity. Existing rank-1 config and profile persistence flow
  remains unchanged.
- Added monotonic CTC per-phone alignment evidence, a conservative weakest-phone pass floor,
  and a labeled-data threshold calibration utility. This is deployed only on dev. No real
  training or listening/calibration dataset was run, so audible improvement remains unverified.
- Tests: client 397/397; Lambda 194/194 plus model-selection checks; gateway 180/180;
  inference 252/252 and Python 7/7; training-quality/pipeline 5/5; Python compilation and GI
  production build passed. The unrelated existing gpu-worker SMTP-vs-SES email mock still fails.

## 2026-08-18

- Deployed faculty-only Microsoft SSO to staging. `faculty.lkcmedicine.org` now requires
  sign-in and admits only `staff.main.ntu.edu.sg`/`assoc.main.ntu.edu.sg`; lectures is
  untouched and keeps its student-inclusive policy and main table.
- Created `vcs-staging-lecturers` (`PK`/`SK`, on-demand, `signins-by-day` GSI, TTL on `ttl`,
  PITR). `dynamodb:CreateTable` was never absent from the internship role — it is gated on the
  `CreatorId=INTERNS2026` resource tag, which the 2026-08-17 attempt omitted.
- Granted the gateway instance role `dynamodb:PutItem` on that table through a DynamoDB
  **resource-based policy** rather than an IAM change, since `iam:*` is denied. Confirmed from
  the instance with a non-destructive conditional put.
- Fixed a routing gap the rollout plan missed: the faculty distribution had no
  `/api/live/session/*` cache behavior, so sign-in POSTs hit the Lambda origin and 404'd. The
  behavior was copied from lectures and inserted before the `/api/*` catch-all.
- Stamped `X-VCS-Site: faculty` on the faculty distribution's Lambda and ALB origins, deployed
  the gateway (pull to `a43d671`, `.env` keys, restart; `/readyz` 200 with no problems) and the
  staging Lambda (merge added only the faculty allowlist and emptied `LIVE_AUTH_EXEMPT_ORIGINS`;
  `LIVE_DEMO_LOCKOUT` and `VOICE_PROFILE_INTERNAL_*` preserved), and rebuilt/deployed
  `chatbot-text` (`assets/index-zgw-uRR3.js`, `/*` invalidated).
- Tests: gateway 180/180, Lambda 139/139, client 355/355. Live: both hosts 200, both
  `/api/live/session/signin` 401 unauthenticated, unauthenticated WebSocket refused on both,
  lectures bundle unchanged, lecturer table ACTIVE with 0 items.
- Not yet verified: a real staff sign-in, student rejection, and actual lecturer-table writes.

## 2026-08-17

- Implemented, but did not deploy, faculty-only Microsoft SSO for the staging
  `chatbot-text` build. Faculty uses staff/associate email domains, CloudFront site
  scoping, and a dedicated `vcs-staging-lecturers` table; lectures keeps its existing
  student-inclusive policy and main table. Gateway tests passed 180/180, client auth
  tests 26/26, and Lambda auth tests 11/11. Deployment is blocked because the assumed
  internship role is denied `dynamodb:CreateTable`; the table and Entra faculty SPA
  redirect URI remain unverified and no AWS runtime resource was changed.
- Restored live staging GPU availability to 07:00-19:00 Singapore without deploying
  dev or rebuilding code/images. The staging Lambda now reads `enabled=true`, start
  `7`, end `19`, timezone `Asia/Singapore`; ASG recurring actions now set min/desired
  `1/1` at 07:00 and `0/0` at 19:00, max 192. Readback succeeded in account
  `329599637774`; current in-window ASG capacity remained min 1/desired 2/2 instances.
  `GPU_INFERENCE_ASG_NAME` remains unset on Lambda, so the fixed GPU and ASG schedules
  remain independent. No dev AWS resource was changed.
- Corrected pronunciation precedence across Live Fast, Live Full, regeneration, and
  inserted Full chunks: synthesis aliases still apply first; otherwise an admin
  ARPAbet word now bypasses automatic ALL-CAPS acronym/emphasis rewriting and remains
  one token for GPT-SoVITS hot-dictionary lookup. Without an admin entry, existing
  acronym behavior is unchanged. Centralized the route preprocessing order and added
  regressions for alias-first `STEREOCHEMISTRY`, ARPAbet-only `WHO`, and ordinary
  `WHO`. Full inference-worker suite: 245/245. Not tested: real GPT-SoVITS dictionary
  reload, GPU audio, browser flow, or deployment. Multiword aliases continue to use
  their alias tokens for synthesis and the original full ARPAbet sequence for optional
  full-span verification; automatic per-alias-token phoneme splitting is unsupported.
- Live Fast now applies the existing conservative chemical-formula rewrite before
  synthesis, matching Live Full for inputs such as `C6H12O6`, `(CH2O)n`, `NaCl`,
  and `COOH` without adding a network, model, verification, or retry step. Also
  closed the compact-formula route test correctly so the following test is no longer
  nested. Code: `gpu-inference-worker/src/routes/inference.js`,
  `gpu-inference-worker/src/services/textPronunciation.js`, and their tests. Tests:
  focused worker tests 85/85 and full inference-worker suite 243/243. A local
  100,000-call benchmark measured about 125 microseconds of incremental preprocessing
  per roughly 240-character input. Not tested: real GPU audio, browser flow, deployment,
  and production multi-user latency.

## 2026-08-14

- Staging-only Live Fast now makes two normal takes (`LIVE_FAST_RETRY_COUNT=1`)
  and, only after catastrophic babble remains, up to two additional reseeded takes
  (`MAX_BABBLE_ESCAPE_RESEEDS=2`), for a hard maximum of four. ASR
  `duplicatedWords` now reaches candidate scoring and costs six points per duplicate,
  so best-effort selection no longer ignores that signal. Targeted local tests passed
  19/19; focused tests on the staging canary passed 5/5. The broader worker selection
  still has one known pre-existing compact-formula failure.
- Baked worker AMI `ami-0b05ebda8d96a924f`, made LT v27 the default, and rolled only
  `vcs-staging-gpu-inference`. Two fresh v27 instances passed source-hash, service,
  restart-count, warm-event, and target-health gates. A public faculty-host synthesis
  returned HTTP 200 RIFF. The temporary builder `i-0f6c399842bd8cc38` was shut down;
  the internship role cannot terminate it.
- Staging chatbot-text now exempts only `d3k2rz0hqm8nxi.cloudfront.net` and
  `faculty.lkcmedicine.org` from `LIVE_DEMO_LOCKOUT`; other hosts remain locked when
  the Lambda flag is true. Built and deployed `assets/index-BJPFG8hT.js` to CloudFront
  distribution `E38A3666CJ7FVJ`; both public hostnames returned the bundle. Unit/build
  verification passed, but the live flag was not temporarily enabled and duplicate-word
  ranking has not yet had a controlled listening comparison.

## 2026-08-13

- Aligned the staging inference ASG with the fixed GPU's new 24-hour availability.
  Live min/desired is currently 1/1; the retained 07:00 and 19:00 Singapore actions
  set min 1/max 192 with desired unset, so they do not reset autoscaled capacity.
  Both occupancy alarm actions are enabled. The fixed GPU was independently read
  as running with its Lambda schedule enabled from hour 0 through 24.
  `offHoursMinCapacity` is now 1 and
  the schedule script reads that setting instead of hardcoding a scale-to-zero action.
  Fresh LT v26 instance `i-040b58dedddec65de` completed its full active-profile warm
  in 627 seconds: Whisper medium active, CUDA phoneme model loaded with real decisions,
  10 two-slot RIFF rounds, zero worker restarts, both services active, healthy target,
  and two first-attempt HTTP 200 RIFF public primes. Hot rounds took 2-4 seconds after
  cold model loading; the one-time phoneme-load round took 180 seconds.

- Fixed staging verifier boot on autoscaled GPUs. Whisper-medium startup now has a
  configurable 360-second default instead of the failing 120-second cutoff; boot warm
  resolves the active S3 voice profile, runs once, and prewarms a strict phoneme phrase.
  Added host phoneme/espeak provisioning and cached the full model in AMI
  `ami-0538dcd9374f9ecdb`; LT v26 is default. Targeted Node tests passed 39/39 locally
  and on the canary; shell syntax, PowerShell parse, and `git diff --check` passed.
  Fresh-v26 proof observed one 616-second warm, no restart, Whisper/speaker active,
  phoneme model loaded, both services active, and healthy target. A separate direct
  authenticated public request returned HTTP 200 RIFF in 14.29 seconds. Fresh-v26
  cloud-init then completed without errors and both automated public primes returned
  HTTP 200 RIFF first try. ASG 0/0 and both alarm actions were restored afterward.

- Made GPU boot-warm work for autoscaling instead of only for a manually pre-warmed event
  fleet. `scripts/warm-staging-deanvoice.sh` is a hand-run, DeanVoice-hardcoded script, and
  `WARM_ON_BOOT` was off with no `last_warm.json` in the AMI, so every scaled-out instance
  served its first requests cold (verified live: flag unset, payload missing, no boot-warm
  log, GPU at 2.4 of 23 GB, inference server not even loaded). `warmOnBoot` now falls back to
  the activated voice profile read straight from S3 (`voice-profiles/active.json`) and loads
  that profile's weight pair before the throwaway synth, so a scale-out warms whichever voice
  is actually on demand rather than a hard-coded one. `WARM_ON_BOOT` now defaults on.
  Takes effect only once the AMI is re-baked — the ASG launches from the image, not from git.
- Verification: worker 247/247 minus one pre-existing chemical-formula failure that also fails
  without these changes (243/1 before, 247/1 after); 4 new boot-warm tests.

- Staging only (`codex/staging-multi-user-scaling`): the chatbot assistant instructions are
  now deployable from the UI instead of being a constant in the client bundle. Added Lambda
  route `GET/PUT /api/chatbot/system-prompt` (`lambda/chatbot-prompt/`, S3 key
  `<prefix>/chatbot-config/system-prompt.json`), a Deploy button, and a startup fetch so
  both staging kiosk distributions load the deployed text; the bundled prompt stays as the
  fallback. The editor ships only on the text-chat build (`d3k2rz0hqm8nxi`) via the new
  `showInstructionsEditor` flag — the GI build (`d25sg72wp8oj5g`) reads the deployed prompt
  but shows no panel. The write is unauthenticated by operator decision, so anyone who can
  open the text-chat page can change the prompt for both apps; staging only, not for
  production. Added `chatbot-prompt` to the Lambda packaging allowlist. Tests: Lambda
  13/13, client 31/31, `build:gi` + `build:chatbot`, live anonymous PUT round-trip verified
  and the probe deleted afterwards. Dev does not have this feature — see DECISIONS.md
  "Branch Divergence: Dev vs Staging".

- Changed the GI home page so `Admin analytics` is shown only when the authenticated
  account passes the Lambda's existing supervisor check (Entra `Supervisor` app role or
  `SUPERVISOR_OIDS` allowlist). `/api/learner/me` now returns that authoritative boolean;
  the learner table's profile role is not used for authorization. Tests: learner Lambda
  8/8, focused GI client 30/30, GI production build. Added Entra OID
  `31e46d84-542c-4414-bcc0-1c7c24023198` to the preserved dev `SUPERVISOR_OIDS` allowlist
  (two entries verified). Deployed dev Lambda code hash
  `h3qR9im7D8yIWnI0UU65b+Kyl8jhqAWvmTnC3jsKhWY=` and GI bundle
  `assets/index-BC69UgKb.js`; CloudFront invalidation
  `IDJ90F9DQIQH9163ASVMTV76J` completed. Signed-in browser role visibility remains to verify.

## 2026-08-12

- Attributed learner questions from the question text alone and stopped using the video position for
  them. `evidenceFromEvent` previously fell back to `conceptAt(lessonSlug, videoTime)` whenever
  semantic classification failed, so in practice the playhead decided most question evidence; an
  unclassifiable question now produces no evidence at all. The rewatch signal still uses position,
  which is correct there — seeking backwards over a span is an act on that span. The repeat tracker no
  longer drops a repeat when the video position is unreadable.
  Rebuilt `classifyQuestionConcept` to make that viable: stemmed whole-token and phrase matching
  instead of raw substring (`ppi` used to match inside `happiness`), IDF weighting over the term table
  so a term may legitimately belong to several concepts, a multi-word phrase bonus, and two separate
  gates — an absolute evidence floor (`MIN_CONCEPT_SCORE`) plus the existing 0.75 top-vs-runner-up
  separation. The old scorer had only the separation gate, so a lone generic keyword scored confidence
  1.0. Fixed the stemmer to be idempotent (`messages`/`message` both -> `message`; previously `messag`
  vs `message` silently broke phrase matches) and to handle `ies` plurals and 4-letter abbreviations
  (`PPIs` -> `ppi`). Term lists expanded across all nine concepts; generic action words
  (`treatment`, `management`) removed because they competed with real vocabulary.
  Deliberately not done, per product decision: no quiz/answer items, no concept-duration
  normalisation, no fitted weights, no cross-signal dedup, no per-learner baselines.
  Tests: Lambda 169/169, client lib 42/42 (added 3 classifier tests), GI build. Deployed dev Lambda SHA
  `0zUIY4gsU92MOlYpjLJcHVDq2RAjgLmp7tpYD11x8go=` and client `assets/index-DTuudZ7l.js`;
  invalidation `I75I5VD69VLLWFGMSYLOZD556F` created.

- Redesigned the admin analytics dashboard onto the GI design tokens. `/admin` previously used raw
  sky/rose accents belonging to no palette; brand maroon (`--primary`) now carries the eyebrow, tabs,
  selected student, active filter and evidence badges. Added `--chart-recommended` (#a32a92, a lighter
  step of the same 308 brand hue, because #7c1d6f is too dark to read as a fill) and `--chart-possible`
  (#d97706) as chart tokens in `globals.css` plus `chart.*` in the Tailwind theme; the pair passes
  lightness-band, chroma, CVD-separation and contrast checks against a white card. Layout: sticky brand
  header carrying the back button, cohort totals promoted to a four-tile row, per-concept hover card on
  the chart, ranking key moved below the plot, and the repeated show-more/button markup collapsed into
  shared `BTN_*` constants and a `ShowMoreControls` component. Behaviour, scoring and API calls are
  unchanged. Client analytics tests 4/4 and GI build passed; not visually verified in a browser.
  Deployed dev client `assets/index-BTK_EMbh.js`; invalidation `I31F6NQVYBBV94IRQ5CB8KKDR` created.

## 2026-08-11

- Simplified the Admin Questions tab to use DynamoDB retained conversation turns as its sole source;
  S3 remains the Events audit/analytics lake and is no longer merged into the question list. Client
  analytics tests 4/4 and GI build passed. Deployed client `assets/index-CIZWx4bL.js`; CloudFront
  invalidation `I7PIECXNT3I9XX7U60WL3DNSOQ` created.

- Synced the Admin Questions tab with retained DynamoDB conversation turns, so questions from before
  `question_asked` analytics was introduced now appear alongside newer S3 analytics questions. The UI
  deduplicates matching text within 30 seconds and labels transcript-only history; this is a read-only
  history merge and does not synthesize analytics evidence or change old scores. Also corrected repeated
  questions so their stored `question_asked` record is scoring-neutral: a repeat receives only its
  independent weight-1.0 signal, while an ordinary question receives weight 0.5. Lambda 169/169 and GI
  build passed. Deployed Lambda SHA `3pOuxtlfBowhU7xwgtk1fxDqyFnjGeylhx8KAbJ5Vks=` and client
  `assets/index-weH0TlqD.js`; invalidation `I9RZEH6YNJ7BZDUJT7YRO5JCAM` created.

- Added authenticated `question_asked` events that retain question text up to 500
  characters in the verified-subject per-user lake, add `concept_question` evidence at weight
  0.5 without requiring repetition, and preserve the separate stronger repeated-question bonus at 1.0.
  Admin gains
  a newest-first Questions tab with five-row paging; the contradictory session-only history copy now
  matches the existing 90-day login notice. Tests: Lambda 168/168, focused client 16/16, GI build.
  Deployed dev Lambda SHA `LmaIRq5TGi84/O6k89POtqur7frl04yrrNbAv4bGDk0=` and client
  `assets/index-BAHnDogJ.js`; invalidation `IAHLVFW2NU88X128KFDBF7F7FH` completed.

- Reduced Learning signals density: each concept now starts with its five newest evidence events,
  expands five at a time, and can collapse to five. Reworked the cohort graph to suppress zero-value
  labels, use a clean axis/plot, and move long concept names into a numbered two-column ranking key.
  Client analytics tests 4/4 and GI build passed. Deployed bundle `assets/index-D4DYkxRa.js`;
  CloudFront invalidation `IB23YLOP89ML11KEWH6GKRU58M` completed.

- Changed each Learning signals evidence row from a misleading base `weight` label to its current
  effective score contribution after 14-day decay and logarithmic rank discount, while keeping the
  base weight secondary. Added a deterministic helper/test mirroring the backend formula (4/4 client
  analytics tests pass). Deployed GI bundle `assets/index-CpjVgO1x.js`; CloudFront invalidation
  `IORVV4ED6Q0AX0CU95RT6JQC0` completed.

- Replayed the per-user raw S3 lake through the current learner scorer after verifying that the
  earlier two-per-signal model left DynamoDB with only four Endoscopy events while S3 contained
  16 qualifying Endoscopy events. Added `scripts/backfill-learner-evidence.mjs` with dry-run default
  and explicit `--apply`. Dry run found two learners, 96 raw events, and 17 qualifying events; apply
  updated two concepts for the affected learner. DynamoDB read-back verified Endoscopy at 16 retained
  events, score 3.27, `support_recommended`, and Presentation/epidemiology at one event/0.42.

- Replaced the hidden `/supervisor` UI with a visible `/admin` analytics experience on dev;
  `/supervisor` redirects for compatibility. The home page links to Admin analytics. The dashboard
  shows every authored concept, ranks by support-recommended then possible-support learner counts,
  offers interactive filters, cohort totals, individual summaries/signals, and an Events tab.
  Events remain supervisor-authorized server-side. A slow request-time global-lake fallback was
  removed: new batches now write once to a verified-subject per-user S3 lake, and 32 valid identified
  batches from the retained 44-object global archive were backfilled (12 non-user/invalid records
  skipped; nothing deleted). Events prefetch on learner selection and read newest batches 25-way in
  parallel until the 500-event cap. The browser never receives S3 credentials. Files: `client/src/GiApp.jsx`,
  `client/src/pages/SearchPage.jsx`, `client/src/pages/SupervisorDashboardPage.jsx`,
  `client/src/services/learnerAnalytics.js`, `lambda/analytics/index.js`,
  `lambda/learners/eventRepository.js`, `lambda/learners/index.js`, `lambda/learners/repository.js`,
  `lambda/router.js`, and tests. Full Lambda suite: 165/165 pass. GI production build passed with the
  existing bundle-size warning. The final dashboard uses an animated grouped vertical concept graph;
  the cramped Table mode was removed. Learning signals separates status, decayed score, qualifying count, signal
  types, and individual evidence timestamps/weights. Fixed the Events effect self-cancelling its
  successful response, added an action-count summary, newest-first 10-row paging, and a spacious
  responsive graph with reduced-motion-safe staggered animation. Removed the unintended 3-point hard
  score cap and changed decay to apply per logarithmic rank, so stale retained events cannot suppress
  newer evidence. Thresholds are now visible in Learning signals. Deployed dev Lambda SHA
  `07MyViCb7NCCTed3O0JXXdPcZR2RdwWmxAPQnL7L2j4=` and GI bundle `assets/index-CjftY7ww.js`;
  invalidation `I19PYX6HN731WSDOKR0IOAQJBM` completed. Direct S3-reader
  verification returned the allowlisted user's 93 events in 289ms, untruncated. Signed-in visual
  interaction remains to be browser-verified. Staging unchanged.

## 2026-08-10

- Stopped rewriting an unchanged lesson summary on every analytics batch. `recordBatch`
  rebuilt and `Put` the `#SUMMARY` item for each touched lesson unconditionally, with no
  dirty check. The per-lesson `Query` prefix widened from `LESSON#<slug>#CONCEPT#` to
  `LESSON#<slug>#` so the stored summary returns in the same request (no extra read), and
  the `Put` is skipped when the rebuilt summary is content-identical ignoring `updatedAt`
  and `ttl`. The TTL is still refreshed once the stored value falls more than half a TTL
  period behind the new one, so a summary cannot expire while its concepts live on. Files:
  `lambda/analytics/learnerStore.js`, `lambda/analytics/learnerStore.test.js`.
  Tests run: `node --test lambda/analytics/learnerStore.test.js` — 12 pass, including three
  new cases (unchanged summary not rewritten, changed summary still written, TTL run-down
  forces a rewrite). Deployed to dev only via `scripts/deploy-lambda.ps1 -Env dev`
  (`Liu_Teng_Yu_Intern2026-Voice_Cloning_Project`, code SHA `+BwpRwlJh62KoVSeS3NCjPt5DYFWziOt2PABXvc4fQU=`).
  Staging unchanged. Not yet exercised against a live signed-in learner batch.

- Reworked the learner support scoring model and deployed it to dev (`c6b59b4`, `c571480`).
  Evidence now decays on a 14-day half-life instead of holding full weight until the 30-day
  cliff, and the per-signal caps of two became a 20-event retention limit with logarithmic
  growth per signal, so frequency keeps counting instead of saturating. Thresholds were
  recalibrated to preserve the states the linear scale produced (`POSSIBLE_SUPPORT_SCORE`
  0.75, `SUPPORT_RECOMMENDED_SCORE` 1.55, `STRONG_SUPPORT_SCORE` 2.3, split from the score
  cap). Chatbot guidance now sends concept and support state only, with a test asserting no
  signal name, score, or count can leak into the prompt. Files: `lambda/analytics/concepts.js`,
  `lambda/analytics/learnerStore.js`, `lambda/learners/repository.js`,
  `client/src/lib/learnerGuidance.js` and their tests. 459 lambda + client tests pass;
  calibration is locked by tests. Retention applies only to evidence collected from here on.
- **Incident:** while removing the dead `LEARNER_SUMMARY_MODEL` variable, a PowerShell 5.1
  command using `Join-String` (PowerShell 7 only) interpolated to `Variables={}` and wiped
  every dev Lambda environment variable. Restored 21 keys from `lambda/.env.deployment` plus
  `GPU_SCHEDULE_ENABLED=false`; verified `/api/learner/me` and `/api/supervisor/users` return
  401 rather than failing. `SUPERVISOR_OIDS` had not been set, so no value was lost and
  supervisor access continues through the `SUPERVISOR_APP_ROLE` app role. No published Lambda
  versions existed to roll back to, so recovery depended entirely on the repo file.

- Fixed the analytics write path summarising learner concepts from raw stored DynamoDB
  attributes, which reported expired evidence as active support for concepts not touched by
  the current batch. Both paths now share `currentConceptState`. Removed the OpenAI learner
  summary generator, whose output was stored but never served because reads always rebuild the
  rule summary; rules are the single source of truth and may be revisited later. Files:
  `lambda/analytics/learnerStore.js`, `lambda/learners/repository.js`, `lambda/.env.deployment`,
  deleted `lambda/analytics/summaryGenerator.js(.test.js)`. Added a regression test covering
  stale untouched concepts and confirmed it fails against the previous behaviour; full lambda
  suite passes (153 tests).

- Granted the two current developers dev-only `/supervisor` access through the Lambda's
  verified Entra object-ID allowlist. No staff email or DynamoDB role is required, no IDs
  were committed, and staging was unchanged. Updated the deployment map and corrected the
  recorded repeated-question weight to the deployed value of `1`.

- Added a supervisor-only cross-learner concept ranking. It ranks by the number of distinct
  identified learners at the maximum bounded support-signal score (`3`), then uses broader
  support-state learner counts only to break ties. The dashboard shows count, denominator, and
  percentage; chatbot personalization never receives the cohort rank.

- Reframed dev learner analytics as conservative support guidance rather than uncertainty
  prediction. Rewinds now contribute `0.5` at most twice, clarification requests contribute
  `1` at most twice, and the internal score caps at `3`. Long pauses and transcript scrolling
  remain in raw analytics but no longer affect concept state. Statuses are now
  `no_support_inference`, `possible_support`, and `support_recommended`; the supervisor UI no
  longer displays a pseudo-assessment score. Detailed current-turn explanation requests are
  explicitly preserved, while persistent style preferences, learner confirmation, and
  knowledge checks remain future work.
- Chatbot personalization now receives structured concept-specific guidance and must match the
  current question's concept before applying it. It ignores supervisor `focusConcepts` and
  receives every qualifying concept. Concept ranking remains dashboard-only, and
  low-signal concepts cannot be promoted by the optional summary LLM.

## 2026-08-07

- Replaced unlimited dev learner accumulation with a 30-day rolling model: score cap 5,
  two retained events per signal, count cap 8, event-id deduplication, concurrent-update retries,
  and read-time expiry. Short clarifications such as “even simpler” inherit the prior question's
  topic. Supervisors can reset one concept and automatically rebuild its summary. Lambda 151/151,
  client 350/350, GI build, live bundle/Lambda/auth/GPU checks passed. Existing dev concepts were
  conditionally migrated to scores 5 and 1.5; staging was untouched.

- Fixed inflated dev GI learner evidence after a real NTU test. One scrubber drag emitted
  several native `seeked` events and repeated transcript scrolling emitted duplicate review
  signals, producing score 8 instead of 2.75. The client now coalesces one seek gesture and
  records one transcript review per visit. Client tests pass 348/348; dev bundle
  `assets/index-DBQt8Fr-.js` is live. A cold check also proved GI starts the dev GPU.

- Fixed the dev GI text-working/Dean-audio-401 split. CloudFront OAC signs the Lambda Function URL
  with SigV4 `Authorization`, so the browser's bearer header could not survive to Lambda. Authenticated
  Lambda REST calls now use forwarded `X-VCS-Entra-Token`; Lambda prefers it and retains bearer fallback
  for direct callers. Client 346/346 and Lambda 143/143 passed, as did GI build/package. Dev Lambda and
  bundle `assets/index-6qG3aJlL.js` are live after completed invalidation; staging was untouched.

- Added dev-only GI live-chat handshake visibility after a signed-in session was reported stuck on
  `Connected. Preparing live chat...`. The client now handles gateway auth rejection explicitly and
  ends setup after 15 seconds without `session.ready`. Client tests passed 346/346, the GI build
  passed, and live dev serves `assets/index-CXMDfndS.js` with both messages and `deanvoice-v1`.
  Dev gateway/ALB and direct OpenAI Realtime setup were healthy; a signed-in browser retry remains
  necessary to identify the actual auth/init failure. Staging was not changed.

- Removed GI's unnecessary startup profile request, which could race token availability and falsely
  show `Sign in to load the lesson voice` plus `No cloned voice is set up`. Both GI clients now become
  ready from configured ID `deanvoice-v1` and include it in every synthesis request; the backend
  resolves the saved model/reference profile during synthesis. Dev `d2o` bundle
  `assets/index-CplLB5_6.js` and staging bundle `assets/index-Cklj8mCD.js` are live. Full client tests
  passed 344/344 dev and 328/328 staging; both builds and live no-old-route inspections passed.

- Fixed GI startup voice selection in dev and staging. Both GI builds now fetch the saved
  `deanvoice-v1` profile through an authenticated read-only endpoint and pin that exact model/reference
  snapshot for the conversation. They neither depend on nor mutate shared `active.json`, so TTS or
  training users can change the globally active voice without blocking GI. Dev bundle
  `assets/index-B0E_z1t1.js` and staging bundle `assets/index-C3Y7_cZC.js` are live after completed
  invalidations. Client dev 343/343, client staging 327/327, Lambda dev 142/142, Lambda staging
  125/125, both GI builds, live bundle inspection, and unsigned endpoint 401 checks passed.

- Fixed dev GI cloned voice returning `Sign in to use the voice assistant` after a valid
  Microsoft sign-in. The shared Axios voice client omitted the bearer token even though the
  WebSocket and learner APIs sent it. Dev bundle `assets/index-BPBBhsIk.js` now attaches the
  configured token. Lambda voice auth is scoped to GI requests using its deployment-controlled
  `X-Demo-Request` CloudFront origin header; normal dev TTS, Training, and Dean tools remain
  public, while analytics/supervisor routes remain authenticated. Client 343/343, Lambda
  140/140, GI build/package, live GI unsigned 401, and public-dev unsigned 400 validation pass.

- Added and deployed a secondary supervisor analytics view to dev only. Each learner keeps
  Summary as the default tab; Learning signals is optional, lessons are collapsible, and
  qualifying concepts show ranked score bars, cautious status, total evidence-event count,
  contributing signal types, and update time. The UI does not invent unavailable per-signal
  counts. After rebasing onto the latest remote dev-parity changes, client 342/342, Lambda
  139/139, and GI build passed; bundle `assets/index-DYklguXz.js`, completed invalidation,
  and anonymous supervisor 401 were verified.

- Improved and redeployed dev-only repeated-question evidence: deterministic concept matches
  at confidence 0.75 or higher may cross video timestamps; ambiguous, tied, or unknown
  questions still require the same timestamp-authored concept. Accepted matches score 1.25
  with an 8-second floor, 10-minute window, 0.65 similarity threshold, and two-signal cap.
  Analytics/S3 excludes question text; DynamoDB transcripts retain it. Lambda 139/139,
  client 331/331, GI build, dev Lambda update, live bundle `assets/index-BXcd6-Hm.js`,
  completed invalidation, config check, and anonymous learner 401 all passed.

- Enabled PITR and deployed authenticated per-user learner analytics to dev only: the
  non-staging Lambda, fixed dev gateway, dev chatbot CloudFront/S3 target, and
  `vcs-dev-transcripts`. Added the dev `/api/live/session/*` gateway behavior.
- Proved gateway `PutItem` through the actual instance profile with an expiring probe;
  verified gateway readiness, public login/retention notice, completed CloudFront rollout,
  and anonymous 401 responses for learner, supervisor, and sign-in routes.
- Fixed dev deployment env selection, scoped host Git safe-directory handling, and failed
  SSM status reporting in the local commit; push remains blocked by missing GitHub auth.
- Tests: Lambda 135/135, gateway 154/154, client 327/327, GI production build. Still
  unverified: real NTU sign-in, resulting rows, personalization, and supervisor acceptance.

## 2026-08-06

- Implemented a dev-first identified learner analytics MVP: verified-token event ingestion,
  authored GI concept mapping, DynamoDB evidence aggregation, deterministic/optional
  structured-LLM summaries, chatbot personalization retrieval, and supervisor-protected
  API/UI paths.
- Created the dev DynamoDB table with its user index, TTL, deletion protection, and tags.
  Stopped before deployment when PITR and runtime-policy operations were denied; the live
  dev application remains unchanged.
- Tests run: Lambda 135/135, gateway 154/154, client 327/327, and dev GI production build.
- Untested: real NTU sign-in, live Lambda/gateway writes, OpenAI summary call, CloudFront
  supervisor/session routing, browser dashboard, and end-to-end personalization.

- Restored the Live Fast TTS advanced-settings collapsible by enabling the existing
  shared frontend feature flag, then deployed only the dev and staging `live-fast`
  clients. Training and chatbot/GI distributions were not changed.
- Verification: `npm.cmd run build:live-fast` passed; both CloudFront invalidations
  completed; both public TTS bundles contain the restored advanced-settings UI.

## 2026-08-05

- Unified the dev and staging application histories, including staging SSO,
  transcript/sign-in recording, and dev lesson analytics, then deployed the combined
  source to both environments without changing their environment-specific settings.
- Added authenticated staging load-test/public-prime requests, a safe Lambda env merge,
  and a direct speaker-similarity diagnostic. Rotated the staging prime credential.
- Installed `resemblyzer==0.1.4` on the staging GPU image and enabled relay liveness
  health semantics for the fixed port-3003 SSE target; readiness remains in force for
  autoscaled inference targets.
- Verification: sign-in client tests 9/9, targeted gateway tests 51/51, script syntax,
  speaker sidecar model load, and direct speaker similarity (same sample: ~1.0) passed.
- Audited environment separation: dev and staging use distinct fixed EC2 instances,
  Lambdas, ALBs, CloudFront paths, and S3 prefixes; only staging has an ASG. Both
  environments carry the SSO code, while SSO remains enabled only in staging runtime.
- Promoted staging AMI `ami-09d03a73cf78729ab` as launch-template v24 after baking
  the unified application source with `resemblyzer==0.1.4`; restored ASG ELB health
  checks after the replacement target reached healthy readiness.

## 2026-08-03

- Implemented and deployed dev GI behavior analytics. The browser batches lesson,
  play/pause/seek, navigation, tab, and transcript-scroll events to the new
  `POST /api/analytics/events` Lambda route; Lambda validates an allowlist and writes
  gzip NDJSON to `echolect/analytics/events/date=.../hour=.../` in S3.
- Added two-minute rewind/skip and long transcript-pause context to the live gateway.
  The AI treats these only as uncertain review/reflection signals, never proof of
  confusion or mastery. No mock email or client-supplied user identity is stored.
- Verification: client analytics/context 21/21, Lambda analytics/router 12/12,
  local gateway 56/56, dev-host gateway 56/56, GI production build, gateway health,
  public ingest/readback, and automatic browser session events all passed.
- Reconciled the earlier three-file dev gateway hot patch through Git: preserved the
  patch in a named stash, fast-forwarded the host from `070a99a` to remote `ce75eab`,
  reran 56/56 gateway tests, restarted healthy, and dropped only that temporary stash.
- Recorded the 55-node inference-readiness/autoscaling audit, the fixed SSE relay's
  fail-open health-check mismatch, and staging's missing `resemblyzer` dependency.
  History does not support treating the missing speaker gate as a fleet-wide latency
  decision; separately documented the intentional first-live-clip verification bypass.
- Replaced the obsolete dev-duplication proposal with the deployed environment map,
  documented branch/IAM/runtime-role ownership, changed dev deployment access to SSM,
  and marked the unpushed GitHub-origin state as a handoff blocker.
- Created and read back staging event actions for 2026-08-04: min/desired 50 at
  13:30 SGT and min/desired 1 at 16:00 SGT. Existing 07:00/19:00 recurrence and
  exact-capacity five / change-capacity +10 reactive policies remain enabled.
- Fast-forwarded dev application source to the staging implementation and deployed
  commit `070a99a` to the fixed dev GPU, Lambda, and all three dev frontends.
- Made dev CloudFront behavior configs equal to staging after substituting dev-only
  Lambda, ALB, and S3 origins. Kept the extra staging chatbot-text distribution absent.
- Kept dev fixed-instance only: schedule mode false, no ASG coupling, no dev ASG or
  scheduled capacity actions. Added the tested two-slot inference queue settings.
- Enabled dev inference boot warming after the stricter readiness check exposed a
  post-restart ALB deadlock; local health and the ALB target both returned healthy.
- Verification: Lambda 105/105, gateway 55/55, client 296/296, three client builds,
  normalized CloudFront parity, public HTTP/API/video/activity checks, and service
  health. Full inference and training-worker suites still each have one test issue.

## 2026-08-01

- Deployed fixed-GPU/inference-ASG lifecycle coupling code and added safe deployment
  helpers. Lambda tests passed 105/105 and packaging passed. Exact state coupling was
  rolled back after the Lambda role lacked Auto Scaling permissions.
- Created and verified recurring inference-ASG actions: 07:00 Singapore restores
  min/desired 1 and 19:00 sets min/desired 0. Immediately scaled the ASG to zero because
  the fixed GPU was already stopped; retained the August 3 08:30/17:00 event actions.
- Verified the two named validation GPUs are stopped standalone instances. Attempts to
  deregister/terminate them were denied, so no validator was deleted.
- Restricted Lambda deployment output to function name, timestamp, and code hash after
  the prior AWS CLI response exposed environment values; recorded coordinated internal
  authentication-value rotation as required follow-up.

## 2026-07-31

- Recorded the next capacity plan: publish occupied/total/no-capacity/pending metrics
  every 10 seconds, include admission pressure in scale-out, compare short jittered
  retries with a fair central queue, prewarm additional capacity for a known 150-user
  simultaneous event, and test both an immediate burst and a 30-60 second ramp.

- Clarified voice-resolution scope: GI now adds a pinned model snapshot, regular Live
  Fast/Full already pins its selected model, and ID-only direct callers still resolve
  saved profiles. The optimization does not globally disable S3 profile resolution.
- Decomposed the final 150-user tail. First-turn p95 had 9.75 seconds of capacity-retry
  sleep; the 22.35-second maximum slept 19.75 seconds across 12 retries. Two later
  outliers instead spent 9.50-16.55 seconds outside Lambda with warm workers. Recorded
  capacity admission and transit investigation as separate follow-up work.

- Deployed eager Live Lambda initialization at 512 MB and made the GI client freeze/
  send the full GPT/SoVITS voice snapshot. Any router warmup now prepares Live; no
  provisioned concurrency was added. Updated deployment configuration and load tests.
- Deployed GI bundle `index-DENtXOAd.js`. Browser render had no console errors. The
  GPU-free first invocation fell from 4.618 s to 15.71 ms; real profile resolution
  became 0 ms. Strict-ready 50-GPU reruns passed 100/100 and 150/150 three-turn users.
- Tests: 102 Lambda tests, 85 client tests, GI build, direct cold/warm probe, browser
  bundle/render check, pinned real-flow smoke, 50/50 readiness, and full 100/150 load.
- Deployed request-level Live TTS diagnostics: Lambda cold/environment/request IDs,
  capacity retry count/sleep, preserved queue timing where available, and load-harness
  request-to-headers/body-transfer splits. The router now forwards AWS context.
- Isolated first-hit latency with CloudWatch and GPU-free probes. The lazy Live route
  import consumed 4.618 s cold versus 1.95 ms warm at 128 MB; AWS Init Duration was
  only 128.57 ms. A reversible 512 MB A/B reduced it to 1.071 s, then restored 128 MB.
- Tests: full 101-test Lambda suite, harness syntax/diff checks, cold/warm CloudFront
  and direct real-flow TTS, exact request/REPORT correlation, and invalid-body no-GPU
  cold/warm plus memory A/B probes.
- Fixed and live-applied quiet inference scale-in by feeding Step Scaling explicit
  zero request datapoints through CloudWatch metric math. A desired-3 proof reached
  desired 1 after the 15-minute quiet window and two conservative `-1` actions.
- Repeated the real three-turn event flow with first-chunk verification enabled and
  recorded text-done-to-first-WAV latency. Completion was 100/100 at 50 GPUs,
  149/150 at 50 GPUs, 150/150 after strict 60-GPU readiness, and 100/100 at 60 GPUs.
  The pre-scale 150 wave sampled 82%, triggered 50->60, and the added fleet passed
  strict health/service/cloud-init/public-prime proof; no second +10 occurred.
- Tests: full 100-test Lambda suite, full 55-test live-gateway suite, PowerShell
  parser, four public complete-flow waves, 50/50 and 60/60 strict readiness, live
  scale-out, live quiet scale-in, and a final HTTP 200 RIFF smoke in 6.28 seconds.
  Raw reports remain ignored under `.tmp/`.
- Reconciled the next-session handoff, decisions, API notes, project map, event TODO,
  and deployment runbook with the deployed `fc99271` bundle and current tiered
  occupancy policy; removed stale branch, bundle, baseline-ID, and rejection-policy
  guidance without deleting historical test results.
- Deployed staging Live Fast early-sentence voice: multi-sentence replies can begin
  TTS after the first confirmed complete streamed sentence instead of always waiting
  for the full OpenAI response. Live Full/non-phrase behavior is unchanged.
- Deployed staging Lambda timing headers and load-harness collection for profile
  resolution, worker round trip, and Lambda total. Target Optimizer did not preserve
  the worker queue header, so the harness now keeps missing queue time as null.
- Verified 79 client helper tests, full Lambda tests, 55 gateway tests, GI build,
  public RIFF/timing smoke, deployed bundle `assets/index-DJ5lJmLS.js`, real browser
  playback (12.42 s new session; 3.26/2.96 s warm turns), and one successful scripted
  full-flow control. No population p50/p95 A/B was run.
- Added the browser-equivalent 15-second WebSocket keepalive to the complete-flow
  harness, explicit report timestamps, and keepalive counts. Corrected readiness to
  retry pending SSM command distribution instead of false-failing a warm fleet.
- Added desired 300-second ALB idle-timeout configuration plus a standalone apply/
  read-back script. Live apply was denied by IAM, so staging remains 60 seconds;
  the main provisioner does not depend on that denied permission.
- Ran four real three-turn flows without changing production OpenAI or Live Fast:
  50/100, 50/150, fully primed 60/100, and 60/150 all completed 100%. Keepalive
  removed the earlier 33/100 and 13/150 WebSocket-collapse result.
- Captured reactive 50->60 timing. A 73% 07:00 occupancy point alarmed 07:03:48;
  launch 07:04:01, all healthy 07:09:27, and all public-prime markers by 07:11:30.
  Post-scale 100/150 waves peaked at 27.5/47.5%, so no second increment occurred.
- Restored min/desired 1, retained max 192 and Aug 3 actions, verified both occupancy
  alarms enabled/OK, and left `vcs-staging-tg-3002` healthy.
- Added tiered occupancy scaling. Below five healthy GPUs, 70% occupancy sets exact
  capacity five; at five or more, the existing policy adds ten. This prevents a
  one-GPU baseline from jumping directly to eleven.
- Generalized local deep-warm to the configured 1-4 synthesis slots. A temporary
  three-slot fleet rollout passed only 39/50 mandatory gates and was rejected before
  user load. Restoring two slots passed 50/50.
- Hardened event readiness so a boot-time public-prime log cannot be reused after a
  worker restart. Promoted launch-template v20 metadata and retained two slots.
- Re-primed the public route with 100/100 valid WAVs, then ran hot real-flow controls.
  The 100-user run completed 33/100 sessions; 150 completed 13/150. Most failures were
  WebSocket 1006 while turn-one completion exceeded the ALB's 60-second idle timeout.
  This is an active gateway reliability issue, not evidence for three-slot capacity.
- Corrected the schedule record: CloudWatch showed one Lambda invocation every five
  minutes, proving an automatic invoker exists, although this role cannot inspect it
  or verify the exact 07:00/23:00 transition.
- Tests: JSON parse, PowerShell parse/dry run, Bash syntax, three-slot canary/fleet
  warm gates, two-slot 50/50 restore gate, public 100-request RIFF prime, and real
  100/150-user three-turn flows. Final AWS cleanup could not be re-read after the
  separate PowerShell credentials stopped being inherited by Codex.
- Replaced rejection-driven scale-out with a live one-minute occupied-slot percentage:
  occupied optimizer slots / (`HealthyHostCount * 2`). At 70% the ASG adds exactly
  10 and re-evaluates later samples; it is active outside event mode. The old
  rejection alarm remains telemetry-only with actions disabled.
- Promoted launch-template v19. Public prime retries now require HTTP 200 plus RIFF;
  the old `skip_verify` path was removed. Added an SSM-batched event-readiness gate
  and verified a 50/50 fleet through health, services, cloud-init, and prime markers.
- Rescheduled live actions to 2026-08-03 08:30/17:00 SGT. Enabled the Lambda GPU
  schedule flag and verified its in-window decision, but EventBridge creation was
  denied; the timer is not operational. The fixed gateway remained running/healthy.
- Ran the real WebSocket -> OpenAI -> chunked DeanVoice flow at 50 GPUs/two slots.
  The 100-user run completed 99/100 three-turn sessions; the 150-user run completed
  130/150. Failures were WebSocket 1006, not failed completed TTS chunks. Occupancy
  triggered 50->60 after the approximately 160-second 150-user wave, too late to
  rescue it. Three slots were not tested because safe canary isolation was denied.
- Returned the inference ASG to min/desired 1. PowerShell parsing and the 50-target
  readiness run passed; raw JSON reports remain ignored in `.tmp/`.
- Repeated the v17 public event rehearsal without replacing prior evidence. Verified
  3.0 TiB visible gp3 usage against the 50-TiB quota, LT/default v17, the paired
  August 2 actions, the armed rejection alarm, and all 50 initial nodes through ALB
  health plus independent cloud-init/public-prime/service checks.
- The measured 100-user three-turn run completed 100/100 in 95.29s. The hot
  150-user run delivered turn one to 150/150 and completed 147/150 in 134.77s;
  three WebSockets closed code 1006 before turn two and no TTS chunk failed.
- The 150-user wave produced 379/777/171 optimizer rejects across three one-minute
  buckets and triggered the configured fixed step from 50 to 60. All 10 added GPUs
  joined the target group and completed public prime. They became ready after the
  short burst, confirming that scheduled prewarm is still required.
- Diagnosed an excluded 0/100 setup attempt: the separate staging control instance
  owning the live gateway was stopped, so every WebSocket received 503. Starting it
  restored the route and a full-flow smoke passed. The event runbook/TODO now require
  explicitly starting and health-checking that gateway because the inference ASG
  schedule does not control it.
- Restored ASG min/desired 1 and max 192, preserved the August 2 schedule, restored
  the live-gateway instance to its original stopped state, and passed a final public
  TTS RIFF smoke in 3.15s. Raw reports remain ignored under `.tmp/`.
- Code files changed: none. Markdown changed: repo `docs/staging-architecture.md`
  plus mirrored `HANDOFF.md`, `TODO.md`, `BUGS.md`, `CHANGELOG.md`, and
  `docs/deployment.md`.
- Later the same day, added `scripts/ensure-staging-live-gateway.ps1`. It starts the
  fixed gateway only when necessary, waits for its exact port-3002 target to become
  healthy, and has no stop/schedule behavior. Live verification passed and the gateway
  was left running. The stored 07-23 Singapore schedule was audited but is disabled.
- Corrected the chatbot harness to use the deployed browser's chunking and short-first-
  phrase helpers. First-chunk verification now defaults on; capacity-only runs must set
  and report `VCS_CHATBOT_SKIP_FIRST_VERIFY=true`. Parser/dry-run checks, 32 helper
  tests, and a verified one-user public flow passed.

## 2026-07-30

- Verified two independent fresh-fleet failure layers. First-boot unattended upgrades
  restarted warmed v15 services and erased model readiness; commit `407ab93` and LT
  v16 mask update units and gate every worker restart on full warm. Stable v16 still
  completed only 48/100 fresh users, proving service restart was not the sole cause.
- Added automatic realistic public-route priming in commit `4d06d14` and promoted LT
  v17 on AMI `ami-021aeb72894b8c79b`. Each new node deep-warms locally, starts Target
  Optimizer, waits 90 seconds, sends two public first-clip syntheses, and waits 45
  seconds for backend work hidden by CloudFront 504 to finish.
- Fresh auto-primed v17 50 GPUs completed 100/100 three-turn users with first-audio
  averages 6.51/2.16/2.03s. Hot 150 delivered turn one to 150/150 and completed
  148/150; two later WebSockets closed 1006 and no TTS request failed. The August 2
  scale-up now starts 06:50 SGT so preparation completes before 07:15; scale-down
  remains 18:00.
- Tests: PowerShell parse/dry-run, embedded Bash syntax, JSON/diff checks, v16 canary
  restart audit, 50-target health audits, manual public-prime A/B, v17 canary prime,
  fresh v17 100-user full flow, and hot v17 150-user full flow. Raw JSON is ignored
  under `.tmp/`; full timing and evidence are in repo `docs/staging-architecture.md`.
- Changed the requested 2026-08-02 staging event prewarm from 32 to 50 GPUs in
  `scripts/staging-autoscaling.config.json` and the deployment documentation.
  Applied the live Auto Scaling scheduled action and read back min/desired 50,
  max 192 at 07:15 SGT; the paired 18:00 action remains min/desired 1, max 192.
- Ran public three-turn WebSocket→OpenAI→DeanVoice rehearsals. Newly warm 50 GPUs
  completed 48/100 sessions; hot 50 GPUs completed 129/150; a real zero-capacity
  alarm scaled 50→80; route-warmed 80 GPUs completed 150/150. Restored min/desired 1.
  Raw JSON remains under ignored `.tmp/`; detailed timing is in repo
  `docs/staging-architecture.md`. No application code changed.
- Changed the provisioned scale-out condition from zero sampled capacity plus rejects
  to a configurable rejection threshold and fixed GPU increment; live/default is one
  rejection in 60 seconds adding 10 GPUs. Exact 30-second triggering is unavailable
  from the standard ALB metric. Updated route warm
  to launch two concurrent same-model TTS calls and require two RIFF results. Bash
  concurrency/syntax and PowerShell/JSON parsing pass. The live alarm/policy were read
  back successfully.
- Baked the two-slot gate into AMI `ami-0a2618372e7f8b8da` from commit `fff074c`
  and promoted launch-template v14. A fresh validator completed both route syntheses
  in 3 seconds and cloud-init warm-up in 206 seconds, became healthy through Target
  Optimizer, and passed public RIFF synthesis. It is stopped but requires an admin to
  deregister and terminate it because this role is denied those actions.
- Repeated the public three-turn event rehearsal on v14. Newly warmed 50 GPUs
  completed 68/100 users (32 first-chunk 504s); hot 50 completed 144/150 (six
  WebSocket 1006 closures after turn-one voice). A real 226-rejection minute proved
  fixed scale-out 50->60, and fully route-warmed 60 GPUs completed 150/150 with no
  failures. Raw JSON is ignored under `.tmp/`; detailed audio-only timing is in repo
  `docs/staging-architecture.md`. The fleet was restored to one after testing.
- Strengthened `scripts/warm-staging-deanvoice.sh` from one two-request pair to 10
  configurable two-slot rounds (20 syntheses per GPU), cycling representative medical
  chunks through first-chunk and verified later-chunk paths before Target Optimizer
  starts. Sequential mocks verified 20 calls, mode distribution, non-RIFF failure,
  invalid-round rejection, and Bash syntax.
- Deployed that deep warm from commit `330d329`, baked AMI
  `ami-021aeb72894b8c79b`/snapshot `snap-09cf487a09a2c82f3`, and promoted launch
  template v15. A fresh validator completed the 10 rounds in 26 seconds and total
  cloud-init warm in 256 seconds before Target Optimizer started. The mitigation
  failed its public proof: newly warmed 50 GPUs completed 59/100 sessions (40
  first-turn 504s and one later WebSocket 1006), while the same hot fleet completed
  150/150. This disproves more localhost synthesis as a sufficient readiness fix.

## 2026-07-29

- Consolidated the staging takeover memory after final testing: added the exact
  WebSocket/TTS test method, timing-boundary glossary, complete 32/51-GPU and saturation
  ledger, burst/retry interpretation, ASG-owned warm-up rationale, rebuild/deployment
  runbook, and future-option tradeoffs. Added post-event roadmaps for durable multi-user
  training and horizontally correct Live Full, and updated the Week 18 internship entry
  with the architecture/testing lessons learned.
- Replaced completed-request autoscaling with a strict Target Optimizer capacity rule:
  +60% only after a sampled zero-capacity minute plus rejected traffic; one-instance
  scale-in after 15 no-traffic minutes. Added bounded retry marking and worker-local
  retry priority. Legacy target tracking is neutralized because deletion is denied.
- Added real `/inference/tts` RIFF warm-up and duration/report controls to the staging
  load harnesses. Final AMI `ami-0ffe20a0a5986a0cb` contains commit `2ab26ee`;
  launch-template v13 is default.
- Verified 100 sequential users with verification skipped did not scale 32 GPUs while two slots remained:
  2,427/2,427 valid WAVs, p50/p95 3.86/11.31s. A deliberate 192-user saturation minute
  scaled desired 32->51; launches began 20:23:56 SGT and all 19 new nodes completed
  full route warm by 20:28:31.
- Full public chatbot results on the hot 51-GPU fleet: 100/100 three-turn sessions
  completed with median first voice 5.02/3.34/3.40s, and a 50/50 comparison completed
  at 5.69/4.10/4.30s. Restored live min/desired 1, max 192, and preserved the August 2
  07:15/18:00 SGT schedule.
- Code files: `lambda/shared/gpuWorker.js`, worker inference route/scheduler,
  autoscaling provisioner, route warm script, chatbot/TTS load harnesses and tests.
  Tests: Lambda 95/95, worker 16/16, scheduler 4/4, Node/PowerShell/JSON checks, public
  32/51-GPU load tests, SSM 19/19 warm verification. A 60-minute soak and intentional
  target-termination rehearsal remain untested.
- Added a complete public chatbot load harness covering independent WebSockets,
  OpenAI replies, sequential DeanVoice chunks, WAV validation, and per-user first/
  total voice timing. At 32 healthy GPUs 41/50 full flows completed; at 45 healthy
  GPUs 50/50 completed. Recorded the public 504 finding and response-length caveat.
- Rehearsed reactive scaling from 32 to 45 using three one-minute request waves:
  alarm detection took 5m36s and all 45 targets were healthy 12m20s after first
  demand. Restored live min/desired 1, preserved the event schedule, and recorded
  surviving healthy instance `i-080216db47f377410`.
- Created paired 2026-08-02 event actions: 32 GPUs at 07:15 SGT and return to one at
  18:00 SGT. Added flexible timestamp validation; both times must be supplied and the
  end must be later than the start.
- Added environment-controlled ASG maximum and event prewarm capacity. Repo defaults
  are max 192 and event 32; validation rejects prewarm/desired above max. Dry runs
  covered defaults, explicit overrides, paired schedules, and invalid combinations.
  Live max was updated to 192 while min/desired remained 1; no schedule was created.
- Added per-phase DeanVoice warm timing (`62f86ff`) and built final staging AMI
  `ami-02e0a90f76ed1ce2a`; launch-template v10 passed fresh boot, readiness, and
  public 10/10 WAV validation. Default v11 now starts Target Optimizer only after the
  complete warm synthesis. Fresh boot reached cloud-init ready in 442 seconds;
  an already initialized worker completed the same warm flow in 13 seconds.
- Recorded 16-GPU public burst results: 50/50 (p50 20.18 s, p95 24.30 s) and 60/60
  (p50 3.67 s, p95 9.09 s). A cold 60-request burst returned all 504s and did not
  trigger request-count scaling. Changed the ASG baseline from min/desired 0 to 1
  because the policy cannot recover from zero targets.
- Rolled back corrupt launch-template v9 after its no-reboot AMI captured a zero-byte
  inference-worker entry file. The corrected filesystem was verified and synced
  before the final image was created and validated.
- Diagnosed the ASG inference failure through SSM: a startup timeout left the original
  Python child alive and a retry spawned a duplicate. Added process ownership/cleanup
  tests and raised the true cold-boot window to five minutes (`b798125`, `472b44e`).
- Validated a fresh g6.xlarge from final AMI `ami-0cc434135361d7400`: correct commit,
  subnet/security group, worker and Target Optimizer services, one Python API process,
  DeanVoice warm, and valid 32 kHz WAV output. Launch-template v8 is default.
- Cut staging listener rule 3 to `vcs-stg-opt-3103`. The healthy ASG is min 0/max 16/
  desired 1 with target tracking at six ALB requests per target. Three final public
  GI chatbot TTS requests returned HTTP 200 WAVs. No timed 16-GPU prewarm exists yet.
- Deployed exact conversation voice pinning to the staging Lambda and corrected the
  chatbot deployment to `build:gi`. Staging now serves `assets/index-DfcO_k9s.js`
  from `staging-chatbot` commit `846893e`; the GI engine freezes GPT, SoVITS, profile,
  and revision. CloudFront invalidation `I43HK3A7U66H6TC7RUUUUW6MLU` completed.
- Copied the existing GI lesson video server-side to
  `echolect-staging/dist-chatbot/videos/gi-bleeding.mp4` because staging lacks dev's
  separate `/videos/*` origin. Public index/video and rendered SSO-login checks pass.
- Created staging launch template `lt-07728350a25e691a4` from approved AMI
  `ami-07ecb50a65a104ef1`. ASG creation remains blocked because
  `AWSServiceRoleForAutoScaling` is absent and `iam:CreateServiceLinkedRole` is denied.
- Code changed: GI voice snapshot helper/wiring/tests; Windows PowerShell AWS-error
  handling in the ASG provisioner; GI-aware client deployment mapping and video
  preservation. Tests: Lambda 94/94; client 88/88; GI build; provisioner dry run;
  Lambda package hash/public config; public GI bundle/video/browser checks.
- Created `AWSServiceRoleForAutoScaling`, ASG `vcs-staging-gpu-inference`, instance
  `i-0cfbf33c4a372fc55`, and request-count target policy. Fixed policy JSON/order and
  missing ALB SG egress to Target Optimizer ports 3103/3004.
- The new target passed ALB health at zero weight, but DeanVoice cold startup remained
  not-ready and public TTS failed. Rule 3 was rolled back to the original healthy
  target. `ssm:SendCommand` remains denied, blocking service-log diagnosis.

## 2026-07-28

- Documented the complete staging/dev EC2, Lambda, CloudFront, branch, and S3-prefix map; made the staging architecture and deploy config mandatory source-of-truth inputs for future AWS work.
- Recorded the current single-GPU/shared-state concurrency limit and the staging-only 2026-08-03 design: DeanVoice Live Fast, immutable pre-warmed EC2 GPU workers, ASG, ALB Target Optimizer at one inference request per GPU, scheduled pre-scaling, quota/capacity confirmation, and production-shaped load testing.
- Public read-only checks passed for all three staging front doors: GPU running/ready, DeanVoice loaded, inference/training idle. Live AWS control-plane drift was not checked because Windows Application Control blocked the installed AWS CLI before authentication.
- Code files changed: none.
- Markdown files changed: repo `AGENTS.md`, repo `docs/staging-architecture.md`, vault `docs/deployment.md`, vault `TODO.md`, vault `CHANGELOG.md`.
- Tests run: public HTTP smoke checks for staging `/`, `/api/config`, `/api/instance/status`, `/api/models`, `/api/inference/status`, `/api/inference/current`, and `/api/train/current`; Markdown diff/line-limit checks.
- Implemented and deployed general multi-user isolation on
  `codex/staging-multi-user-scaling`: immutable request/conversation voice snapshots,
  bounded model-aware synthesis scheduling, atomic model-pair changes, S3-backed Full
  sessions/SSE/chunks/cancellation, queued training, and bounded Lambda capacity retry.
  Commits through `1c945b9` are pushed; staging Lambda/GPU use the branch.
- Updated staging chatbot from `chatbot-live-full` commit `9821dd5`; public bundle is
  `assets/index-Dnjl1fjR.js` with `deanvoice-v1`. Replaced global staging CloudFront
  SPA error mappings with `vcs-staging-spa-route-rewrite`; deep routes return HTML 200
  and missing API profiles now return JSON 404.
- Validated two same-model jobs per g6.xlarge. Four verified concurrent requests
  returned 4/4 valid WAVs in 10.8s; ten returned 10/10 in 32.7s, with no worker
  warning/OOM and ~2.95/23 GiB GPU memory after the run. Lambda 93/93, client 124/124,
  inference worker 234/234, and gpu-worker syntax checks pass.
- Installed the pinned Target Optimizer proxy on staging and created target group
  `vcs-stg-opt-3103` plus AMI `ami-07ecb50a65a104ef1`. Launch template/ASG/listener/
  schedule remain blocked by denied `ec2:CreateLaunchTemplate`; the legacy launch
  configuration fallback was also denied. Provisioning is checked in and documents the
  exact scoped permissions and environment-driven 07:15 prewarm.
- Corrected the dev Dean chatbot mapping to `d2o0cbe2zunqkr.cloudfront.net`;
  `d3fwx6qxeaxfmo.cloudfront.net` is the separate GI-bleeding chatbot.
- Closed the same-profile cross-chunk race: each conversation now pins exact GPT,
  SoVITS, references, and revision, and Lambda no longer rereads mutable profile state
  for pinned requests. Main commit `b86748c` and Dean-client commit `4058357` are
  pushed. Main client 125/125 + build, main Lambda 94/94, Dean client 221/221 + build,
  and Dean-branch Lambda 78/78 pass. Staging redeployment remains.

## 2026-07-27

- Fixed Live Full targeted regeneration to force the edited review card through one synthesis unit, matching the UI contract and insertion path instead of reapplying initial chunk limits. Mutable worker audio routes now send `Cache-Control: no-store` headers so overwritten chunk/final WAV URLs cannot reuse an older take. Local commit `cc7e356`; targeted worker tests pass 71/71, and syntax/diff checks pass. Directly deployed the exact two-file diff to dev EC2 `3.38.97.107`, with rollback copies under `/home/ubuntu/codex-backups/regeneration-fix-20260727`; the inference service is active and `/healthz` returns OK. GitHub push remains blocked by missing HTTPS credentials, so the EC2 checkout intentionally has these two modified tracked files. The reported WAV was not available locally, so its waveform and real browser behavior remain unverified.

## 2026-07-24

- Added and deployed a Live Full per-chunk generation library. Every successful regeneration archives the replaced worker-local WAV, text, timestamp, and best-effort status; restoring any take makes it current, archives the displaced current take, and rebuilds previews/final audio without synthesis. Insert/delete clear histories because indices change. Commit `47e3fba` is pushed, and local/GitHub/EC2 match. The inference service is active, Seoul Lambda updated successfully, and public bundle `assets/index-DbDJGVH2.js` is live after completed invalidation `I9LLUU7C4N6WN9V7JCXG9ELBM1`. Worker 222/222, Lambda 19/19, client 124/124, build, public bundle strings, and fake version-route 404 checks pass. Real browser regeneration/restore remains unverified.
- Fixed exact pronunciation searches not opening the saved entry for editing. An exact case-insensitive match now fills the category, word, ARPAbet, synthesis alias, and strict-verification fields, scrolls the editor into view, and focuses Word; partial searches still show selectable results. Commit `338e06e` is pushed and EC2 matches it. Client 124/124 and Live Fast build pass. Bundle `assets/index-D0Ma3o-Y.js` is deployed after invalidation `IEOUWCBRLSDMIODN7DOZVKJY57`; the public API returns the complete `enantiomers` entry and the bundle contains the exact-match focus behavior.
- Added case-insensitive pronunciation-word search across all dictionary categories. The Lambda returns globally deduplicated substring matches with each entry's category and caps responses at 100; the UI shows category badges and supports editing, testing, and deleting search results without changing category-list behavior. Commit `5eedce4` is pushed and the dev EC2 checkout matches it. The non-staging Seoul Lambda update succeeded, Live Fast bundle `assets/index-Dh0HIKYL.js` is deployed under `echolect/dist-live-fast`, and CloudFront invalidation `I5OTJWQAUVV9XXURTZIBZ3T8H1` completed. Public `search=stereo` returned two matches and the public bundle contains the search UI. Lambda 7/7, client 124/124, Live Fast build, Lambda packaging, and diff checks pass. Visual browser automation was unavailable.
- Added optional pronunciation-dictionary `synthesisAlias` support for reviewed compound spellings such as `stereochemistry` → `stereo chemistry`. Lambda accepts only 2+ English word parts using letters/spaces/apostrophes/hyphens and rejects markup or unsafe forms. The worker rewrites exact whole-word matches only; ASR checks the rewritten tokens, strict phoneme verification scores the complete alias span against the original entry ARPAbet, conclusive mismatches still reject, and non-strict aliases do not become phoneme gates. UI edit/list/CSV import/export support is deployed. Also fixed CSV camel-case header parsing so `verifyPhonemes` and `synthesisAlias` survive imports.
- Commit `3c30bfe` is pushed to `origin/separate-containers-new` and dev EC2 `43.203.248.253` is fast-forwarded to it; remote focused worker tests pass 82/82 and the service is active. The non-staging Seoul Lambda update succeeded with `S3_PREFIX=echolect/`. Live Fast bundle `assets/index-DFY5Xz5p.js` is deployed under `echolect/dist-live-fast`, CloudFront invalidation `IDAG195F8JY949RFCLLBT18GT6` completed, and the public bundle contains the alias UI; public dictionary GET returns 200. Local tests: worker 220/220, client 124/124, Lambda focused 12/12, client build, and Lambda package. A complete Lambda test command hung and was terminated; no real voice listening test was run after the worker restart.
- Fixed Full English normalization treating standalone element-symbol words such as `In`, `As`, `At`, and `He` as chemical formulas and spelling them as letters. Alphabetic formula expansion now requires multiple valid element symbols unless digits or grouping make the notation explicit; `NaCl`, `H2O`, `COOH`, and grouped formulas remain supported.
- Added conservative terminal-word phoneme evidence: terminal strict/dictionary checks now score both Whisper-timestamp crops and independently detected speech-end crops. A terminal `pass` requires at least one passing crop from each family; disagreement is `uncertain`, and thresholds are unchanged. Added Python decision tests and a worker test proving terminal requests enable endpoint crops.
- Tests: focused JavaScript 42/42, Python 3/3, complete inference-worker 216/216, Python compilation, remote JavaScript/Python syntax checks, and remote pre-restart legacy focused tests 40/40. Commit `b822d20` is pushed to `origin/separate-containers-new`, and dev EC2 `43.203.248.253` is fast-forwarded to that exact commit with a clean tracked worktree; the earlier direct-deploy state is preserved in a named stash and rollback directory. `gpu-inference-worker` is active, `/activity/status` is healthy, and transcription/speaker sidecars loaded. A later complete remote `node --test` run stalled for over two minutes and was terminated; the completed local 216/216 suite remains the full-suite evidence. No model is selected after restart, so real DeanVoice generation/listening remains unverified.

## 2026-07-22

- Narrowed Full risky-sentence isolation: an ARPAbet dictionary term inside a sentence no longer forces a one-sentence review card. Normal two-sentence grouping now remains unless the text is genuinely long or clause-dense; positional dictionary-tail regrouping and the controlled one-sentence context exception still protect terms that actually reach a chunk edge. Tests: long-text 60/60 and worker 214/214. Commit `e67394e` is pushed to `separate-containers-new`, the EC2 checkout matches it, and `gpu-inference-worker` is active.

- Committed and pushed the complete quality/gain change set as `44df0cb` on `separate-containers-new`. Fast-forwarded the EC2 checkout from `075fedf` to that exact commit after proving the previously copied runtime files were semantically identical except for line endings; preserved unrelated untracked `docker/vendor/GPT-SoVITS.zip` and `gptsovits-src.tgz`. Restarted and started `gpu-inference-worker`; service is active and Git HEAD is `44df0cb`.

- Deployed the complete 2026-07-22 runtime changes to the original dev stack (not staging): five inference-worker runtime files to EC2 `13.125.233.205`, restarted systemd `gpu-inference-worker`, updated Seoul Lambda `Liu_Teng_Yu_Intern2026-Voice_Cloning_Project` with `LastUpdateStatus=Successful` and confirmed `S3_PREFIX=echolect/`, and synced the Live Fast build to `s3://interns2026-small-projects-bucket-shared/echolect/dist-live-fast`. CloudFront invalidation `I19B11YP2KRM5T4CWCD0TVY0XC` was created for dev distribution `E36CNBL620DMGM`; the public site serves bundle `index-Du14fYUs.js` containing the gain and best-effort UI. EC2 Python/JS syntax checks pass, the service is active, and the public `/api/models` smoke test lists DeanVoice. The service restart left model weights unloaded until a normal profile selection; the engine itself was started successfully. A complete Lambda test command hung without a summary and was terminated; fresh Lambda packaging succeeded.

- Extended the persisted `-6..+6 dB` saved-output gain to Live Fast TTS and Fast Queue. Fast applies gain after take verification/selection and boundary-break padding, using the same -1 dBFS ceiling; retry, chunking, synthesis, ASR, and phoneme behavior are unchanged. Worker and frontend are deployed to dev. Tests: worker 213/213, client 123/123, focused Fast/Full 70/70, focused client 38/38, Live Fast production build, and diff checks pass.

- Follow-up verification after the regeneration-unit exception: the complete inference-worker suite passes 212/212.

- Added Full/Full Queue quality controls without changing Live Fast synthesis policy: an ARPAbet word left at a normal two-sentence boundary may borrow exactly one following sentence under a 15% hard overflow ceiling; Full fallback reasons now include missing/clipped/doubled and phoneme mismatch/uncertainty details; SSE/regeneration metadata marks best-effort chunks in the review UI; and a persisted `-6..+6 dB` saved-output gain is applied only after verification with a -1 dBFS peak ceiling. Admin regeneration preserves the edited review text as exactly one requested synthesis unit instead of reapplying initial chunk limits or dictionary-tail regrouping; normal Full ASR/phoneme verification, 3→5 retries, fallback, and stitching remain. Added leading/trailing `<break>` WAV padding to Full and Live Fast, with consecutive boundary breaks additive up to 10 seconds. Real EC2 calibration found and fixed stress-insensitive ARPAbet conversion (`ER0`/`AH0`) that produced an unsupported IPA token, and fixed exact split-compound coverage (`through out` vs Whisper `throughout`). The controlled third-sentence rule fired on real DeanVoice synthesis; start-position `structural` passed phoneme verification after the IPA fix, while terminal timestamps remained conservatively uncertain. Worker full suite passed 211/211 before the regeneration exception; the updated long-text suite passes 59/59, client tests pass 122/122, focused boundary/settings tests pass 35/35, Live Fast production build passes, Python compilation/assertions and diff checks pass. The worker changes are live but uncommitted on dev EC2 with a rollback backup; frontend deployment, browser listening, threshold labeling, and S3 verification remain.

## 2026-07-21

- Added arbitrary Live Full chunk insertion before, between, or after existing review chunks. The new chunk uses the same SSML/dictionary/emphasis preprocessing and Full synthesis/verification/best-effort pipeline as targeted regeneration. On success, later chunk audio files are reindexed without regeneration, the session manifest is updated, shared-loudness previews are rewritten, and the full WAV is rebuilt/uploaded. Frontend insertion controls are inline at every boundary; Lambda and worker expose `/inference/insert-chunk`. Tests: worker long-text 56/56, focused Lambda 18/18, worker syntax checks, and Live Fast production build passed. Real GPU/S3/browser insertion remains unverified.
- Fixed Live Full heading-only, colon-fragment, and unexpected one-sentence chunks caused by competing guards. Newlines are now ordinary whitespace rather than sentence boundaries; only terminal punctuation ends a sentence; ordinary numbers/acronyms no longer force risky isolation; colons, semicolons, and em dashes stay inside sentences; and the automatic 170-character boundary remains hard. Chunks target two sentences within 170 characters; a sub-eight-word result may absorb exactly one extra sentence only when it still fits, while oversized sentences split safely and continue in the next chunk. Renamed review cards from misleading `Sentence` labels to `Chunk`. Added per-chunk deletion through the frontend, Lambda proxy, and inference worker; it removes saved chunk audio, reindexes later chunks, regenerates normalized previews, rebuilds/uploads the final WAV from the remaining chunks, and updates the browser history card. The only remaining chunk cannot be deleted. Tests: inference-worker long-text suite, focused Lambda 17/17, worker syntax checks, Live Fast production build, and diff checks passed. Real GPU/S3/browser deletion remains unverified.

## 2026-07-20

- Fixed SSML-lite `<break>` parity across targeted Live Full regeneration and both Live Fast TTS buttons. Regeneration now retains break sentinels, reuses Full chunking/retry/verification/loudness joining, and restores the session's original max-word/max-sentence synthesis settings. A break no longer creates separate Full review cards: ordinary sentence/word/minimum-context rules choose the parent review chunk, while the break creates only internal verified audio segments that are joined back into that one chunk. Editable previews render the `<break>` markup. Live Fast expands SSML before its dictionary/normalization layer, runs its normal verified three-take policy independently on both sides, and joins them with the exact requested silence; the browser chunker keeps both sides in one request. Tests: inference worker 203/203, client 122/122, Lambda inference 10/10, Live Fast production build, and diff checks passed. Real GPU/browser listening and deployment remain.

## 2026-07-15

- Corrected the Dean demo integration after confirming `chatbot-live-full` defaults to Live Fast, not Full. Ported configurable whole-sentence Fast chunking into the pulled chatbot branch: rank-#1 `max_chunk_words` and `max_sentences_per_chunk` restore into page state, bound each progressively queued `/api/live/tts-sentence` request, and remain separate from the already whole-reply Live Full path. Kept the old phrase splitter exported for compatibility but removed it from Dean Fast synthesis; removing Fast chunking entirely would have sent an unbounded whole reply. Focused tests pass 98/98, the chatbot production build passes, and commit `18aa401` is pushed to `chatbot-live-full`; frontend/Lambda deployment and real demo verification remain.
- Preserved Live Fast rank-#1 `max_chunk_words` and `max_sentences_per_chunk` in voice-profile activation payloads and stored profiles, promoted existing values from `metadata.liveFast.defaults`, and forwarded them through `voiceProfileId` resolution to Live Full generation. Explicit request values still take priority. The demo chatbot already sends the whole Full reply to `/inference/generate` before its Fast-only phrase splitter, so no frontend split removal was needed. Focused current-branch tests pass 72/72 and chatbot-branch tests pass 94/94. Commits `99078b6` and `65bece1` are pushed to `separate-containers-new` and `chatbot-live-full`; Lambda deployment and demo chatbot verification remain.

- Changed Live Fast client chunking to default to one sentence per chunk across chatbot speech, standard TTS, and queued TTS. Added persisted `Max sentences per chunk` (1–5, default 1) and `Max chunk words` (Auto or 10–100) advanced settings. Auto preserves the 280-character heuristic; an explicit word value takes priority over it. A chunk below eight words may absorb exactly one neighbouring sentence when the active hard limit permits, and an oversized sentence can still split at safe internal boundaries. Live Fast's existing three-take worker loop now runs the independent ARPAbet phoneme verifier for every usable Whisper-verified take: a phone `pass` can rescue a dictionary spelling mismatch, a conclusive strict-word `reject` re-seeds, and Full-only accurate-ASR/tail/short-word gates remain separate. Tests: inference worker 192/192, client 121/121, Live Fast production build passed; deployment and real GPU/browser listening remain.

## 2026-07-14

- Fixed Live Full's `Max sentences / chunk` control so a value of 2 groups two sentences whenever the pair fits the configured character/word limit; removed the premature 60%-full flush that emitted a one-sentence chunk before considering its neighbour. A chunk below eight total words may now absorb exactly one additional sentence for adequate synthesis context, while hard size limits and risky-sentence isolation remain. Edited review boxes still regenerate their entire edited text regardless of how many full stops were added. Also made dotted and space-separated initialisms converge on explicit spoken letter names (`F.A.D` and `F A D` -> `eff ay dee`), including deterministic `A`/`I` letter pronunciation inside an initialism. A dotted initialism now retains one final period when it also ends the sentence (`F.A.D. Another` -> `eff ay dee. Another`) while mid-sentence `W.H.O. guidance` remains pause-free. Tests: full inference-worker suite 189/189. Commit `2e6885b` pushed to `separate-containers-new`; deployment and real GPU/browser listening remain.
- Made the admin pronunciation dictionary ARPAbet-only and globally unique by word. Removed readable pronunciation state/input/rendering and readable CSV output; legacy CSVs retain ARPAbet import compatibility. Lambda rejects readable-only saves, returns only the newest legacy duplicate, moves/replaces a saved word across all category files, physically removes every copy on delete, and rewrites sanitized category files on save. The inference worker never rewrites synthesis text from readable fields, ignores readable-only legacy records, and deterministically deduplicates ARPAbet records before hot-dictionary sync or verification. This prevents transformations such as `iron` → `eye urn` from creating false missing-word failures. Tests: worker 121/121, client 116/116, pronunciation Lambda 5/5, JS syntax and diff checks passed. Commit `73dfde0` is pushed to `separate-containers-new`; deployment is pending.
- Corrected the phoneme verifier after production logs showed clean `coverage=100%`, no-missing/no-cut/no-repeat takes being rejected. Ordinary correctly transcribed dictionary words no longer enter the phoneme model; default checking is limited to Whisper-missed/mistranscribed ARPAbet terms, with an explicit `verifyPhonemes` opt-in for reviewed strict terms. The Python sidecar now scores three overlapping crops and returns `pass`/`reject`/`uncertain`; only `pass` forgives a Whisper mismatch, while only a conclusive `reject` rejects a strict correctly transcribed term. Added structured score logs, conservative reject thresholds, candidate-ranking treatment, CSV/schema/UI support, legacy CSV compatibility, and production-regression coverage. Tests: worker 114/114, client 116/116, pronunciation Lambda 3/3, and JS syntax checks passed. Commit `1aea2c1` is pushed to `separate-containers-new` and its worker path is live on dev EC2.
- Deployed commit `60126ae` to dev EC2 `3.34.51.4` (`i-03f258d470a2fa73f`). Installed `espeak-ng`, `phonemizer 3.3.0`, and the previously missing `resemblyzer 0.1.4` in `/home/ubuntu/miniconda3/envs/gptsovits`; downloaded and validated the 315.8M-parameter Meta phoneme CTC model. A real CUDA forward-pass smoke test succeeded on the NVIDIA L4 with 1263.3 MiB peak allocation, exact `Michaelis` IPA tokens, and worker health preserved. Speaker similarity and Whisper medium are both active after restart. Built and uploaded the dev Live Fast frontend; the EC2 role could not create a CloudFront invalidation, but a fresh origin fetch refreshed the root and the public distribution serves new bundle `index-fr9HrpL8.js` with HTTP 200. Real voiced-word threshold calibration/listening remains.
- Added an independent phoneme-level gate for Live Full/Queue ARPAbet dictionary terms. After anchored Whisper timing and real waveform energy establish the word's location, a lazily loaded `facebook/wav2vec2-lv-60-espeak-cv-ft` CTC recognizer compares the cropped audio against explicit ARPAbet-to-IPA phone tokens. Every saved technical term is checked even if Whisper context-corrects it to the expected spelling; measured mismatches reject the take and lower terminal best-effort ranking, while unavailable/inconclusive checks never grant dictionary forgiveness. Added CUDA-to-CPU fallback and container dependencies. Also replaced the fragile first metadata probe with retrying full-WAV fetch/blob validation, eliminating the just-finalized artifact race behind `Audio metadata was not ready yet`. Tests: worker quality 112/112, focused routes 2/2, phoneme helper/token-vocabulary checks, client 116/116, Live Fast production build, Python/JS syntax checks. Real GPU threshold calibration and browser listening remain.
- Hardened Full technical-word forgiveness against Whisper timestamp hallucinations. The verifier now resolves the exact expected slot between surrounding matched anchors, requires the heard gap not to be shorter than the expected gap, requires a sufficiently long/confident timed token, and inspects PCM16 samples inside that precise span for RMS, peak, and voiced-sample energy relative to the whole sentence. A timestamp laid over silence, a missing slot, a near-zero span, or healthy neighboring-word energy cannot forgive the dictionary word. Tests: worker quality 110/110 including spoken substitution, absent slot, silence-backed timestamp, and neighbor-timing regressions.
- Restored terminal best-effort for Live Full/Queue after the adaptive ladder: a failed two-sentence chunk splits at sentence boundaries, each sentence gets three then five takes, and an indivisible sentence that still has no verified take contributes its highest-ranked audio-usable full-sentence take instead of aborting the request; the same applies when ASR is unavailable. Silent/structurally unusable audio still fails. Full can now forgive a dictionary technical word such as `Michaelis` when Whisper produced a different token but anchored surrounding words prove that a sufficiently long/confident timed token occupied the expected slot; a shorter/absent slot is not forgiven, and neighboring-word timing cannot be borrowed. Tests: worker quality 109/109, focused routes 2/2, JS syntax checks passed.
- Tightened Live Full/Queue completeness and frontend readiness behavior. Full now counts one-letter alphabetic words, applies zero length-based exemption to timing/cut scrutiny, and cannot use its terminal best-candidate fallback when ASR reports any missing, skipped, or clipped word; Live Fast thresholds/fallback remain unchanged. Widened sentence-review textareas and the Full output rail. Voice switching now defers expensive reference resets and ignores stale model-load responses; a single transient not-ready response no longer flashes `No model`. GPU readiness restores a recent confirmed-ready state while rechecking, polls cold startup every 3 seconds, and Lambda probes EC2/worker state concurrently. Busy detection now uses live request/session ownership instead of stale progress status. Tests: worker quality 106/106, focused worker routes 2/2, client 113/113, Lambda 86/86, Live Fast production build and JS syntax/diff checks passed. Real multi-browser/GPU listening and deployment remain.
- Replaced the always-five Live Full/Queue tournament with an adaptive 3→5 ladder for user-perceived latency: rank the first three takes and stop if any passes; otherwise generate takes four and five. If the whole multi-sentence chunk still has no passing take, run the same 3→5 ladder per whole sentence, use each sentence's strongest usable full-sentence candidate only after five failures, and stitch every sentence in order. A one-sentence chunk reuses its best candidate after five instead of generating a duplicate batch. Speaker-verifier unavailability now degrades to ASR-only completeness validation/ranking instead of rejecting every take at 0%; accurate ASR unavailability still fails closed and cannot enter best-candidate fallback. Tests: worker quality 103/103, focused speaker-unavailable route regression 1/1, Live Fast production build passed.
- Changed Live Full/Queue from six early-accept retries to a five-take quality tournament per chunk: all five voice-faithful seeds run, strict large-v3 ASR word/timing checks and speaker similarity reject unsafe candidates, then the strongest verified candidate wins using voice similarity plus natural-duration/audio-quality scoring. Risky technical, numeric/acronym, long, or clause-heavy sentences are isolated before synthesis; multi-sentence recovery also uses five takes per sentence and fails the session if any sentence has no valid take. Accurate ASR now defaults to beam size 5, Full no longer forgives dictionary-word mismatches or low-confidence spans, and configured ASR/speaker verifier outages fail closed. The browser automatically scans Full scripts for missing pronunciation overrides and warns once before proceeding. Live Fast retry/fallback logic is unchanged. Tests: worker quality 100/100, client 110/110, Lambda 86/86, Live Fast production build and Python AST parse passed. A broader worker route run was 103/104 due to the pre-existing `W.H.O.` expectation mismatch; no real GPU/browser listen or deployment was performed.
- Hardened Live Full/Queue against known-bad output: after six whole-chunk takes and sentence-boundary recovery, a chunk rejected by ASR/clip checks now fails the session instead of publishing the highest-scoring rejected take; configured-but-unavailable transcription verification also fails closed. This prevents detected or unchecked skips, cuts, and mispronunciations from entering the final WAV or progressive queue. Live Fast retains its existing best-effort audio policy. Tests: long-text 41/41; full worker suite 160/163 with three pre-existing acronym expectation failures.
- Made Live Full/Queue review text editable. Regeneration accepts revised chunk text through client, Lambda, and worker, applies runtime pronunciation/SSML normalization, commits text only after successful verified synthesis, refreshes the chunk preview, and rebuilds the full WAV. Added one-synthesis-owner locking across Live Fast and Live Full, preserved upstream HTTP 409 through both Lambda routes, and added friendly shared-GPU contention/expired-session messages. Tests: client 110/110; Lambda 86/86; Live Fast production build passed. Real GPU/browser verification and deployment remain.
- Strict Live Full recovery uses six whole-chunk takes followed, when the chunk contains multiple sentences, by six takes per isolated sentence. Every recovered sentence must pass and `concatWavs` stitches all of them in order; otherwise the session fails without publishing the chunk. Live Fast is unchanged. Tests: long-text 42/42.

## 2026-07-13

- Added Live Full/Queue advanced chunk overrides: `Max chunk words` (Auto preserves the 170-character default; 10–100 words overrides the character heuristic) and `Max sentences / chunk` (1–5, default 2). Values flow through synthesis requests and persist in Live Full saved-config metadata. Added a browser-only Delete button for whole TTS output cards; it removes local history without deleting GPU/S3 artifacts. Tests: worker long-text 41/41; client Live Full/history 6/6; Live Fast production build passed.
- Adjusted Live Full/Queue primary chunking from one sentence to at most two sentences while retaining the 170-character default cap. Two short sentences can share context; longer pairs still separate by length, and oversized individual sentences still use guarded splitting. Live Fast is unchanged. Tests: long-text inference 39/39.
- Added sentence-level review and repair for Live Full and Live Full Queue outputs. Completed Full outputs now retain their session/chunk list, show a normalized audio preview for each sentence, and allow one sentence to be regenerated. The worker replaces only the selected raw chunk, recomputes shared chunk loudness previews, rebuilds the normalized full WAV, and overwrites the result artifact. Added `POST /api/inference/regenerate-chunk` and `GET /api/inference/chunk-preview/:sessionId/:index`. Code spans client, Lambda routing/proxying, and the inference worker. Tests: long-text service 39/39; Lambda inference/router 15/15; client TTS history 2/2; Live Fast client build passed. Worker route suite has one pre-existing unrelated W.H.O. initialism assertion failure. Not tested on real GPU/browser.
- Mitigated cumulative long-script accuracy loss on Live Full and Live Full Queue by changing the shared Full quality preset to generate one normal sentence per primary chunk. ASR verification and up to six voice-faithful re-seeded takes now recover a bad sentence without regenerating adjacent good sentences. Unusually long sentences still use the existing guarded length splitter, and tiny fragments still merge with a neighbour to avoid silent micro-clips. Live Fast is unchanged. Code: `gpu-inference-worker/src/services/longTextInference.js`, `gpu-inference-worker/src/config.js`, and `gpu-inference-worker/src/services/longTextInference.test.js`. Tests: `node --test src/services/longTextInference.test.js` in `gpu-inference-worker/` (38 passed). Not tested: real GPU/browser audio; sentence-to-sentence flow and accuracy need a listening comparison against the previous grouped behavior.

## 2026-07-07
- Pronunciation/accuracy pass on the shared text + verifier path (no quality/sampling changes). (1) `textPronunciation.js` now expands numeric notation to WORDS before synthesis: units after a number (`1 mg`→`1 milligram`, `500 mg`→`500 milligrams`, mcg/µg/ml/kg/km/cm/mm/bpm/hr(s)/min(s)/mmHg — singular only for exactly `1`), attached/spaced percent (`50%`→`50 percent`), ordinals `1st–12th`→words, and Roman numerals ONLY after a classifier (`stage IV`→`stage 4`; bare `IV`/`I` untouched). This both makes GPT-SoVITS pronounce them deterministically AND turns them into countable words the skip/clip verifier can protect (digit-bearing tokens were previously excluded from coverage). Runs before the Greek-letter pass so `5µg` maps correctly. (2) `wordCoverage.js` canonicalizes Whisper's re-abbreviations back to the expanded words (`mg`→milligrams, `1st`→first, `%`/`mmHg` in tokenize) so the expanded synthesis text never reads as a dropped word → no needless re-rolls. (3) `findClippedWords` now applies the same tail-cut scrutiny to the FIRST expected word (onset clip) as it already did to the final word, under the same `finalWordTailCheck` opt-in (Live Full/Queue only). Tests: `node --test src/services/*.test.js` in gpu-inference-worker (145 pass, incl. new numeric-expansion + Roman-classifier cases). NOT verified on real GPU/browser — needs a listen. Commit on `separate-containers-new`.

- Corrected environment naming (user: NEW stack = staging, original system = dev) and executed the rename (462b076): new staging ALB voice-gpu-alb-staging + vcs-staging-tg-* + rules, staging Lambda `…-staging` (S3_PREFIX=echolect-staging/, idle 90 min, URL 7xx6w7q5jwzda6nlltlyfckfzm0vyfmy… NONE+both statements), 3 CloudFront distros' origins repointed to staging Lambda/ALB/echolect-staging paths, S3 echolect-dev/→echolect-staging/ (old prefix removed), branches staging + staging-chatbot pushed, deploy.config.json + client env files swapped, staging-userdata.sh. Deleted -dev Lambda + SG (role can't delete ELB: voice-gpu-alb-dev + TGs left for admin). Discovered the NAT gateway was deleted overnight → recreated nat-0dadc68ca781b8df9 (new EIP), but route repair denied (ec2:ReplaceRoute/DeleteRoute) → admin must fix rtb-068aad306c3adcbe0. Launch still blocked on iam:PassRole. Self-contained cross-device handoff: `docs/staging-environment-handoff.md` (replaces dev-environment-handoff.md). Tests: staging /api/models 200 via d1qh0ebsvevhy3 pre-rename; distro updates deployed InProgress.
- Deployed ~85% of the dev environment (commits a93f403, 4d388ac): private subnet 10.0.32.0/20 + NAT (reused idle EIP) + route table + S3 endpoint + dev SG; dev ALB voice-gpu-alb-dev with 3 TGs + staging-mirror rules; dev Lambda `…-Voice_Cloning_Project-dev` (staging exec role — iam:CreateRole denied) with dev env + Function URL (NONE, matching staging; fixed a 403 needing BOTH public-access + InvokedViaFunctionUrl policy statements); 3 dev CloudFront distros cloned from snapshots (training d1qh0ebsvevhy3 / live-fast dfzrfr93t2ruf / chatbot d25sg72wp8oj5g), bucket policy extended; echolect-dev/ seeded mirroring echolect/; all 3 dev frontends built (chatbot from chatbot-live-full worktree) + uploaded + verified 200 incl. /api/models end-to-end; deploy scripts + 6 client env files committed and dry-run-verified. AMI ami-06338e47a2f1bae6a of the (stopped) staging box completed (~4h for 484GB). BLOCKED: dev GPU launch needs iam:PassRole on VoiClo_GPU (admin), EventBridge/Scheduler denied (admin). Handoff with exact admin commands/console steps + post-launch checklist: `docs/dev-environment-handoff.md`. Tests: dry-runs + live HTTP smoke of the 3 dev domains + Lambda direct invoke; no GPU flows yet (no instance).

## 2026-07-06

- Filled the duplication guide with REAL verified AWS values (bd637cf): installed AWS CLI locally, assumed `Liu_Teng_Yu_Intern2026`@329599637774 via the identity account, ran a read-only sweep (EC2/VPC/subnets/SGs, ALB listeners+rules+TGs, Lambda config/env/URL/resource-policy, all 3 CloudFront distro configs saved to `docs/aws-snapshots/`, OACs, S3 layout). Key discoveries: staging instance is currently STOPPED and its public IP is ephemeral (43.201.247.226 stale); two idle unassociated EIPs (13.125.17.99, 3.36.84.29); Lambda Function URL AuthType is actually **NONE** (public — docs claimed AWS_IAM); idle-stop is 90 min via EventBridge rule `VoiClo-gpu-idle-stop`; both subnets are public; user's role is DENIED events:*, scheduler:*, iam reads (guide notes console/admin fallbacks). Guide now has real staging values everywhere; `<FILL-IN>` remains only for dev resources created during execution.
- Wrote `docs/dev-environment-duplication-guide.md` — the authoritative guide for duplicating the entire live stack ("staging") into a parallel dev environment: full system census (EC2 systemd units incl. hardcoded live-gateway secrets, `~/gpt-sovits-v2pro` v2ProPlus local mods, legacy `/opt/gpt-sovits` worker_temp dependency, conda sidecars, Lambda/ALB/3×CloudFront/EventBridge/S3), then 12 sections: pre-snapshot prep (push the EC2's 14 unpushed commits), `develop` + `develop-chatbot` branches, private-subnet + NAT Gateway networking with SSM access, AMI clone, dev ALB (3 TGs), scoped dev Lambda + Function URL, three dev CloudFront distros (training/live-fast/chatbot), CORS wire-up + `echolect-dev/` seed, idle-stop + nightly-stop schedules, deploy scripts spec, verification checklist, runbooks/cost. All AWS values are `<FILL-IN>` placeholders with adjacent discovery commands (local creds were expired). Added "superseded by" headers to the 2026-07-06 spec + plan. Docs only — no AWS mutations, no code changed, no tests applicable. Committed + pushed on `separate-containers-new` (3452541).

- Live Fast now uses whole-sentence chunks + per-chunk anti-skip retry instead of tiny split phrases. Client: added `splitLiveReplyChunks()` in `client/src/hooks/liveConversation.js` (a faithful port of Live Full's server-side `splitTextIntoChunks` — sentence grouping into ~1-3 sentence/≤280-char chunks, `mergeShortChunks`, dotted-initialism protection). Swapped the phrase splitter for it in `useLiveSpeech.js` (live conversation, first chunk still `shortenFirstFastPhrase`d for fast first audio), `LivePage.jsx` (both fast + fastQueued TTS routes), and the `liveFastQueuedTts.js` default. Progressive playback is unchanged: the queue still plays the first generated chunk immediately, then each as it's ready. Server: the Live Fast endpoint `/inference/tts` (`gpu-inference-worker/src/routes/inference.js` → `handleLiveTtsRequest`) now wraps each chunk in `synthesizeLiveFastChunk` — the SAME re-seed + ASR word-coverage/quality verification Live Full uses per chunk, but capped at `LIVE_FAST_RETRY_COUNT=2` (3 takes) and with NO sentence-split escalation. Early-accepts the first clean take; if none pass, ships the best-effort take (highest coverage / least clipped) via the exported `scoreAudioCandidate`, so a stubborn chunk still speaks every word rather than failing. Kept Fast's own synth params (cut5, sampling, fragment_interval) — only the seed varies between takes. Endpoint URL unchanged (other systems depend on it). Files: `client/src/hooks/liveConversation.js`, `client/src/hooks/useLiveSpeech.js`, `client/src/pages/LivePage.jsx`, `client/src/lib/liveFastQueuedTts.js`, `gpu-inference-worker/src/routes/inference.js`, `gpu-inference-worker/src/services/longTextInference.js` (exported `scoreAudioCandidate`). Tests: `node --test` in `client/` (110 pass, incl. new `splitLiveReplyChunks` cases + updated queue test) and `gpu-inference-worker/` (114 pass, incl. new retry-accept and best-effort-fallback cases). Not tested: real GPU/browser — needs a listen to confirm Live Fast still starts quickly and no longer skips/cuts words.
- Made Live Full's chunk joins seamless to close the naturalness gap with Live Fast. Diagnosis: Fast and Full now share sampling; the reason Fast sounds better is the JOIN, not the split — Fast plays its phrase clips back-to-back with each clip's natural trailing decay intact and inserts no synthetic silence, while Full trimmed the natural tail and spliced a punctuation-scaled synthetic pause (period = basePause*3.2 = 384ms) at every chunk seam, reading as mechanical. Set the default `chunkJoinPauseMs` to 0 in both `DEFAULTS` and `FULL_QUALITY_OPTIONS`. With base 0, `concatWavs` skips the trim+silence+fade branches (all gated on gap>0) and concatenates chunks byte-for-byte with their natural tails — identical in spirit to Fast's sequential playback; the model's own sentence-final decay governs the gap. The punctuation-scaled pause/trim/fade machinery is untouched and re-activates for any caller passing a non-zero base, so the mechanism tests (explicit 120) still pass. Code: `gpu-inference-worker/src/services/longTextInference.js`. Tests: `node --test src/services/longTextInference.test.js` in `gpu-inference-worker/` (31 pass). Not tested: real GPU/browser — needs a listen to confirm Full now flows like Fast.
- Reworked stubborn-chunk recovery to never split below a sentence (was the main glitch source). Sub-sentence half-split and fine-fragment splitting produced audible mid-clause seams (independently generated fragments differ in pitch/energy) and degraded pronunciation (lost context). New `synthesizeChunkResilient`: (1) whole chunk, re-seed suite (`retryCount` 3→5, early-accept keeps the common case fast); (2) on failure, split at SENTENCE boundaries only and re-seed each whole sentence, joins landing on natural pauses; (3) terminal best-effort each whole sentence so every word is still spoken. Removed the now-unused `splitChunkInHalf`/`splitChunkFine`. All skip/half-cut/dict verification still runs per unit (unchanged). Added a regression test asserting recovery never synthesizes a sub-sentence fragment; existing best-effort/whole-chunk tests still pass. Code: `gpu-inference-worker/src/services/longTextInference.js` + test. Tests: `node --test` in `gpu-inference-worker/` (112 pass). Not tested: real GPU — needs a listen to confirm seams/glitches are gone.
- Fixed the click/glitch on fullstops (and any pause-inserting join). `applyFade`'s `'out'` branch was inverted: it used `0.5*(1+cos)`, leaving the final sample at FULL amplitude right before the inserted silence (gain 0 landed inward instead of at the boundary), so every chunk join stepped from full amplitude to zero = a click. Both directions now use `0.5*(1-cos(pi*t))` so the boundary sample fades to ~0. Added a `concatWavs` regression test asserting the edge touching inserted silence is faded to ~zero. Only caller is the join code added earlier today. Code: `gpu-inference-worker/src/services/longTextInference.js` + test. Tests: `node --test` in `gpu-inference-worker/` (111 pass).
- CRITICAL skip fix: closed the dict-forgiveness hole that let "and unregulated" be dropped from the last chunk (`...divide very fast and unregulated`) yet pass with no re-roll. The count gate used `heard >= floor(0.9*expected)` — a 10% slack that tolerated ~2 dropped words in an 18-word chunk, so a dropped dict word (`unregulated`) was forgiven. A mispronunciation preserves the token count exactly while a skip lowers it, so forgiveness now requires NO net token drop (`heard >= expected`). At worst a correct take with ASR function-word merging is re-rolled (acceptable); a real drop can never be forgiven. Added a regression test for the exact chunk. Code: `gpu-inference-worker/src/services/transcriptionVerifier.js` + test. Tests: `node --test` in `gpu-inference-worker/` (110 pass).
- Reverted the default comma breath back to OFF (`COMMA_PAUSE_MS` default 0): user confirmed the 35ms splice caused many audible glitches. Timestamp-spliced breaths still land too close to speech in practice; kept as opt-in via env only. Code: `gpu-inference-worker/src/config.js`, `.../longTextInference.js`, test reverted.
- Re-enabled a tiny comma breath in Full Inference (was cut0-only). `COMMA_PAUSE_MS` now defaults to 35ms (was 0) and `FULL_QUALITY_OPTIONS.commaPauseMs` reads it, so `withCommaPauses`/`computeCommaPauses` splices a small silence at comma/clause breaks. Safe now that placement is gap-aware: the pause lands in the already-quiet gap AFTER the word (not on Whisper's early-marked word end, which clipped tails) with ~5ms fades, and is skipped entirely on heard/expected word-count drift so it never lands mid-word. Env-tunable (set 0 to disable, raise for a longer breath). Code: `gpu-inference-worker/src/config.js`, `.../longTextInference.js`, test updated. Tests: `node --test` in `gpu-inference-worker/` (109 pass). Not tested: real GPU/browser — comma feel needs a listen.
- Fixed intermittent "Audio metadata was not ready yet" on Live Full playback. Root cause is a readiness race, not a missing file: the result endpoint 404s until `final.wav` is written/uploaded, and in S3 mode `getGenerationResultSource` hands that URL straight to an `<audio>` element (no server-readiness poll), so a final-upload/eventual-consistency lag past the ~7s retry budget surfaced as a spurious error. Widened `waitForPlayableAudioSource` retry budget from 5→8 attempts (≈25s of backoff) in `client/src/pages/LivePage.jsx`; the transient 404 is already treated as retryable. Not tested: browser.
- Hardened dictionary-word forgiveness in the verifier so a global word-count match can no longer mask a real drop. The old gate forgave a mis-transcribed dict word whenever the whole-chunk heard token count stayed within 90% of expected — a global signal a stray ASR hallucination could refill. Now forgiveness requires all three: (1) the count gate (unchanged), (2) no NON-dictionary substantial word missing, and (3) per-word timing confirmation via new `isWordSpokenByTiming` in `wordCoverage.js` — the dict word's position is mapped into the Whisper word-timing sequence and must show a real (>=120ms) span nearby, so a dict word actually skipped (near-zero span) stays un-forgiven. Degrades safely: with no word timings available it falls back to count + non-dict gates rather than never forgiving. Code changed: `gpu-inference-worker/src/services/wordCoverage.js`, `.../transcriptionVerifier.js`, plus tests in `wordCoverage.test.js`. Tests run: `node --test` in `gpu-inference-worker/` (109 pass).
- Fixed the mid-sentence "glitch / word cut off" and over-long fullstops at chunk joins. `concatWavs` accepted a `fadeDurations` arg it never used, so audio met inserted silence with a hard step (click that sounds like a cut word), and the model's variable trailing near-silence stacked on top of the join pause (same fullstop much longer at a chunk boundary than mid-chunk). Now, ONLY at joins that insert a pause: trailing near-silence is trimmed (threshold ~-44dBFS, keep 30ms, cap 400ms so a soft consonant/word tail is never eaten) and a 3ms Hann micro-fade is applied to the audio edges touching the silence. No-gap (mid-sentence continuous) joins are left byte-for-byte intact. Code changed: `gpu-inference-worker/src/services/longTextInference.js` + `longTextInference.test.js` (new trim regression; existing sample-preservation test still passes). Tests run: `node --test` in `gpu-inference-worker/` (109 pass). Not tested: no real GPU/browser TTS generation — perceived fullstop length and glitch removal need a listen.

## 2026-06-30

- Hardened verifier handling for number-unit words such as `3 hours`, `20 minutes`, and `20 hours`. Coverage alone can be fooled because Whisper may include a predictable unit word after a number even when the synthesized audio swallows it. `findClippedWords` now treats time-unit words after numeric tokens as hard skips if their Whisper span is too short (<180ms) or low-confidence (<0.72). Added tests for weak vs clean `hours` spans and low-confidence `minutes`. Code changed: `gpu-inference-worker/src/services/wordCoverage.js`, `gpu-inference-worker/src/services/wordCoverage.test.js`. Tests run: `node --test src/services/wordCoverage.test.js`, `node --test src/services/transcriptionVerifier.test.js`, `node --test src/services/longTextInference.test.js`, `git diff --check`.
- Fixed false Full Inference verifier rejections around the phrase `one and a half to three hours`. Logs showed Whisper often transcribes the spoken phrase as `1.5 to 3 hours`, causing coverage to report missing `and`/`half` even when `hours` was present. `wordCoverage` now canonicalizes `one and a half` and `1.5` to the same token before coverage/count checks. Added pure coverage and transcription-verifier regressions. Code changed: `gpu-inference-worker/src/services/wordCoverage.js`, `gpu-inference-worker/src/services/wordCoverage.test.js`, `gpu-inference-worker/src/services/transcriptionVerifier.test.js`. Tests run: `node --test src/services/wordCoverage.test.js`, `node --test src/services/transcriptionVerifier.test.js`, `node --test src/services/longTextInference.test.js`, `git diff --check`.
- Fixed verifier forgiveness that masked the real `divide very fast` skip. The log showed `missing=[divide, very, fast]` but also `dictForgiven=[divide, very, fast]`, so coverage was adjusted to 100% and the missing phrase was not treated as the rejection cause. Dictionary-word forgiveness now only applies to longer rare/technical terms (>=7 chars), not common words like `very`/`fast`/`divide`. Also lowered the substantial missing / clipped-word scrutiny threshold from 5 chars to 4, so missing `very` and `fast` force re-rolls. Code changed: `gpu-inference-worker/src/services/transcriptionVerifier.js`, `gpu-inference-worker/src/services/wordCoverage.js`, and tests. Tests run: `node --test src/services/transcriptionVerifier.test.js`, `node --test src/services/wordCoverage.test.js`, `node --test src/services/longTextInference.test.js`, `node --test src/routes/inference.test.js`, `git diff --check`.
- Fixed a more direct audible cut/glitch source in Full Inference WAV assembly. `concatWavs` no longer fades, trims edge silence, or zero-crossing-trims generated chunks before joining; it now preserves every synthesized PCM sample and only inserts the requested pause. The old post-processing could shave soft consonants/word tails after ASR had already accepted the chunk, making it sound like words were cut despite complete synthesis. Added a regression test proving zero-pause concatenation preserves chunk PCM exactly. Code changed: `gpu-inference-worker/src/services/longTextInference.js`, `gpu-inference-worker/src/services/longTextInference.test.js`. Tests run: `node --test src/services/longTextInference.test.js`, `node --test src/routes/inference.test.js`, `git diff --check`. Not tested: no real GPU/browser TTS generation.
- Removed the likely remaining comma-caused Full Inference glitch source. Full Inference no longer inherits timestamp-spliced comma breaths by default (`commaPauseMs: 0` in `fullInferenceQualityOptions`), because Whisper timing drift can place silence inside comma-adjacent words and sound like skipped/merged speech. The long-text splitter also no longer treats commas as sentence boundaries or preferred long-sentence cut points, so intermediate chunks avoid ending on commas. Code changed: `gpu-inference-worker/src/services/longTextInference.js`, `gpu-inference-worker/src/services/longTextInference.test.js`. Tests run: `node --test src/services/longTextInference.test.js` and `node --test src/routes/inference.test.js` in `gpu-inference-worker/`; `node --test live/index.test.js` in `lambda/` after `npm ci`; `git diff --check`. Not tested: no real GPU/browser TTS generation.
- Fixed severe over-rejection / slowness: `findClippedWords` was hard-rejecting fully-correct (100%-coverage) takes over the per-word duration/confidence heuristic (`skipped/cut=[different]`, `[maintenance]`, `[cells]` etc. on takes that were transcribed completely). Root cause: Whisper's word-boundary timestamps are too imprecise for a per-char-duration ("too short") or confidence gate — briskly-spoken complete words look "too short" and rare words get low confidence. Refined the half-cut signal: `tooShort` and `tooQuiet` are each NOISY alone (brisk complete word looks short; rare complete word looks low-confidence) so neither alone forces a re-roll, but a genuine half-cut word is BOTH short AND low-confidence together — so `skippedSpan` OR (`tooShort` AND `tooQuiet`) is the hard re-roll, which catches real half-cuts without false-rejecting complete takes. Each signal alone stays advisory (best-of-N scoring). Genuine drops are still caught by near-zero span + the coverage/substantial-missing check. Reverted the trailing-word low-confidence hard rule (same false-positive problem). `SUBSTANTIAL_WORD_LENGTH` stays 5 (missing 5-letter words still re-roll, coverage-based and reliable). Disabled the custom comma-pause (`COMMA_PAUSE_MS` default 0) since timestamp placement glitched. Tests updated; 52 worker tests pass.
- Comma-pause glitch fix + trailing-word hardening + lower tracking threshold. (1) The custom comma breath sounded like a cut word: it spliced silence exactly at Whisper's word-end (which is marked slightly early, clipping the word tail) with a hard amplitude jump (click). Now `computeCommaPauses` places the silence in the natural GAP after the word (nudged up to 50ms past word-end, toward the next word's start) and applies a ~5ms `fadeEdge` ramp on both sides of the inserted silence so there's no click/clip. (2) Trailing-word hardening in `findClippedWords`: the LAST content word of a chunk now treats low confidence as a HARD re-roll (not just advisory), because end-of-chunk is where the model trails off and Whisper hallucinates the word back from context (the "minutes" skip that passed). Interior words keep confidence advisory. (3) Lowered `MIN_SCRUTINY_LENGTH` and `SUBSTANTIAL_WORD_LENGTH` 6→5 so 5-letter content words (`times`, `cells`, `nerve`) are tracked for retry. Tests added; 52 worker tests pass.
- Switched Live Full to cut0 (was cut5) and added a CUSTOM comma breath. cut5 split on every comma and synthesized each fragment separately → robotic/choppy pausing + worse pronunciation on small chunks + more Whisper false-retries (too little context). Live Fast uses cut0 (`lambda/live/index.js`). Live Full now uses cut0 for smooth natural prosody, and `insertCommaPauses` (`gpu-inference-worker/src/services/longTextInference.js`) splices a small tunable silence (`COMMA_PAUSE_MS`, default 120ms) into the finished audio at comma/clause positions using the Whisper word timestamps already computed during verification (no extra transcription → no speed cost). Degrades safely (returns audio unchanged) if not PCM16, no commas, missing timings, or heard-vs-expected word count drifts >2. `verifyChunk` now returns `words`; threaded through to `synthesizeChunkWithRetry`. Chunk size kept at the ~280-char best zone (1-3 sentences) — better context for the model AND for Whisper. Tests added (50 worker tests pass). Not GPU-verified.
- Made Live Full (and Live Full Queue) faster without weakening skip detection. Four changes in `gpu-inference-worker`: (1) `findClippedWords` now splits its output — `skippedWords` (near-zero audio span = reliable real skip, the only hard re-roll trigger) vs `suspectWords` (low-confidence/short = advisory, best-of-N scoring only). This stops perfect 100%-coverage takes being rejected over a quiet common word like "daughter"/"arranged". (2) `retryCount` 6→3 (sampling now matches Live Fast so most chunks pass in 1-2 takes). (3) Dictionary-word presence check in `verifyChunk`: admin ARPAbet words Whisper mis-transcribes (`centriole`→`central`) are forgiven when the heard word COUNT matches expected (mispronunciation keeps the count, a skip lowers it) — kills wasted re-rolls on medical terms while a real skip (short count) still re-rolls. `inference.js` loads dict words and passes them. New `countWords` helper. (4) Chunking now groups to ~500 chars and breaks ONLY at sentence ends (never commas → commas become natural cut5 pauses, less stilted), so short replies become one Live-Fast-style context-rich chunk. Added `transcriptionVerifier.test.js` (4 tests) + updated others; 47 worker tests pass. Not yet GPU-verified.
- Aligned Full Inference synthesis with the Live Fast settings that demonstrably pronounce hard medical words cleanly (user A/B: Live Fast, with no Whisper/retry, beat Full Inference). In `gpu-inference-worker/src/services/longTextInference.js`: (1) `FULL_QUALITY_PRESET` `top_k` 15→5 and `temperature` 0.62→0.7 to match Live Fast's calmer sampling; (2) `buildAttemptVariants` no longer relaxes `repetition_penalty` across retries (pinned at 1.35) — the relaxation was what produced the "barrels of barrels"/"darrels" stutter; retries now vary only the seed; (3) chunking no longer isolates one sentence per chunk (`maxSentencesPerChunk` 1→3, `maxChunkLength` 200→320) so short clinical phrases keep surrounding context — isolated short chunks were where the model degenerated into "two centrals"/"Tools and Tools". Updated affected tests; 42 worker tests pass. Not yet verified with a real GPU run.
- Made chunk verification tolerant of Whisper's orthographic normalization so genuinely-correct takes stop being rejected (and retried). `canonicalize` in `gpu-inference-worker/src/services/wordCoverage.js` maps number-words to digits (`nine`↔`9`) and US/UK spelling (`fibers`↔`fibres`, `organizing`↔`organising`, `centre`↔`center`) before matching, applied to `computeWordCoverage` and `findClippedWords`. Originals are still reported. Confirmed via logs that real model mispronunciations (e.g. `centriole`→`central`) are still caught — when the model says the word right, Whisper-medium transcribes it right, so these are genuine model errors, NOT ASR errors; excluding medical words from the check was rejected as it would silently ship mispronunciations. Tests added (47/47 worker suites pass).
- Fixed `mergeShortChunks` folding a short lead-in fragment backward onto a completed sentence (e.g. `…microtubules.` + `Structurally,`), producing a chunk that straddled a full stop with a dangling word — the chunk the model reliably mangled. It now folds such fragments FORWARD into the clause they introduce; trailing fragments still fold back as a last resort. Existing chunk tests preserved + new regression test added.
- Fixed admin pronunciation dictionary (ARPAbet) entries being silently ignored. GPT-SoVITS `english.py` only reads `engdict-hot.rep` when it rebuilds `engdict_cache.pickle`; if the cache already exists it loads that and never reads the hot file. The sync rewrote `engdict-hot.rep` but never invalidated the stale cache, so every admin ARPAbet word added after the cache was built (e.g. `centriole`) reached g2p with the wrong phonemes — the model then dropped/mispronounced it on every take, which produced the "skipped word" feedback. Changed `writeHotDictionaryOverrides` (`gpu-inference-worker/src/services/runtimePronunciationDictionary.js`) to delete `engdict_cache.pickle` whenever the hot file changes, and to self-heal by deleting a cache that predates the hot file even when this sync made no change. Widened the `/inference/start` restart trigger to also fire on `cacheInvalidated`. Cache-invalidation logic verified against a temp filesystem (7/7); full suite not run locally (deps not installed — `@aws-sdk/client-s3` missing).

## 2026-06-26

- Fixed Live Full chatbot queued replies so each assistant response snapshots the selected engine and reference/config before phrase generation starts. Live Full now keeps the Live Fast-style first-phrase queue behavior, but every phrase in that reply stays on the Live Full `/inference` route and Live Full config even if the engine selection changes mid-reply.
- Tightened Live Full chatbot payload parity with Text to Speech Full: queued chatbot phrase requests now carry `voiceProfileId` and `inference_mode: quality`, and `buildLiveReplyParams` preserves those fields instead of stripping them.
- Fixed inconsistent soft volume in queued Live Full chatbot phrases by normalizing single-chunk full-inference WAVs through the same `concatWavs` post-processing path used for joined multi-chunk output. This affects `gpu-inference-worker/src/services/longTextInference.js`; Text to Speech Full already benefited when output had multiple chunks.
- Changed chatbot Live Full queueing to use one `/api/inference/generate` session for the whole assistant reply, matching Text to Speech Full's full-session path. The hook now listens for `chunk-complete`, fetches each generated chunk via the new `/api/inference/chunk/<sessionId>/<index>` route, and plays chunks as they become ready instead of starting a separate full-inference request per phrase.
- Added inference chunk serving/proxy support in `gpu-inference-worker/src/routes/artifacts.js`, `lambda/inference/index.js`, and `lambda/shared/gpuWorker.js`.
- Fixed the top-level Lambda router so `GET /api/inference/chunk/<sessionId>/<index>` dispatches to the inference handler; without this, deployed chunk fetches returned `No Lambda route`.
- Fixed the browser chunk fetch URL in `client/src/services/api.js` to explicitly call `/api/inference/chunk/<sessionId>/<index>` via `resolveApiPath`; otherwise Vite/dev hosting could request `/inference/chunk/...` and return `Cannot GET /inference/chunk/...`.
- Added `createLiveSynthesisSnapshot` in `client/src/hooks/liveConversation.js`, used it from `client/src/hooks/useLiveSpeech.js`, and covered snapshot/payload parity with regression tests in `client/src/hooks/liveConversation.test.js`.
- Added a worker regression test proving one-chunk full inference is peak-normalized like joined chunks.
- Added a Lambda regression test for proxying generated inference chunks.
- Tests run:
  - `node --test client/src/hooks/liveConversation.test.js`
  - `node --test src/services/longTextInference.test.js` in `gpu-inference-worker/`
  - `node --test inference/index.test.js` in `lambda/`
  - `node --test router.test.js` in `lambda/`
  - `node --check src/services/longTextInference.js` in `gpu-inference-worker/`
  - `node --check src/routes/artifacts.js` in `gpu-inference-worker/`
  - `node --check inference/index.js` and `node --check shared/gpuWorker.js` in `lambda/`
  - `npm run build:live-fast` in `client/`
- Not tested: no browser microphone/WebSocket flow or real GPU Live Full synthesis was exercised.

## 2026-06-25

- Reduced Text to Speech tab Live Fast time-to-first-clip without quality loss. Added `shortenFirstFastPhrase` in `client/src/hooks/liveConversation.js`: when the first phrase is long (>70 chars) it splits once at the first clause boundary, but only if both halves stay >=24 chars / >=3 words and land on a real comma/clause mark (so a short opening clip still reads cleanly); otherwise the phrase is left intact. Applied only in the TTS-tab fast routes in `client/src/pages/LivePage.jsx` (immediate-join `fast` and `fastQueued` via a new `splitText` option on `client/src/lib/liveFastQueuedTts.js`); the OpenAI chatbot path is untouched. Also added a best-effort TTS-tab pre-warm effect: once a profile is ready it fires one tiny throwaway `synthesizeSentence` to warm GPT-SoVITS (CUDA + ref features), guarded once per profile+ref, errors swallowed. Ref-file caching (#3) was already in place (`gpu-inference-worker/src/services/refAudioCache.js` + `/ref-audio/warm`). `node --test liveConversation.test.js liveFastQueuedTts.test.js` (21/21) and `npm run build:live-fast` passed; no browser/GPU flow exercised.
- Stopped auto-persisting fallback-mode reference picks in `client/src/pages/LivePage.jsx`: `applyBestReference` now only marks the picked set for auto-sync when `chooseBestReferenceSet` returns `mode: 'strict'`. A fallback pick (clip scores / ASR transcripts not ready → mediocre primary + padded 5 aux) is still shown in the UI with a "clip scores not ready yet — not saved" message but is no longer frozen into the saved rank #1 config / voice profile. The auto-select effect also only locks `autoReferenceKeyRef` on a strict pick, so a later `trainingAudioFiles` re-fetch with scores can upgrade and persist the strict set. `npx vite build` + `node --test referenceSelection.test.js` (10/10) passed; no browser/GPU flow exercised.
- Fixed manual Live Fast reference clip edits reverting to the auto-picked 5-clip set in `client/src/pages/LivePage.jsx`: `handleAuxToggle`/`handlePrimaryReferenceChange` previously cleared `pendingAutoSyncFingerprintRef`, so manual primary/aux changes were never persisted and the active-profile restore effect overwrote them on the next profile re-fetch. They now mark the new selection for auto-sync (new `markReferenceSelectionForAutoSync` helper mirroring the `currentAutoSyncFingerprint` shape), so manual edits persist like the auto-pick. `npx vite build` passed; no browser/GPU flow exercised.
- Fixed Live Fast live edits reverting after refresh in `client/src/pages/LivePage.jsx`: the auto-sync effect only wrote the active voice profile, but model load re-applies the saved rank #1 config, so stale config ref/aux/settings overwrote unsaved edits. Auto-sync now updates the rank #1 saved config itself (via `persistLiveFastAutoSync`) and then syncs it to the voice profile; falls back to profile-only activation when no saved config exists. `npm run build:live-fast` and targeted autoVoiceProfileSync/liveFastSetup tests passed; no browser/GPU flow exercised.
- Investigated speed-factor having no audible effect (Live Fast + Live Full): verified `speed_factor` is built from the UI and forwarded end-to-end (liveRefParams/liveFullRefParams -> liveConversation params -> lambda live/inference -> worker readInferenceParams/resolveRefAudioParams/buildAttemptVariants -> GPT-SoVITS `/tts`) with no override or clamp. No code defect found; effect is engine-side in external GPT-SoVITS `/tts`. Next test: toggle `split_bucket:false` to confirm engine behavior.

- Changed Live Full configs in `client/src/pages/LivePage.jsx` to metadata presets only: Full Inference TTS, load, update, and sample now always use Live Fast rank #1 refs/aux/transcript, and the visible Live Full ref/aux controls were removed from advanced settings.
- Fixed Live Fast/Live Full config auto-selection and update behavior in `client/src/pages/LivePage.jsx`.
- Live Fast rank #1 now auto-loads only once per profile instead of snapping the UI back after refresh/update, and auto-created defaults are immediately loaded as the saved rank #1 config.
- Existing Live Fast rank #1 configs also sync to the voice profile during startup auto-load; sync failures are logged without hiding the saved config list.
- Live Full settings moved under advanced settings, gained its own best-reference no-config fallback, default config auto-save/load, reorder controls, and Full Inference sample generation without syncing to the voice profile.
- Fixed the saved Live Full config row layout so auto-created configs show their name, reference, and defaults instead of being squeezed invisible by action buttons.
- Live Fast config save/update now persists the saved config first and reports voice-profile sync failures separately for rank #1 instead of making the whole save look failed.
- Live Fast user-triggered rank #1 changes now require voice-profile sync for save/update/load/rename/reorder/delete-to-new-#1, so the active voice profile is treated as part of the rank #1 contract.
- Model-load completion now warms/applies the latest saved Live Fast rank #1 config and active voice-profile restore is skipped when saved configs exist, preventing stale voice-profile refs from overwriting updates after the model fully loads.
- Saved config prompt text/language now takes precedence over raw training file metadata when saving, loading, sampling, and syncing voice profiles, preventing edited config metadata from disappearing when the clip path is present in the training file list.
- Live Full reference selection now mirrors Live Fast with score badges, strict/manual labels, rejection reasons, primary score summary, preview buttons, and an inline preview player.
- Code files changed:
  - `client/src/pages/LivePage.jsx`
- Tests run:
  - `node --test src/lib/liveFullSetup.test.js src/lib/liveFastSetup.test.js src/lib/referenceSelection.test.js` in `client/`
  - `npm run build:live-fast` in `client/`
  - `git diff --check`
- Not tested: no browser interaction or real GPU Live Fast/Full TTS generation was executed.

## 2026-06-24

- Added an isolated Live Full settings/config panel in the Text to Speech tab. It defaults first-time refs/aux from Live Fast rank #1, uses Full Inference system defaults for metadata, saves/loads/deletes configs separately via a `liveFull` pipeline marker, and sends only Live Full params to Full Inference TTS.
- Full Inference quality defaults now fill omitted sampling controls instead of overwriting Live Full user settings.
- Code files changed:
  - `client/src/lib/liveFullSetup.js`
  - `client/src/lib/liveFullSetup.test.js`
  - `client/src/pages/LivePage.jsx`
  - `gpu-inference-worker/src/services/longTextInference.js`
  - `gpu-inference-worker/src/services/longTextInference.test.js`
- Tests run:
  - `node --test client/src/lib/liveFullSetup.test.js client/src/lib/liveFastSetup.test.js`
  - `node --test gpu-inference-worker/src/services/longTextInference.test.js`
  - `npm run build:live-fast` in `client/`
- Not tested: no browser interaction or real GPU Full Inference TTS generation was executed.

- Fixed Live Fast saved-config load/update behavior so only rank #1 syncs back into the saved voice profile, while loaded non-rank configs update the current Live Fast runtime state without replacing the default profile.
- Live Fast Text to Speech and pronunciation test generation now send the current config's explicit reference audio, aux refs, transcript, language, and inference controls instead of relying only on `voiceProfileId` lookup.
- Code files changed:
  - `client/src/pages/LivePage.jsx`
- Tests run:
  - `npm run build:live-fast` in `client/`
- Not tested: no browser interaction or real GPU TTS generation was executed.

- Added a final Full Inference quality retry that uses a Live-Fast-compatible minimal GPT-SoVITS payload, removing long-text-only flags such as `batch_size`, `split_bucket`, `parallel_infer`, and `streaming_mode` after quality/safe attempts still produce bad audio.
- Added a regression test for the final compatibility retry payload shape.
- Code files changed:
  - `gpu-inference-worker/src/services/longTextInference.js`
  - `gpu-inference-worker/src/services/longTextInference.test.js`
- Tests run:
  - `node --test src/services/longTextInference.test.js` in `gpu-inference-worker/`
  - `node --test client/src/lib/ttsHistory.test.js client/src/lib/wavConcat.test.js lambda/inference/index.test.js gpu-inference-worker/src/services/longTextInference.test.js gpu-inference-worker/src/routes/inference.test.js`
  - `npm run build:live-fast` in `client/`
  - `git diff --check -- gpu-inference-worker/src/services/longTextInference.js gpu-inference-worker/src/services/longTextInference.test.js`
- Not tested: no browser interaction or real GPU TTS generation was executed after this compatibility fallback.

- Fixed Full Inference quality-mode request shaping after repeated `Generated audio is effectively silent` errors: internal `inference_mode` is stripped before calling GPT-SoVITS, and incoming `seed: -1` now becomes a real random retry seed base instead of a fixed first-attempt seed.
- Added regression tests covering stripped internal fields and randomized `-1` seed handling.
- Code files changed:
  - `gpu-inference-worker/src/services/longTextInference.js`
  - `gpu-inference-worker/src/services/longTextInference.test.js`
- Tests run:
  - `node --test src/services/longTextInference.test.js` in `gpu-inference-worker/`
  - `node --test client/src/lib/ttsHistory.test.js client/src/lib/wavConcat.test.js lambda/inference/index.test.js gpu-inference-worker/src/services/longTextInference.test.js gpu-inference-worker/src/routes/inference.test.js`
  - `npm run build:live-fast` in `client/`
  - `git diff --check -- gpu-inference-worker/src/services/longTextInference.js gpu-inference-worker/src/services/longTextInference.test.js`
- Not tested: no browser interaction or real GPU TTS generation was executed after this request-shaping fix.

- Relaxed the Full Inference quality analyzer's silence gate so very quiet but non-empty PCM audio is treated as recoverable and can be peak-normalized during WAV joining, while true silence is still rejected.
- Added a regression test for quiet recoverable audio that previously failed with `Generated audio is effectively silent`.
- Code files changed:
  - `gpu-inference-worker/src/services/longTextInference.js`
  - `gpu-inference-worker/src/services/longTextInference.test.js`
- Tests run:
  - `node --test src/services/longTextInference.test.js` in `gpu-inference-worker/`
  - `node --test client/src/lib/ttsHistory.test.js client/src/lib/wavConcat.test.js lambda/inference/index.test.js gpu-inference-worker/src/services/longTextInference.test.js gpu-inference-worker/src/routes/inference.test.js`
  - `npm run build:live-fast` in `client/`
  - `git diff --check -- gpu-inference-worker/src/services/longTextInference.js gpu-inference-worker/src/services/longTextInference.test.js`
- Not tested: no browser interaction or real GPU TTS generation was executed after this threshold adjustment.

- Changed Full Inference TTS into a dedicated quality mode that ignores UI sliders and applies a worker-owned GPT-SoVITS preset for natural/stable output.
- Added a longer adaptive retry ladder for Full Inference chunks: first attempt uses the natural quality preset, later attempts progressively lower randomness and increase safety, and the final attempt uses the safest split/inference settings.
- Added best-effort chunk fallback for Full Inference so, after all quality attempts fail, the worker can use the best non-silent/non-corrupt candidate instead of failing the whole final WAV.
- Adjusted Full Inference chunking to keep normal sentences intact for flow while still limiting long chunks to about 220 characters.
- Code files changed:
  - `client/src/pages/LivePage.jsx`
  - `gpu-inference-worker/src/routes/inference.js`
  - `gpu-inference-worker/src/services/longTextInference.js`
  - `gpu-inference-worker/src/services/longTextInference.test.js`
- Tests run:
  - `node --test src/services/longTextInference.test.js src/routes/inference.test.js` in `gpu-inference-worker/`
  - `node --check src/routes/inference.js` in `gpu-inference-worker/`
  - `npm run build:live-fast` in `client/`
  - `node --test client/src/lib/ttsHistory.test.js client/src/lib/wavConcat.test.js lambda/inference/index.test.js gpu-inference-worker/src/services/longTextInference.test.js gpu-inference-worker/src/routes/inference.test.js`
  - `git diff --check -- client/src/pages/LivePage.jsx gpu-inference-worker/src/routes/inference.js gpu-inference-worker/src/services/longTextInference.js gpu-inference-worker/src/services/longTextInference.test.js`
- Not tested: no browser interaction or real GPU TTS generation was executed.

- Fixed Full Inference TTS reliability by starting worker generation immediately after `/api/inference/generate` returns, instead of waiting for the browser SSE connection before synthesis begins.
- Added a Text to Speech fallback poll of `/api/inference/current` so a completed Full Inference session can still add a playable output card if the SSE completion event is missed.
- Improved Full Inference TTS quality by sending the active UI/config inference parameters and using shorter one-sentence long-text chunks with a slightly longer join pause.
- Code files changed:
  - `client/src/pages/LivePage.jsx`
  - `gpu-inference-worker/src/routes/inference.js`
- Tests run:
  - `npm run build:live-fast` in `client/`
  - `node --check src/routes/inference.js` in `gpu-inference-worker/`
  - `node --test client/src/lib/ttsHistory.test.js client/src/lib/wavConcat.test.js lambda/inference/index.test.js`
- Not tested: no browser interaction or real GPU TTS generation was executed.

- Fixed Live Fast saved-config updates so the nested inference metadata preserves the updated config's id/name, keeping saved config records and active profile metadata aligned.
- Changed saved config `Load` so it also activates that config as the current voice profile used by inference; updating the currently loaded config now syncs it into inference too.
- Code files changed:
  - `client/src/pages/LivePage.jsx`
- Tests run:
  - `npm run build:live-fast` in `client/`
- Not tested: no browser interaction or real GPU TTS generation was executed.

- Fixed browser-side Live Fast Text to Speech WAV joining when sentence clips return as PCM16 WAVs with different sample rates; clips are now resampled to the first clip's sample rate before concatenation.
- Code files changed:
  - `client/src/lib/wavConcat.js`
  - `client/src/lib/wavConcat.test.js`
- Tests run:
  - `node --test client/src/lib/wavConcat.test.js`
  - `npm run build:live-fast` in `client/`
- Not tested: no browser interaction or real GPU TTS generation was executed.

## 2026-06-23

- Changed Text to Speech pronunciation ARPAbet save/delete/import behavior so entries are saved immediately but no longer restart inference automatically per word.
- Added a manual `Load changes` action in the pronunciation dictionary panel; it runs the existing stop/start/status refresh once so GPT-SoVITS reloads pending ARPAbet hot-dictionary updates when the user chooses.
- ARPAbet pronunciation tests now require pending changes to be loaded first, avoiding tests against stale `engdict-hot.rep` contents.
- Code files changed:
  - `client/src/pages/LivePage.jsx`
- Tests run:
  - `npm run build:live-fast` in `client/`
- Not tested: no browser interaction, real GPU TTS generation, real S3 dictionary write, or real GPT-SoVITS restart was executed.

## 2026-06-22

- Added a Text to Speech `Live Fast Queue` button that uses the same `/api/live/tts-sentence` sentence generation path but starts playback as soon as the first sentence clip is ready while later sentence clips continue generating. Queued clips play internally and are not added to the visible Live Fast output history.
- Added a reusable frontend helper for queued Live Fast sentence generation so other frontend integrations can call the same split/generate/clip-ready flow.
- Code files changed:
  - `client/src/pages/LivePage.jsx`
  - `client/src/lib/liveFastQueuedTts.js`
  - `client/src/lib/liveFastQueuedTts.test.js`
- Tests run:
  - `node --test client/src/lib/liveFastQueuedTts.test.js client/src/lib/wavConcat.test.js client/src/lib/ttsHistory.test.js`
  - `npm run build:live-fast` in `client/`
- Not tested: no browser interaction or real GPU TTS generation was executed.

- Fixed Text to Speech Full Inference output playback in browser-download/GPU-artifact mode by accepting `/api/inference/result/<sessionId>` JSON `{ url }` responses instead of wrapping that JSON as a fake WAV blob.
- Fixed the follow-up case where Full Inference audio only became playable after switching tabs by waiting for browser audio metadata with retries before adding the output card.
- Kept direct WAV blob handling for local/non-artifact responses and kept the S3-mode redirect source unchanged.
- Code files changed:
  - `client/src/pages/LivePage.jsx`
  - `client/src/services/api.js`
- Tests run:
  - `npm run build:live-fast` in `client/`
- Not tested: no browser interaction or real GPU TTS generation was executed.

## 2026-06-18

- Changed Text to Speech tab Live Fast generation so it always uses `/api/live/tts-sentence`; long pasted text is split with the Live Fast chatbot phrase splitter, generated sentence by sentence, then joined into one browser-local WAV for download.
- Kept Full Inference TTS on the async `/api/inference/generate` path.
- Changed Text to Speech tab Full Inference result handling to use a same-API redirect URL for audio playback in S3 mode, avoiding browser blob fetches of presigned S3 WAVs while still giving the audio element a playable source.
- Added Live Fast Text to Speech sentence progress showing current sentence number and text while queued sentence clips render.
- Moved English pronunciation/text normalization into shared GPU inference-worker code and applied it to both long/full inference and Live Fast `/inference/tts`.
- Expanded English normalization for bullets, dash/range forms, smart quotes, math symbols, and more abbreviations.
- Added an English-only pronunciation dictionary admin panel on the Text to Speech tab with category selection and S3-backed custom entry storage under `pronunciation-dictionary/english/<category>.json`.
- Wired saved admin pronunciation entries into runtime: readable entries replace matching words immediately before synthesis, and ARPAbet entries are written into a managed block in GPT-SoVITS `engdict-hot.rep` before `/inference/start`.
- Admin ARPAbet entries remove older matching runtime `engdict-hot.rep` lines before writing the managed block, so admin custom words override existing dictionary pronunciations.
- Added Lambda proxy support for `POST /api/inference/start`; after saving an admin ARPAbet entry, the TTS tab stops and starts inference so GPT-SoVITS can reload the hot dictionary.
- After admin ARPAbet saves, the TTS tab now reloads the selected model after inference restarts.
- If an admin entry has both readable pronunciation and ARPAbet, ARPAbet takes priority for synthesis; readable entries are applied as text replacement only when ARPAbet is absent.
- Added pronunciation dictionary edit/delete controls in the Text to Speech tab. Saving an existing word updates it; deleting an ARPAbet entry restarts inference and reloads the selected model so GPT-SoVITS drops the managed hot-dictionary override.
- Added pronunciation test generation from the admin panel. Readable-only draft entries can be tested before saving; ARPAbet entries can be tested after save/restart because GPT-SoVITS reads them from the hot dictionary.
- Added CSV export/import for pronunciation dictionaries. Export downloads the current category; import accepts `word,category,readable,arpabet,notes` rows and batches restart/reload once when imported rows include ARPAbet.
- Pronunciation save/delete/import restart now clears the existing page auto-load guard and refreshes inference status, so the same startup auto-load effect reloads the selected voice profile/model/config instead of using a separate manual load path.
- Pronunciation tests use the Live Fast sentence endpoint (`/api/live/tts-sentence`) and write the preview clip into the Live Fast output history.
- Improved English normalization so spaced dashes/em dashes become comma pauses instead of raw dash punctuation, and added slash/abbreviation expansions such as `w/`, `w/o`, `b/c`, `ref.`, and word/word forms.
- Added a Datamuse-based maintenance sync for complex English technical terms into the committed `engdict-hot.additions.rep`; the admin UI stays custom-only and does not call Datamuse.
- Expanded `gpu-inference-worker/pronunciation/engdict-hot.additions.rep` with Datamuse-synced biology, chemistry, and math terms.
- Added browser-side WAV concatenation helper for Live Fast sentence clips.
- Code files changed:
  - `client/src/pages/LivePage.jsx`
  - `client/src/services/api.js`
  - `client/src/lib/pronunciationCsv.js`
  - `client/src/lib/pronunciationCsv.test.js`
  - `client/src/lib/wavConcat.js`
  - `client/src/lib/wavConcat.test.js`
  - `gpu-inference-worker/src/services/textPronunciation.js`
  - `gpu-inference-worker/src/services/textPronunciation.test.js`
  - `gpu-inference-worker/src/services/runtimePronunciationDictionary.js`
  - `gpu-inference-worker/src/services/runtimePronunciationDictionary.test.js`
  - `gpu-inference-worker/pronunciation/engdict-hot.additions.rep`
  - `gpu-inference-worker/pronunciation/datamuse-terms.txt`
  - `gpu-inference-worker/scripts/sync_datamuse_pronunciations.js`
  - `gpu-inference-worker/src/services/longTextInference.js`
  - `gpu-inference-worker/src/routes/inference.js`
  - `gpu-inference-worker/src/routes/inference.test.js`
  - `lambda/inference/index.js`
  - `lambda/inference/index.test.js`
  - `lambda/pronunciation-dictionary/index.js`
  - `lambda/pronunciation-dictionary/index.test.js`
  - `lambda/router.js`
  - `lambda/scripts/package-function-url.ps1`
- Tests run:
  - `node --test gpu-inference-worker/src/services/runtimePronunciationDictionary.test.js gpu-inference-worker/src/services/textPronunciation.test.js gpu-inference-worker/src/services/longTextInference.test.js gpu-inference-worker/src/routes/inference.test.js`
  - `node --test gpu-inference-worker/src/services/runtimePronunciationDictionary.test.js gpu-inference-worker/src/services/textPronunciation.test.js gpu-inference-worker/src/routes/inference.test.js`
  - `node --test client/src/lib/wavConcat.test.js client/src/hooks/liveConversation.test.js`
  - `node --test lambda/pronunciation-dictionary/index.test.js lambda/router.test.js lambda/inference/index.test.js`
  - `node --test lambda/inference/index.test.js lambda/pronunciation-dictionary/index.test.js lambda/router.test.js`
  - `node --test lambda/pronunciation-dictionary/index.test.js lambda/router.test.js lambda/inference/index.test.js`
  - `node --test client/src/lib/pronunciationCsv.test.js client/src/lib/wavConcat.test.js client/src/hooks/liveConversation.test.js`
  - `npm run build:live-fast` in `client/`
  - `git diff --check`
- Not tested: no browser interaction, real GPU TTS generation, real S3 dictionary write, or real GPT-SoVITS restart with admin ARPAbet entries was executed.

## 2026-06-16

- Added a Text to Speech tab to the Live Fast build.
- Made the live-fast deployed tab CloudFront/S3-friendly by routing the tab to `/?tab=text-to-speech`; the direct `/text-to-speech` route remains available only when SPA fallback is configured.
- The Text to Speech page reuses the existing Live Fast voice/model/config state and offers two generation paths:
  - Live Fast TTS via `/api/live/tts-sentence`
  - Full inference TTS via `/api/inference`
- Generated TTS WAVs are browser-local blob downloads and are not uploaded to S3.
- Text to Speech now keeps browser-local generation history for both Live Fast and Full Inference outputs; newer generations are added at the top instead of replacing previous audio.
- Code files changed:
  - `client/src/App.jsx`
  - `client/src/lib/appMode.js`
  - `client/src/lib/appMode.test.js`
  - `client/src/lib/ttsHistory.js`
  - `client/src/lib/ttsHistory.test.js`
  - `client/src/pages/LivePage.jsx`
- Tests run:
  - `node --test client/src/lib/ttsHistory.test.js client/src/lib/appMode.test.js`
  - `npm run build:live-fast` in `client/`
- Not tested: no browser interaction or real GPU TTS generation was executed; AWS deploy was blocked by invalid local AWS credentials.

## 2026-06-12

- Fixed deployed Live Fast voice-profile activation 403s caused by CloudFront blocking large `/api/voice-profile/activate` request bodies around 8 KB.
- Compacted activation metadata in `buildVoiceProfilePayload` so rich reference scoring/check/transcript details stay in saved config records, while the active voice profile keeps only compact selected path/score metadata.
- Verified the real Student1 compact activation payload was 3,756 bytes and `POST /api/voice-profile/activate` returned 200 through the public CloudFront URL.
- Fixed `/api/models/select` auto-reference persistence so backend auto-selection for a weak saved voice profile also writes `voice-profile-configs/<voiceProfileId>/default.json`.
- Moved default voice-profile config construction into shared model-selection code and reused it from synthesis-time voice profile resolution.
- Code files changed:
  - `client/src/lib/voiceProfilePayload.js`
  - `client/src/lib/voiceProfilePayload.test.js`
  - `lambda/shared/modelSelection.js`
  - `lambda/shared/modelSelection.test.js`
  - `lambda/shared/voiceProfileRuntime.js`
- Tests run:
  - `node --test src/lib/voiceProfilePayload.test.js` in `client/`
  - `npm run build:live-fast` in `client/`
  - `node --test lambda/shared/modelSelection.test.js`
  - `node --test lambda/shared/modelSelection.test.js lambda/shared/voiceProfileRuntime.test.js lambda/router.test.js lambda/training/index.test.js`
  - Public CloudFront probe: compact Student1 activation POST returned 200
- Not tested: no full browser voice-chat run or real GPU synthesis call was exercised after the frontend payload change.

## 2026-06-10

- Upgraded Live Fast reference selection from ranking-only to strict filtering plus fallback ranking.
- Added visible reference metadata: score breakdown, strict/manual mode, rejection reasons, and selected primary/aux metadata.
- Saved voice-profile metadata layers for reproducibility:
  - training metadata
  - reference metadata
  - Live Fast inference/config metadata
- Added an always-visible Live Fast config panel in advanced settings with current settings, saved metadata state, and a local Save config action.
- Added per-person saved config storage under `voice-profile-configs/<voiceProfileId>/<configId>.json`.
- Live Fast configs can now be listed, loaded into the editable controls, updated, deleted, and used to generate a short comparison sample in the browser.
- Config records store immutable training metadata for display, editable inference metadata, editable reference/aux metadata, rank/selected fields, and sample metadata.
- Fixed deployment packaging so the Lambda zip includes `voice-profile-configs/`.
- Switched config save/delete browser calls to POST for CloudFront method compatibility.
- Hardened config sample generation so it resolves the primary reference transcript from training audio/config metadata and blocks invalid sample requests with an in-panel message.
- Added `GET /api/train/metadata/<expName>` to read training metadata from `training/runs/<expName>/metadata.json`.
- Live Fast now shows training metadata separately from saved configs and logs config/training metadata lifecycle events to the browser console.
- Primary reference dropdown options now show reference score and strict/manual status.
- Save new config is enabled for any selected model with a primary reference, so changed refs, aux clips, or inference sliders can be saved as a new config.
- Fixed generated sample playback by keeping browser blob URLs alive until replacement or unmount.
- Voice profile is the source of truth for external chatbot and system synthesis; configs are saved variants under the profile.
- Frontend auto-loads rank #1 config for editing, but rank #1 saves sync into the voice profile rather than backend synthesis reading config storage directly.
- If refs must be auto-selected from a weak voice profile, the backend updates the voice profile and writes `voice-profile-configs/<voiceProfileId>/default.json` as the first config record.
- Saved config cards now track the loaded config, only allow Update on the loaded config, and support Up/Down reordering.
- Reordering persists ranks; whichever config becomes rank #1 is synced back into the voice profile.
- Replaced config Up/Down buttons with drag-and-drop reordering.
- Config names can now be renamed inline; blur or Enter saves the new name.
- Added GPU training-run metadata sidecar upload to `training/runs/<expName>/metadata.json`.
- Forwarded training source dataset stats and optional selected reference metadata through Lambda to the GPU worker.
- Code files changed:
  - `client/src/lib/referenceSelection.js`
  - `client/src/lib/referenceSelection.test.js`
  - `client/src/lib/voiceProfilePayload.js`
  - `client/src/lib/voiceProfilePayload.test.js`
  - `client/src/pages/LivePage.jsx`
  - `client/src/services/api.js`
  - `client/src/pages/TrainingPage.jsx`
  - `lambda/router.js`
  - `lambda/router.test.js`
  - `lambda/shared/s3.js`
  - `lambda/scripts/package-function-url.ps1`
  - `lambda/training/index.js`
  - `lambda/training/index.test.js`
  - `lambda/voice-profile/index.js`
  - `lambda/voice-profile/index.test.js`
  - `lambda/voice-profile-configs/index.js`
  - `lambda/voice-profile-configs/index.test.js`
  - `gpu-worker/src/routes/training.js`
  - `gpu-worker/src/services/pipeline.js`
  - `gpu-worker/src/services/pipeline.test.js`
- Tests run:
  - `node --test src/lib/referenceSelection.test.js src/lib/voiceProfilePayload.test.js` in `client/`
  - `node --test training/index.test.js voice-profile/index.test.js` in `lambda/`
  - `node --test training/index.test.js router.test.js` in `lambda/`
  - `node --test voice-profile-configs/index.test.js router.test.js` in `lambda/`
  - `npm.cmd run package:function-url` in `lambda/`
  - `node --test src/services/pipeline.test.js` in `gpu-worker/`
  - `npm.cmd run build` in `client/`
- Not tested: no browser interaction, full training run, S3 upload, or real-audio reference comparison was executed. Config sample audio is generated in-browser; only sample metadata is saved server-side.

## 2026-06-09

- Updated project-memory docs after reviewing newer branch commits `48648fe..977330d`.
- Recorded the move to the `v2ProPlus` training path, the added speaker-verification step, duration-aware reference selection, the `Skip denoise` training option, and the repo doc renames that mark older deployment notes as outdated.
- Markdown files changed:
  - `PROJECT_MAP.md`
  - `HANDOFF.md`
  - `TODO.md`
  - `DECISIONS.md`
  - `docs/api.md`
  - `docs/setup.md`
  - `docs/deployment.md`
- Code files changed: none.
- Tests run:
  - `npm run build:training` in `client/`
  - `python -m py_compile gpu-worker/scripts/score_clips.py`
  - `node --check` on the touched Lambda, gpu-worker, and non-JSX client modules
- Not tested: no training, inference, browser, or deployment flow was executed.

## 2026-06-07

- Bootstrapped project-memory docs in the vault:
  - `PROJECT_MAP.md`
  - `HANDOFF.md`
  - `TODO.md`
  - `DECISIONS.md`
  - `docs/setup.md`
  - `docs/api.md`
  - `docs/deployment.md`
- Code files changed: none.
- Tests run: none.
- Not tested: repo behavior was inspected only; no runtime or unit verification was executed.
# 2026-08-27

- Faculty Live Fast now shows `Select a voice to begin.` without a loading spinner when no cloned or standard voice is selected; real model-loading states retain the existing progress banner.
- AWS readback found staging inference scaled 1→2 for Dean demand at 02:06 UTC and 2→3 for a distinct pending `cs-nathanael-ng-v1` faculty model at 02:13 UTC. Existing coordinator logs do not preserve the active/queued snapshot needed to prove why the first Dean request exhausted capacity.
- Code files changed: `client/src/pages/LivePage.jsx`, `client/src/giPublicAccess.test.js`.
- Tests run: `node --test src/giPublicAccess.test.js` (26/26), `npm run build:chatbot`.
- Not tested: the new faculty banner has not been deployed or browser-verified.
- Added publish-time staging-to-Dev mirroring for lecture category records and the exact cloned
  profile, GPT/SoVITS weights, and selected reference audio. Backfilled `gi-bleeding` and verified
  nine artifact copies by size/ETag before switching Dev to `deanvoice-v1`.
- Hid advanced settings on faculty, made Dev GPU lifecycle manual-only, and corrected staging's
  daily ASG actions to preserve one baseline without resetting desired capacity.
- Unified both remote branches at `7c9a781`; deployed equal Lambda package hashes and equal GI
  bundle `assets/index-BrQYHCPo.js`. Dev fixed and staging ASG workers independently returned
  HTTP 200 WAV synthesis for the mirrored DeanVoice model.
- Code files changed: `client/env/staging/chatbot-text.env`, `client/src/giPublicAccess.test.js`,
  `lambda/.env.deployment`, `lambda/.env.deployment.staging`, `lambda/chatbot-prompt/index.js`,
  `lambda/chatbot-prompt/index.test.js`, `lambda/shared/s3.js`.
- Tests run: Lambda 282/282; client 464/464; targeted config suite 27/27; both client builds;
  public category/bundle checks; S3 size/ETag checks; two real worker synthesis canaries.
- Not tested: authenticated faculty publish from the browser, a second lecture/profile, and an
  active 50-GPU event run remain pending.

# 2026-08-28

- Corrected staging model routing so a ready idle GPU changes to the requested model immediately;
  sequential voice choices by one user no longer reserve several GPUs for five minutes and force
  unnecessary scale-out. A positive residence window remains available for explicit event mode.
- Restored the original Dev GPU's 30-minute activity stop and added a separate manual-only Dev
  inference GPU. A dedicated activity route prevents the shared target group from stopping the
  original based on the comparison GPU's state.
- Deployed both Dev workers and Dev Lambda. Two ALB requests produced valid WAVs on different GPUs,
  both with the exact Dean weights. The manual GPU was stopped after the test. Staging finished at
  desired 1 with one healthy idle Dean worker.
- The deployed staging TTS page showed GPU ready, DeanVoice ready, and no perpetual loading state.
- Temporary AMI `ami-02b84a31fa1faf824` was deregistered. Snapshot
  `snap-08ec74499a13176f7` remains because the assumed role lacks `ec2:DeleteSnapshot`.
- Code files changed: `client/src/giPublicAccess.test.js`, `gpu-inference-worker/src/routes/activity.js`,
  `lambda/instance/index.js`, `lambda/instance/index.test.js`, `lambda/model-coordinator/index.js`,
  `lambda/model-coordinator/decision.js`, `lambda/model-coordinator/decision.test.js`, deployment
  env/config files, and `scripts/deploy-bundle-hosts.ps1`.
- Tests run: client config 27/27; Lambda instance/coordinator 28/28; coordinator 11/11;
  inference worker 258/258; live AWS Lambda/ASG/target-health checks; two real Dev TTS calls.
- Not tested: authenticated faculty Publish from the browser and a full multi-user scale-out event.

# 2026-09-05

- Shut down Prof. Sung lecture GPU capacity in AWS account `329599637774`: stopped the fixed
  Staging GPU (Dev was already stopped), set the Staging ASG to min/desired 0, and neutralized both
  recurring ASG actions at zero. The sole account Fargate services were already desired/running 0.
- Prevented automatic restart by giving both fixed-GPU controllers an always-closed schedule and
  switching the Staging model coordinator from autoscale to routing-only.
- Updated `docs/staging-architecture.md` and `scripts/deploy.config.json`; live verification checked
  EC2 state, ASG capacity/membership/actions, Lambda control settings, and all-region ECS inventory.

# 2026-10-05

- Added a staging Live MC site: `client/src/pages/McSessionPage.jsx`, `client/src/lib/mcSession.js`
  (MC system prompt + status copy), build mode `mc` (lazy-loaded from `main.jsx`, kiosk in
  `appMode.js`), `client/env/staging/mc.env`, new CloudFront `E2F49Q71ZUM0G0` /
  `d32nzk2gacfhag.cloudfront.net` in `deploy.config.json` and `deploy-client.ps1`.
- Uses the shared Live Fast pipeline (OpenAI realtime + `deanvoice-v1`, phrases mode) with the
  same server-resolved Dean settings as the pinned chatbot. Collapsible system instructions,
  reference-style avatar placeholder tile with mic/waveform/end-call pill, and a fullscreen stage
  (edge-to-edge tile + chat-bubble transcript); falls back to a window-filling overlay when native
  fullscreen is refused or hangs.
- `useLiveSpeech`/`liveConversation`: new `listeningMode` (`turns` gates mic input and barge-in
  while the AI replies; `continuous` is unchanged default) and a fix for mic streams left running
  when a session ends while mic permission is pending.
- Staging restored (see deployment.md): `scripts/configure-staging-mc.mjs` (CORS/auth origin,
  S3 OAC policy for `dist-mc`, schedule 00-24, autoscale, ASG daily min 1).
- Tests: client `node --test` 503/503; live `scripts/test-staging-mc.mjs` PASS (text turn + PCM
  speech turn -> OpenAI -> DeanVoice WAV, context kept, admin API not routed); Chrome checks of
  normal/fullscreen/fallback layouts. Not tested: a real human microphone session in the browser.

# 2026-10-06

- Live MC turn detection: the client noise gate stopped sending audio ~1.5s after speech, so
  OpenAI `semantic_vad` never heard the trailing silence it needs and turns hung on "Listening...".
  `useLiveSpeech.js` now sends ~4s of digital-zero frames after the gate closes
  (`VOICE_GATE_SILENCE_TAIL_FRAMES`). Shared hook: other live clients get it on their next deploy.
- Live MC reconnect: opt-in `autoReconnect` in `useLiveSpeech` (enabled in `McSessionPage.jsx`).
  A dropped socket after the first `session.ready` reopens with backoff (1/2/4/8s, 10 attempts),
  re-sends the system prompt plus the recent transcript (`buildReconnectSystemPrompt` in
  `liveConversation.js`), and keeps a playing reply. MC status shows "Connection dropped · reconnecting".
- Added `scripts/soak-staging-mc.mjs` (long-held public MC socket with periodic turns).
- Deployed staging `mc` client twice. Tests: client `node --test` 507/507; live
  `test-staging-mc.mjs` PASS; Chrome fake-mic runs: trailing-off utterance -> turn end 0.8s after
  speech, reply text 1.5s; forced socket close -> reopened and ready in <3s with context kept.
  Not tested: a real human microphone; drops caused by OpenAI's session time limit (soak running).
- Live MC voice capture (later 2026-10-06): the client noise gate (RMS 0.02) dropped normal
  phone-distance speech entirely (fake mic at RMS 0.0156 never produced `speech.started`). New
  `useLiveSpeech` option `noiseGate: false` (MC only) streams all mic audio to OpenAI's VAD.
- Turn ending: `session.init` may carry `turnEagerness` (low/medium/high/auto) for semantic_vad;
  gateway `openaiRealtimeEvents.js`/`openaiRealtimeBridge.js`/`routes/liveChat.js`, client
  `liveChatHandshake.js`/`liveChatSocket.js`; MC sends `high`. Other clients unchanged (auto).
- Deployed: staging gateway files via SSM to `i-0f0da8be59367f7a8` (ap-northeast-2, pm2
  `live-gateway`, backups `*.bak-20261006101344`), then `pm2 restart`; staging `mc` client.
- Tests: gateway 182/182, client 507/507, `test-staging-mc.mjs` PASS after restart. Chrome fake mic
  (voice RMS 0.014 + noise 0.005): old build never heard it; ungated heard it but ended the turn
  4.4s after speech; with `high` 2.5s (reply text 2.8s). Soak stopped at ~40 min (6/6 turns <1.1s)
  for the gateway restart; the 60-minute OpenAI session cap is still unsoaked.
- Live MC capture/turn-taking overhaul (later 2026-10-06; inference untouched):
  - Gateway `session.init` accepts validated `turnDetection` (server/semantic VAD, clamped), `noiseReduction`
    and `transcriptionPrompt`. `scripts/vad-bench-mc.mjs` streams real-time speech with 0.5/0.7/1.1s
    mid-sentence pauses: semantic VAD median 1.4-1.6s but tail 3-5s; server VAD 700ms ended turns in
    1.29-1.37s every time and rode out 0.5-0.7s pauses. MC uses server VAD 0.5/700ms/500ms prefix, far field.
  - Capture: `client/src/lib/micCapture.js` (AudioWorklet off the main thread, ScriptProcessor fallback) and
    `micResampler.js` (windowed-sinc anti-aliasing; the old box average aliased at 44.1 kHz). 40ms frames
    when ungated, 85ms when gated (gate timings unchanged for other pages).
  - `useLiveSpeech` `fullDuplex` (MC): mic streams until the reply is audible in both modes, so a speaker
    who pauses and continues cancels the half-ready reply; continuous mode streams while the AI speaks and
    barge-in comes from OpenAI's VAD (`user.speech.started`), not an RMS threshold. Reply-start input pauses
    now defer to the phase rule. Mute mid-sentence commits on OpenAI speech evidence (quiet voices).
  - MC UI: statuses Listening / Hearing you / Got it · replying / speaking · mic paused (or talk to
    interrupt) / Muted · tap the mic to talk; typing dots replace placeholder bubbles.
- Staging gateway box: systemd `voice-live-gateway` and pm2 both supervised the gateway and raced for
  :3002 (19,666 systemd restarts; every restart was a race). pm2 app deleted and `dump.pm2` saved empty
  (backup `dump.pm2.bak-20261006`); systemd is the only supervisor.
- Tests: gateway 183/183, client 517/517. Chrome fake-mic on staging (worklet path confirmed): pause then
  continue -> early reply dropped unvoiced, full thought answered, turn end 1.08s; mute mid-sentence ->
  commit in 10ms, exact partial transcript; continuous barge-in -> reply stopped, interruption answered.
  Not tested: a real human mic, speaker echo in continuous mode (browser AEC), Safari/iOS, Firefox.
- Live MC follow-up (user report: turn-based replies were being cut off, transcripts fragmented):
  - Turn-based is strictly half duplex again: mic closes when a turn ends, replies always finish; only
    continuous mode cancels/interrupts. Turn-based pause 900ms (continuous 700ms); mode locked per session.
  - MC transcript (`mcTranscriptEntries`): replies cancelled before any audio was heard are hidden; consecutive
    user fragments merge into one bubble. Level meter is flat whenever the mic is not being sent.
  - "Voice capture settings" panel (saved per browser, applied at session start): noise filter Off
    (no browser NS, no OpenAI noise reduction) / Standard (both, far field) / Strong (+ VAD threshold 0.65);
    pause Short/Normal/Long. Hook option `micConstraints`.
  - Gateway `transcriptionContext`: after each reply the transcriber prompt is refreshed with the last
    exchange (~600 chars) via a full session.update.
  - Tests: client 519/519, gateway 185/185, build OK. Bench (quiet voice + noise, 900ms): Standard 1.60s,
    Strong 1.49s, Off 1.44s turn end, no misses, Off accepted by OpenAI.
  - NOT DEPLOYED: AWS session credentials expired before the gateway/client deploy.
- Live MC follow-up, deployed (supersedes the "NOT DEPLOYED" entry above):
  - Reverted per user: no user-bubble merging; interrupted AI replies stay visible, tagged "Interrupted".
  - Transcriber benchmark (quiet voice + noise): gpt-4o-transcribe 5.6% WER (kept); gpt-4o-mini 12.9%;
    gpt-transcribe 194% with a 7.4s stall; a conversation-context prompt leaked earlier turns into
    transcripts (e.g. "Yes." -> a paragraph), so the context feature was removed. Gateway keeps a
    whitelisted per-session `transcriptionModel` option for future tests.
  - Background-talker bench: false turns 6 (threshold 0.5) / 4 (0.65) / 2 (0.8); no noise reduction never
    ended a turn; a soft speaker was still caught at 0.8. Sliders: noise Off/Low/Medium(0.65, default)/
    High(0.72)/Max(0.8); pause 0.4-1.5s, default 0.7s (reply starts ~pause + 0.6s). Mode/slider changes
    mid-session show "applies to the next session"; the running session keeps its start settings.
  - Fixed a race where End then immediate Start reused the previous session's capture settings.
  - Tests: client 519/519, gateway 184/184; Chrome on staging verified slider values reach getUserMedia and
    session.init (Max/1.0s and Off/0.5s), OpenAI accepts noise reduction off, mid-session notice shows.


## 2026-10-08

- Shut down staging inference capacity: ASG and both recurring actions min/desired/max 0;
  coordinator routing-only; enabled fixed Staging GPU 00-00 schedule (Dev already closed).
- Updated repo deployment map and architecture plus vault deployment/handoff/bug state.
- Checks: AWS schedule/Lambda read-backs; instance controller tests 17/17.
  ASG worker termination still draining at the initial check; no application code changed.
- Final follow-up: last ASG worker reached EC2 `shutting-down`; ASG remains 0/0/0.
  Termination completion is not yet observed. Fixed GPUs remain stopped.

## Zero-shot lab - 2026-10-22

- Seoul ap-northeast-2a: i-093e8b2081168aff3, g6e.2xlarge, one L40S, 8 vCPU, 64 GiB RAM, 350 GiB gp3. Dev/Staging unchanged.
- Public URL: https://d11833a346b73cedf4.gradio.live/ . Login: repo-local .tmp/zero-shot/access.json; do not commit credentials. The old f9a287074a9fc61eb4 link is obsolete.
- Eight models generated valid audio: LongCat, dots.tts, VoxCPM2, Qwen3-TTS, FireRedTTS3, IndexTTS2.5, untrained GPT-SoVITS v2Pro and v5dev. Raon is blocked by a published vocabulary/checkpoint mismatch (5559 versus 5555 tokens); no speculative token remapping applied.
- Independent ffprobe/soundfile and CPU Whisper checks passed for the eight outputs. Ten input-validation tests passed. Authenticated public Qwen API returned 4.88 seconds of audio in 30.731 seconds; unauthenticated config access returned 401. Speaker similarity, browser microphone interaction and broad language coverage remain unverified.
- Remote root /opt/zero-shot-lab; systemd zero-shot-lab.service runs as ubuntu and starts on boot. Logs: logs/ui.log; evidence: smoke/verification-results.json and smoke/public-api.json. Each request loads one model and releases GPU memory on exit.
- Scheduled shutdown: 2026-10-22 22:20 SGT. EC2 stop retains billable EBS. Temporary Gradio URL can change on service restart and lasts up to one week. Stop earlier using AWS EC2 stop-instances for this instance in ap-northeast-2.
- Code added: scripts/clone-bench/catalog.py, install_lab.py, run_model.py, app.py, smoke_lab.py, verify_lab.py, test_lab.py and start_lab.sh. Updated repo docs/voice-model-evaluation.md with compatibility evidence.


## 2026-10-23 - LongCat text dropping

- Cause: LongCat caps reference + generated audio at max_wav_duration 60 s; the 30 s Dean reference left 30 s for ~40 s of text, so output clamped at 29.95 s and words were dropped. Confirmed from lab run 2da4caa0 log.
- scripts/clone-bench/run_model.py: LongCat now synthesizes sentence chunks (<=220 chars) and joins them with 0.25 s gaps. Chunker checked locally to keep every word; not yet deployed or GPU-tested (remote write blocked). Lab instance left stopped.
- Deployed 2026-10-23 to lab i-093e8b2081168aff3 (old file kept as app/run_model.py.bak-nochunk). Re-run with the same 30 s Dean reference: 4 chunks, 43.6 s, Whisper medium.en hears every sentence (old take lost sentence 1). New issue: each chunk opens with "year"/"this year" because the reference transcript ends mid-sentence; use references that end on a full sentence.

## 2026-10-23 - Fish Audio added; FireRedTTS3 babble fixed

- Added Fish Audio Drama 3 (FP8, ~41 GB, flagship) and S2-Pro to the lab (catalog `fishd3`/`fishs2`, shared env `fish`, Python 3.12, upstream uv.lock installed with --no-deps minus pyaudio). Files: scripts/clone-bench/catalog.py, install_lab.py, run_model.py, smoke_lab.py.
- install_lab.py: root re-installs now work on ubuntu-owned repos (lab gitconfig with safe.directory; HOME override for setuptools-scm builds).
- FireRed cause: 30 s Dean reference ends mid-phrase; output babbled (Whisper WER 63%). Same text with 19.4 s ref 24%, 9.0 s ref 2%. app.py now rejects FireRed references >12 s; test added.
- Tests: test_lab 11/11 on the box; smoke audio for fishs2 and fishd3; Dean paragraph Whisper small.en WER: S2-Pro 0%, Drama 3 4% (dropped "While some"), FireRed 9 s ref 2%. Speaker similarity not measured.
- Artifact "Dean GI Bleed Clone Test" updated: added Fish S2-Pro, Drama 3, fixed FireRed; removed old FireRed and old LongCat takes.
- Lab UI restarted; public URL now https://6eda55f6ef0ae0fc3f.gradio.live/ .

## 2026-10-23 - Emotion controls in the zero-shot lab

- Only IndexTTS 2.5, VoxCPM2, Fish S2-Pro and Fish Drama 3 can steer emotion on a cloned voice (repo scan: Qwen3 Base clone has no instruct, FireRed emotion is voice-design only, dots needs separate dots.tts.edit, others none).
- app.py: Emotion panel (8 IndexTTS emotions + intensity 0-1 + free description; emotion reference clip for IndexTTS) shown only for those models. run_model.py: IndexTTS emo_vector (upstream bias/0.8 cap) / use_emo_text (QwenEmotion) / emo_audio_prompt; VoxCPM2 "(very angry)" prefix in reference-only mode; Fish "[very angry]" before each sentence. catalog.py: `emotion` kind + emotion_phrase.
- Tests: test_lab 15/15 on box. 12 GPU takes (calm 9 s Dean ref, neutral sentence), judged by emotion2vec+ large (envs/judge): IndexTTS sad -> sad 0.96; IndexTTS angry -> fearful (F0 151->239 Hz); IndexTTS "furious, shouting" -> happy; VoxCPM2 angry raised F0 but judged neutral; Fish S2/Drama 3 tags barely changed delivery (neutral). Whisper: no tags spoken. Listening not done.
- Lab UI restarted; URL now https://7fffb005241e2a5673.gradio.live/ .

## 2026-10-23 - Audiobook clone comparison, in-house audiobook voice, Dean emotion grid

- Default lab reference is now 30secAUDIOBOOK.wav + 30secTRANSCRIPT.txt (30.0 s, ends on a full sentence). FireRed gets the first 7.2 s (two sentences). All 8 working zero-shot models generated the GI paragraph, no emotion, seed 1234 (108-525 s per run incl. load).
- Staging training finished for profile cs-tengyuliu-v1 (v2ProPlus, 30minAUDIOBOOK.wav, 350 clips, SoVITS 20 / GPT 25 epochs). Live Fast (32.9 s) and Live Full (33.9 s) of the same paragraph generated from the staging Text to Speech page; WAVs saved beside the other outputs in the Voices test folder.
- Emotion grid: Dean 30 s lecture ref, IndexTTS 2.5 / VoxCPM2 / Fish S2-Pro / Drama 3 x (none + 8 emotions) at intensity 0.6, 36/36 generated.
- Artifacts: "Audiobook Voice Clone Shootout" (8 zero-shot + 2 in-house) and "Dean Emotion Grid". Only generation success checked; no Whisper, speaker-similarity or listening scores yet.
- Lab API gotcha: /clone validates language against the session's dropdown choices, so API clients must call /model_info for the model first (else "Auto is not in the list of choices"). Needs gradio_client >= 2 (server Gradio 6.30).
- Staging TTS page: typing long text key-by-key froze the tab (dictionary list re-renders); one 403 on first voice select, succeeded on retry. Not investigated further.
- Shutdown (17:5x-18:1x SGT): staging ASG vcs-staging-gpu-inference set min 0 / desired 0 (max 1); fixed staging i-0f0da8be59367f7a8 and lab i-093e8b2081168aff3 stopped (verified). ASG instance i-08099a515c0b2b98b still running: it is ProtectedFromScaleIn, so the scale-in activity was Cancelled. Removing protection was blocked in-session; run set-instance-protection --no-protected-from-scale-in to let it terminate.
