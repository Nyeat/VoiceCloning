# Deployment Notes

## Current Shape

- 2026-10-30: staging inference default is LT v41 / `ami-0642b66fa3ae46b4f` (30234eb + e3ab580 worker patch); v40 / `ami-07236b80dcdb93bcb` is the rollback. 23 older AMIs deregistered; their snapshots await an administrator (TODO).

### Staging manual operation (2026-10-09)

- User requested staging on now and daily start/stop disabled. Fixed EC2
  `i-0f0da8be59367f7a8` started; `vcs-staging-gpu-inference` min/desired/max = 1.
  This is one inference GPU, with no overflow beyond one; previous maximum was 192.
- SuspendProcesses and DeleteScheduledAction were denied. Both actions were instead
  changed to non-recurring entries: daily-stop 2099-01-02 11:00 UTC, daily-start
  2099-01-02 23:00 UTC, each min/desired/max 0. They do not run daily now.
- Staging main Lambda: GPU_SCHEDULE_ENABLED=false, GPU_IDLE_STOP_MINUTES=0.
  GPU_INFERENCE_ASG_NAME remains unset, so the fixed instance and ASG are independent.
- Staging coordinator MODEL_COORDINATOR_MODE=autoscale restores ASG discovery;
  routing-only had no configured instance IDs. The ASG maximum limits capacity to one.
- Gateway healthy; inference target remained unhealthy across 40 startup health polls. Worker logs
  showed local /tts HTTP 200, but transcription verification timed out and the inference service
  remained in start-post. Public speech readiness is unverified. No Dev changes.

To shut staging GPU compute down (account 329599637774, region ap-northeast-2):
1. Set ASG minimum, desired AND maximum to 0. This terminates inference workers;
   do not stop an ASG member directly, since the group can replace it.
2. Stop fixed EC2 `i-0f0da8be59367f7a8` separately. Active work is interrupted.
3. Verify ASG has zero instances and fixed EC2 is stopped. Keep Lambda schedule
   disabled, idle-stop 0, and the deferred actions unchanged. No hour edits needed.

Historical cause: 2026-10-06 19:00 SGT daily-stop and 2026-10-07 07:00 daily-start
restored min 1/max 192 and launched GPUs after manual zeroing. Minimum 1 is a floor,
not a request to reduce a fleet to one; traffic is not required for scheduled starts.
Reapplying provisioning/daily-schedule scripts can restore automatic operation.
### Autoscaling decision boundary (2026-09-01)

- Atomic fleet admission is implemented locally at commit `7b297dc` but is not deployed. The
  previous live failure was real rather than a display-only defect: six simultaneous requests chose
  one stale oldest-worker snapshot, queue depth exceeded two, one request failed, and desired capacity
  increased 4->5 while two matching GPUs were idle.
- The coordinator now serializes only the short scheduling decision with a scoped DynamoDB lease and
  records expiring per-request reservations. Synthesis and model loading remain outside the lease.
  Matching free slots pack oldest-first to two active requests per GPU; overflow uses the least-loaded
  matching queue with at most two waiting requests per GPU. Excess demand returns retryable
  `MODEL_QUEUE_FULL` instead of exceeding the bound.
- Selection on TTS and Faculty and lecture selection/opening may prepare the chosen cloned voice.
  Preparation first routes to matching capacity, then reassigns an eligible idle GPU, and scales only
  when neither exists. Real synthesis follows the same reuse-first order and may queue behind a loaded
  matching voice while one model-scoped scale claim prepares overflow.
- Client retries preserve preparation, full-queue, timeout, and admission-contention codes. A pending
  answer retries its own speech after the server hint; successful audio clears stale capacity notices.
  ElevenLabs synthesis bypasses cloned-voice GPU admission and does not consume a slot.
- Search coordinator logs for `[model-coordinator][decision]` to attribute the exact route, queue,
  reassignment, retry, or scale decision before interpreting an instance-count change.
- Event mode writes a coordinator residency lock for the default event voice and configured minimum.
  Protected minimum workers are unavailable to other-model reassignment; overflow workers remain
  reusable. A scheduled scale-down supplies the lock expiry; disabling event mode removes the lock.
- ASG replacement after an EC2 member is stopped is capacity maintenance, not synthesis scale-out.
  Check scaling activity cause and EC2 state-transition reason before combining those incidents.
- Worker runtime changes must be baked into and canaried from the launch-template AMI; patching current
  workers alone does not update future scale-outs.
- The shared DynamoDB table is partitioned logically by `MODEL_COORDINATOR_SCOPE=dev|staging` for
  demand, reassign, pending-scale, and residency-lock records. Never remove the scope variables or
  interpret legacy unscoped markers as live state. `MODEL_PREFLIGHT_REASSIGN_IDLE_MS=30000` protects
  an idle prepared lecture voice from opposing 15-second polls; real synthesis keeps immediate idle
  reassignment through `MODEL_REASSIGN_IDLE_MS=0`.

### Atomic admission release and acceptance (commit `7b297dc`)

This release changes Lambda/coordinator scheduling and all three affected client surfaces. It does not
change `gpu-inference-worker`, so do not patch workers, create an AMI, or promote a launch-template
version for this release.

1. Start from a clean tree. Refresh the user-level temporary credentials, map them into process-only
   `AWS_*` variables, assume the authorised role, and verify `aws sts get-caller-identity` reports the
   intended account. Confirm both local environment branches contain `7b297dc`; push them before cloud
   deployment so source control matches the release.
2. Re-run the focused baseline if the commit changes: `npm.cmd test` in `lambda/`, `npm.cmd test` in
   `client/`, `node --test "src/**/*.test.js"` in both `gpu-inference-worker/` and `gpu-worker/`, and
   the default, `live-fast`, and `gi` client builds. Package both Lambda archives and inspect the
   coordinator ZIP for the admission implementation.
3. From `separate-containers-new`, run
   `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\deploy-lambda.ps1 -Env dev`, wait for
   both function updates to succeed, then deploy `-Env dev -Mode live-fast` and
   `-Env dev -Mode chatbot` with `deploy-client.ps1`.
4. Switch to `codex/staging-multi-user-scaling` and confirm it resolves to the same reviewed commit.
   Run `deploy-lambda.ps1 -Env staging`, wait for both function updates to succeed, then use
   `deploy-client.ps1` for Staging modes `live-fast`, `chatbot`, and `chatbot-text`. Wait for every
   CloudFront invalidation and read back each public `index.html` plus its current hashed bundle.
5. Dev is routing-only: verify selection prepares a fixed idle GPU, two overlapping requests use its
   two slots, queue/preparation responses auto-retry without a second prompt, and no ASG mutation is
   attempted. Start the second fixed GPU manually only when the scenario requires it.
6. In Staging, establish three ready workers with the same test voice and issue six simultaneous
   requests. Require six successful responses, a 2/2/2 direct-admission distribution in oldest-first
   order, no queue depth above two, and no desired-capacity increase.
7. With four matching workers' direct slots occupied, issue three more requests. Require their waiting
   reservations to spread across the least-loaded workers rather than stack on the oldest worker. Fill
   all bounded queues and confirm further requests receive retryable `MODEL_QUEUE_FULL`, then succeed
   automatically when capacity becomes available.
8. Exercise the two scaling boundaries separately. With matching workers full and an eligible idle
   different-model GPU present, require queue admission plus idle reassignment and no scale-out. With no
   matching or reusable idle GPU, require exactly one model-scoped scale claim, a truthful preparation
   notice, automatic retry after the new worker becomes ready, and removal of the stale notice on audio.
9. Confirm an ElevenLabs request creates no cloned-voice admission reservation or worker occupancy.
   During event mode, confirm protected minimum GPUs cannot switch; after traffic and event protection
   end, verify the newest continuously idle overflow worker is selected for scale-in.
10. Restore the normal Staging schedule and minimum/desired values after temporary capacity testing,
    wait for replacement/scale-in activity to settle, and run one final signed-in TTS, lecture, and
    Faculty synthesis. Record request IDs, coordinator decisions, worker assignment, queue depth, and
    desired-capacity history for the acceptance evidence; do not infer correctness from frontend text.

The repo docs describe a split cloud deployment:

- CloudFront serves the frontend and is the browser entrypoint.
- Lambda Function URL handles `/api/*` REST traffic.
- A GPU ALB forwards long-lived browser traffic to GPU-side services.
- GPU EC2 hosts three app processes:
  - `gpu-worker` on `3001`
  - `live-gateway` on `3002`
  - `gpu-inference-worker` on `3003`

## Live TTS cold-path state (2026-07-31)

- Staging Lambda is 512 MB with no provisioned concurrency or alias.
- The router eagerly imports Live, so any environment warmup prepares that module.
- GI sends the active profile's pinned GPT/SoVITS snapshot for the conversation,
  avoiding synthesis-time S3 profile reads. Profile resolution is 0 ms p50.
- This is not a global resolver bypass. Regular Live Fast/Full already supplies its
  selected-model snapshot; direct callers that send only `voiceProfileId` still load
  the saved profile normally.
- GPU-free first invocation dropped from 4.618 s to 15.71 ms. Strict-ready 50-GPU
  full-flow reruns passed 100/100 and 150/150; the 150-user tail is capacity retries.
- At 150 users, first-turn p95 was 12.82 s, including 9.75 s p95 retry sleep. The
  22.35 s maximum slept 19.75 s across 12 retries. Two later maxima were different:
  9.50-16.55 s was outside Lambda, so retain separate transit instrumentation.
- A versioned alias and scheduled provisioned concurrency remain future improvements.
- The next capacity rehearsal must publish occupied/total slots, no-capacity responses,
  and pending admissions every 10 seconds; compare shorter jittered retries with a
  centralized fair queue; prewarm above the current rehearsal floor for a known
  simultaneous 150-user event; and compare an immediate burst with the same workload
  arriving over 30-60 seconds. Reactive GPU launch is not the event safety mechanism.

## Environment Map

The authoritative resource-level inventory is repo `docs/staging-architecture.md`;
always read and live-verify it before AWS work.

### Dev learner analytics checkpoint (2026-08-07)

- `vcs-dev-transcripts` is live in Seoul with deletion protection, TTL, and point-in-time
  recovery. Real NTU sign-in has proven the profile, session/turn, concept, and summary rows.
- Query the raw partition value `USER#<oid>`; do not include `PK = ` inside the value field.
- Support inference uses a 30-day rolling window. Two rewinds produce only
  `possible_support`; two clarification requests produce `support_recommended`. The internal
  score caps at `3` and qualifying count at four. Long pauses and transcript scrolling are
  raw analytics only. Supervisors can reset one learner concept and rebuild its summary.
- Dev bundle `assets/index-DUXyI87I.js` coalesces scrubs, recognizes clarification repeats,
  hides per-learner score, and shows the supervisor-only distinct-learner cohort ranking.
- The two current developers have dev-only supervisor access through the Lambda
  `SUPERVISOR_OIDS` Entra object-ID allowlist. This is independent of email domain and does
  not change DynamoDB learner roles. Keep the IDs out of source control; staging is unchanged.
- Operational interpretation: a concept row holds rolling qualifying events; its separate
  lesson summary row is derived chatbot/dashboard guidance. Two rewinds should produce score
  `1`, count `2`, and `possible_support`. After an initial question, two clarification
  follow-ups at least eight seconds apart should produce the maximum score `3`, count `4`,
  and `support_recommended`. Wait ten seconds before reading the table.
- A learner/concept reset clears only derived support state. Old session/transcript rows and
  immutable raw event batches remain for audit and do not restore or influence the cleared
  score. Use two distinct authenticated learners to validate cohort ranking; repeated actions
  by one learner still count as one learner for that concept.

| Environment | Training | TTS | GI bleeding chatbot | Dean chatbot (not video GI) | Live MC |
|---|---|---|---|---|---|
| staging | d1qh0ebsvevhy3.cloudfront.net | dfzrfr93t2ruf.cloudfront.net | d25sg72wp8oj5g.cloudfront.net | d3k2rz0hqm8nxi.cloudfront.net | d32nzk2gacfhag.cloudfront.net |
| dev | d3dghqhnk7aoku.cloudfront.net | doovx82fh9tfs.cloudfront.net | d2o0cbe2zunqkr.cloudfront.net | none | none |

Live MC (`deploy-client.ps1 -Env staging -Mode mc`, S3 `echolect-staging/dist-mc`) routes only
`/api/live/chat/realtime` (ALB), `/api/live/tts-sentence` and `/api/live/cancel` (Lambda URL);
no admin, auth or capacity APIs. Smoke test: `node scripts/test-staging-mc.mjs <24kHz mono wav>`.

Staging uses the `echolect-staging/` application prefix and the `-staging` Lambda;
dev uses `echolect/` and the Lambda without a suffix. `d3fwx6qxeaxfmo.cloudfront.net`
is a separate legacy GI-bleeding chatbot and is not part of this dev/staging map.

Both environments are in account `329599637774`, primarily in Seoul
(`ap-northeast-2`). Operators assume
`arn:aws:iam::329599637774:role/Liu_Teng_Yu_Intern2026`. Both Lambdas use
`Liu_Teng_Yu_Intern2026-LambdaExecutionRole`; fixed GPU instances and staging ASG
instances use the `VoiClo_GPU` instance profile. The Auto Scaling service-linked
role belongs to the staging ASG path only.

| Ownership | dev | staging |
|---|---|---|
| Branch | `separate-containers-new` for all components | `codex/staging-multi-user-scaling` for all components |
| Fixed GPU instance | activity-managed `i-03f258d470a2fa73f`; manual inference comparison `i-0048470294e4ec518` | `i-0f0da8be59367f7a8` |
| Capacity management | routing-only coordinator over both fixed IDs; original stops after 30 idle minutes; comparison is manual-only; no ASG/automatic start | fixed training/control GPU plus model-aware `vcs-staging-gpu-inference`; one baseline, immediate idle reassignment, reactive overflow, and explicit event prewarm |
| Worker access | SSM | SSM |

There is no dev `-dev` Lambda, `echolect-dev/` prefix, dev ASG, or separate dev chatbot
branch. The two active branches are deployment pointers to the same reviewed commit;
environment files and AWS configuration own the differences. Always verify both remote
pointers, `scripts/deploy.config.json`, and live AWS before mutation.

Latest live read-back (2026-08-31): the Dev and Staging remote deployment pointers were pushed
together from the same reviewed tree after final verification. Both main Lambdas and both
coordinators were redeployed from that tree. `deploy-lambda.ps1` now packages/uploads coordinator
code as well as synchronizing its environment, preventing false-success coordinator rollouts.
Dev has 30-minute idle stop, schedule off, a
routing-only coordinator over its two fixed IDs, and
a fixed-activity URL routed only to original GPU `i-03f258d470a2fa73f`. Shared inference also has
manual comparison GPU `i-0048470294e4ec518`. Coordinator traffic reaches worker port 3003 only from
the coordinator Lambda security group. Final live proof isolated the original GPU, prepared Dean,
and returned a 183,084-byte RIFF; the manual comparison worker remained stopped. The original stays
activity-managed. Staging ASG is min/desired 1 and max 192; worker `i-030f2a2a2428230de` was healthy,
idle, and READY for Dean and returned a 129,324-byte coordinated RIFF. Corrected worker files were
baked into `ami-07236b80dcdb93bcb`, launch-template v40. One v40 canary reached coordinator READY;
the no-traffic policy then returned desired 2->1. Scaling activity also records natural 4->3->2->1.
Both daily actions preserve min 1 and leave desired unset.

Staging chatbot serves the GI build from `codex/staging-multi-user-scaling`; its published
`gi-bleeding` category currently selects cloned profile `deanvoice-v1`. Faculty publish copies
the selected profile, exact weights/references, and then its category into Dev's `echolect/`
prefix. It does not share transcripts, analytics, training state, or other environment data.
Staging Live Fast starts multi-sentence voice after the first confirmed completed
streamed sentence. The staging Lambda exposes profile-resolution, worker-round-trip,
capacity-retry, cold-environment, and total timing headers; memory is 512 MB.
The lesson video is preserved under `echolect-staging/dist-chatbot/videos/`. The three staging
CloudFront distributions use static-behavior SPA rewrites rather than global 404-to-200
fallbacks, so API errors preserve their real status.

## 2026-08-02 Capacity Work

- Staging code is generally multi-user: immutable voice snapshots, a bounded model-aware
  scheduler, S3-backed Full sessions, and queued training are deployed.
- A g6.xlarge has been validated at two same-model synthesis slots. Ten simultaneous
  verified requests returned 10/10 valid WAVs in 32.7 seconds without worker OOM.
- Target group, final AMI, launch template, ASG, target policy, and one inference
  instance exist. ALB rule 3 is cut over and public synthesis passes.
- Pre-scale before 07:15 SGT; do not depend on reactive GPU launch for the 08:00 burst.
- Initial measured plan is 16 prewarmed GPUs for a 50-request burst; finish the
  25/50/60-user fleet tests before acceptance.
- SageMaker training jobs do not serve inference. A SageMaker real-time endpoint may be
  revisited after the event, but migration risk is higher than scaling the existing EC2
  worker for this deadline.

## Important Routing

- `/api/live/chat/realtime` must reach `live-gateway`.
- `/models*`, `/ref-audio*`, and `/inference*` must reach `gpu-inference-worker`.
- Other GPU worker traffic defaults to `gpu-worker`.
- Browser SSE paths stay off Lambda:
  - `/train/progress/*`
  - `/inference/progress/*`

## Deployment Touchpoints By Area

- Frontend changes:
  - Build from `client/`
  - Upload build output to the frontend bucket/prefix
  - Invalidate CloudFront
- Lambda changes:
  - Package from `lambda/`
  - Update Lambda function code
- GPU worker changes:
  - Pull code on EC2
  - Restart the affected service
  - Verify the deployed GPT-SoVITS runtime includes the `v2ProPlus` assets plus `2-get-sv.py`/SV checkpoint support expected by the training pipeline
  - For Live Full phoneme verification, install `espeak-ng` at the OS level and `phonemizer` plus `transformers>=4.40,<5` in `PYTHON_EXEC`; pre-warm `facebook/wav2vec2-lv-60-espeak-cv-ft` or allow its first verified technical term to download it. The inference-worker Dockerfile includes these dependencies.

## Dev Deployment Reference (Not Staging)

- Target AWS account: `329599637774`
- Assume role: `arn:aws:iam::329599637774:role/Liu_Teng_Yu_Intern2026`
- EC2 access: SSM target `i-03f258d470a2fa73f` (do not depend on the old workstation SSH path)
- EC2 repo: `/home/ubuntu/VoiceCloning`
- Branch: `separate-containers-new`
- Inference service: `gpu-inference-worker`
- Seoul Lambda: `Liu_Teng_Yu_Intern2026-Voice_Cloning_Project`
- Lambda region: `ap-northeast-2`
- Frontend bucket: `interns2026-small-projects-bucket-shared`
- Frontend prefix: `echolect/dist-live-fast/`
- Application S3 prefix: `echolect/`
- Dev CloudFront distribution: `E36CNBL620DMGM`

Use fresh SSO credentials for account `116310094355` only to call `sts assume-role`;
never save access keys or session tokens in this vault or repo. Export the returned
role credentials into the current process, then verify `aws sts get-caller-identity`
reports account `329599637774`.

Durable deploy order:

1. Run local tests/builds and package Lambda.
2. Commit and push `separate-containers-new`.
3. On EC2, preserve any intentional tracked edits, `git fetch`, then
   `git merge --ff-only origin/separate-containers-new`; do not delete the two known
   unrelated archives if still present.
4. Restart `gpu-inference-worker`; verify `systemctl is-active`, `/activity/status`,
   and sidecar-active log lines. `/` and `/health` are not worker health endpoints.
5. Update the non-staging Seoul Lambda with
   `lambda/.dist/voice-cloning-function-url.zip` and wait for a successful update.
6. Sync `client/dist-live-fast/` to
   `s3://interns2026-small-projects-bucket-shared/echolect/dist-live-fast/`.
7. Invalidate `/*` on CloudFront `E36CNBL620DMGM`, wait for completion, and verify
   the public bundle/API behavior.

## Staging Inference Takeover and Rebuild Runbook

Start every staging AWS session by reading repo `docs/staging-architecture.md`, repo
`scripts/deploy.config.json`, vault `HANDOFF.md`, and vault `TODO.md`. Work from
`codex/staging-multi-user-scaling` for Lambda/GPU/ASG and GI-client changes.
`scripts/deploy-client.ps1` intentionally rejects a chatbot build from a branch other
than the environment's configured `chatbotBranch`.

1. Check `git status` and `git log -3`. Preserve unrelated local changes. Export fresh
   temporary `VCS_AWS_*` credentials outside chat, map them to `AWS_*`, assume the
   authorised staging role, and verify the destination account. Never write credentials
   into source, logs, reports, or Markdown.
2. Read live state before trusting recorded IDs: describe the ASG, launch-template
   default, AMI, scaling policies, alarms, scheduled actions, listener rule, target
   group, instance subnet/security group/profile, and service quota. Run one public
   RIFF smoke request before making changes.
3. Run targeted tests locally. Current baseline commands are `npm.cmd test` in
   `lambda/`, `node --test "src/**/*.test.js"` in `gpu-inference-worker/`, Node syntax
   checks for changed scripts, PowerShell parser/dry-run checks for the provisioner,
   and JSON parsing for both deployment configuration files.
4. Package Lambda with `npm.cmd run package:function-url` from `lambda/`. Update only
   the staging Lambda, wait for `LastUpdateStatus=Successful`, and run the public TTS
   smoke. Capacity retries are implemented in Lambda, so an AMI rebuild alone does not
   deploy retry changes.
5. For the GI client, stay on the configured `codex/staging-multi-user-scaling`
   branch, confirm the expected commit and clean tree, then run:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\deploy-client.ps1 -Env staging -Mode chatbot
   ```

   This selects `build:gi`, syncs `dist-gi` to the staging chatbot prefix while
   preserving `videos/*`, and creates a CloudFront invalidation. Verify the public
   bundle, lesson video, pinned `deanvoice-v1`, and real API status handling.
6. Update a baseline ASG worker through SSM without exposing it as unhealthy halfway
   through deployment. Temporarily use EC2 health while stopping/restarting the
   Target Optimizer-facing service, fast-forward the repo to the pushed commit,
   restart `gpu-inference-worker`, run `scripts/warm-staging-deanvoice.sh`, start
   Target Optimizer only after the real RIFF route warm succeeds, verify public audio,
   and restore ELB health checks. Stopping Target Optimizer while ELB health remains
   authoritative caused an earlier ASG replacement and must not be repeated.
7. Before creating an AMI, verify `git rev-parse HEAD`, service state, the non-zero
   inference entry-file size, the warm timing output, one Python API process, and one
   valid public WAV. Flush the filesystem (`sync`) before `ec2 create-image`. Wait for
   the AMI to become `available`; do not promote a pending or unverified image.
8. Create a new launch-template version from the known-good version, changing only the
   reviewed AMI/user-data fields, and set it as default. Run the staging provisioner
   without `-Apply` first:

   ```powershell
   .\scripts\ensure-staging-live-gateway.ps1 -Apply
   $env:VCS_STAGING_EVENT='true'
   $env:VCS_STAGING_PREWARM_CAPACITY='50'
   $env:VCS_STAGING_MAX_CAPACITY='192'
   $env:VCS_STAGING_SCALE_OUT_OCCUPANCY_PERCENT='70'
   $env:VCS_STAGING_SCALE_OUT_ADD_CAPACITY='10'
   $env:VCS_STAGING_PREWARM_AT='2026-08-04T13:30:00+08:00'
   $env:VCS_STAGING_SCALE_DOWN_AT='2026-08-04T16:00:00+08:00'
   .\scripts\provision-staging-autoscaling.ps1 -AmiId <verified-ami> -DesiredCapacity 1
   ```

   The gateway preflight starts the fixed control instance only when necessary,
   waits for it in `vcs-staging-tg-3002`, and never stops it or creates a schedule.
   `GPU_SCHEDULE_ENABLED=true` is live with 07:00-19:00 Singapore values. CloudWatch
   showed one Lambda invocation every five minutes, but this role cannot inspect its
   invoker. Matching inference-ASG actions run daily at 07:00 (min/desired 1) and
   19:00 (min/desired 0); apply them with `set-staging-asg-daily-schedule.ps1 -Apply`.
   Review the dry run, then repeat with `-Apply`. Use `-SwitchListener` only when an
   intentional listener cutover is required. Environment variables do not update AWS
   until the provisioner is applied.
9. After prewarm, do not admit users until this succeeds:

   ```powershell
   .\scripts\wait-staging-event-ready.ps1 -ExpectedCapacity 50
   ```

   It requires desired capacity, InService/healthy target coverage, and every
   instance's verified public-RIFF prime marker newer than the current worker start.
   A worker restart therefore fails closed until public prime is repeated. The instances perform model warm and
   public prime themselves using their instance roles; operator credentials are used
   only to inspect/control AWS from this script. Pending SSM command distribution is
   retried; do not interpret ALB health alone as public-prime completion.
   The browser and complete-flow harness send a WebSocket keepalive every 15 seconds.
   Desired ALB defense-in-depth is 300 seconds:

   ```powershell
   .\scripts\set-staging-alb-idle-timeout.ps1 -Apply
   ```

   This role is denied `elasticloadbalancing:ModifyLoadBalancerAttributes`, so live
   staging remains 60 seconds until an administrator runs and verifies that script.
10. For a scale rehearsal, raise min/desired explicitly, record request start, metric
   minute, alarm transition, desired-capacity change, EC2 launch, cloud-init finish,
   route warm, and optimizer capacity separately. Use per-instance
   `ssm:GetCommandInvocation`; `ssm:ListCommandInvocations` is denied.
11. Run the complete chatbot harness and the closed-loop TTS harness described in repo
    `docs/staging-architecture.md`. State whether verification was skipped. Save raw
    JSON under ignored `.tmp/`; copy durable aggregate results into the architecture
    document rather than committing large session transcripts.
12. Restore min/desired 1 and max 192 after testing. Re-read both scheduled actions,
    verify only one healthy `InService` baseline remains, run a public RIFF smoke, then
    update repo architecture/config and vault deployment/handoff/TODO/bugs/changelog.
    Commit and push the code repository. Remove temporary credentials from User scope.

The GI student page does not load models or send a warm inference when each student
enters. It reads the pinned profile and begins work when chat starts. Model, primary
reference, five auxiliary references, throwaway synthesis, and the real TTS route are
prepared once by each ASG instance before Target Optimizer starts. This avoids a
redundant student-entry warm-up burst.

## Staging ASG State (verified 2026-10-05)

- Restored for the Live MC page: fixed staging `i-0f0da8be59367f7a8` running, ASG
  `vcs-staging-gpu-inference` min 1/max 192 with both daily actions keeping min 1, staging
  Lambda `GPU_SCHEDULE_START_HOUR=0`/`END_HOUR=24`, coordinator `autoscale`
  (`scripts/configure-staging-mc.mjs --apply`). Dev `i-03f258d470a2fa73f` remains stopped.
  To shut down again, reverse all of these together.

- Current image `ami-0fdeab564c09be219` contains inference latency fix `331586a`; launch
  template `lt-07728350a25e691a4` version 30 is latest/default and the ASG follows `$Default`.
  It uses `g6.xlarge`, `VoiClo_GPU`, and the staging GPU security group. Verify a fresh v30
  boot on the next natural scale-out.
- ASG `vcs-staging-gpu-inference` is currently min 0/max 192/desired 0 with no instance.
  Its normal operating baseline before the shutdown was one warm GPU in
  `subnet-0c1937ef298f54500`.
- Listener rule 3 routes inference/model/reference traffic to Target Optimizer group
  `vcs-stg-opt-3103`.
- Live scale-out is model-aware in the coordinator: route to an existing matching free slot;
  otherwise immediately reassign an eligible idle unassigned/differently loaded worker, or add
  one ASG instance when all eligible workers are occupied or unavailable. A positive residency
  delay is only an explicit event-mode configuration. Matching requests pack onto the oldest worker.
  Legacy rejection/occupancy alarms are telemetry-only; scale-in removes one newest instance after
  fifteen no-traffic minutes.
  Warmup/health grace is 10 minutes, cooldown 5 minutes, and target drain up to
  2 minutes. Normal scale-in stops at min 1. Event mode can immediately set or schedule the
  configured 50-GPU floor; every new worker claims pending model demand, otherwise warms
  `deanvoice-v1`, completes ten two-slot warm rounds and public RIFF primes, and only then
  becomes ready. A paired scale-down restores the normal one-GPU baseline.
- A browser-keepalive A/B completed all four real-flow waves: 100/100 and 150/150
  on 50 effective GPUs, then 100/100 and 150/150 on fully primed 60 GPUs. The earlier
  33/100 and 13/150 collapse was a harness mismatch, not a demonstrated GPU limit.
- The 100-user run sampled 73% at 07:00 UTC. Alarm 07:03:48, launch 07:04:01,
  all target-healthy 07:09:27, and all public-prime logs by 07:11:30. Health therefore
  preceded strict prime by about two minutes; reactive strict readiness took 11m46s
  from load start. Post-scale 100/150 peaked at 27.5/47.5%, so no second +10.
- An exact-model request admitted while both resident slots are occupied enters that worker's
  bounded priority/FIFO queue while the coordinator requests overflow capacity. If no worker has
  the model, the coordinator prepares an idle worker and returns a retryable preparation state;
  it does not hold the original HTTP request through a multi-minute model load. A slot may be
  briefly unused while rejected Lambdas sleep before retry.
- Launch-template v15 requires 10 two-slot rounds (20 RIFF responses) before
  advertising capacity, covering first-chunk and verified later-chunk paths. A fresh
  validator completed the deep rounds in 26 seconds and full cloud-init warm in 256
  seconds before Target Optimizer started.
- The newly warmed v15 50-GPU/100-user run completed only 59/100: 40 first-turn
  CloudFront 504s and one later WebSocket 1006. The same hot fleet then completed
  150/150. Local deep warm is therefore deployed but is not a valid public-readiness
  proof; do not add more local rounds.
- LT v16 masks first-boot automatic-update services and makes full warm an
  `ExecStartPost` gate on every worker restart. It removed post-warm service churn,
  but stable v16 still completed only 48/100 fresh users.
- LT v17 adds the proven public-route prime: each new node waits 90 seconds after
  Target Optimizer starts, sends two concurrent realistic first-clip requests through
  CloudFront, then waits 45 seconds for backend work hidden by a 504 to settle.
  Fresh auto-primed 50 GPUs passed 100/100; hot 150 delivered turn one to 150/150 and
  completed 148/150 with two later WebSocket 1006 closures and no TTS failures.
- Final cleanup restored min/desired 1, ELB health authority, and the rejection alarm
  in OK state with actions enabled. The retained v17 baseline passed a public RIFF
  smoke in 3.27 seconds.
- Public GI DeanVoice synthesis passed after fresh-instance cold-load validation.
  A fresh v10 node completed cloud-init in 442 seconds: its timed warm command spent
  9 seconds on cache lookups, 273 seconds loading the Python/base/voice model stack,
  and 96 seconds on reference caching plus first synthesis. The same command on an
  already initialized node took 13 seconds.
- A 16-node warm fleet returned 50/50 requests (p50 20.18 s, p95 24.30 s) and then
  60/60 (p50 3.67 s, p95 9.09 s). A cold 60-request burst returned 60 HTTP 504s and
  did not trigger scaling before timeout, so the 07:15 SGT scheduled prewarm is
  mandatory. Paired 06:50/18:00 SGT actions are now live for 2026-08-02.
- After real-route warm, 32 GPUs completed 50/50 three-turn chatbot sessions. Median
  first voice by turn was 7.57/3.79/4.11 seconds. At 100 users, all completed first
  voice and 98 completed all three turns; the busiest sample still had five free slots,
  so desired correctly stayed 32.
- A closed-loop 100-user/120-second TTS run with verification skipped returned 2,427/2,427 valid WAVs at
  p50/p95 3.86/11.31 seconds and retained two free slots. A separate 192-user trigger
  produced a true zero-capacity minute at 20:20 SGT: alarm 20:23:43, desired 32->51,
  launch 20:23:56, all 19 new route-warm checks complete by 20:28:31.
- On the hot 51-GPU fleet, 100/100 users completed three turns. Median first voice was
  5.02/3.34/3.40 seconds and total response 23.54/19.04/17.15 seconds. A hot 50-user
  comparison also passed 50/50 with first voice 5.69/4.10/4.30 seconds; no two-user
  first-audio penalty was observed, but generated answer lengths varied.
- A prior one-user response's 14 chunks ran one after another in about 28 seconds.
  It did not autoscale because sequential chunks did not exhaust the fleet. Use
  `node scripts/load-test-staging-chatbot.mjs 50` for the complete-flow test.
- Repo uses max 192 and the requested event default is 50, with
  `VCS_STAGING_PREWARM_CAPACITY` and `VCS_STAGING_MAX_CAPACITY` overrides. Max 200
  is invalid against the verified 768-vCPU/192-instance On-Demand G/VT quota.
- Live one-time actions start min/desired 50 preparation at 06:50 SGT on 2026-08-02
  so automatic public prime finishes before the 07:15 event, and restore min/desired
  1 at 18:00 SGT. Both were read back and verified on
  2026-07-30. The provisioner accepts flexible ISO timestamps through
  `VCS_STAGING_PREWARM_AT` and `VCS_STAGING_SCALE_DOWN_AT`, requires both, and rejects
  an end time that is not later than the start. Rerun with `-Apply` to change AWS;
  setting environment variables alone does not modify an existing schedule.
- After testing, live min/desired was restored to 1 and max remains 192. The schedule
  was re-read unchanged after cleanup.
- Validator `i-015de451bff24a73b` is stopped but remains registered as an unused target.
  An administrator must deregister it from `vcs-stg-opt-3103` and terminate it because
  this role is denied both actions; its stopped EBS volume still incurs storage cost.
- Fresh v15 validator `i-0eb2ca68edb88d6d7` is stopped and requires administrator
  termination because this role is denied `ec2:TerminateInstances`.
- On 2026-08-01 the fixed GPU was stopped while the ASG baseline still ran. Matching
  recurring actions were created and read back, and the ASG was immediately set to
  min/desired 0. The Lambda code for exact manual stop/termination coupling is deployed,
  but its setting was rolled back after the execution role was denied
  `autoscaling:DescribeAutoScalingGroups`; an administrator must grant that plus
  `autoscaling:UpdateAutoScalingGroup` before applying the lifecycle helper.
- The v14 event rerun waited for all 50 two-slot gates before load. Immediate 100 users
  completed 68/100 (32 first-chunk 504s); hot 150 users completed 144/150 (six
  WebSocket 1006 closures). A real 226-rejection minute changed desired 50->60
  exactly, and all 60 route-warmed targets then completed 150/150. Fifty is not a
  reliable immediate-burst capacity; 60 has one passing v14 wave, not a guarantee.
- The v15 event rerun also waited for all 50 targets. Immediate 100 users heard
  turn-one audio for 60/100 and completed 59/100; successful first-audio averages were
  24.23/1.85/1.87s. The hot 150-user follow-up completed 150/150 at
  7.04/3.01/2.81s. Deep localhost warming did not improve cold public traffic.
- During the v17 acceptance recycle, recently deleted 49x500-GiB volumes temporarily
  left stale quota accounting and EC2 rejected launches against the 50-TiB gp3 quota;
  the visible live inventory was already 3.42 TiB and launches resumed after accounting
  cleared. Verify gp3 headroom before 06:50 and avoid a mass recycle immediately before
  the event.
- The 2026-07-31 independent v17 repeat verified 3.0 TiB visible gp3 usage against
  the 50-TiB quota, all 50 initial nodes through target health and public-prime
  completion, 100/100 complete three-turn users in 95.29s, and 147/150 complete in
  134.77s with three WebSocket 1006 closures and no failed TTS chunks. The 150-user
  wave produced 379/777/171 optimizer rejects in three minutes and triggered the
  fixed step 50->60. All 10 added nodes became healthy and completed public prime,
  but only after the short wave ended; scheduled prewarming remains required.
- A separate stopped control instance owns the staging live WebSocket gateway.
  Full chatbot tests returned uniform 503 until `i-0f0da8be59367f7a8` was started;
  start and health-check `vcs-staging-tg-3002` before the event or any complete-flow
  test. The TTS-only inference ASG and its scheduled action do not start this gateway.

Detailed per-turn timing definitions, the complete test ledger, warm-up ownership,
burst interpretation, and evaluated future options with downsides are maintained in
repo `docs/staging-architecture.md`. Keep this operational file concise enough to use
as a runbook; do not duplicate raw per-session JSON here.

## 2026-07-31 Evening Rehearsal

- A temporary 50-GPU event floor passed 50/50 strict health, service, cloud-init, and
  public-prime checks. A 150-user wave sampled 82% occupancy and changed desired
  50->60; all 60 later passed the strict gate. Post-scale 150 and 100 waves did not
  request another increment.
- First-WAV latency is measured from fully completed assistant text, excluding speech
  upload/transcription/OpenAI generation. Full results are in repo architecture docs;
  raw JSON remains ignored in `.tmp/`.
- Fixed live/repo quiet scale-in with `FILL(requests,0)`. A controlled desired-3 run
  changed 3->2 after the 15-minute quiet window and later 2->1. The `-1` policy is
  safe but removes subsequent GPUs only after drain/cooldown completes. The baseline
  public route then returned a verified HTTP 200 RIFF in 6.28 seconds.
- The August 3 08:30/17:00 actions described by this historical rehearsal section
  were superseded. Current verified one-time actions are August 4 at 13:30/16:00 SGT;
  strict readiness has taken about eight minutes, so admit users only after the gate.

## Repo Files Worth Checking First

- `docs/lambda-serverless-gpu-worker-guide.md`
- `docs/external-chatbot-handoff.md`
- `docs/containerization-images-split.md`
- `docker/gpu-worker/entrypoint.sh`
- `docker/gpu-inference-worker/entrypoint.sh`
- `systemd/gpu-inference-worker.service`

Historical only:

- `CLOUD_FRONTEND_FLOW_README(Outdated).md`
- `docs/complete_ai_handoff(Outdated).md`
- `docs/gpu-ec2-from-scratch-setup(Outdated).md`

## Current Repo Gap

- The repo currently checks in `gpu-inference-worker.service`.
- Matching checked-in systemd units for `gpu-worker` and `live-gateway` were not present in this scan.

## Staging Live Gateway Hotfix Path (2026-10-06)

- `/api/live/chat/realtime` on the MC distribution goes to `voice-gpu-alb-815777974`
  (ap-northeast-2); the gateway is a plain copy under `/home/ubuntu/VoiceCloning/live-gateway`
  on `i-0f0da8be59367f7a8`, supervised only by systemd `voice-live-gateway` (pm2 copy removed
  2026-10-06; never re-add it, the two race for :3002). Not a git checkout.
- Update: compare md5 of LF-normalized repo files first, back up, write via SSM, `node --check`,
  `systemctl restart voice-live-gateway`. A restart drops open live sockets (MC reconnects).

## Zero-shot lab - 2026-10-22

- Seoul ap-northeast-2a: i-093e8b2081168aff3, g6e.2xlarge, one L40S, 8 vCPU, 64 GiB RAM, 350 GiB gp3. Dev/Staging unchanged.
- Public URL: https://7fffb005241e2a5673.gradio.live/ (since 2026-10-23 emotion-controls restart; earlier links obsolete). Emotion judge env: envs/judge (funasr emotion2vec+ large, faster-whisper). Login: repo-local .tmp/zero-shot/access.json; do not commit credentials. The old f9a287074a9fc61eb4 link is obsolete.
- Eight models generated valid audio: LongCat, dots.tts, VoxCPM2, Qwen3-TTS, FireRedTTS3, IndexTTS2.5, untrained GPT-SoVITS v2Pro and v5dev. Raon is blocked by a published vocabulary/checkpoint mismatch (5559 versus 5555 tokens); no speculative token remapping applied.
- Independent ffprobe/soundfile and CPU Whisper checks passed for the eight outputs. Ten input-validation tests passed. Authenticated public Qwen API returned 4.88 seconds of audio in 30.731 seconds; unauthenticated config access returned 401. Speaker similarity, browser microphone interaction and broad language coverage remain unverified.
- Remote root /opt/zero-shot-lab; systemd zero-shot-lab.service runs as ubuntu and starts on boot. Logs: logs/ui.log; evidence: smoke/verification-results.json and smoke/public-api.json. Each request loads one model and releases GPU memory on exit.
- 2026-10-23: Fish Audio Drama 3 (models/fishd3, FP8 experts on L40S SM89) and S2-Pro (models/fishs2) installed in envs/fish; both verified. Instance found running on 23 Oct.
- Scheduled shutdown: 2026-10-22 22:20 SGT (did not stop the instance). EC2 stop retains billable EBS. Temporary Gradio URL can change on service restart and lasts up to one week. Stop earlier using AWS EC2 stop-instances for this instance in ap-northeast-2.
