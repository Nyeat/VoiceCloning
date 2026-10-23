# Active TODO

- [ ] Model bake-off: ten models (incl. Fish Drama 3, S2-Pro) deployed and smoke-tested on one Seoul L40S. Audiobook comparison (8 zero-shot + in-house Live Fast/Full) and Dean emotion grid are generated (2026-10-23): run Whisper WER + speaker similarity and blind-listen them, then record 3-5 more target speakers before ranking. Raon needs an authoritative vocabulary/checkpoint fix. See repo docs/voice-model-evaluation.md.

- [ ] Live MC: read-aloud test with a real human voice (names, long sentence with pauses, short "yes")
  and compare transcript bubbles word for word; tune noise/pause defaults from it.

- [ ] Live MC (staging): run a real human microphone session in Chrome/Edge in both turn-based and
  continuous modes (headphones for continuous). Scripted and fake-mic browser turns pass (2026-10-06).

- [ ] Redeploy the other live clients (chatbot/GI, Faculty, lectures) so they get the 2026-10-06
  VAD silence-tail fix in the shared `useLiveSpeech` hook.

- [ ] Reconcile `origin/codex/staging-multi-user-scaling` (2 commits not on local branches) with
  `separate-containers-new` before re-syncing Dev/Staging pointers; it was not force-pushed.

- [ ] Finish staging shutdown: remove scale-in protection from ASG instance i-08099a515c0b2b98b so
  desired 0 terminates it (ASG min/desired already 0, fixed EC2 stopped 2026-10-23).

- [ ] Ask an administrator for `cloudtrail:LookupEvents` (or a CloudTrail Lake query) to attribute the
  staging ASG instance stops recorded in BUGS.md. Until then the churn cannot be traced: the Lambda
  scheduler/idle-stop touches only the fixed `i-0f0da8be59367f7a8`, and no repo script stops ASG
  instances.


- [ ] Deploy and live-verify the local same-model burst fix after refreshing `VCS_AWS_*`. The code now
  uses a scoped fleet admission lease plus expiring request reservations, distributes waiting work,
  enforces two queued per worker, and automatically retries queue-full/timeout responses. Rerun the
  exact six-request/three-GPU case and a larger super-overflow burst; require no idle-capacity scale.

- [ ] Isolate the frontend-specific automatic speech retry beyond the backend retry window. Staging
  lecture copy and automatic clearing now pass against real reassignment/scale-out, and one answer
  became playable without reprompt; Faculty Alice also played during cloned-GPU contention. Still
  force a long enough capacity failure to observe the 15-second client retry itself, and verify the
  same on Faculty with a cloned voice. Dev TTS/GI `SIMULATED` browser coverage remains pending.

- [ ] Revoke or refresh the temporary AWS session credentials exposed in the debugging conversation,
  then replace the user-level `VCS_AWS_*` values. Never record the replacement values in the vault,
  repository, terminal transcript, or progress report.

- [ ] Delete orphaned temporary snapshot `snap-08ec74499a13176f7` with an identity that has
  `ec2:DeleteSnapshot`. The associated temporary AMI is deregistered; the live manual Dev GPU is
  independent and must remain available for explicit two-target tests.

- [ ] Finish authenticated faculty publishing proof with at least two real lecture categories and
  two trained profiles. One-category storage/runtime proof now passes: staging and Dev both expose
  `gi-bleeding -> deanvoice-v1`, mirrored artifacts match, and both GPUs synthesize the exact pair.
  Still prove lecturer ownership in-browser and category isolation. Standard-voice GPU bypass passed
  live with Faculty Alice during cloned-worker saturation.
- [ ] Add per-model burst planning on top of the implemented lecture binding. Use
  confirmed conversations, admitted/queued work, and expiring reservations to calculate
  each model's slot deficit and batch-launch the required two-slot GPUs with headroom,
  limits, cooldown, and scale-down hysteresis. Keep scheduled per-voice event prewarming
  until immediate-burst and ramp tests pass with at least two real lectures/profiles.
- [ ] In an authenticated lectures browser, verify the deployed lecture-click capacity notices:
  absent voice blocks with the up-to-15-minute alternative, busy resident voice remains usable
  with `BUSY_STARTING`, and the warning clears after capacity is ready. Direct coordinator canaries,
  client tests, deployed bundle readback, scale-out, fresh-v38 boot, and scale-down all pass.
- [ ] Browser-time first and second authenticated staging GI/Live Fast replies after the
  canonical-cache rollout. Worker/fresh-boot evidence proves the reload mismatch is removed,
  but public end-to-end timing is still needed to quantify OpenAI/WebSocket overhead.
- [ ] Browser-refresh one active Full and Full Queue job on staging and Dev, record the
  session ID before/after, and prove only one new S3 session exists. Unit/build and live-bundle
  readback plus terminal-SSE tests pass, but the end-to-end browser check remains pending.
- [ ] Browser-time representative staging Full requests after the warm-medium ASR fix and compare
  Dev with identical model, references, settings, text, and retry outcomes. The formerly problematic
  text took 18 seconds directly on staging; do not reduce 3→5 without a controlled quality comparison.
- [ ] Add backend idempotency or a distributed active-request lease if duplicate prevention
  must cover separate tabs/devices or cleared session storage; current recovery is per tab.
- [ ] In a fresh Dev browser session, load `dea-voice-version2-v1`, preview the selected
  primary, and confirm the UI transcript is “a lot of technology that involves patients'
  data.” Then run a controlled synthesis/listening comparison; profile/config/manifest
  integrity is verified, but audible pronunciation improvement is not.
- [ ] Restore Dev single-file transcription support. `/api/transcribe` currently returns 500
  because `/home/ubuntu/gpt-sovits-v2pro/tools/asr/transcribe_single.py` is absent; this did
  not cause the saved prompt mismatch but blocked an independent ASR check of the reference.
- [ ] Isolate the reported Dev pronunciation/gibberish regression before retaining or
  reverting the quality work. Current live comparison is confounded: Dev uses
  `dea-voice-version2-v1`, staging uses `deanvoice-v1`. On Dev, hold weights, rank-1
  primary/aux references, text, inference settings, and seeds constant; compare the old
  rank-ordered auxiliaries against diversity selection, then verifier off/on. Training
  filtering requires same-input old/new retrains. Do not promote these changes to staging.
- [ ] Browser-reproduce staging Full generation while switching tabs: completed RIFF/WAVE
  output should enter history without a false “still being finalized” error, and the GPU
  badge should fall when the inference `/models` route is unavailable rather than following
  the fixed training worker.
- [ ] Run one new dev training job on representative clean/noisy recordings; inspect
  `clip-scores.json` and `training-quality-report.json`, confirm the gate retains enough
  speech, then compare old/new reference sets and cloned audio blind. This deployment
  has structural/test evidence only, not audible-quality evidence.
- [ ] Collect human-labeled dev phoneme crops with controls and use
  `python/calibrate_phoneme_thresholds.py` on a training split; validate the selected
  thresholds on a held-out split before changing the deployed defaults.
- [ ] Browser-verify the deployed faculty SSO on `https://faculty.lkcmedicine.org`: a real
  staff/associate account signs in and can use text and cloned voice; a student-domain account
  is rejected; faculty `PROFILE`/`SIGNIN`/session/turn rows appear only in
  `vcs-staging-lecturers`; and a lectures login still writes only to `vcs-staging-transcripts`.
  Everything else shipped on 2026-08-18 (table, its resource-based write grant, the CloudFront
  site header and the missing `/api/live/session/*` behavior, gateway, Lambda, client) — see
  `docs/staging-architecture.md`. Check the table, not the HTTP response: a failed sign-in
  write still returns `recorded: true`.
- [ ] Ask an administrator to terminate stopped standalone verifier canary
  `i-0e4ef8844a120d069`; the internship role is denied termination.
- [ ] Ask an administrator to terminate stopped staging AMI builder
  `i-0f6c399842bd8cc38`; the internship role is denied termination.
- [ ] Synchronize the rotated `LIVE_AUTH_LOADTEST_SECRET` to the fixed live gateway
  during its next running window. Lambda and LT v26 match and a direct public prime
  returned HTTP 200 RIFF; the fixed gateway stopped before its `.env` could be updated.

- [ ] Browser-verify deployed dev login from a newly opened tab and `/admin` with an
  allowlisted Microsoft account: confirm the first render (without refresh) visually matches
  D25 rather than faculty, then check the home button, graph
  sort/filter, cohort counts, detailed evidence, prefetched S3 Events, and mobile layout.

- [ ] Verify the live conservative support model: a pause/transcript scroll must not affect a
  concept, two rewinds must produce only `possible_support`, and two delayed “even simpler”
  requests must produce `support_recommended` and further evidence must rise with diminishing returns. Verify supervisor Reset. Future:
  add learner confirmation, knowledge checks, and a separate learner-controlled persistent
  explanation-style preference. Do not deploy analytics to staging.
- [ ] Verify the supervisor cohort ranking with at least two identified test learners: only one
  row per learner/concept may count, maximum-score learners drive primary rank, percentages use
  the displayed identified-learner denominator, and the ranking never affects chatbot replies.
- [ ] Add a liveness-only health endpoint for the fixed staging SSE progress relay
  and point `vcs-staging-tg-3003` at it; preserve S3 cross-host progress polling and
  verify synthesis still routes only to `vcs-stg-opt-3103`.
- [ ] Bake `resemblyzer` into a canary staging inference AMI, verify the speaker gate
  becomes active, benchmark its latency/quality cost, then promote through a reviewed
  launch-template version. Do not hand-patch ephemeral ASG instances.
- [ ] Future: evaluate a versioned alias plus scheduled provisioned concurrency only
  if eager 512 MB initialization is still insufficient. Current reruns passed 100/100
  and 150/150. It will not fix GPU admission retries or network/transit outliers.
- [ ] Reduce 150-user first-audio tails. First-turn p95 included 9.75 seconds of
  capacity-retry sleep, while the maximum slept 19.75 seconds across 12 retries.
  Publish occupied/total slots, no-capacity responses, and pending admissions every
  10 seconds; scale on capacity pressure rather than only minute-averaged occupancy.
  Compare shorter jittered retries with a centralized fair queue, requiring bounded
  FIFO waiting and no retry storm/starvation. For a known 150-user simultaneous event,
  prewarm more than the current 50-GPU rehearsal floor and do not depend on reactive
  launch. Test the same three-turn workload as both an immediate burst and a 30-60
  second arrival ramp, reporting p50/p95/max, retries, pending demand, errors, and
  GPU-hours. Separately trace the two requests that spent 9.50-16.55 seconds outside
  Lambda.
- [ ] Before the 2026-08-04 event, re-read LT v20/default, the verified 13:30/16:00
  actions, occupancy alarms/actions, and gateway health. The 13:30 action begins GPU
  launch; it is not an admission-ready timestamp. Run
  `ensure-staging-live-gateway.ps1 -Apply`, then
  `wait-staging-event-ready.ps1 -ExpectedCapacity 50` before users enter. The final
  browser-equivalent keepalive runs completed 100/100 and 150/150 on both 50 and
  fully primed 60 GPUs. Do not use three slots: its warm gate passed only 39/50
  targets. Still run the 60-minute soak and one target-loss rehearsal.
- [ ] Ask an administrator to apply and read back the optional 300-second ALB idle
  timeout with `scripts/set-staging-alb-idle-timeout.ps1 -Apply`; this role is denied
  `elasticloadbalancing:ModifyLoadBalancerAttributes`. Keep the 15-second client/
  harness keepalive regardless.
- [ ] Verify the fixed GPU's 07:00 and 19:00 SGT boundary transitions. Matching ASG
  recurring actions were read back, but the fixed GPU's invoker remains uninspectable.
- [ ] Ask an administrator to grant the staging Lambda execution role
  `autoscaling:DescribeAutoScalingGroups` and `autoscaling:UpdateAutoScalingGroup`
  scoped to `vcs-staging-gpu-inference`, then apply
  `scripts/set-staging-lifecycle-coupling.ps1 -Apply` for manual stop/termination coupling.
- [ ] Rotate the internal voice-profile authentication value across Lambda, the fixed
  worker, and the inference launch image; an older deploy command exposed the current
  value in console output. The deploy script now prints deployment metadata only.
- [ ] Ask an administrator to deregister stopped validator `i-015de451bff24a73b`
  from `vcs-stg-opt-3103` and terminate it, and terminate stopped v15 validator
  `i-0eb2ca68edb88d6d7`; fresh 2026-08-01 attempts confirmed both permissions denied.
- [ ] After the event, prototype durable multi-user training orchestration. Compare a
  queue-backed training ASG/AWS Batch with SageMaker Training Jobs using the same
  v2ProPlus pipeline; require per-job S3 isolation, leases/idempotency, checkpoints,
  cancellation, progress, quotas, cost/startup measurements, and explicit model
  activation before choosing.
- [ ] Improve scale-out detection latency. The live one-minute 70% occupied-slot
  alarm saw 73% at 07:00 but alarmed only at 07:03:48. Build a real fleet-wide custom
  high-resolution occupied/total metric every 10 seconds and test three consecutive
  samples against false scale-outs and GPU-hours; changing the standard metric's
  alarm period alone cannot create 10-second source data.
- [ ] Run a controlled staging A/B for early-sentence voice with comparable
  multi-sentence answers. Record OpenAI first token/text done, TTS start, first audio,
  profile resolution, worker round trip, and p50/p95. The current Node complete-flow
  harness waits for full text, so adapt it or use browser instrumentation; current
  browser checks are functional smoke evidence only.
- [ ] Design a dedicated warm target group/hidden public route. Exercise each exact
  new target through the public stack, then promote it to the production target
  group; current ALB health preceded public-prime completion by about two minutes,
  and a target's public request can be routed to another target.
- [ ] Audit the exact CloudFront TTS behavior/origin before testing a 60-second origin
  response timeout, and benchmark gp3 reads/model phases on one canary before paying
  for Fast Snapshot Restore. Neither change is yet justified as a latency baseline.
- [ ] Make Live Full horizontally correct before increasing its concurrency: add a
  distributed session lease/fencing token, conditional manifest revisions,
  idempotency keys, durable resumable progress, and worker-loss/concurrent-edit tests.
  Evaluate chunk-level parallelism only afterward because it can increase cost and
  produce cross-GPU voice/prosody/loudness inconsistencies.
- [ ] In two signed-in staging browsers, verify one conversation keeps the same exact voice
  revision while another browser loads or overwrites a profile between Fast chunks.

- [ ] Browser-test the deployed Live Full chunk generation library: regenerate one chunk at least three times, listen to every archived take, restore the oldest, and confirm the displaced current take returns to the library while textarea/chunk preview/final playback/download use the restored version without synthesis. Verify histories remain independent across chunks and insert/delete clear them.

- [ ] In the deployed pronunciation UI, save and load `stereochemistry` with synthesis spelling `stereo chemistry`, then compare no-alias vs alias audio in Fast and Full at sentence start/middle/end. Confirm spacing improves clarity without an unnatural pause and inspect ASR/full-span phoneme logs; delete or revise the alias if listening is worse.
- [ ] If alias tokens must synthesize from custom phonemes rather than GPT-SoVITS defaults,
  design an explicit per-alias-token ARPAbet schema. Do not guess boundaries in one flat
  ARPAbet sequence or globally override common alias words.

- [ ] Browser-test the deployed Live Fast TTS and Fast Queue saved-output gain at -6/0/+3/+6 dB, including saved-config restore and multi-clip queued playback; confirm clipping stays below the -1 dBFS ceiling.

- [ ] Load DeanVoice after the 2026-07-24 worker restart, then listen-label the saved calibration WAVs and extend held-out checks to `glycoprotein`, `glycolipids`, `structural`, and controls at sentence start/middle/end. Compare timestamp vs `speech_end` crop-family logs and measure false approvals before changing any threshold; endpoint crops are deployed, but real-audio performance is not yet verified.
- [ ] Browser-test Full/Queue saved-output gain at -6/0/+3/+6 dB, confirm previews/queued chunks/final download match and stay unclipped, verify best-effort badges/reasons survive initial generation and regeneration, and test leading/trailing/consecutive boundary breaks in Full, Full Queue, Fast TTS, and Fast Queue.

- [ ] Deploy the 2026-07-20 SSML break parity changes to the inference worker and frontend, then browser-listen to `hello <break time="7000ms"/> hello` through Live Fast TTS, Live Fast Queue, initial Live Full generation, and a Live Full sentence regeneration; confirm roughly seven seconds of silence, no spoken markup, and one editable Full review card containing both words plus the break tag.
- [ ] Deploy the ARPAbet-only/global-uniqueness change to Lambda and the inference worker, build/deploy the frontend, then save or import one entry to rewrite all category files without readable-only legacy records.
- [ ] Run one full `v2ProPlus` training pass and verify the new 9-step SSE flow, especially `Extract Speaker Verification`.
- [ ] Verify `training/runs/<expName>/metadata.json` is uploaded to S3 after a real training run.
- [ ] Compare `Skip denoise` enabled vs disabled on clean recordings and record when it actually improves cloned timbre.
- [ ] Validate strict frontend reference filtering and visible scores against `gpu-worker/scripts/score_clips.py` on real clips.
- [ ] Browser-test Live Fast saved config list/load/update/delete/sample generation on a real trained model; confirm the sentence limit defaults to 1, Max chunk words defaults to Auto/280 characters, saved 10–100-word values override the character heuristic and restore, sub-eight-word chunks absorb at most one neighbour within the hard limit, and both normal phoneme-rejected takes re-seed before best-effort output; catastrophic babble may add at most two more takes.
- [ ] Browser-test Live Full metadata-only defaulting, save/load/update/delete/sample, and Full Inference generation using Live Fast rank #1 refs on a real trained model.
- [ ] Browser-test Live Full/Queue on a real GPU: verify 3→5 retries and per-sentence best-effort never abort on an audio-usable take, timing+waveform-forgiven technical words are actually audible, revised text persists in the wider editor, normalized previews/full WAV refresh, dropdown/model-ready state does not flap, warm GPU return bypasses the slow overlay, two concurrent browsers receive 409, and an abandoned session does not leave a false another-user banner.
- [ ] Deploy the scoped three-outcome phoneme verifier plus the Live Fast integration, then on the real GPU listen-test Whisper-mismatched and explicitly strict ARPAbet terms in both Fast and Full. Calibrate pass thresholds (`PHONEME_MIN_CTC_LOG_PROB`, `PHONEME_MIN_SIMILARITY`), conservative reject thresholds, and crop paddings from structured `[phoneme]` logs; also verify completed/regenerated WAVs no longer hit the metadata-readiness retry limit. Model download/token validation and a CUDA forward-pass smoke test are complete (1263.3 MiB peak on L4).
- [ ] Deploy and browser-test Live Full's hard 170-character Auto boundary, two-sentence target, fit-bounded short-context exception, safe oversized-sentence continuation, and per-chunk insert/delete actions; use the Opus/Sol/Terra script to confirm newlines/numbers/acronyms do not create heading-only cards, insert chunks at the start/middle/end, delete a middle chunk, and confirm every rebuilt/downloaded WAV, review index, preview, and S3 result is correct.
- [ ] Browser-test Live Full chatbot queued replies with a real microphone/WebSocket/GPU reply and verify each phrase uses Live Full route/config while the first completed phrase plays immediately.
- [ ] Decide whether generated config sample WAVs should be uploaded and persisted, instead of only saving sample metadata.
- [ ] Reconcile current deployment/source-of-truth docs now that older handoff files were renamed with `(Outdated)`.
- [ ] Decide whether repo-managed deployment should also check in `gpu-worker.service` and `live-gateway.service`; only `systemd/gpu-inference-worker.service` is currently present in the repo.
