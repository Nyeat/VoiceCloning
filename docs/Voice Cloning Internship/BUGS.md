# Bugs

- Open (found 2026-10-26): the staging TTS page can save another voice's reference clips onto a new voice.
  cs-tengyuliu-v1 (audiobook) stores DeanVoice's primary + 5 aux refs; it was created 27 s after deanvoice-v1
  was re-saved on 2026-10-23. Output matched Dean (resemblyzer 0.81) better than the narrator (0.73).
  Likely path: client/src/pages/LivePage.jsx keeps refAudioPath/aux from the previous voice when the new
  voice's clip scores are not ready, then persists them. Same carry-over seen 2026-10-26: the first request
  for cs-tengyu-liu_2 sent the old profile's voice_model.revision. Repair: re-point cs-tengyuliu-v1 at its own clips;
  guard saves so ref paths must sit under training/datasets/<expName>/. cs-tengyuliu-v1 data repaired 2026-10-26 (S3 backup *.bak-deanrefs-20261026); page bug still open.
- Open (2026-10-26): Live Full duration check (`longTextInference.js`, 15 chars/s, reject <65%) rejects
  fast speakers; cs-tengyu-liu_2 reads ~22 chars/s and a complete 7.70 s take missed the 7.8 s cutoff.
  Derive expected pace per voice from its training clips. Retried 2026-10-26: 18/18 failed, sentence always 6.8-7.7 s vs 7.8 s minimum.

- Fixed 2026-10-08: daily-start and daily-stop both restored ASG minimum 1, undoing
  manual zeroing. Both actions and ASG now have min/desired/max 0; coordinator
  scale-out and browser-triggered fixed GPU starts disabled.

- Fixed and deployed 2026-10-06 (staging MC): spoken turns hung on "Listening..." because the
  client noise gate (RMS 0.02) dropped normal-volume speech and cut the trailing silence OpenAI's VAD
  needs; any live socket drop also ended the session. MC is now ungated, eager, and reconnects.
  Other live clients keep the gate (only the silence tail) and need a redeploy to get that.
- Fixed 2026-10-06 (staging gateway box `i-0f0da8be59367f7a8`): systemd `voice-live-gateway` and pm2
  both ran the gateway and raced for :3002 on every restart. pm2 copy removed; systemd only.
- Fixed and deployed 2026-10-06 (staging MC): turn-based mode closed the mic as soon as a reply began
  synthesizing, so speech after a mid-sentence pause was discarded; continuous barge-in relied on RMS 0.04.
- Fixed locally, not deployed (found live 2026-09-01): same-model burst admission was not atomic across
  ready matching GPUs. With three READY `deanvoice-v1` workers (two slots each), six simultaneous
  coordinator requests produced five RIFFs all on the oldest worker, with queue waits up to 6.2s;
  one request returned `MODEL_CAPACITY_STARTING` and desired capacity changed 4 -> 5 while two
  matching GPUs were idle. The worker row briefly reached active 2 / queued 3 even though live
  `MODEL_MAX_QUEUED_PER_WORKER=2`. A later one-GPU five-request run produced one
  `MODEL_QUEUE_TIMEOUT`. Root cause: concurrent coordinator Lambdas selected from the same stale
  worker snapshot with no shared admission reservation. The local correction serializes the short
  fleet decision with a scoped DynamoDB lease, records expiring per-request occupancy, distributes
  bounded queues, and preserves queue-full/timeout codes for automatic client retry. Coordinator
  54/54, Lambda 335/335, client 499/499, worker 259/259, gateway 180/180, and three client builds
  pass. AWS deployment/live proof is blocked by an expired user-level `VCS_AWS_*` session.

- Open: something outside the repo stops freshly-launched staging ASG instances, and the group
  rebuilds them. On 2026-08-31 `i-06377cac29eaadff0` was taken out of service at 09:37:41Z with cause
  "EC2 health check indicating it has been terminated or stopped"; its replacement
  `i-0aba3a13bca27b90d` launched 09:37:43Z and met the same fate at 09:45:41Z. The handoff records the
  same `Client.UserInitiatedShutdown` pattern at 02:09Z. It is NOT the Lambda scheduler or idle-stop:
  those act only on the fixed `GPU_INSTANCE_ID=i-0f0da8be59367f7a8`, never on ASG instances, and no
  repo script issues StopInstances against the group. Attribution needs `cloudtrail:LookupEvents`,
  which the internship role is denied. Each cycle wastes a g6.xlarge boot.

- Not a bug, but the docs were wrong: staging has no 19:00 scale-to-zero. Both scheduled actions set
  `MinSize=1, MaxSize=192` with desired unchanged, so one g6.xlarge runs 24/7 by design
  (`offHoursMinCapacity: 1`). `PROJECT_MAP.md` claimed scale-to-zero and has been corrected.
  Decision 2026-08-31: keep MinSize=1 so staging stays warm; revisit only if cost matters more than
  avoiding a ~10-minute first-request cold start.

- Open (UX): Faculty shows a full-screen blocking "Starting the GPU" modal while capacity warms, so a
  lecturer cannot write or edit instructions during the wait. The lecture surface correctly uses the
  non-blocking `BUSY_STARTING` notice instead.

- Fixed and deployed 2026-09-01: `prepareCapacity` did not clear a `PENDING` boot marker after its
  claimed/new GPU became ready, leaving the lecture warning until TTL expiry. Capacity polling and
  synthesis now share the same strict completion check and delete only after that worker is `READY`,
  matches the model, and has a free slot. Faculty also retries the pending speech automatically.
  A second stale-banner path is also fixed: successful speech clears older wait copy, and a live
  pending boot is now reported as a new GPU starting rather than only an idle GPU switching.
  Unit/build/public-bundle and live-log evidence pass. A controlled signed-in browser turn now
  confirms reassignment and scale-out copy change with real AWS state, plus automatic banner clearing
  when the requested worker becomes ready. One prompt produced playable speech without a reprompt;
  the frontend retry branch itself was not isolated from the backend's shorter retry window.

- Open: the staging lecture badge showed `cs-nathanael-ng` while `client/env/staging/gi.env` still
  pins `VITE_GI_VOICE_PROFILE_ID=deanvoice-v1`. Confirm which binding wins after a faculty publish.


- Fixed: passive long pauses and transcript scrolling previously increased the same numeric
  score used for concept personalization, allowing ambiguous behaviour to imply uncertainty.
  They are now retained only as raw analytics; only bounded rewatches and clarification
  requests derive a cautious support state.

## Active

- 2026-08-31 regression fixed locally, not deployed: two admitted requests filled a two-slot worker
  and each speculative post-admission check scaled, producing direct desired changes 1->2->3.
  A pre-existing matching worker then incorrectly cleared the first boot marker, permitting the
  duplicate scale. Dev also consumed Staging's unscoped pending marker and displayed a false GPU-
  starting message, while different lecture pages with 15-second polling and zero preparation grace
  repeatedly switched the sole worker. The local correction scales only for actual queue/rejection,
  scopes coordination records per environment, preserves a pending boot until its new/claimed worker
  is ready, and gives preflight-only reassignment a 30-second anti-thrash grace. Lambda 312/312 and
  coordinator packaging pass; cloud deployment and signed-in browser verification remain pending.

- 2026-08-31 fixed and baked in launch-template v40: model reassignment could fail with `Inference server is
  already running` after a short readiness probe missed a healthy managed Python process applying
  weights. The worker now reuses that process. A hash-matched Staging source produced
  `ami-07236b80dcdb93bcb`; one canary reached coordinator READY and scaled down naturally. The isolated
  original Dev worker returned a 183,084-byte Dean RIFF.

- 2026-08-31 fixed in deployment tooling: `deploy-lambda.ps1` synchronized the coordinator environment
  but did not upload `model-coordinator.zip`, so a rollout could appear successful while coordinator
  code stayed old. It now packages, uploads, and waits for both coordinator functions; live event-lock
  actions verified the new code.

- 2026-08-28 fixed and deployed: Dev routing-only coordination saw two running, locally ready GPUs
  as unavailable. Unassigned base-ready workers were excluded from reassignment, both workers lacked
  coordinator auth, and their security group admitted port 3003 only from the ALB. The decision now
  assigns `UNASSIGNED` workers, both services persist the shared token, and TCP 3003 is allowed only
  from the coordinator Lambda security group. Two-GPU failover and a real 3,177-ms queued request passed.

- 2026-08-28 fixed and deployed: one person's sequential voice selections could grow the staging
  ASG from one to three GPUs because each previously requested model was protected for five minutes.
  Idle nonmatching workers now reassign immediately; scale-out occurs only when all eligible workers
  are occupied, queued, draining, starting, or unavailable. Live proof reassigned Dean on the sole
  worker while desired capacity stayed at one, and final readback is one healthy idle worker.

- 2026-08-27 fixed and deployed: staging faculty publishing updated only the staging category;
  Dev could point at an absent profile/model if it was copied manually. Publish now mirrors the
  exact cloned profile, both weights, and selected references before writing Dev's category.
  Current GI data was backfilled and verified; a real authenticated faculty publish is still pending.

- 2026-08-27 fixed operationally: the old staging 19:00 scheduled action still set min/desired
  to zero despite the tracked one-GPU baseline. Both daily actions now preserve min 1, leave
  desired unset, and retain max 192. Dev's original GPU retains its 30-minute activity stop;
  the new second comparison GPU is manual-only.

- 2026-08-27: the deployed faculty bundle renders the correct idle `Select a voice to begin.`
  state, but the existing signed-in Chrome session received 401 from session-signin/profile API
  calls and showed `Sign in to see your voices.` A retry did not recover. The AWS base session
  expired before server-log inspection, so whether this is a stale Entra token or server audience/
  validation issue is not yet isolated; actual lecturer voice listing and publish remain blocked.

- 2026-08-25 fixed: Dev and staging application branches had diverged, then a faculty-site
  deployment replaced staging's main Lambda/client with code that omitted coordinator calls.
  Both branch pointers share the same head and unified application commit `30234eb`; both main Lambdas share one package SHA and all
  clients were rebuilt. Fixed Dev/staging workers run the unified commit. Tagged AMI
  `ami-0cf96ffb91690b17c` and launch-template v39 were independently fresh-booted with zero
  runtime drift and service readiness; the prior operational verification blocker is cleared.

- 2026-08-24 fixed and deployed: staging deep warm cached model weights by basename while
  request-time voice isolation cached the same S3 keys under key-derived hashed names.
  Production therefore treated an already-warmed model as a different local model and
  reloaded it on the first routed request. Model download and request enforcement now share
  one canonical cache resolver, and route warm includes the production model snapshot.
  All five serving workers match, are warm/ready/healthy, and LT v31 uses the proven fresh-boot
  AMI. Authenticated browser first/second-turn timing remains pending.

- 2026-08-21 fixed: identical Full text split into one chunk on Dev and two on staging because
  Dev set `FULL_MAX_CHUNK_LENGTH=240` and staging used the 170 fallback. The shared fallback is
  now 240, and staging's saved Dean profile/default/Live Full settings match Dev without changing
  any reference path. A same-text browser timing comparison after deployment remains pending.

- 2026-08-21 fixed in code: staging Full generation had an extreme retry tail. A later durable
  event record proved five first-chunk takes consumed 310.66 seconds specifically because
  transcription verification was unavailable. Full lazily loaded `large-v3`, exceeded the 60s
  request deadline, then regenerated even though new audio cannot restore ASR. Full now reuses
  warm medium with its stricter beam/tail gates and stops after one usable take on ASR outage.
  The formerly problematic text completed directly on staging in 18 seconds with five takes;
  equivalent end-to-end browser timing remains pending.

- 2026-08-21 fixed: completed staging Full audio could show “still being finalized” after a
  refresh because staging origins were absent from S3 CORS and an originating worker retained
  terminal session locality instead of using durable replay. CORS and terminal cleanup are
  live; a new browser refresh reproduction remains pending.

- 2026-08-21: Dev `/api/transcribe` returns 500 because the fixed GPU lacks
  `tools/asr/transcribe_single.py`. This is separate from synthesis and did not create the
  stale reference prompt, but it prevents using that endpoint for an independent reference
  transcript audit.

- 2026-08-21: a user listening comparison found Dev more prone to mispronunciation and
  gibberish than staging. The outcome is credible, but the comparison did not isolate the
  new selector/verifier/training gates: Dev served `dea-voice-version2-v1` and staging served
  `deanvoice-v1`, with different weights/references. Treat the quality changes as unvalidated
  despite their later explicit promotion to staging, and run controlled same-model component A/Bs.

- 2026-08-14 fixed: Live Fast defaulted to three normal takes and could add four
  catastrophic-babble reseeds; it now uses two normal takes plus at most two escape
  takes. Fallback ranking also received repeated phrases but not ASR `duplicatedWords`,
  so a visibly duplicated-word take could avoid the intended penalty. The field is now
  propagated and costs six score points per occurrence. Deployed to staging LT v27;
  controlled duplicate-word listening comparison remains outstanding.

- 2026-08-13: LT v24 killed Whisper-medium at its hardcoded 120-second startup
  deadline; measured steady-state load was 215.77 seconds. The host image also lacked
  `phonemizer`, espeak-ng, and the full phoneme model. Code/AMI/LT v26 correct these.
  Fresh-v26 status showed Whisper and speaker verification active and the phoneme model
  loaded. One cold phoneme load still made a warm round take 180 seconds despite the
  baked cache, and verifier-driven reseeds remained observable; cold ASG admission is
  therefore still about ten minutes, not equivalent to event-mode prewarming.

- 2026-08-07 fixed: learner evidence accumulated without bound and short clarification repeats
  lost their medical topic. Dev now uses a capped 30-day event window and inherits the preceding
  topic for phrases such as “even simpler.” Supervisor concept reset supports controlled QA.

- 2026-08-07 fixed: one GI scrub gesture could emit several `seeked` events, and scroll
  bursts in one transcript visit each counted as review. A real run therefore stored score 8.
  Dev now coalesces the gesture and limits transcript review to once per visit; verify the
  next run by a `+2.75` before/after score delta.

- 2026-08-07: dev GI text chat recovered, but Dean audio returned an unsigned 401. Root cause:
  CloudFront OAC signs the Lambda origin with SigV4 `Authorization`, replacing the viewer bearer
  header. Dev now sends Entra REST auth as `X-VCS-Entra-Token`; Lambda accepts it before falling
  back to ordinary bearer auth. Bundle `assets/index-6qG3aJlL.js` and Lambda are live. Unit/build,
  policy, bundle, and deployment checks pass; signed-in Dean audio still needs browser verification.
- 2026-08-03: staging fixed inference and ASG AMI `ami-021aeb72894b8c79b`
  lack `resemblyzer`, so speaker-identity scoring degrades to ASR/audio-quality checks.
  History shows the gate was added intentionally; no evidence supports removal as a
  fleet-wide latency optimization. Do not confuse this with the deliberate first-live-
  clip `skip_verify` path. Bake and benchmark the dependency in a canary AMI.
- 2026-08-03: staging `/inference/progress/*` uses the fixed port-3003 target while
  its inference-readiness health check is 503. S3-backed SSE currently works through
  ALB fail-open and synthesis remains on the ASG, but health is misleading and loss
  of the fixed relay can interrupt progress. Add a relay-liveness health check.
- 2026-08-03: the full inference-worker suite has one cancelled nested subtest in
  the compact-chemical-formula case, and the training-worker suite has one email mock
  failure when mail env is absent. Lambda, gateway, and client suites pass; deployed
  worker/public health passes. Do not call the full local worker test matrix green.

- 2026-07-31: the final 150-user run passed every session, but its first-turn p95 was
  dominated by capacity backoff: 9.75 seconds retry sleep at p95 and 19.75 seconds in
  the maximum. Two later requests separately spent 9.50-16.55 seconds outside Lambda
  despite 1.47-2.17 second worker times. Track admission pressure and transit tails as
  separate issues; neither is a Lambda cold-start/profile-resolution regression.

- 2026-07-31: one of 150 pre-scale keepalive sessions produced no completed turn and
  timed out after 720 seconds; the other 149 completed all three turns and all
  post-scale 150 sessions completed. Keepalive prevents idle 1006 collapse but does
  not guarantee a stalled OpenAI/gateway turn will complete. Preserve timeout/error
  instrumentation and reproduce under a soak before calling this resolved.
- 2026-07-31: ALB target health precedes strict public-prime completion. During
  reactive 50->60, all targets were healthy at 07:09:27 but public-prime logs
  completed through 07:11:30. Public requests from a node can also route to another
  target. Strict per-target public readiness needs a dedicated warm target group/path.
- 2026-07-31: worker restarts could leave the boot-time public-prime log marker in
  place, allowing readiness to accept stale evidence. The readiness probe now fails
  closed unless the prime log is at least as new as the current worker start.
- 2026-07-31: setting `GPU_SCHEDULE_ENABLED=true` enables the staging Lambda's
  07:00-23:00 Singapore decision logic, and a direct in-window idle-check invocation
  returned `in-window-running`. CloudWatch later showed exactly one Lambda invocation
  every five minutes, including quiet hours, proving an automatic invoker exists.
  This role cannot list its resource; the exact boundary transition remains unverified.
- 2026-07-29: the corrected real-route warm made the 32-GPU/50-user chatbot flow pass
  50/50, but a 100-user three-turn run completed 98/100 sessions; two WebSockets closed
  with code 1006 after turn 1. A separate 128-user sustained TTS run produced 34
  CloudFront 504s near 30 seconds and one 503 while the strict capacity rule retained
  one sampled free slot. The 51-GPU hot run passed 100/100. Choose event capacity and
  decide whether to remove the public 30-second timeout exposure.

## Recently Fixed

- 2026-08-21: refreshing during Full/Full Queue generation discarded the in-memory client
  session, so submitting again created another independent GPU job. Pending session identity,
  text, chunks, and progress now survive per-tab refresh; the client reconnects the existing
  SSE stream, warns before navigation, and locks duplicate clicks. Cross-tab/device dedupe is
  still outside this client-only fix.

- 2026-08-21: Dev auto-selection changed the primary reference path but preserved the old
  profile's `prompt_text`, pairing `...340800...464000.wav` with unrelated COVID-19 text.
  Model warming now transports primary transcript/language, same-path comparisons include
  them, and the client refuses a stale active-profile prompt from another primary. The live
  active profile and auto rank-1 config now match the training manifest; staging was unchanged.

- 2026-08-07: GI's replacement authenticated startup profile GET could race client token availability,
  falsely claiming a signed-in user was unsigned and leaving voice readiness empty. GI now makes no
  startup profile request: it sends fixed `deanvoice-v1` with synthesis and lets the backend resolve it.
- 2026-08-07: GI previously compared its configured Dean voice against shared `active.json`, so a
  TTS/training user activating another profile blocked GI. Dev and staging now load saved
  `deanvoice-v1` directly through an authenticated read-only route and pin its snapshot without
  changing global active state. Live unsigned route checks return 401; signed-in audio remains a
  manual browser/listening check.
- 2026-08-07: dev GI Microsoft sign-in created learner profiles and authenticated the
  WebSocket, but cloned-voice REST calls omitted the bearer token and returned 401. The shared
  API client now attaches the configured token. Voice auth is required only for GI-tagged
  CloudFront requests, preserving public dev TTS/Training/Dean access; analytics and supervisor
  routes remain independently authenticated.

- 2026-07-31: fixed the 4.618-second first Live lazy import by eagerly loading Live at
  512 MB. GI now sends the pinned GPT/SoVITS snapshot, reducing its synthesis-time
  profile resolution to 0 ms p50. ID-only callers still resolve normally, and regular
  Live Fast/Full retains its existing selected-model snapshot behavior. GPU-free first
  invocation is 15.71 ms; 100/150 three-turn reruns passed.

- 2026-07-31: the 15-minute quiet alarm used missing-data-as-breaching, so it entered
  ALARM without a numeric datapoint and Step Scaling never applied `-1`; five GPUs
  remained running for almost an hour. The alarm now evaluates
  `FILL(TargetControlRequestCount,0) < 1`. A controlled desired-3 run proved 3->2
  and 2->1 while retaining the min-1 floor.
- 2026-07-31: Live Fast phrase replies always waited for `assistant.text.done` before
  starting TTS. Staging now begins after the first confirmed complete streamed
  sentence for multi-sentence replies. A deployed browser completed cloned playback,
  but population-level latency improvement is not yet measured.
- 2026-07-31: the load harness omitted the browser's 15-second WebSocket keepalive.
  Long-answer controls completed only 33/100 and 13/150 with code 1006. With the
  keepalive, 50-GPU runs completed 100/100 and 150/150, and fully primed 60-GPU
  comparisons also completed 100%. Live ALB idle timeout remains 60 seconds because
  this role is denied the optional 300-second attribute change.
- 2026-07-31: event readiness checked SSM invocations once before command distribution
  completed, producing false 0/50 and 49/50 summaries. It now retries pending
  invocations; the final gates passed 50/50 and 60/60.

- 2026-07-31: baseline occupancy previously could make two overlapping requests scale
  a one-GPU fleet directly to 11. Below five healthy GPUs, the 70% alarm now sets
  exact capacity five; the separate fleet alarm keeps +10 increments from five onward.
- 2026-07-31: three slots per GPU failed its mandatory rollout gate: only 39/50
  targets completed ten concurrent rounds. It was not user-load-tested or promoted;
  two slots were restored and passed 50/50.

- 2026-07-30: local warm and target health did not make a fresh event fleet public-
  burst ready. Stable v16 completed only 48/100; Lambda init averaged 126.7ms while
  synthesis duration p95/max reached 30.36/37.89s and Target Optimizer rejected 21.
  A realistic public prime absorbed the cold work, after which full flow passed
  100/100. LT v17 now automates two public first-clip primes per new instance plus
  backend settle; the fresh 50-GPU v17 acceptance run completed 100/100.
- 2026-07-30: first-boot `unattended-upgrade` restarted the warmed v15 inference and
  Target Optimizer services, leaving Node listening with model readiness false and
  causing ALB 503 churn. v16/v17 mask automatic-update units and gate every worker
  restart on the full warm before Target Optimizer can start.
- 2026-07-29: completed-request target tracking could scale from small sustained
  traffic even while optimizer capacity was free. Scale-out now requires a sampled
  zero-capacity minute plus rejected traffic; 100 and 128 sequential users correctly
  did not scale with two/one free slots, while 192 users triggered 32->51. The legacy
  target policy is neutralized because the role cannot delete it.

- 2026-07-29: ASG target tracking allowed min/desired zero, but
  `ALBRequestCountPerTarget` cannot scale out when no targets exist. A validation
  scale-in terminated every target. The live ASG and repo default now keep one
  baseline instance.

- 2026-07-29: launch-template v9 referenced a no-reboot AMI that captured
  `gpu-inference-worker/src/index.js` as zero bytes. It was rolled back to v8; the
  source file was verified at 3,577 bytes and the filesystem synced before final
  AMI `ami-02e0a90f76ed1ce2a` was validated. Launch-template v11 additionally gates
  Target Optimizer startup on the completed warm synthesis.

- 2026-07-29: a true cold ASG boot could exceed the inference worker's 120-second
  startup timeout. The timed-out Python child was forgotten but left alive, so a retry
  launched a second API process and readiness flapped. Timed-out children are now
  killed, late exits cannot clear a newer process, and cold startup has a five-minute
  window. A fresh AMI instance produced valid DeanVoice audio with one API process.

- 2026-07-28: freezing only a `voiceProfileId` left a cross-chunk edge case: editing
  that same S3 profile record during a Live Fast conversation could make a later chunk
  resolve newer weights/references. Conversations now carry the exact GPT/SoVITS refs,
  reference set, and revision; Lambda accepts that pinned snapshot without rereading
  mutable profile state. Code/tests are pushed; staging deployment is pending.

- 2026-07-28: staging CloudFront globally converted S3/API 404s to `index.html` with
  status 200, so a missing voice profile looked like successful audio. The three
  staging distributions now rewrite only frontend routes on the default static
  behavior; API errors retain their real status/content type.

- 2026-07-28: concurrent users could change the process-global model/voice during
  another request, bypass the lock through demo paths, or lose Full session ownership
  when ALB routing changed target. Requests/conversations now freeze voice identity,
  all inference/model mutations use one bounded model-aware scheduler, and Full session
  state/events/artifacts/cancellation are shared through S3.

- 2026-07-27: Live Full regeneration did not actually pass the helper's `preserveReviewUnit` flag, despite the implementation comment and helper-level test, so edited cards could be internally re-chunked. Regeneration now forces one synthesis unit, and mutable worker WAV routes disable caching to prevent an older overwritten take from being reused. Targeted tests pass; the supplied-name WAV was unavailable locally and real browser listening remains unverified.

- 2026-07-24: pronunciation CSV imports lowercased header names but compared them with camel-case `verifyPhonemes`, silently dropping strict flags; the new `synthesisAlias` header would have failed the same way. Known headers now canonicalize before parsing, and round-trip tests cover both fields.

- 2026-07-24: Full formula preprocessing treated standalone valid element-symbol words such as sentence-initial `In` as chemical notation and rendered their letters individually. Alphabetic formulas now require multiple element symbols unless digits/grouping provide explicit formula evidence. Terminal phoneme approval also no longer relies on multiple correlated paddings of one Whisper span: it requires agreement with speech-end-anchored crops. Automated and deployment checks pass; real listening-labelled false-approval performance remains unverified.

- 2026-07-22: Production phoneme verification mapped every `ER` to unsupported IPA `ɝ` and discarded stress before mapping `AH`, so strict words such as `structural` could only return `uncertain`. ARPAbet conversion now maps `ER0`/stressed ER and `AH0`/stressed AH distinctly using tokens supported by the deployed wav2vec2 tokenizer. Real DeanVoice start-position checks now produce CTC/similarity scores and pass. Also reconciled exact normalized split compounds such as expected `through out` with Whisper `throughout`, removing false missing-word retries. Terminal word timing can still overlap a preceding word and remains open.

- 2026-07-22: A `<break>` before the first spoken word was discarded and a break after the final word could not become a WAV gap because joining only inserted silence between audio buffers. Full and Fast now separate boundary breaks from internal breaks and prepend/append exact WAV silence; consecutive boundary breaks add up to the existing 10-second cap. Unit coverage passes, but deployment and real browser listening remain.

- 2026-07-20: Live Full targeted regeneration expanded `<break>` into an internal marker and then stripped that marker before synthesis, while initial Full exposed both sides as separate review cards; Live Fast skipped SSML expansion entirely and browser Fast chunking could strand a break at a separate WAV boundary. Full now keeps the break inside one parent review chunk selected by ordinary context/chunk rules, uses it only for internal verified audio splitting/joining, and preserves editable markup. Fast applies its established per-segment verification then exact-silence joining, and the browser keeps both sides together. Deployment and real audio verification remain.
- 2026-07-14: Live Full could emit one sentence per chunk even with `Max sentences / chunk = 2` because a 60%-of-size heuristic flushed the first sentence before evaluating whether the second fit. Removed the premature flush; sentence count and character/word limits now determine grouping, with one bounded extra sentence when the result has fewer than eight words. Dotted and spaced initialisms now share deterministic spoken letter-name normalization, including `A` and `I`; a dotted initialism's last period is preserved when it also marks a sentence boundary instead of accidentally fusing the next sentence.
- 2026-07-14: pronunciation categories were separate S3 files but runtime concatenated them, allowing the same word to compete across categories; readable-only records could also rewrite verifier text (`iron` → `eye urn`) and falsely report a correctly transcribed word as missing. Fixed in pushed commit `73dfde0` by making entries ARPAbet-only, enforcing global replacement/deletion across categories, hiding and cleaning legacy duplicates, and defensively deduplicating/ignoring readable records in the worker. Deployment is pending.
- 2026-07-14: dev Full quality silently lacked speaker-similarity verification because `resemblyzer` was absent from the systemd service's Conda environment. Installed `resemblyzer 0.1.4`; the sidecar now reports active at the configured `0.62` threshold after restart.
- 2026-07-14: the first phoneme gate checked all 3,683 saved ARPAbet entries, so ordinary words such as `parameters` could reject otherwise clean `coverage=100%` takes. Fixed in pushed commit `1aea2c1` by checking Whisper-missed/mistranscribed dictionary terms by default and requiring explicit `verifyPhonemes` opt-in for correctly transcribed strict terms. Three overlapping crops produce `pass`/`reject`/`uncertain`; uncertainty cannot forgive a mismatch or hard-reject a strict word. Fast remains unchanged. Deployment is pending.
- 2026-07-14: newly completed/regenerated audio could show `Audio metadata was not ready yet` because the browser issued a metadata/range probe while the final WAV was still being written or exposed. Playback readiness now retries a cache-busted full-WAV fetch, rejects incomplete files, verifies the local blob's metadata, and retains a CORS-safe native-audio fallback.
- 2026-07-14: a plausible Whisper timestamp alone could falsely “prove” a hard dictionary word was present even if the timestamp covered silence or borrowed a neighboring word's speech. Full forgiveness now requires the exact anchored token slot plus sufficient timestamp duration/confidence and real PCM energy within that same span; silence/absent/short spans remain rejected.
- 2026-07-14: strict Full aborted the entire request after five one-sentence takes when Whisper repeatedly failed to transcribe a technical word such as `Michaelis`. Terminal per-sentence best-effort is restored after 3→5 retries, including ASR-unavailable runs. Technical dictionary mismatches can pass normally only when anchored timestamps show a real sufficiently long/confident token in the expected slot; an actually absent slot remains a rejection during retries.
- 2026-07-14: Full still exempted one-letter words from coverage/timing scrutiny. Full now counts every alphabetic word and applies zero length-based cut exemption during its 3→5 acceptance ladder; after those retries, the later terminal best-effort decision intentionally prioritizes returning the strongest audio-usable full sentence. Fast behavior is unchanged.
- 2026-07-14: stale `waiting`/`generating` progress could show another-user contention with no live request; voice-switch races could briefly show `No model` or apply an older model response; returning to an already-ready GPU paid the full blocking status delay. Ownership now comes from live Fast/Full activity, model loads are selection-versioned with a transient not-ready confirmation, and recent GPU-ready status restores immediately while background status checks run faster/in parallel.
- 2026-07-14: Full failed every take with `covered 0% (voice verification unavailable)` when the optional speaker-similarity sidecar was down. The fail-closed rule incorrectly treated an unavailable identity scorer as proof of incomplete audio. Full now retains strict ASR completeness validation and ranks without similarity until the speaker sidecar returns; only unavailable accurate ASR remains fatal.
- 2026-07-14: Live Full could still choose the first merely acceptable take and leave uncertain pronunciations/voice quality on the table. Full/Queue now rank verified candidates, isolate risky sentences, use beam-5 accurate ASR, and hard-reject low-confidence/dictionary mismatches during normal acceptance. Accurate ASR fails closed if unavailable; speaker similarity is used whenever available. Live Fast is intentionally unchanged.
- 2026-07-14: Live Full/Queue could publish whole missing spans and unclear/mispronounced words even though Whisper visibly rejected them. Root cause: after all strict retries failed, `synthesizeChunkResilient` deliberately returned the highest-scoring rejected take. Full/Queue now hard-fail that chunk before final/queued playback; an explicit legacy best-effort option remains for non-Full callers.
- 2026-07-14: concurrent Fast/Full users could collide in the shared inference process, and worker 409 responses were flattened to Lambda 500/generic browser failures. The worker now tracks Live Fast ownership alongside Full session state, both Lambda synthesis routes preserve upstream status codes, and the TTS UI distinguishes contention (409), expired sessions (404), and transient gateway timeouts.
- 2026-06-30: Full Inference skipped "divide very fast" while logs showed `missing=[divide, very, fast]` and `dictForgiven=[divide, very, fast]`. Root cause: dictionary forgiveness could apply to common words loaded from the admin/hot dictionary list, so the verifier adjusted coverage to 100% and did not treat the missing phrase as substantial. Fixed by allowing dictionary forgiveness only for longer rare terms (>=7 chars) and lowering substantial missing / clipped scrutiny from 5 chars to 4 so `very` and `fast` force re-rolls.
- 2026-06-30: Full Inference could still audibly cut/glitch words even when ASR verification accepted complete chunks. Root cause candidate: `concatWavs` post-processed accepted audio by fading chunk edges, trimming edge silence, and trimming to zero crossings before joining; that can shave soft word starts/tails after synthesis. Fixed by preserving generated PCM samples exactly during concat and only inserting the join pause. Regression test added.
- 2026-06-30: Full Inference dropped whole spans of words (e.g. "barrels of nine triplet microtubules" vanished). Root cause in `synthesizeChunkResilient` (`gpu-inference-worker/src/services/longTextInference.js`) pass 4: when no clean read existed, it returned the single highest-scoring candidate from `salvage` — but salvage held PARTIAL-span sub-chunks, so a passing first half ("Each centriole is made up of") could be returned as the WHOLE chunk, dropping the rest. Fixed: pass 4 now best-efforts EVERY span and concatenates, guaranteeing the full chunk text is always spoken (a mispronounced word is acceptable; a dropped one is not). Removed the partial-span `pickBestCandidate`/`salvage` path. Regression test added; 23 worker tests pass. NOTE: this, not chunk size, was the cause of the "skips 10 words at once" reports.
- 2026-06-30: Admin pronunciation dictionary ARPAbet entries had no effect (e.g. `centriole` still synthesized as "central/essential", causing the word to be dropped and reported as a skip). Root cause: GPT-SoVITS `english.py` reads `engdict-hot.rep` only when rebuilding `engdict_cache.pickle`; the cache (dated Jun 8) predated the hot file (Jun 30), so the engine kept loading the stale pickle and never saw the hot entries — even across restarts. On the box, dict path/load were all correct (`/home/ubuntu/gpt-sovits-v2pro`, valid phonemes, engine started after the hot-file write); only the cache shadowed it. Fixed `writeHotDictionaryOverrides` to invalidate `engdict_cache.pickle` on hot-file change and to drop a cache older than the hot file (self-heal); `/inference/start` now also restarts on `cacheInvalidated`. Manual one-time fix on the GPU box: `rm /home/ubuntu/gpt-sovits-v2pro/GPT_SoVITS/text/engdict_cache.pickle` then restart `gpu-inference-worker`. NOTE: the deployment uses the `.env` root (`gpt-sovits-v2pro`), NOT `.env.gpuinferenceworker.deployment` (`/opt/gpt-sovits`, a stale 2025 leftover).

- 2026-06-26: Deployed Live Full chatbot chunk playback still returned `Cannot GET /inference/chunk/...` after the code was pulled because the `gpu-inference-worker` Node process had not reloaded the updated route table. Restarted `gpu-inference-worker`; localhost and public fake chunk checks now reach the route and return `Chunk not ready or session not found` instead of Express HTML.
- 2026-06-26: Live Full chatbot queued replies could drift to the current engine/config between generated phrases because the phrase loop read `engineRef.current` during each phrase. The payload also did not match Text to Speech Full because `voiceProfileId` and `inference_mode: quality` were stripped before per-phrase synthesis. Fixed by snapshotting engine/ref/config once per assistant reply and preserving the full-inference identity/quality fields; targeted client test and Live Fast build passed.
- 2026-06-26: Queued Live Full chatbot phrases could sound inconsistently soft because each phrase usually returned a one-chunk full-inference WAV, and `synthesizeLongText` bypassed `concatWavs` normalization for one-chunk outputs. Fixed by always running full-inference final output through `concatWavs`; targeted worker test passed.
- 2026-06-26: Live Full chatbot still differed from Text to Speech Full because it launched a separate full-inference request per phrase, while TTS Full uses one session for the whole text. Reworked chatbot Live Full to use one `/inference/generate` session and fetch/play completed chunks from that session.
- 2026-06-26: Deployed Live Full chatbot chunk playback returned `No Lambda route for GET /api/inference/chunk/...` because the top-level Lambda router regex did not include the new chunk route. Fixed router pattern and added a router regression test.
- 2026-06-26: Browser chunk playback could request `/inference/chunk/...` without the `/api` prefix and get `Cannot GET /inference/chunk/...`. Fixed `getInferenceChunk` to build an explicit API URL with `resolveApiPath`.
- 2026-06-12: Live Fast `/api/voice-profile/activate` returned CloudFront 403 for full metadata payloads around 8 KB. Fixed by compacting activation reference metadata in `client/src/lib/voiceProfilePayload.js`; rich details remain in saved config records.
- 2026-06-12: `/api/models/select` could auto-select and persist saved-profile references without creating `voice-profile-configs/<voiceProfileId>/default.json`, leaving Live Fast with no default saved config after model selection. Fixed in `lambda/shared/modelSelection.js`; targeted Lambda tests passed.
