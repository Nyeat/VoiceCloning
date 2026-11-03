# Staging Environment — Complete Architecture Reference

As of 2026-08-25, faculty publishing stores a validated `voiceProfileId` with each deployed
lecture category, and staging GI reads that published binding from
`GET /api/chatbot/system-prompt?category=<lecture>`. The published value is authoritative; the
course object's legacy value and the build-time pin are fallbacks for unpublished/standalone
lectures only. A published `elevenlabs:<id>` uses standard synthesis without GPU capacity
preflight. A cloned profile is resolved by Lambda into an immutable GPT/SoVITS/reference snapshot,
then the coordinator routes by the exact GPT+SoVITS weight pair rather than display name or shared
`active.json`. The current `gi-bleeding` staging category publishes cloned profile
`deanvoice-v1`.

**Environment:** `staging` (the stable copy for users; development happens on `dev`)
**Region:** ap-northeast-2 (Seoul) · **Account:** 329599637774
**Last control-plane inventory:** 2026-11-03 · **Last public-path check:** 2026-08-25

**Access hardening (2026-11-03, read back live):** the Lambda Function URLs (dev and staging)
are `AuthType AWS_IAM`; only the listed CloudFront distributions may invoke them (statements
`cf-url-<dist>` + `cf-invoke-<dist>`), so a direct URL call returns 403. Every ALB listener rule
also requires header `X-VCS-Origin-Verify` (per-environment secret held in the CloudFront ALB
origin custom header and the Lambda env `ALB_ORIGIN_VERIFY_VALUE`); rule 49000 (`/*`) answers 403
to anything else, because this role cannot run `ModifyListener` to change the default action.
CloudFront Lambda/ALB origins use a 60 s read timeout and honest origin IDs
(`staging-lambda-url`, `staging-gpu-alb`). The Oct 2026 shutdown was lifted on 2026-11-03: the
coordinator is `autoscale` again, the fixed-GPU schedule is disabled, and capacity is set by hand.

> **Keep this file up to date.** Any change to staging infra (console, CLI, or script) must be reflected here in the same PR/commit. Every ID below was read from AWS on the date above — an AI session can diff this file against `aws describe-*` output to detect drift.
>
> Related docs: `docs/dev-environment-duplication-guide.md` (step-by-step from-scratch build recipe; note its "dev" naming means today's "staging"). The original deployment handoff (`staging-environment-handoff.md`) was deleted after launch — recoverable from git history if needed.

## 1. Big picture

```
Browser
  │
  ├─ https://d1qh0ebsvevhy3.cloudfront.net   (training UI)      CF EC2SYT1OKGW9Q
  ├─ https://dfzrfr93t2ruf.cloudfront.net    (live-fast UI)     CF E3DE2SRSU9JAEG
  ├─ https://d25sg72wp8oj5g.cloudfront.net   (chatbot UI, gi)   CF E3MLIO4CZFOPEO
  └─ https://d3k2rz0hqm8nxi.cloudfront.net   (chatbot UI, kiosk) CF E38A3666CJ7FVJ
        │ static assets        → S3 echolect-staging/dist-*
        │ /api/* (control)     → Lambda Function URL (start/stop GPU, model list, presign…)
        │ GPU paths (below)    → ALB voice-gpu-alb-staging → GPU instance ports 3001-3003
        ▼
   GPU instance i-0f0da8be59367f7a8 (g6.xlarge, STOPPED, PRIVATE subnet, no public IP)
        │ outbound internet via NAT nat-0dadc68ca781b8df9
        └─ S3 via gateway endpoint vpce-0386d983dfdff41dc
```

The fixed GPU and inference fleet are intentionally shut down as recorded above. The
historical baseline was one fixed GPU plus an ASG min/desired floor of 1; do not restore
that baseline without also restoring the fixed-controller schedule and coordinator
autoscale mode.

### Model-aware lecture capacity (current staging rule)

Each ready `g6.xlarge` worker advertises two synthesis slots and one resident model pair. For a
requested lecture voice, the coordinator applies this order:

1. Serialize the short fleet-admission decision with a scoped DynamoDB lease. Live per-request
   reservation rows bridge concurrent/stale worker probes and expire if a Lambda dies. Route to a
   reachable READY worker with the same immutable GPT+SoVITS pair and a real free slot, defined as
   `active + queued < maxSlots`. Among matches, pack onto the longest-lived worker first so newer
   overflow workers can become continuously idle.
2. If every matching slot is occupied, admit the request to the least-loaded matching waiting list,
   capped by `MODEL_MAX_QUEUED_PER_WORKER=2`, while preparing capacity. Reassign a different-model
   worker only when it has zero effective active/queued work and is not event-residency protected;
   otherwise atomically increase ASG desired capacity by one (up to max 192). A live per-model
   `PENDING` marker prevents one scale-out per queued caller. Requests beyond every queue ceiling
   receive retryable `MODEL_QUEUE_FULL` instead of being stacked onto one worker.
3. If no worker has the requested model, reassign a safely idle worker or start one GPU and return
   `MODEL_CAPACITY_STARTING`; the client retains the answer and retries its speech automatically.
   The new GPU claims the pending model and deep-warms it on boot. A boot with no pending claim falls
   back to `deanvoice-v1`.

Lecture/voice-selection preflight does not scale merely because one matching slot remains. With a
free slot it allows conversation and reports tight/background capacity where applicable. With a
resident voice but no free slot it begins reassignment or scale-out in the background and leaves
conversation usable. With no resident matching voice it reports WARMING/STARTING, blocks cloned
speech, and offers the up-to-15-minute/other-lecture message. Actual synthesis—not a page view—owns
the atomic slot/queue reservation. ElevenLabs stock voices bypass this coordinator entirely.

There is no minimum GPU per voice. The ASG has one global minimum GPU; scheduled actions preserve
that floor without pinning voice pools. Legacy Target Optimizer occupancy scale-out alarms are
telemetry-only. Scale-in uses coordinator inactivity and removes capacity after the configured
15-minute idle window. Its `NewestInstance` termination policy removes newer overflow capacity
first after active workers clear instance protection. The fixed staging GPU remains the training,
progress, and control instance; lecture synthesis routes only through the inference ASG. Controlled
scale-down passed, but an untouched full 15-minute timing canary remains pending.

### Faculty-selected lecture voice (implemented; multi-lecture verification pending)

`faculty.lkcmedicine.org` lists the signed-in lecturer's completed trained profiles plus approved
stock voices. Publishing writes the selected ID into the authenticated deployed category record;
the lecture client loads it with the prompt/documents. The publish handler validates authorization
and the selection instead of trusting a browser-only mapping. `LessonPage -> GiChatPanel ->
useGiChatEngine` gives that published binding precedence over the legacy course/build fallback.
The current site has only one real lecture/category, so cross-lecture ownership and two simultaneous
cloned profiles are not yet proven end to end in authenticated browsers.

Current resolution follows the latest saved profile for that ID at request/conversation start, then
uses the resulting immutable snapshot for in-flight work. If faculty require reproducible historical
lectures, add and persist an explicit profile revision; otherwise edits to the saved profile will
change future conversations while already-started conversations retain their snapshot. Profiles that
reference the same exact GPT+SoVITS weights intentionally share one resident GPU pool even if their
IDs, reference audio, or synthesis settings differ.

### Future per-model burst planning (not implemented)

The current one-GPU-at-a-time reactive path is suitable for gradual traffic but is not sufficient
by itself for a large cold burst because launch and deep warm take several minutes. Event operation
should pre-assign and deep-warm expected GPU capacity per model before learners enter, with a modest
warm-slot headroom. Reactive scaling should remain as overflow protection.

A later coordinator improvement should calculate a per-model slot deficit from confirmed active
conversations, admitted/queued synthesis, and short-lived conversation reservations rather than raw
lecture page views. It can then launch the required batch (`ceil(deficit / 2)` for the current
two-slot workers), subject to ASG/cost limits, cooldown, and scale-down hysteresis. Expiring
reservations prevent abandoned lecture clicks from holding capacity. This must be load-tested with
at least two real lectures and two trained profiles, both as an immediate burst and a ramp, before it
replaces scheduled event prewarming.

The end-to-end ownership chain is: faculty publishes lecture category -> authoritative deployed
category stores profile ID -> lectures API returns the binding -> lecture backend resolves the
saved profile into exact trained GPT/SoVITS weights -> coordinator routes or prepares that immutable
model pair. The coordinator should not duplicate lecture metadata or independently guess which voice
belongs to a lecture. Missing, deleted, incomplete, or unauthorized profile bindings must fail
clearly and must never silently fall back to a different lecturer's voice.

## 2. CloudFront distributions

| App | Domain | Distribution ID | Static origin (S3) |
|---|---|---|---|
| training | d1qh0ebsvevhy3.cloudfront.net | `EC2SYT1OKGW9Q` | `echolect-staging/dist-training` |
| live-fast | dfzrfr93t2ruf.cloudfront.net | `E3DE2SRSU9JAEG` | `echolect-staging/dist-live-fast` |
| chatbot | d25sg72wp8oj5g.cloudfront.net | `E3MLIO4CZFOPEO` | `echolect-staging/dist-gi` |
| chatbot-text | d3k2rz0hqm8nxi.cloudfront.net | `E38A3666CJ7FVJ` | `echolect-staging/dist-chatbot-text` |

⚠️ The `chatbot` distro's live S3 origin path is `/echolect-staging/dist-gi`, **not**
`dist-chatbot` — it was repointed when the staging kiosk was rebuilt in GI mode
(see below). The `dist-chatbot` prefix is still mounted as an orphaned origin that
no cache behavior targets; writing there deploys nothing.

`chatbot-text` (created 2026-07-31) is the second kiosk distribution: the same
staging Lambda/ALB/GPU backend, but serving the `chatbot` build mode — the
"Live Voice Chat" kiosk UI (engine toggle, Assistant-instructions sidebar,
Reference documents) with the typed-question composer from `c70bf7d`. It was
cloned from `E3MLIO4CZFOPEO`'s live config minus the gi lesson-video origin and
its `/videos/*` behavior. Deploy with
`scripts/deploy-client.ps1 -Env staging -Mode chatbot-text`; its client env
(`client/env/staging/chatbot-text.env`) leaves every origin URL blank so the
artifact is origin-agnostic and all `/api/*` traffic stays same-origin.

Each distro has three origin types: S3 (static, via OAC; bucket policy on the shared bucket includes all 3 distro ARNs), the staging Lambda Function URL (API/control paths), and the staging ALB (GPU paths). Full origin/behavior JSON snapshots: `docs/aws-snapshots/cf-*-staging.json` (note: snapshots are of the *original* distros used as templates — verify against live config before relying on them).

**Complete environment map (do not infer environment from a similar name):**

| Environment | GPU EC2 | Lambda | Training | TTS | GI bleeding chatbot | Dean chatbot (not video GI) | S3 application prefix |
|---|---|---|---|---|---|---|---|
| staging | `voice-gpu-staging` | `Liu_Teng_Yu_Intern2026-Voice_Cloning_Project-staging` | d1qh0ebsvevhy3.cloudfront.net | dfzrfr93t2ruf.cloudfront.net | d25sg72wp8oj5g.cloudfront.net | d3k2rz0hqm8nxi.cloudfront.net | `echolect-staging/` |
| dev | `VoiClo-GPU-Seoul` | `Liu_Teng_Yu_Intern2026-Voice_Cloning_Project` | d3dghqhnk7aoku.cloudfront.net | doovx82fh9tfs.cloudfront.net | d2o0cbe2zunqkr.cloudfront.net | none | `echolect/` |

These names are authoritative: `chatbot`/`chatbot-text` in deployment tooling mean
the video GI and non-video Dean builds respectively. Dev has no separate Dean
distribution. `d3fwx6qxeaxfmo.cloudfront.net` is a separate legacy GI-bleeding
chatbot and is not part of this dev/staging map.

**AWS ownership and runtime roles:** both rows are in account `329599637774` and
are operated by assuming
`arn:aws:iam::329599637774:role/Liu_Teng_Yu_Intern2026`. Both Lambdas use
`Liu_Teng_Yu_Intern2026-LambdaExecutionRole`; fixed GPU instances and staging ASG
instances use the `VoiClo_GPU` instance profile. The Auto Scaling service-linked
role and all ASG policies/actions belong to staging only. There is no dev `-dev`
Lambda, `echolect-dev/` prefix, or dev ASG.

On 2026-07-31, the staging chatbot was rebuilt in **GI mode** from
`codex/staging-multi-user-scaling` commit `fc99271` and deployed as
`assets/index-DJ5lJmLS.js`. Its fixed staging profile is
`deanvoice-v1`; it uses the staging Lambda/ALB/GPU stack. The lesson video is copied
to `echolect-staging/dist-chatbot/videos/gi-bleeding.mp4` because this distribution
does not have dev's separate `/videos/*` origin; GI deploy syncs preserve that path.
All three staging
distributions now use CloudFront Function `vcs-staging-spa-route-rewrite` on the
default static behavior instead of global 403/404-to-200 error mappings. Deep frontend
routes still serve `index.html`, while real `/api/*` errors retain their HTTP status
and JSON content type.

## 3. Load balancer

- **ALB:** `voice-gpu-alb-staging` — DNS `voice-gpu-alb-staging-1031778835.ap-northeast-2.elb.amazonaws.com`
  arn: `arn:aws:elasticloadbalancing:ap-northeast-2:329599637774:loadbalancer/app/voice-gpu-alb-staging/781c056e87784609`
- internet-facing, subnets `subnet-02484fe5c859c7d80` + `subnet-0692e838cd2e7c7c7` (public), SG `sg-0027def934fd4cb8d`
- **Listener:** HTTP :80 (`…listener/…/16873b8d49639f2e`). HTTPS not needed — CloudFront terminates TLS and talks HTTP to the ALB.

**Listener rules (priority order):**

| Prio | Path pattern(s) | Target group | Backend service |
|---|---|---|---|
Rules 1–4 and 50 also require `X-VCS-Origin-Verify` (see the access-hardening note at the top).

| Prio | Path pattern(s) | Target group | Backend service |
|---|---|---|---|
| 1 | `/api/live/chat/realtime` | vcs-staging-tg-3002 | live gateway (WebSocket) |
| 2 | `/inference/progress/*` | vcs-staging-tg-3003 | fixed progress relay; polls shared S3 events when another worker owns the session |
| 3 | `/models*`, `/ref-audio*`, `/inference*` | vcs-stg-opt-3103 | ASG inference fleet through Target Optimizer |
| 4 | `/api/live/session/*` | vcs-staging-tg-3002 | live gateway (sign-in records) |
| 50 | header only | vcs-staging-tg-3001 | gpu worker (training) |
| 49000 | `*` (no header) | — | fixed 403 `Forbidden` |
| default | unreachable | vcs-staging-tg-3001 | left as-is (ModifyListener denied) |

**Fixed-instance target groups** (HTTP, health check `GET /healthz`, interval 30 s,
healthy threshold 5):

| Name | Port | ARN suffix |
|---|---|---|
| vcs-staging-tg-3001 | 3001 | `targetgroup/vcs-staging-tg-3001/782635b79a09031d` |
| vcs-staging-tg-3002 | 3002 | `targetgroup/vcs-staging-tg-3002/77d07064082cbead` |
| vcs-staging-tg-3003 | 3003 | `targetgroup/vcs-staging-tg-3003/3449adfcba215f65` |

`vcs-stg-opt-3103` is the separate ASG inference target group. Its data/control
proxy listens on 3103/3004 and forwards to the local inference worker on 3003.

The fixed 3003 worker intentionally does not warm its Python inference server, so
its inference-readiness `/healthz` returns 503. Rule 2 still returns a working SSE
stream because that route does not synthesize: it polls shared S3 session events.
With the fixed target marked unhealthy, ALB routes to it only through fail-open when
all targets in that group are unhealthy. This does not redirect synthesis away from
the ASG or affect Target Optimizer scaling, but it is operationally brittle: health
reporting is misleading and loss of the fixed relay can interrupt browser progress
while synthesis continues. Replace this target group's readiness check with a
relay-liveness endpoint; do not warm fixed inference merely to make the check green.

⚠️ After a **new instance** is launched (e.g. from a fresh AMI), it must be re-registered in all three TGs — registration is per-instance-ID, and stop/start of the *same* instance keeps it registered.

## 4. GPU instance

| Property | Value |
|---|---|
| Instance ID | `i-0f0da8be59367f7a8` (Name `voice-gpu-staging`, tag `Environment=staging`) |
| Type / AMI | g6.xlarge / `ami-06338e47a2f1bae6a` (snapshot of the dev box, 2026-07-06) |
| Subnet | `subnet-0c1937ef298f54500` (private, 10.0.32.0/20, AZ apne2a) — **no public IP** |
| Private IP | 10.0.37.234 (changes if a new instance is launched; irrelevant to TGs which track the ID) |
| Key pair | `VoiClo-Gpu-Seoul` (SSH unused — access is SSM only) |
| IAM instance profile | `VoiClo_GPU` (S3 access, SSM) |
| Security group | `sg-03a2f3dddf4eff21c` (`vcs-staging-gpu-sg`) |
| First-boot config | user-data = `docs/aws-snapshots/staging-userdata.sh`; log `/var/log/staging-bootstrap.log`; marker `/home/ubuntu/STAGING_BOOTSTRAP_DONE` |

**Services on the box** (systemd, code at `/home/ubuntu/VoiceCloning`, branch
`codex/staging-multi-user-scaling` at commit `c70bf7d` on disk at the 2026-08-03
read-back):

| Port | systemd unit | Role | Env file |
|---|---|---|---|
| 3001 | `gpu-worker` | training/cloning worker | `gpu-worker/.env` (`S3_PREFIX=echolect-staging/`, staging CORS) |
| 3002 | `voice-live-gateway` | realtime live-chat gateway (OpenAI realtime API) | `live-gateway/.env` (holds `OPENAI_API_KEY`, `PORT=3002`, `OPENAI_REALTIME_MODEL=gpt-realtime`, `OPENAI_REALTIME_VAD=semantic_vad`, staging CORS) |
| 3003 | `gpu-inference-worker` | TTS inference worker | `gpu-inference-worker/.env` (same S3/CORS changes) |
| 3103 / 3004 | `target-optimizer-inference` | ALB Target Optimizer data/control proxy to 3003 | reads inference `.env`; advertises `SYNTHESIS_MAX_CONCURRENCY=2` |

All three expose `GET /healthz` for the ALB health checks. Direct-to-worker endpoints return 403 to plain curl (origin/internal-auth checks) — same behavior as dev; not a bug.

**2026-08-03 fleet audit:** before the next idle removal, 55/55 ASG instances were
InService and passed the repository's strict public-prime marker; 55/55 local
inference workers returned 200 on port 3003, both worker/optimizer services were
active, and every GPU had a Python inference process. Live scaling history showed
50->60 from the 70% occupancy alarm and conservative idle steps down through 54,
with the event floor preventing a drop below 50 before the scheduled reset.

Speaker similarity is currently unavailable on the staging fixed host and on ASG
AMI `ami-021aeb72894b8c79b`: `resemblyzer` is absent from the GPT-SoVITS Conda
environment. This is **not a verified latency optimization**. Repository commit
`cd79b03` added the similarity gate, and project history treats a missing dependency
as a bug; dev later installed `resemblyzer 0.1.4`. Staging therefore continues with
ASR/audio-quality validation but without reference-speaker similarity scoring, which
can admit a take with weaker voice identity. Fix it in a canary AMI/launch-template
version and measure latency before rollout; do not patch ephemeral ASG nodes by hand.

A separate, intentional latency optimization does exist: client commit `6cd6de0`
marks the first Live Fast/chatbot reply clip `skip_verify=true`, and backend commit
`4e37c58` disables the entire live verification callback for that clip. It therefore
skips ASR, phoneme, and speaker checks only for the first clip that gates
time-to-first-audio. Later reply clips remain verified when their dependencies are
available, and Live Full/Queue is unaffected. Launch-template v19 removed
`skip_verify` from public-prime readiness requests only; it did not remove the live
browser behavior or the `resemblyzer` dependency requirement.

## 5. Networking

**VPC:** `vpc-0b81d044238fcee4d` (10.0.0.0/16) — **shared with dev**; isolation between environments is by security group, not by VPC.

**Staging private subnet** `subnet-0c1937ef298f54500` → route table `rtb-068aad306c3adcbe0`:

| Destination | Target |
|---|---|
| 10.0.0.0/16 | local |
| 0.0.0.0/0 | `nat-0dadc68ca781b8df9` (NAT gw in public subnet `subnet-0692e838cd2e7c7c7`, EIP 43.200.210.184 / eipalloc-0e3b4e564f9b5acca) |
| S3 prefix list `pl-78a54011` | S3 gateway endpoint `vpce-0386d983dfdff41dc` |

(A second, unassociated route table `rtb-00bf8ce2b545ffc4e` exists from the NAT-outage workaround — harmless; can be deleted.)

⚠️ **History:** the original NAT was deleted by an unknown actor on 2026-07-06→07 (routes went blackhole, box lost internet). If staging suddenly can't reach the internet, check this route table first. The role cannot edit routes (`ec2:ReplaceRoute` denied) — that's an admin fix.

**Security groups:**

| SG | Name | Ingress | Egress |
|---|---|---|---|
| `sg-03a2f3dddf4eff21c` | vcs-staging-gpu-sg (instance) | tcp 3001-3003 **from sg-0027def934fd4cb8d only** | all |
| `sg-0027def934fd4cb8d` | VoiClo-Gpu-Seoul-ALB-SG (shared by dev+staging ALBs) | 80, 443 from 0.0.0.0/0 | tcp 3001, 3002, 3003 → `sg-0806b2491f69f242e` (dev GPU SG) **and** → `sg-03a2f3dddf4eff21c` (staging GPU SG) |

⚠️ **Hard-won lesson:** the ALB SG's *egress* must include the staging GPU SG. On first launch only the dev-GPU egress existed and all health checks failed with `Target.Timeout`. If health checks time out, check ALB SG egress before suspecting the services.

## 6. Lambda (control plane)

| Property | Value |
|---|---|
| Function | `Liu_Teng_Yu_Intern2026-Voice_Cloning_Project-staging` |
| Runtime / size / timeout | nodejs24.x / 128 MB / 120 s, handler `index.handler` |
| Exec role | `Liu_Teng_Yu_Intern2026-LambdaExecutionRole` (shared with dev Lambda — scoped staging role is an open admin ask) |
| Function URL | `https://7xx6w7q5jwzda6nlltlyfckfzm0vyfmy.lambda-url.ap-northeast-2.on.aws/` — AuthType **AWS_IAM** since 2026-11-03; each staging distribution needs both `cf-url-<dist>` (InvokeFunctionUrl) and `cf-invoke-<dist>` (InvokeFunction). A new distribution 403s until both are added. POST/PUT bodies must carry `x-amz-content-sha256`. |

**Environment variables** (secrets redacted; change with get-function-configuration → edit one key → update-function-configuration, never rebuild the map by hand):

| Key | Value |
|---|---|
| GPU_INSTANCE_ID | `i-0f0da8be59367f7a8` ← must track the current staging instance |
| GPU_INSTANCE_REGION | ap-northeast-2 |
| GPU_IDLE_STOP_MINUTES | 0 (manual capacity mode; the fixed GPU hosts the gateway) |
| GPU_SCHEDULE_ENABLED | false |
| GPU_INFERENCE_ASG_NAME | unset; exact fixed-instance state coupling is pending Lambda-role Auto Scaling permissions |
| INFERENCE_CAPACITY_RETRY_MS | 20000 (with the 55 s worker deadline, stays inside the 60 s CloudFront timeout) |
| ALB_ORIGIN_VERIFY_VALUE | *(secret; must equal the staging CloudFront ALB origin header)* |
| GPU_WORKER_URL, INFERENCE_WORKER_URL | `http://voice-gpu-alb-staging-1031778835.ap-northeast-2.elb.amazonaws.com` |
| GPU_WORKER_PUBLIC_URL | `https://dfzrfr93t2ruf.cloudfront.net` |
| CORS_ORIGIN | all 7 staging origins; identical list in the gateway env |
| LIVE_AUTH_EXEMPT_ORIGINS | Live Fast/TTS + Live MC only (staff tools; Origin is spoofable, so treat as public metered surfaces) |
| S3_BUCKET / S3_PREFIX / S3_REGION | `interns2026-small-projects-bucket-shared` / `echolect-staging/` / ap-southeast-1 |
| ARTIFACT_SOURCE / MODEL_SOURCE | s3 / s3 |
| LIVE_DEMO_LOCKOUT | **true on the 2026-07-28 public `/api/config` check** (the 2026-07-07 control-plane snapshot recorded false) |
| VOICE_PROFILE_INTERNAL_AUTH_HEADER_NAME / _VALUE | `x-internal-key` / *(redacted — read from the Lambda env)* |

## 7. S3 layout

Bucket `interns2026-small-projects-bucket-shared` (**ap-southeast-1**, not Seoul), prefix `echolect-staging/`:
`dist-training/`, `dist-live-fast/`, `dist-gi/`, `dist-chatbot-text/` (frontend bundles served today) · `dist-chatbot/` (orphaned — no behavior points at it) · `models/` (incl. `models/user-models/gpt|sovits/`) · ref audio, artifacts — mirrors `echolect/` (dev). Bucket policy grants the 4 staging CF distro ARNs read via OAC.

The bucket is **shared with other interns' projects** and its policy is a single
`AllowCloudFrontServicePrincipal` statement with an explicit `AWS:SourceArn`
allowlist (14 distribution ARNs as of 2026-07-31). A new distribution serves 403
on every object until its ARN is appended — edit that list additively, never
rebuild it, or you take down other projects' distributions.

## 8. Git branches ↔ environments

| Branch | Deploys to | Notes |
|---|---|---|
| `separate-containers-new` | dev (all three clients, Lambda, and fixed GPU) | Dev deployment pointer |
| `codex/staging-multi-user-scaling` | staging clients, Lambda, fixed worker and inference fleet | Staging deployment pointer |
| `chatbot-live-full` | none | legacy branch; its dev chatbot work is merged into `separate-containers-new` |

Both active environment branches point to the same unified application commit after promotion.
Environment files and AWS resources create the differences: Dev stays fixed-instance/on-demand with
no ASG/coordinator variables; staging enables the model coordinator, inference ASG, two-slot
admission, reassignment, and scale-out. Never merge code by deploying the other environment's branch
in place; first unify and test one commit, fast-forward both pointers, then deploy with `-Env dev` or
`-Env staging`.

Dev parity rollout (2026-08-03): `separate-containers-new` and the fixed
`VoiClo-GPU-Seoul` host application source are at `070a99a`. The three dev distributions now
match their staging templates after substituting the dev Lambda, ALB, and
`echolect/` origins. Dev Lambda is 512 MB with schedule mode false and no ASG
name. Dev has no ASG or scheduled capacity actions; the five-minute
`VoiClo-gpu-idle-stop` rule performs idle checks, while user activity starts
the fixed instance. `WARM_ON_BOOT=true` keeps inference ALB-ready after service
restarts. GitHub `separate-containers-new` was verified synchronized through
operations/docs commit `8b963eb`; AWS dev application source remains `070a99a`.

### Dev identified learner analytics deployment (2026-08-07)

`vcs-dev-transcripts` now exists in `ap-northeast-2` with `PK`/`SK`, on-demand
billing, GSI `GSI1` (`GSI1PK`/`GSI1SK`), deletion protection, project/environment/data
classification tags, TTL on `ttl`, and point-in-time recovery. PITR was enabled and
read back from the successful `UpdateContinuousBackups` response on 2026-08-07.

The dev-first implementation at `4c8911a` is deployed to dev only. The non-staging
Lambda has authentication and `LEARNER_TABLE_NAME=vcs-dev-transcripts`; the fixed dev
gateway is running the same commit with transcript storage/authentication enabled; and
the GI client bundle `assets/index-BIiMcuh6.js` is live on distribution `EYZ4NLNGITY7T`.
That distribution routes `/api/live/session/*` to the existing dev ALB before the
general `/api/*` Lambda behavior. No staging resource was changed.

- `VoiClo_GPU` performed a controlled `PutItem` through SSM using the instance profile;
  the probe row had a ten-minute TTL.
- The operator successfully enabled PITR.
- IAM policy inspection remains denied, so Lambda table access has not been independently
  proven without a real signed-in analytics request.

Public checks pass for the login page/90-day notice, gateway readiness, completed
CloudFront deployment, `/api/learner/me` and supervisor anonymous 401s, and the gateway
sign-in route's missing-token 401. Remaining verification requires a real NTU sign-in:
identified S3 analytics subject, DynamoDB profile/evidence/summary rows, personalized
prompt retrieval, and supervisor-role rejection/acceptance. Do not promote to staging.

On 2026-08-09, the two existing developer identities were added to the dev Lambda's
`SUPERVISOR_OIDS` allowlist. This grants `/supervisor` access by immutable verified Entra
object ID without requiring a staff email or changing learner-table records. The normal
`Supervisor` app-role path remains supported, and staging remains unchanged. Do not record
the object IDs in source control or project memory.

Repeated-question evidence was added and deployed to dev on 2026-08-07. The client compares
content-token overlap for up to ten minutes, ignores matches within eight seconds, and emits
at most two repeat signals per question cluster. A deterministic curated classifier may
assign both questions to the same concept across different video timestamps only at
confidence 0.75 or higher; ambiguous or tied matches cannot override time. Otherwise Lambda
requires both timestamps to map to the same authored concept. Similarity must be at least
0.65 and accepted evidence weighs 1. The analytics/S3 batch contains concept,
similarity, and timing metadata but no question text; the existing DynamoDB transcript row
still contains the chat text. The non-staging Lambda update and CloudFront invalidation
completed successfully. The dev `/supervisor`
learner detail keeps Summary as the default tab and adds a secondary Learning signals tab.
Lessons are collapsible; the tab ranks qualifying concepts with proportional score bars,
status, total evidence-event count, contributing signal types, and updated time. DynamoDB
currently stores a total evidence count and a set of signal types, not counts by signal type,
so the UI deliberately does not claim per-signal frequencies. Live dev bundle is
`assets/index-CplLB5_6.js`.

GI voice selection is environment-separated but behaviorally identical. Both clients become ready
from configured ID `deanvoice-v1` without a startup profile GET and include that ID in every synthesis
request. Each environment's synthesis backend resolves its own saved profile under `echolect/` or
`echolect-staging/`; neither client reads or changes shared `active.json`. Dev serves
`assets/index-CplLB5_6.js`; staging serves `assets/index-Cklj8mCD.js`. The staging change did not alter
its ASG, gateway, TTS, or training stacks.

Dev voice authentication is intentionally frontend-scoped. GI's Lambda origin injects
`X-Demo-Request: true`; with `LIVE_AUTH_DEMO_ONLY=true`, `/api/live/*` requires a Microsoft
token only for those tagged GI requests. The normal dev TTS, Training, and Dean distributions
remain unsigned/public. Analytics, learner, and supervisor handlers retain their own mandatory
auth guards and do not use this exception. The GI Axios client must attach the same ID token as
the WebSocket; omitting it caused the 2026-08-07 signed-in voice 401.

Deploy tooling: `scripts/deploy-client.ps1 -Env staging|dev -Mode training|live-fast|chatbot`, `deploy-lambda.ps1`, `deploy-worker.ps1`, driven by `scripts/deploy.config.json` (holds instance IDs, distro IDs, S3 targets; both workers use **SSM**). Client env vars per environment: `client/env/{staging,dev}/*.env`.

### Staging worker deployment guard

`deploy-worker.ps1` and `deploy.config.json` now use
`codex/staging-multi-user-scaling`. Before running it, verify that both active remote branches point
to the intended unified commit and inspect the remote worker's dirty tree. Preserve tracked
deployment-time edits in a named stash and handle only untracked files that collide with the
fast-forward; do not force-reset the worker.

Two more things that cost an hour if you meet them cold:

- **SSM `AWS-RunShellScript` runs as root**, and git rejects `/home/ubuntu/VoiceCloning` for
  *dubious ownership* because the tree belongs to `ubuntu`. `git branch --show-current` then
  fails in a way that reads exactly like "this is not a git repo". It is one. Prefix every
  git call with `sudo -u ubuntu`.
- **The repo is shared by the gateway and both GPU workers.** A pull moves worker code on
  disk even when only `voice-live-gateway` is restarted; it activates at their next restart
  or reboot. Check `git status --porcelain` first — `gpu-inference-worker/src/index.js`
  carries an uncommitted local edit that must survive.
- **The script reports success even when the remote command failed.** It prints "Deployed
  workers to staging" unconditionally after `aws ssm wait`, with no check of the invocation's
  exit code. Read the invocation output, never the script's last line.

### ⚠️ Root-owned files, the delayed cost of one root-run deploy

Because SSM runs as root, a deploy whose `npm`/`git` steps were *not* prefixed with
`sudo -iu ubuntu` leaves files on disk owned by `root`. This happened at least once before
2026-08-06 and left **14,802** root-owned paths: all three `node_modules` trees, plus ~31
tracked source files (`live-gateway/src/routes/liveChat.js`, `lambda/router.js`,
`gpu-inference-worker/src/index.js`, `scripts/`, `docs/`, `systemd/`).

It stays hidden for months, because the two things you normally do still work:

- **`git pull` succeeds even on root-owned tracked files.** Git replaces a file by writing a
  new one into the directory, so it needs write permission on the *parent directory* — which
  is still `ubuntu`. Only an **in-place** edit of those paths fails.
- **`npm ci --dry-run` reports "up to date".** It resolves the tree without writing, so it
  cannot see the permission problem. Only a real `npm ci` fails, with `EACCES` on something
  like `node_modules/.bin/mime`.

So the bill arrives at the next deploy that changes a dependency — the one deploy where you
least want a surprise. Detect and fix:

```bash
R=/home/ubuntu/VoiceCloning
sudo find $R -user root -not -path '*/.git/*' | wc -l        # expect 0
sudo find $R -user root -not -path '*/.git/*' -not -path '*/node_modules/*'   # tracked files
for d in gpu-worker gpu-inference-worker live-gateway; do
  sudo chown -R ubuntu:ubuntu $R/$d/node_modules
done
sudo -iu ubuntu npm --prefix $R/live-gateway ci --omit=dev   # a REAL ci is the only proof
```

Fixed 2026-08-06 for `node_modules` (14,802 → 31, verified by a real `npm ci` on all three
packages). The ~31 tracked source files are **still root-owned** — harmless until something
edits one in place.

### Gateway deploy and rollback (staging)

systemd loads `live-gateway/.env` — **not** the `.env.livegateway.deployment.staging` file
sitting beside it. `.env` holds `OPENAI_API_KEY`, so edit it surgically; overwriting it takes
the chat down. New dependencies need `npm install` on the box or the service will not start.

```bash
# deploy (via aws ssm send-command, or a start-session shell)
R=/home/ubuntu/VoiceCloning; F=$R/live-gateway/.env
sudo -u ubuntu cp $F $F.bak-$(date +%Y%m%d)          # ALWAYS, before anything
sudo -u ubuntu git -C $R rev-parse HEAD               # write this down — rollback point
sudo -u ubuntu git -C $R fetch origin
sudo -u ubuntu git -C $R merge --ff-only origin/codex/staging-multi-user-scaling
cd $R/live-gateway && sudo -u ubuntu npm install
# edit only the keys you own, never rewrite the file:
sudo -u ubuntu sed -i '/^LIVE_AUTH_ENABLED=/d;/^ENTRA_/d;/^TRANSCRIPT_/d' $F
echo 'LIVE_AUTH_ENABLED=false' | sudo -u ubuntu tee -a $F > /dev/null
sudo systemctl restart voice-live-gateway
curl -s localhost:3002/readyz     # expect {"ok":true,...,"problems":[]}
```

```bash
# rollback — restores code AND env; <SHA> is the rev-parse above
sudo -u ubuntu git -C /home/ubuntu/VoiceCloning reset --hard <SHA>
sudo -u ubuntu cp /home/ubuntu/VoiceCloning/live-gateway/.env.bak-<DATE> \
                  /home/ubuntu/VoiceCloning/live-gateway/.env
cd /home/ubuntu/VoiceCloning/live-gateway && sudo -u ubuntu npm install
sudo systemctl restart voice-live-gateway
```

`npm install` on the way back too: a rollback past a dependency change leaves `node_modules`
holding packages the old `package.json` never declared, which is survivable, but a rollback
past a dependency *addition* without it leaves the tree fine and the lockfile lying.

**2026-08-05 deploy:** `c70bf7d` → `755562a`, backup `.env.bak-20260805`. Rollback SHA is
therefore `c70bf7d`. Shipped the auth + transcript gateway with `LIVE_AUTH_ENABLED=false`
and an empty `TRANSCRIPT_TABLE_NAME` — deliberately inert, see below.

**2026-08-06 deploy:** `dbfd763` → `550f9a2` (fast-forward; rollback SHA `dbfd763`). No env
change. Shipped time-ordered session ids, the `signInDay` attribute and the
`signins-by-day` GSI. Note the on-box HEAD was `dbfd763`, not the `755562a` recorded above —
confirm `rev-parse HEAD` on the box rather than assuming this ledger is the last word.
Verified after restart: a sign-in wrote `SIGNIN#2026-08-06T08:17:12.780Z` with
`signInDay 2026-08-06`, the next socket wrote `SESSION#2026-08-06T08:17:30.839Z#878516d1#META`
in the new format, and `npm run report -- --day 2026-08-06` resolved it through the index.

### Switching transcript storage on

Both `LIVE_AUTH_ENABLED=true` and `TRANSCRIPT_TABLE_NAME` are needed, and **either one alone
records nothing**: with no authentication there is no identity to attribute a row to, and
with no table name the store is never built. `/readyz` reports the half-configured case
rather than failing silently.

> The first draft of this section said the 2026-08-05 deploy shipped inert. It did, but the
> box was switched on later the same day, so by the time anyone read this it was wrong.
> Check the running config before trusting it:
> `sudo -u ubuntu grep -E '^(LIVE_AUTH_ENABLED|ENTRA_|TRANSCRIPT_)' /home/ubuntu/VoiceCloning/live-gateway/.env`

### ⚠️ A new `/api/live/*` route needs **two** routing changes, not zero

Both layers match the live-gateway paths **exactly**, so a new route silently lands somewhere
else and looks like a code bug. Adding `POST /api/live/session/signin` needed:

1. **CloudFront** — a cache behavior for the new path, ordered *before* `/api/*`. Without it
   the request goes to the Lambda, which answers
   `{"error":"No Lambda route for POST /api/live/session/signin"}`.
2. **The ALB** — a listener rule for the new path forwarding to the gateway target group.
   Without it the request falls to the *default* rule, which is the training worker, and
   Express answers `Cannot POST /api/live/session/signin`.

Those two error bodies are the fastest way to tell which layer is missing. A third symptom,
`{"ok":false,"code":"auth_disabled"}`, means routing is correct and you reached a gateway
with `LIVE_AUTH_ENABLED=false`.

### ⚠️ CloudFront OAC silently destroys a bearer token

The Lambda origin on `E3MLIO4CZFOPEO` carried OAC `EEPE53W4BCAQ8`
(`lambda-cloudfront-OAC_V3`) with **`SigningBehavior: always`**. CloudFront then signs every
request to that origin with SigV4 and **replaces the viewer's `Authorization` header** with
its own signature. The client's `Bearer <id token>` never survives the hop.

The symptom is maximally misleading: `readBearerToken()` sees `AWS4-HMAC-SHA256…`, does not
match `/^Bearer\s+/`, and returns `''`, so the Lambda answers its generic
`401 Sign in to use the voice assistant.` — a *sign-in* error caused by a *CDN* setting.
Meanwhile the live gateway authenticates the same token perfectly, because the ALB origin has
no OAC. "Chat works but voice fails" is the signature of this bug.

Fixed by attaching a separate OAC, `E2FQU7VYHBAXBC` (`vcs-lambda-oac-no-override`,
`SigningBehavior: no-override`), to that origin only. `no-override` signs only when the viewer
sent no `Authorization`, so unauthenticated calls behave exactly as before and bearer tokens
pass through. The original OAC is shared — its name suggests other projects use it — so it was
left untouched rather than edited in place.

Note the function URL is `AuthType: NONE`, so the signing was never load-bearing.

**This is per-distribution, and faculty hit it a second time (2026-08-21).** The OAC lives on
the origin, not the function, so fixing lectures did nothing for `E38A3666CJ7FVJ` — it still
carried `EEPE53W4BCAQ8` and produced the identical "chat works, voice fails" report after the
faculty SSO rollout. Swapped to `E2FQU7VYHBAXBC`; the two distributions' Lambda origins now
match. **Any distribution that serves an authenticated build needs this OAC.** As of
2026-08-21 the remaining five (`EC2SYT1OKGW9Q`, `E3DE2SRSU9JAEG`, `E2KTGN0G56FW71`,
`E36CNBL620DMGM`, `EYZ4NLNGITY7T`) still carry the always-signing OAC — harmless only while
their builds send no token, and a latent 401 the moment one does:

```bash
for D in EC2SYT1OKGW9Q E3DE2SRSU9JAEG E3MLIO4CZFOPEO E38A3666CJ7FVJ; do
  printf '%-16s ' "$D"
  aws cloudfront get-distribution-config --id $D     --query "join(' ', DistributionConfig.Origins.Items[?contains(DomainName,'lambda-url')].OriginAccessControlId)" --output text
done
```

**Verifying the fix without a real token** (the timing recipe above is unreliable now —
`JWKS_REFETCH_COOLDOWN_MS` suppresses the refetch on a warm container). Fire ~20 *concurrent*
requests so some land on cold environments, once with a syntactically valid `Bearer` JWT and
once with no `Authorization` at all, and compare the tail. A surviving header pays for a JWKS
fetch on each cold container; a stripped one throws `missing` before any network work. After
the fix, faculty measured p90 0.266 s / max 0.330 s with a token versus p90 0.144 s /
max 0.172 s without — and matched lectures (p90 0.266 s / max 0.333 s).

**Verifying without a real token:** send a syntactically valid JWT with an invented `kid`. If
the header survives, `resolveKey` refetches JWKS and the first call takes ~0.5-0.6 s; a
stripped header fails at `malformed` before any network work, in ~0.25 s.

**Read origin *domains*, not origin IDs.** On `E3MLIO4CZFOPEO` the origin whose Id is
`voice-gpu-alb-815777974…` has DomainName `voice-gpu-alb-staging-1031778835…` — the Id is a
stale label kept across a repoint. Reading the Id leads to the confident, wrong conclusion
that the staging distributions are served by the dev ALB:

```bash
aws cloudfront get-distribution-config --id E3MLIO4CZFOPEO \
  --query 'DistributionConfig.Origins.Items[].{id:Id,domain:DomainName}'
```

```bash
R=/home/ubuntu/VoiceCloning; F=$R/live-gateway/.env
sudo -u ubuntu cp $F $F.bak-$(date +%Y%m%d)
sudo -u ubuntu sed -i '/^LIVE_AUTH_ENABLED=/d;/^TRANSCRIPT_/d' $F
sudo -u ubuntu tee -a $F > /dev/null <<'ENV'
LIVE_AUTH_ENABLED=true
TRANSCRIPT_TABLE_NAME=vcs-staging-transcripts
TRANSCRIPT_TABLE_REGION=ap-northeast-2
TRANSCRIPT_TTL_DAYS=90
TRANSCRIPT_STORE_SYNTHETIC=false
TRANSCRIPT_STORE_ASSISTANT=false
ENV
# ENTRA_* must already be present — check before restarting, they are not added here:
sudo -u ubuntu grep -c '^ENTRA_' $F      # expect 3
sudo systemctl restart voice-live-gateway
curl -s localhost:3002/readyz            # expect {"ok":true,...,"problems":[]}
```

Read the ⚠️ below first — this is the flip that closes the chatbot-text kiosk's sockets.

**The first thing that will fail is the IAM grant.** Whether `VoiClo_GPU` carries
`dynamodb:PutItem` on that table is still unverified and unreadable from the intern role
(`iam:*` denied). The symptom is `[transcript] write failed` in `journalctl -u
voice-live-gateway` while conversations keep working normally — by design, storage never
takes down a lesson. Check the log after the first sign-in rather than assuming success.

### Faculty SSO rollout (2026-08-18 — deployed, one human gate outstanding)

The faculty `chatbot-text` site now requires Microsoft sign-in with the narrower
`staff.main.ntu.edu.sg,assoc.main.ntu.edu.sg` allowlist. Lectures is unchanged and still
admits its student-inclusive allowlist. **The one gate that has not been exercised is a real
staff/associate sign-in** — do not describe faculty SSO as proven until that passes and
lecturer rows are seen in the table.

Faculty data is isolated from the main student transcript table. The gateway selects the
store from `X-VCS-Site: faculty`, stamped by CloudFront as a custom origin header on both of
the faculty distribution's dynamic origins. Never use a viewer-supplied email, request body,
or `Origin` header to select the table. Lectures sends no marker and keeps
`TRANSCRIPT_TABLE_NAME`.

#### What was provisioned

`vcs-staging-lecturers` exists in `ap-northeast-2`: `PK`/`SK` string keys, on-demand billing,
GSI `signins-by-day` (`signInDay`/`signedInAt`, `INCLUDE` projection of `email` and
`displayName`), TTL on `ttl`, and PITR enabled. It mirrors `vcs-staging-transcripts`.

Two things the earlier handoff assumed needed an administrator turned out not to:

- **`dynamodb:CreateTable` is tag-gated, not absent.** The intern role can create a table
  only when the request carries `CreatorId=INTERNS2026`; the 2026-08-17 denial was a missing
  tag, not a missing action. `vcs-staging-transcripts` carries the same tag. Tag every new
  table this way or creation fails with a bare AccessDenied that reads like no permission.
- **The gateway's write grant did not need an IAM change.** `iam:*` is denied to the intern
  role, but `dynamodb:PutResourcePolicy` is allowed, so the grant lives in a resource-based
  policy on the table itself: `PutItem` for `role/VoiClo_GPU`, plus resource-policy
  management for `role/Nathanael_Ng_Intern2026` — DynamoDB rejects any resource policy that
  would lock the caller out of editing it. This is narrower than an IAM change (one
  principal, one action, one table) and is visible next to the table.

Verify a write grant from the instance, never from a laptop — the grant is on the instance
role. `ConditionalCheckFailedException` means allowed and writes nothing;
`AccessDeniedException` means blocked:

    aws dynamodb put-item --region ap-northeast-2 --table-name vcs-staging-lecturers       --item '{"PK":{"S":"USER#zzPermProbe"},"SK":{"S":"PROFILE"}}'       --condition-expression 'attribute_exists(zzNeverPresent)'

#### The routing gap the original plan missed

The faculty distribution had **no `/api/live/session/*` cache behavior**, so the client's
sign-in POST fell through to the `/api/*` Lambda origin and returned
`No Lambda route for POST /api/live/session/signin`. Sign-in rows could never have been
written, and the header work alone would not have revealed it. The behavior was copied
verbatim from the lectures distribution (same ALB origin id, cache policy
`4135ea2d-6df8-44a3-9df3-4b5a84be39ad`, origin request policy
`216adef6-5c7f-47e4-b989-5492eafa07d3`) and inserted **before** the `/api/*` catch-all, since
CloudFront matches behaviors in order. When adding a distribution, diff its behaviors against
lectures rather than assuming the origins are enough.

#### Deployed state

1. Faculty distribution `E38A3666CJ7FVJ`: `X-VCS-Site: faculty` on the Lambda and ALB origins
   (the S3 origin is deliberately untouched, and the Lambda origin keeps `X-Demo-Request`),
   plus the `/api/live/session/*` behavior above.
2. Gateway on `i-0f0da8be59367f7a8` pulled to `a43d671` and restarted
   (`voice-live-gateway` only). `.env` gained `FACULTY_ENTRA_ALLOWED_EMAIL_DOMAINS`,
   `LECTURER_TABLE_NAME=vcs-staging-lecturers`, the two faculty CORS origins, and an emptied
   `LIVE_AUTH_EXEMPT_ORIGINS`; `/readyz` is 200 with `problems: []`. Backup: `.env.bak.presso`.
   systemd reads `live-gateway/.env`, not the `.env.livegateway.deployment.staging` beside it.
3. Staging Lambda redeployed. The merge added `FACULTY_ENTRA_ALLOWED_EMAIL_DOMAINS` and
   emptied `LIVE_AUTH_EXEMPT_ORIGINS` and changed nothing else; `LIVE_DEMO_LOCKOUT` and the
   two `VOICE_PROFILE_INTERNAL_*` keys survived, confirming the merge preserves live-only keys.
4. `chatbot-text` rebuilt and deployed (`assets/index-zgw-uRR3.js`) with `/*` invalidated. The
   served bundle contains the client id, the `/common` authority and the staff/assoc domains,
   and **no** `student.main.ntu.edu.sg`.

Note that pulling the gateway box also moved `gpu-inference-worker` source on disk (the repo
is shared). That code is not running yet and lands only at its next restart.

#### Verified

Gateway 180/180, Lambda 139/139, client 355/355. Live: faculty and lectures both serve 200;
`POST /api/live/session/signin` is 401 `missing` on both; an unauthenticated WebSocket is
refused identically on both; the lectures bundle hash is unchanged; `vcs-staging-lecturers`
is ACTIVE with its GSI ACTIVE and 0 items.

#### Still to verify (needs a human with a real account)

A staff/associate account signs in and can use text and cloned voice; a student-domain account
is rejected; faculty `PROFILE`, `SIGNIN`, session and turn rows appear **only** in
`vcs-staging-lecturers`; and a lectures login still writes **only** to
`vcs-staging-transcripts`. Until a real sign-in happens, the `X-VCS-Site` store selection is
verified only by unit tests, and a sign-in write failure is invisible in the browser —
`recordSignIn` is fire-and-forget and the response reports `recorded: true` regardless, so
confirm in the table, not in the response.

Rollback: restore `.env.bak.presso` and `git checkout e6dd61de` on the gateway, the Lambda
environment snapshot and previous code, the previous client artifact, and the saved
distribution config. Keep the table rather than deleting possible lecturer records.

## 9. Access / operations

- **AWS access:** portal creds for identity account 116310094355 → `aws sts assume-role --role-arn arn:aws:iam::329599637774:role/Liu_Teng_Yu_Intern2026` (portal creds ~2 h, role session 1 h). Role denials (console too): `iam:*`, `events:*`, `scheduler:*`, `elasticloadbalancing:Delete*`, `ec2:ReplaceRoute/DeleteRoute/ReplaceRouteTableAssociation`, `ec2:ModifyVpcEndpoint`, `ssm:DescribeInstanceInformation`. `ssm:StartSession` **is** allowed.
- **Shell on staging:** `aws ssm start-session --region ap-northeast-2 --target i-0f0da8be59367f7a8` then `sudo -iu ubuntu`. No SSH (private subnet).
- **Shell on dev:** `aws ssm start-session --region ap-northeast-2 --target i-03f258d470a2fa73f` then `sudo -iu ubuntu`. The deployment map uses SSM; do not depend on the old workstation SSH path.
- **Manual stop/start:** EC2 console or `aws ec2 stop-instances/start-instances --instance-ids i-0f0da8be59367f7a8`. Same-instance stop/start preserves TG registration, Lambda config, and IP-independence (everything references the instance ID or ALB DNS).
- **Smoke test:** `https://d1qh0ebsvevhy3.cloudfront.net/api/models` → 200 JSON; `/api/instance/status` → `workerReady:true` when the box is up; TG health `describe-target-health` all `healthy`.

## 10. Multi-user readiness and 2026-08-02 event

### Implemented multi-user behavior

The staging application is no longer event- or Dean-specific at the code layer:

- Every request carries an immutable `voice_model` snapshot. A browser conversation
  also freezes its engine, profile, and references until that conversation stops, so
  another user changing the active UI/profile cannot switch its voice mid-reply.
- The inference worker has a bounded FIFO scheduler (`SYNTHESIS_MAX_QUEUE_DEPTH=100`,
  `SYNTHESIS_MAX_QUEUE_WAIT_MS=25000`). Same-model work may use the tested physical
  concurrency; different-model work waits for the active model batch to drain before
  the atomic GPT/SoVITS pair is changed.
- Live Fast, direct inference, Live Full generation/regeneration, and model mutations
  all use the same scheduler. Demo preemption/bypass was removed.
- Live Full manifests, ordered SSE events, chunks, previews, finals, cancellation
  markers, and mutable session state are persisted in S3. Any inference target can
  hydrate/relay the session, so horizontal routing does not depend on instance-local
  ownership.
- Training has its own bounded serial FIFO queue on the fixed training worker. It is
  deliberately not sent to the inference ASG.
- Lambda retries capacity responses (`429`/`503`) for a bounded configurable budget
  (`INFERENCE_CAPACITY_RETRY_MS=30000` live on staging).

The stronger cross-chunk lock that pins the exact GPT/SoVITS references and profile
revision is committed on `codex/staging-multi-user-scaling` (`b86748c`) and the Dean
client branch `codex/chatbot-conversation-snapshot` (`4058357`). It still requires a
staging Lambda + chatbot deployment. Until that deployment, loading another profile
cannot alter an in-progress chunk, but overwriting the same saved profile ID between
separate Live Fast chunks remains a gap.

Staging `g6.xlarge` testing supports `SYNTHESIS_MAX_CONCURRENCY=2` for one loaded voice:
four simultaneous verified requests all returned distinct valid WAVs in 10.8 seconds;
ten simultaneous verified requests all returned valid WAVs in 32.7 seconds. No worker
warning/OOM was recorded, and post-test GPU memory was about 2.95 GiB of 23 GiB. This
means one GPU supports multiple users, but it does **not** meet a 50-request burst
latency target by itself.

### Staging scaling design

Do not use a SageMaker **training job**; it is batch model training, not an online
inference server. Migrating to a SageMaker real-time endpoint would require a new
serving contract and is higher risk than scaling the already-tested EC2 worker.

The implemented staging design keeps the public hostnames and separates roles:

1. The existing instance remains the training/live-gateway control target.
2. Inference instances run only `gpu-inference-worker` plus the pinned AWS ALB Target
   Optimizer proxy. Each target advertises physical concurrency `2`.
3. New target group `vcs-stg-opt-3103` uses data port 3103 and Target Optimizer control
   port 3004. The current image is `ami-09e94f91882b29b91`. Launch template
   `vcs-staging-gpu-inference`
   (`lt-07728350a25e691a4`, default version 29) uses this AMI, `g6.xlarge`,
   `VoiClo_GPU`, and the staging GPU security group.
   ASG `vcs-staging-gpu-inference` is intentionally min/desired 0 with no members;
   `AWSServiceRoleForAutoScaling` also exists. Retained recurring 07:00 and 19:00
   actions both preserve min/desired 0 and max 192 during the lecture shutdown.
4. `scripts/provision-staging-autoscaling.ps1` creates/updates the launch template,
   ASG, target tracking, listener switch, and scheduled actions. Prewarm is configured
   by `VCS_STAGING_PREWARM_AT`, `VCS_STAGING_PREWARM_CAPACITY`,
   `VCS_STAGING_SCALE_DOWN_AT`, and `VCS_STAGING_MAX_CAPACITY`, not hardcoded into
   application behavior. `VCS_STAGING_EVENT=true` uses the configured event default
   only when an explicit prewarm capacity was not supplied.
5. The original 16-GPU event plan passed the complete 50- and 60-request public
   bursts. The requested event default is now 50 for additional headroom. This
   value is also applied to and verified on the live scheduled action.

Live scaling uses Target Optimizer rejection signals rather than completed-request
target tracking:

- add a configurable fixed number of GPUs after a configurable rejection count in one
  60-second period; live/default is 1 reject and +10 GPUs;
- do not require sampled free capacity to be zero; this is intentionally aggressive
  and the threshold should be raised if transient rejects cause false scale-outs;
- scale in one instance after fifteen one-minute periods with no ALB traffic;
- default instance warmup and ELB health grace are 600 seconds, default cooldown is
  300 seconds, and target deregistration delay is 120 seconds;
- normal scale-in stops at ASG minimum 1. An event action that raises minimum to 50
  deliberately blocks automatic scale-in below 50 until a paired action restores
  minimum/desired 1.

The ALB metric is published in 60-second periods, so this configuration cannot promise
an exact 30-second reaction. A true 30-second rule requires a custom high-resolution
metric publisher. Idle automatic scale-in begins after about fifteen quiet minutes and
may take another two minutes to drain. Reactive scale-out still cannot rescue the first
sudden burst because new GPUs take minutes to boot and warm. Configure the threshold
with `VCS_STAGING_SCALE_OUT_REJECTS_PER_MINUTE` and the fixed increment with
`VCS_STAGING_SCALE_OUT_ADD_CAPACITY`.

Target Optimizer requires a new target group and its agent on every inference target.
Do not apply it to the WebSocket gateway on port 3002 or the training worker on 3001.

### Load-test acceptance plan

Test the complete staging CloudFront route with production-shaped requests and a fixed
DeanVoice profile. Do not benchmark only static files or `/api/instance/status`.

1. Establish single-request baseline service time and real-time factor for short,
   medium, and long chatbot sentences.
2. Run 10, 25, 50, then 60 concurrent virtual users. Use independent clients/DNS and a
   5-minute ramp, 15-minute hold, plus a 50-user near-simultaneous burst.
3. Model think time from the lecture workflow; “100 logged in, 50% active” is not the
   same as 50 synthesis requests every second.
4. Pass only if there is no cross-user cancellation/audio mix-up, no worker crash/OOM,
   no sustained 409/429/5xx, and agreed p95 latency is met. Record p50/p95/p99 latency,
   request success, retries, queue/wait time, ALB response time, Lambda duration/
   throttles, GPU utilization/memory, and per-target active requests.
5. Repeat the accepted load for 60 minutes, then perform one target termination during
   a lower-load resilience run and verify draining/replacement.
6. Run a final rehearsal on 2026-08-01 at 08:00 SGT with the exact fleet size and keep
   a rollback path to the original single instance/target group.

CloudFront load testing must use multiple independent clients and DNS resolution. It is
not permitted when Origin Shield is enabled or when the tested cache behavior has a
Lambda@Edge viewer-request/viewer-response trigger; verify both before the run.

Capacity formula after measurement:

`required GPUs = ceil(peak synthesis requests/second × p95 service seconds ÷ target utilization)`

Use a target utilization no higher than `0.7` for the event. Also test the true
simultaneous burst: the formula describes sustained throughput, not the wait experienced
when 50 students all submit at once.

**Results recorded 2026-07-28 through 2026-07-30 through the real staging public path:**

| Probe | Result |
|---|---|
| Cold correct-profile request | 200 valid WAV, 48.8 s |
| 2 concurrent, scheduler concurrency 1 | both 200; 4.3 s wall; correctly serialized |
| 2 concurrent, concurrency 2, verification enabled | both 200; 9.7 s wall |
| 4 concurrent, concurrency 2, verification disabled | 4/4 valid WAV; 7.1 s wall |
| 4 concurrent, concurrency 2, verification enabled | 4/4 valid WAV; 10.8 s wall |
| 10 concurrent, concurrency 2, verification enabled | 10/10 valid WAV; 32.7 s wall |
| 50 concurrent, 16 prewarmed GPUs | 50/50; p50 20.18 s, p95 24.30 s, 25.35 s wall |
| 60 concurrent, same warm fleet after the first wave | 60/60; p50 3.67 s, p95 9.09 s, 9.92 s wall |
| 60 concurrent, one cold target | 0/60; all CloudFront/Lambda 504 around 30.7 s |
| Fresh launch-template v10 node | cloud-init ready in 442 s; public 10/10 after healthy |
| Full chatbot, 50 users, 32 warm GPUs | WebSocket/transcript 50/50; complete voice 41/50; 9 first-chunk 504s; first voice after speech p50 26.54 s/p95 31.64 s; complete response p50 51.85 s/p95 57.94 s |
| Reactive scale-out from 32 | Three 8-request minute waves; alarm after 5m36s; desired 32->43->45; first new healthy capacity 4m20s after launch, all 45 healthy 12m20s after first demand |
| Full chatbot, 50 users, 45 warm GPUs | 50/50 complete; first voice after speech p50 11.62 s/p95 21.00 s; complete response p50 31.25 s/p95 45.20 s |
| Full chatbot, 50 users, 32 route-warmed GPUs | 50/50 complete; turn first-voice p50 7.57/3.79/4.11 s; turn total p50 31.05/27.80/29.02 s; 109.51 s wave |
| Full chatbot, 100 users, 32 route-warmed GPUs | 98/100 complete sessions; all 100 completed turn 1 voice; turn first-voice p50 9.59/4.20/4.12 s; desired stayed 32 because capacity samples retained at least five free slots |
| Closed-loop TTS, 100 users, 32 GPUs, 120 s, verification skipped | 2,427/2,427 valid WAVs; p50 3.86 s/p95 11.31 s; two free slots remained, so no scale |
| Deliberate 192-user saturation | zero-capacity minute at 20:20 SGT; alarm 20:23:43; desired 32->51; 19 launches at 20:23:56; all 19 route-warm checks complete by 20:28:31 |
| Full chatbot, 100 users, 51 hot GPUs | 100/100 complete three-turn sessions; first voice p50 5.02/3.34/3.40 s; total p50 23.54/19.04/17.15 s |
| Full chatbot, 50 users, 51 hot GPUs | 50/50 complete; first voice p50 5.69/4.10/4.30 s; total p50 28.11/25.42/29.30 s |
| Full chatbot, 100 users, newly route-warmed 50 GPUs | 48/100 complete; exactly 50 first-turn TTS requests returned 504; first-audio average 29.60/4.05/3.95 s for users reaching each turn |
| Full chatbot, 150 users, hot 50 GPUs before scale-out | 129/150 complete; first-turn voice 150/150; 21 WebSockets later closed code 1006; first-audio average 10.46/5.51/5.01 s |
| Deliberate 500-user sustained TTS saturation | 9,543 requests; 8,195 valid WAV; 1,323x504 + 25x503; real alarm changed desired 50->80 |
| Full chatbot, 150 users, 80 route-warmed GPUs after scale-out | 150/150 complete; first-audio average 12.43/3.45/3.37 s; no TTS or WebSocket failures |
| Full chatbot, 100 users, newly two-slot-warmed v14 50 GPUs | 68/100 complete; 32 first-turn 504s; successful first-audio average 23.77/1.82/2.11 s |
| Full chatbot, 150 users, hot v14 50 GPUs | 144/150 complete; first-turn voice 150/150; six WebSockets later closed code 1006 |
| Fixed-step rejection scale-out | Real 226-rejection minute changed desired 50->60 exactly once; all ten added v14 targets passed the two-slot gate |
| Full chatbot, 150 users, 60 route-warmed v14 GPUs | 150/150 complete; successful first-audio average 5.94/2.44/2.36 s; no TTS or WebSocket failures |
| Full chatbot, 100 users, newly deep-warmed v15 50 GPUs | 59/100 complete; 40 first-turn 504s and one later WebSocket 1006; successful first-audio average 24.23/1.85/1.87 s |
| Full chatbot, 150 users, same hot v15 50 GPUs | 150/150 complete; successful first-audio average 7.04/3.01/2.81 s; no TTS or WebSocket failures |

The complete-flow test command is `node scripts/load-test-staging-chatbot.mjs 50`.
Each virtual user opens an independent public WebSocket, streams a real 24 kHz PCM
question, receives its OpenAI answer, and sequentially sends the answer chunks through
public DeanVoice synthesis. The 32-GPU run averaged 160.6 response words and 10.3
chunks per user; the 45-GPU run averaged 105.7 words and 7.66 chunks. The latter
improvement therefore reflects both additional capacity and shorter generated answers,
not capacity alone. No ALB 503 or Target Optimizer rejection was recorded in the
32-GPU run. The nine failures were CloudFront 504s near 30 seconds on the first voice
chunk while Lambda/backend processing continued for as long as about 36 seconds.

A single earlier chatbot response produced 14 voice chunks sequentially in about
28 seconds. It did not scale because that is one user's one-at-a-time workload and
does not exhaust the fleet. The old completed-request policy was replaced after it
scaled too aggressively from small sustained traffic. The current policy scaled only
when the 192-user trigger produced a zero-capacity sampled minute plus rejected
traffic. The metric minute began at 20:20 SGT, CloudWatch entered ALARM at 20:23:43,
desired changed 32->51, and 19 instances launched at 20:23:56. Their cloud-init,
route-level synthesis warm, inference service, and Target Optimizer checks all
completed between 20:28:28 and 20:28:31. Existing warm targets stayed available.

SSM diagnosis found overlapping cold-start requests could leave an abandoned Python
child alive after the 120-second startup timeout, allowing a retry to launch a second
process on port 9880. Commit `472b44e` kills timed-out children, protects process
ownership from late exit events, and allows five minutes for a true cold boot.
A fresh launch-template instance loaded DeanVoice once, warmed references, produced a
valid 32 kHz WAV, and exposed exactly one API process. Rule 3 now routes to the healthy
optimized target. Three final public chatbot requests returned WAVs in 13.49, 2.10,
and 1.65 seconds. This validates one node, not the planned 16-GPU event capacity.

The earlier undifferentiated ~352-second warm measurement was instrumented in commit
`62f86ff`. On an already initialized node the complete warm command took 13 seconds:
5 seconds GPT cache lookup, 4 seconds SoVITS cache lookup, 1 second pair selection,
and 3 seconds reference/throwaway synthesis. A brand-new v10 instance took 378 seconds
inside the warm command: 9 seconds model-cache lookup, 273 seconds starting the Python
stack and loading GPT/SoVITS/BERT/CNHuBERT, and 96 seconds caching references plus the
first synthesis. Cloud-init finished 442 seconds after boot. The large fresh-instance
difference is consistent with first reads from snapshot-backed EBS blocks; prewarming
must complete before traffic.

Reactive scaling did not increase capacity during a 60-request cold burst: the public
requests timed out before `ALBRequestCountPerTarget` recorded enough completed work,
so desired capacity stayed at one. Scheduled event prewarm is therefore required.
AWS Auto Scaling also requires a finite numeric maximum. The live ASG maximum is now
192, matching the account's verified 768-vCPU On-Demand G/VT quota at four vCPUs per
`g6.xlarge`; this is only a ceiling and does not launch instances. Single-AZ capacity
is not guaranteed.

The 2026-08-02 event is configured for paired one-time actions:
`vcs-staging-prewarm` should set min/desired 50 (max 192) at 07:15 SGT, and
`vcs-staging-scale-down` restores min/desired 1 at 18:00 SGT. Both live actions
were read back and verified on 2026-07-30. The stored UTC times are 2026-08-01 23:15Z and
2026-08-02 10:00Z. Times remain flexible through `VCS_STAGING_PREWARM_AT` and
`VCS_STAGING_SCALE_DOWN_AT`; changing an environment variable alone does nothing
until the provisioner is rerun with `-Apply`. A maximum of 200 would require
800 vCPUs and exceeds the verified quota.

Launch-template v15 keeps Target Optimizer stopped until
`warm-staging-deanvoice.sh` completes. Its AMI runs 10 two-request rounds, requiring
20 RIFF WAVs while cycling first-chunk (`skip_verify:true`) and verified later-chunk
paths after loading weights and references. A fresh v15 validator completed the deep
rounds in 26 seconds and its full cloud-init warm-up in 256 seconds before Target
Optimizer started. The subsequent 50-GPU public test still returned 40 first-turn
504s, so the extra local syntheses are verified as deployed but are not an effective
public cold-burst mitigation. Scheduled prewarming remains required, and ALB health
must not be interpreted as proof that first routed traffic will meet the timeout.

Capacity retries sent by Lambda carry `X-VCS-Capacity-Retry`; a worker that receives
one inserts it ahead of normal queued work while preserving FIFO within each lane.
This priority applies after Target Optimizer has routed the request. Target Optimizer
rejections happen before the local queue and are retried by Lambda within a bounded
30-second budget.

An intermediate no-reboot AMI (`ami-0b06a87a36a68328d`, launch-template v9) captured
`gpu-inference-worker/src/index.js` as zero bytes and was rolled back before promotion.
The corrected image was created only after verifying the 3,577-byte file and flushing
the filesystem, then validated from a fresh v10 instance before cutover.

### Test method and timing glossary

`scripts/load-test-staging-chatbot.mjs` tests the complete public student flow, not
only the GPU endpoint. Every virtual user opens an independent WebSocket to the exact
staging hostname, waits for `session.ready`, and then all ready users begin together.
Each user streams the same real 24 kHz PCM question at real-time pace, receives an
OpenAI response, uses the browser's `splitLiveReplyChunks` and
`shortenFirstFastPhrase` helpers, and sends the chunks sequentially through the public
DeanVoice endpoint. First-chunk verification is enabled by default, matching the
deployed browser; `VCS_CHATBOT_SKIP_FIRST_VERIFY=true` is capacity-only and must be
stated with the result. The harness requires HTTP 200, `audio/wav`, and a RIFF header
for every chunk. Per-user markers in the system prompt detect response mixing across
WebSockets. A user sends the next turn only after all voice chunks for the current
turn finish.

The normal complete-flow command is:

```powershell
$env:VCS_CHATBOT_TURNS='3'
$env:VCS_CHATBOT_REPORT_FILE="$PWD\.tmp\chatbot-report.json"
node scripts/load-test-staging-chatbot.mjs 50
```

For 100 or 150 synchronized virtual users, replace the last argument with `100` or
`150`. Do not open 100-150 browser tabs: tab throttling, shared browser resources,
manual timing, and unsynchronized starts make that a poor load test. Use one to three
real browser tabs only for human listening/UI checks; use the harness for repeatable
capacity measurements.

Before a complete-flow rehearsal, run the standalone gateway preflight. It starts
the fixed control instance only when needed and waits for that exact instance to be
healthy in `vcs-staging-tg-3002`; it never stops the instance or creates a schedule:

```powershell
.\scripts\ensure-staging-live-gateway.ps1 -Apply
```

The fixed GPU was changed to 24-hour availability on 2026-08-13; live readback found
it running with the Lambda schedule enabled from hour 0 through 24. The inference ASG
was aligned live the same day: verified recurring `vcs-staging-daily-start` (07:00)
and the historically named `vcs-staging-daily-stop` (19:00) both set min 1 and max 192
with desired capacity unset in `Asia/Singapore`. Neither action resets autoscaled
capacity; the latter therefore no longer stops baseline inference capacity.
The deployed Lambda code can couple manual stop/termination to the ASG, but activation
was rolled back because its execution role lacks `autoscaling:DescribeAutoScalingGroups`
and `autoscaling:UpdateAutoScalingGroup`.

`scripts/load-test-staging-tts.mjs` isolates the public TTS path. With no duration it
sends one request per virtual user. With `VCS_LOAD_TEST_DURATION_MS`, every virtual
user runs closed-loop: it sends one request, waits for the WAV, and only then sends its
next request. `VCS_LOAD_TEST_TEXT`, `VCS_LOAD_TEST_SKIP_VERIFY`, and
`VCS_LOAD_TEST_REPORT_FILE` control the sentence, verification, and JSON output.
Verification must be stated with every result because skipping it changes service time.

```powershell
$env:VCS_LOAD_TEST_DURATION_MS='120000'
$env:VCS_LOAD_TEST_SKIP_VERIFY='true'
$env:VCS_LOAD_TEST_TEXT='Gastrointestinal bleeding means bleeding somewhere inside the digestive tract, and it needs careful medical assessment.'
$env:VCS_LOAD_TEST_REPORT_FILE="$PWD\.tmp\tts-report.json"
node scripts/load-test-staging-tts.mjs 100
```

Timing fields have different boundaries:

| Field | Starts | Ends | Includes |
|---|---|---|---|
| `speechToTranscript` | Last real speech frame sent | Final user transcript event | WebSocket/gateway/OpenAI transcription only |
| `speechToFirstToken` | Last real speech frame sent | First assistant text token | Conversation response startup |
| `speechToTextDone` | Last real speech frame sent | Complete assistant text event | Transcription plus complete chatbot text generation |
| `firstVoiceChunk` | First public TTS HTTP request | First valid WAV response | Lambda profile resolution, any internal Lambda capacity retries, ALB/Target Optimizer routing, worker queue wait, and GPU synthesis |
| `speechToFirstVoice` | Last real speech frame sent | First valid WAV response | Preferred first-audio measure: conversation work plus first TTS chunk |
| `timeToFirstVoice` | Beginning of streamed user audio | First valid WAV response | Also includes the user's input-audio duration; do not compare it with `speechToFirstVoice` |
| `voiceSynthesis` | First TTS chunk request | Last TTS chunk response | Every response chunk generated sequentially |
| `endToEnd` | Beginning of streamed user audio | Last TTS chunk response | Input duration, conversation, and all voice chunks |
| `wallMs` | Harness starts opening sessions | Last session finishes | Entire test wave, not one user's latency |

The public harness's HTTP timing includes Lambda's internal bounded retry when Target
Optimizer rejects capacity. It does not include the GI browser's separate retry after
an entire public request returns 429/503, because the harness calls `fetch` directly.
A four-to-six-second first chunk therefore *can* contain retry time, but its duration
alone does not prove a retry happened. Use `TargetControlRequestRejectCount`, Lambda
logs, and response status together.

`p50` is the median user; `p95` is the slowest-five-percent boundary. Complete voice
time depends strongly on answer length and chunk count, so compare first-audio time
and response words/chunks before attributing a total-time change to GPU capacity.

### Detailed final test ledger

Corrected route-warm complete-flow results:

| Fleet / users | Turn | Completed | First audio after speech p50 / p95 | First TTS chunk p50 / p95 | Complete response p50 / p95 |
|---|---:|---:|---:|---:|---:|
| 32 GPUs / 50 users | 1 | 50/50 | 7.57 / 9.27 s | 5.34 / 6.93 s | 31.05 / 43.00 s |
| 32 GPUs / 50 users | 2 | 50/50 | 3.79 / 5.26 s | 1.74 / 2.64 s | 27.80 / 38.73 s |
| 32 GPUs / 50 users | 3 | 50/50 | 4.11 / 5.35 s | 1.95 / 2.87 s | 29.02 / 35.75 s |
| 32 GPUs / 100 users | 1 | 100/100 | 9.59 / 15.41 s | 8.25 s p50 | 31.50 / 49.56 s |
| 32 GPUs / 100 users | 2 | 98/100 | 4.20 / 6.36 s | 2.89 s p50 | 24.82 / 38.34 s |
| 32 GPUs / 100 users | 3 | 98/100 | 4.12 / 6.12 s | 2.73 s p50 | 20.71 / 30.52 s |
| 51 hot GPUs / 100 users | 1 | 100/100 | 5.02 / 12.66 s | 3.23 / 10.08 s | 23.54 / 44.41 s |
| 51 hot GPUs / 100 users | 2 | 100/100 | 3.34 / 4.54 s | 1.82 / 2.80 s | 19.04 / 29.68 s |
| 51 hot GPUs / 100 users | 3 | 100/100 | 3.40 / 5.47 s | 1.96 / 3.52 s | 17.15 / 28.41 s |
| 51 hot GPUs / 50 users | 1 | 50/50 | 5.69 / 7.26 s | 3.41 / 4.72 s | 28.11 / 40.71 s |
| 51 hot GPUs / 50 users | 2 | 50/50 | 4.10 / 5.52 s | 1.74 / 2.78 s | 25.42 / 37.39 s |
| 51 hot GPUs / 50 users | 3 | 50/50 | 4.30 / 5.90 s | 1.73 / 3.11 s | 29.30 / 33.12 s |

2026-07-30 event-mode rehearsal, where average is the arithmetic mean and
`endToEnd` runs from the beginning of streamed user audio through the last cloned
voice chunk:

| Fleet / users | Turn | Completed | First audio min / average / p50 / p95 / max | Average end-to-end |
|---|---:|---:|---:|---:|
| Newly route-warmed 50 / 100 | 1 | 50/100 | 12.34 / 29.60 / 32.12 / 33.21 / 33.66 s | 44.12 s |
| Newly route-warmed 50 / 100 | 2 | 48/100 | 2.27 / 4.05 / 3.77 / 5.51 / 5.94 s | 25.23 s |
| Newly route-warmed 50 / 100 | 3 | 48/100 | 2.21 / 3.95 / 3.91 / 5.08 / 5.36 s | 25.59 s |
| Hot 50 / 150, before scale-out | 1 | 150/150 | 6.05 / 10.46 / 8.40 / 18.68 / 27.00 s | 48.92 s |
| Hot 50 / 150, before scale-out | 2 | 131/150 | 3.48 / 5.51 / 5.18 / 8.55 / 10.97 s | 37.13 s |
| Hot 50 / 150, before scale-out | 3 | 129/150 | 2.89 / 5.01 / 4.99 / 6.50 / 7.41 s | 32.46 s |
| Route-warmed 80 / 150, after scale-out | 1 | 150/150 | 5.01 / 12.43 / 7.20 / 27.73 / 30.74 s | 29.97 s |
| Route-warmed 80 / 150, after scale-out | 2 | 150/150 | 2.13 / 3.45 / 3.40 / 4.69 / 14.63 s | 19.86 s |
| Route-warmed 80 / 150, after scale-out | 3 | 150/150 | 1.99 / 3.37 / 3.30 / 4.58 / 6.81 s | 18.01 s |

Wall times were 133.62 seconds for 100/50, 147.06 seconds for the pre-scale
150/50 run, and 102.56 seconds for the post-scale 150/80 run. The first 100-user
wave began immediately after all 50 targets first became healthy and returned exactly
50 first-chunk 504s. A later 150-user wave on the same hot fleet returned first-turn
voice for 150/150, but 21 sessions closed WebSocket code 1006 before completing all
three turns. This inconsistency means 50 cannot be called reliable for the event based
on these tests, even though its later first-turn voice capacity reached 150 users.
The 80-GPU post-scale run is the only one of these three that completed 100%.

The v14 two-slot-gate rerun began only after all 50 targets were healthy. “First
audio” below is the first successful RIFF chunk request-to-response time; failed 504
bodies are excluded because no audio was heard. “Full voice” is all sequential cloned
voice chunks for that turn.

| v14 fleet / users | Turn | Heard / users | First audio fastest / average / p50 / p95 / slowest | Average full voice |
|---|---:|---:|---:|---:|
| Newly two-slot-warmed 50 / 100 | 1 | 68/100 | 10.07 / 23.77 / 24.30 / 29.87 / 30.21 s | 40.56 s |
| Newly two-slot-warmed 50 / 100 | 2 | 68/100 | 1.06 / 1.82 / 1.76 / 2.82 / 3.59 s | 14.42 s |
| Newly two-slot-warmed 50 / 100 | 3 | 68/100 | 1.07 / 2.11 / 2.00 / 3.14 / 3.81 s | 14.42 s |
| Hot 50 / 150 before fixed-step scale | 1 | 150/150 | 2.66 / 6.17 / 4.29 / 11.31 / 16.49 s | 31.13 s |
| Hot 50 / 150 before fixed-step scale | 2 | 144/150 | 1.36 / 3.02 / 2.97 / 4.71 / 7.11 s | 22.70 s |
| Hot 50 / 150 before fixed-step scale | 3 | 144/150 | 1.21 / 2.90 / 2.89 / 4.22 / 7.26 s | 19.14 s |
| Route-warmed 60 / 150 after fixed-step scale | 1 | 150/150 | 2.81 / 5.94 / 4.50 / 14.20 / 20.05 s | 25.61 s |
| Route-warmed 60 / 150 after fixed-step scale | 2 | 150/150 | 0.94 / 2.44 / 2.31 / 3.62 / 10.47 s | 18.23 s |
| Route-warmed 60 / 150 after fixed-step scale | 3 | 150/150 | 0.99 / 2.36 / 2.33 / 3.48 / 4.33 s | 16.12 s |

The v14 wall times were 122.35 seconds for 100/50, 154.69 seconds for the
pre-scale 150/50 run, and 115.35 seconds for the post-scale 150/60 run. The first run
failed 32 sessions on first-chunk HTTP 504s. The hot 50-GPU run delivered turn-one
voice to all 150 users, then lost six sessions to WebSocket code 1006 after successful
WAVs. Alarm actions were disabled for both controlled 50-GPU measurements so the
fleet size could not change mid-test. A real 226-rejection metric minute was then
allowed to evaluate with actions enabled; the fixed policy changed desired capacity
50->60, exactly +10. All 60 targets were healthy before the final 150-user run, which
completed 150/150 with no failures. A separate 200-user one-shot TTS saturation sent
after alarm re-arm returned 200/200 valid WAVs at p50/p95 6.66/12.18 seconds.

Verdict: 50 GPUs are **not reliable** for the immediate 100/150-user event burst.
The two-slot gate prevents advertising an untested second route, but exact nominal
capacity still leaves no scheduling/latency headroom. Sixty GPUs passed this single
150-user rerun, but one passing wave is not enough to call 60 guaranteed; the earlier
80-GPU rehearsal is additional evidence for using more prewarm headroom.

The v15 deep-warm rerun used the same audio-only definition and began only after all
50 targets were healthy:

| v15 fleet / users | Turn | Heard / users | First audio fastest / average / p50 / p95 / slowest | Average full voice |
|---|---:|---:|---:|---:|
| Newly deep-warmed 50 / 100 | 1 | 60/100 | 10.19 / 24.23 / 25.97 / 30.28 / 30.60 s | 40.39 s |
| Newly deep-warmed 50 / 100 | 2 | 59/100 | 1.02 / 1.85 / 1.69 / 2.87 / 5.00 s | 14.38 s |
| Newly deep-warmed 50 / 100 | 3 | 59/100 | 1.06 / 1.87 / 1.78 / 2.83 / 4.22 s | 13.76 s |
| Same hot 50 / 150 | 1 | 150/150 | 3.34 / 7.04 / 4.85 / 13.81 / 21.29 s | 27.25 s |
| Same hot 50 / 150 | 2 | 150/150 | 1.64 / 3.01 / 2.77 / 4.73 / 6.75 s | 22.22 s |
| Same hot 50 / 150 | 3 | 150/150 | 1.07 / 2.81 / 2.75 / 3.99 / 7.84 s | 16.80 s |

The v15 wall times were 132.06 seconds for newly warmed 100/50 and 115.81 seconds
for hot 150/50. The first run had 40 first-turn voice failures, all HTTP 504, plus
one WebSocket 1006 after successful turn-one audio; the hot comparison had no
failures. Compared with v14's immediate 68/100 result, v15 completed only 59/100 and
successful turn-one first audio was effectively unchanged (24.23 versus 23.77
seconds). Ten local two-slot rounds therefore disproved the assumption that more
localhost synthesis alone would make a newly advertised target behave like a target
already exercised through the public route. The next experiment must isolate the
unwarmed layer in the routed Target Optimizer/ALB/Lambda path or keep new targets out
of service until an equivalent routed readiness probe succeeds; blindly adding more
local rounds is not justified by this evidence.

### v16/v17 restart-safe and public-route prime proof

The v15 fleet also exposed a separate first-boot failure. `unattended-upgrade`
upgraded libc immediately after local warm and restarted containerd, NVIDIA,
networking, Target Optimizer, and `gpu-inference-worker`. The restarted Node worker
listened on port 3003 with `ready:false`, while Target Optimizer had already started.
ALB health returned 503 and Auto Scaling churned the fleet. Launch-template v16 fixes
that failure by masking automatic-update units on the immutable event fleet and
putting the full DeanVoice warm in the worker's `ExecStartPost`; Target Optimizer
cannot start until that restart-safe gate completes. A fresh v16 canary and three
fresh fleet samples showed `cloud-init: done`, `NRestarts=0`, both services active,
all update units masked, and `ready:true`.

That fix removed churn but did not by itself solve public cold-burst latency. On a
stable 50-target v16 fleet, 100 concurrent users completed only 48/100; all 52
failures were first-turn CloudFront 504s. The same hot fleet delivered turn-one audio
to 150/150 and completed 133/150; the 17 failures were later WebSocket 1006 closures.
CloudWatch Lambda evidence ruled out Lambda cold-start cost: the fresh window had 100
cold starts averaging 126.7 ms, but request duration p95/max was 30.36/37.89 seconds.
Target Optimizer published 21 control-request rejections for the 07:39 UTC minute.
The accepted synthesis work therefore continued after CloudFront's response window.

A controlled realistic public prime then sent 100 concurrent first-clip requests
through CloudFront, Lambda, ALB, Target Optimizer, and the GPUs. The prime itself
returned 55 WAVs and 45 expected 504s; after a 30-second backend settle, the same fresh
fleet completed 100/100 full three-turn sessions. Launch-template v17 automates the
same operation: after local warm and Target Optimizer start, every new instance waits
90 seconds, sends two concurrent realistic public first-clip requests, then waits
45 seconds for work hidden by a CloudFront 504 to finish. Five independent v17 batch
samples showed `public_prime completed`, active workers, and zero service restarts.

Audio-heard results count only first-chunk HTTP 200 RIFF responses:

| v17 fleet / users | Turn | Heard / users | First audio fastest / average / p50 / p95 / slowest | First-audio total | Average full voice |
|---|---:|---:|---:|---:|---:|---:|
| Auto-public-primed 50 / 100 | 1 | 100/100 | 3.92 / 6.51 / 5.01 / 11.15 / 14.00 s | 650.75 s | 26.66 s |
| Auto-public-primed 50 / 100 | 2 | 100/100 | 1.26 / 2.16 / 2.12 / 3.10 / 3.29 s | 216.30 s | 16.09 s |
| Auto-public-primed 50 / 100 | 3 | 100/100 | 1.16 / 2.03 / 1.93 / 3.02 / 3.35 s | 203.15 s | 16.78 s |
| Same hot 50 / 150 | 1 | 150/150 | 3.19 / 6.46 / 4.24 / 12.04 / 18.59 s | 969.33 s | 26.89 s |
| Same hot 50 / 150 | 2 | 148/150 | 1.56 / 3.02 / 2.80 / 4.10 / 10.54 s | 447.10 s | 20.05 s |
| Same hot 50 / 150 | 3 | 148/150 | 1.24 / 2.71 / 2.63 / 3.80 / 6.64 s | 400.70 s | 16.81 s |

The v17 wall times were 118.25 seconds for fresh/primed 100 and 137.93 seconds
for hot 150. The first run had no failures. The second had no TTS failure and two
WebSocket 1006 closures after successful turn-one audio, leaving 148/150 complete.
This proves one fresh 50-GPU v17 rehearsal, not a universal capacity guarantee.

The 2026-07-31 repeat preserved those results and added a second independent v17
rehearsal. Before the measured runs, a 100-client attempt returned 100 WebSocket 503s
in 1.84 seconds because the separate control instance
`i-0f0da8be59367f7a8`, which owns the live gateway, was stopped. This was a gateway
precondition failure, not an inference-capacity result, and is excluded below. After
starting that instance, one complete-flow smoke passed. All 50 inference instances
had already passed target health plus independent SSM checks for cloud-init,
`public_prime completed`, and both inference services active.

| 2026-07-31 v17 fleet / users | Turn | Heard / users | First audio fastest / average / p50 / p95 / slowest | Average full voice |
|---|---:|---:|---:|---:|
| Auto-public-primed 50 / 100 | 1 | 100/100 | 3.54 / 8.90 / 10.43 / 11.91 / 13.51 s | 24.88 s |
| Auto-public-primed 50 / 100 | 2 | 100/100 | 2.26 / 3.10 / 2.98 / 4.27 / 4.71 s | 17.08 s |
| Auto-public-primed 50 / 100 | 3 | 100/100 | 2.01 / 3.22 / 3.16 / 4.31 / 5.52 s | 15.81 s |
| Same hot 50 / 150 | 1 | 150/150 | 4.50 / 8.56 / 6.14 / 16.07 / 19.26 s | 31.73 s |
| Same hot 50 / 150 | 2 | 147/150 | 2.41 / 4.42 / 4.18 / 7.09 / 8.71 s | 25.01 s |
| Same hot 50 / 150 | 3 | 147/150 | 2.26 / 3.95 / 3.91 / 5.26 / 7.85 s | 20.93 s |

The 100-user wall time was 95.29 seconds and all 100 sessions completed with no
non-200 TTS chunks. Across each user's three `endToEnd` turn timings, the total was
41.74 / 57.77 / 56.72 / 71.36 / 92.83 seconds
(fastest / average / p50 / p95 / slowest). The 150-user wall time was 134.77 seconds.
All 150 heard turn one, 147 completed all turns, and three WebSockets closed code
1006 before turn two; no TTS chunk failed. For the 147 complete sessions, the
three-turn total was 51.81 / 76.87 / 74.68 / 111.09 / 131.37 seconds in the same
order. These totals sum the three per-turn `endToEnd` measurements; they exclude
connection setup and the harness's two 250 ms think intervals.

The 150-user burst also independently verified reactive scaling. Target Optimizer
reported 379, 777, and 171 rejected routing attempts in the 09:22-09:24 SGT
one-minute buckets. The armed alarm changed desired capacity 50->60 at 09:25:29;
all 10 instances launched at 09:25:43, all 60 targets were healthy by 09:31:06,
and independent SSM checks showed `public_prime completed` on every added node by
09:33:59. The routing rejects include Lambda retries and are not failed-user counts.
The extra capacity became ready after the 134.77-second burst ended, so this proves
the scaling mechanism but also proves reactive scale-out cannot protect the same
short burst. Scheduled prewarming remains mandatory.

The August 2 scheduled expansion now starts at 06:50 SGT so local warm, the converged
98-request public prime from the 49 new nodes, and backend settle finish before the
07:15 event. Scale-down remains 18:00. During the acceptance recycle, recent volume
deletions temporarily produced a stale regional 50-TiB gp3 quota error even though
the live inventory had fallen to 3.42 TiB; launches resumed after quota accounting
cleared. Verify gp3 headroom before the event and do not rehearse a mass terminate/
relaunch immediately before 06:50.

Final cleanup restored min/desired 1, ELB health authority, and the rejection alarm
in OK state with actions enabled. Retained v17 instance `i-096eb75d9a4560973` was
healthy and a final public RIFF smoke completed in 3.27 seconds.

#### Final v19 occupancy-policy rehearsal (2026-07-31)

This run preserves the earlier v14-v17 results above. LT v19 removed public-prime
`skip_verify` and requires HTTP 200 plus a RIFF body before writing
`public_prime completed with verified public RIFF responses`. The readiness script
observed 50/50 desired, InService, healthy targets with the per-instance marker.
Each instance originates a real public request without operator credentials. Because
ALB can route that request to any healthy target, the marker proves every instance
issued and received public RIFF responses, but it does not cryptographically prove
that a request returned to its originating backend.

The load generator ran the real WebSocket -> OpenAI -> browser-equivalent chunking ->
public DeanVoice flow from one machine. It peaked at 22.1% of one CPU core and
193.1 MiB working set, so it was not CPU-saturated. Results below are seconds and use
all finite timings; complete-conversation totals include only sessions completing all
three turns.

| Users / turn | Heard | First audio fastest / average / p50 / p95 / slowest | Complete response fastest / average / p50 / p95 / slowest |
|---|---:|---:|---:|
| 100 / 1 | 100 | 4.85 / 6.39 / 6.44 / 7.69 / 8.05 | 30.15 / 46.25 / 45.33 / 60.87 / 72.33 |
| 100 / 2 | 99 | 2.36 / 3.82 / 3.78 / 5.37 / 6.29 | 10.57 / 25.77 / 27.10 / 43.62 / 49.39 |
| 100 / 3 | 99 | 2.49 / 4.06 / 3.98 / 5.35 / 6.85 | 10.45 / 28.69 / 28.81 / 41.69 / 51.09 |
| 150 / 1 | 150 | 5.25 / 7.91 / 7.51 / 12.25 / 18.71 | 25.65 / 53.07 / 52.83 / 75.40 / 93.54 |
| 150 / 2 | 132 | 2.70 / 4.88 / 4.70 / 7.39 / 8.50 | 13.40 / 34.19 / 35.45 / 55.74 / 67.19 |
| 150 / 3 | 130 | 2.79 / 4.64 / 4.61 / 6.06 / 9.05 | 13.19 / 34.18 / 34.44 / 48.50 / 53.36 |

| Users | Complete sessions | Three-turn total fastest / average / p50 / p95 / slowest | Harness wall time |
|---:|---:|---:|---:|
| 100 | 99/100 | 64.86 / 100.44 / 98.97 / 131.38 / 153.88 s | 156.18 s |
| 150 | 130/150 | 69.72 / 118.04 / 117.22 / 146.72 / 157.58 s | 160.18 s |

The 100-user run had one WebSocket 1006 after turn one. The 150-user run had 20
WebSocket 1006 closures; turn completion was 149/132/130. No completed TTS chunk
failed. This is a fail for a 100% session-completion acceptance criterion.

The new alarm measures occupied slots as
`100 * (1 - freeSlots / (HealthyHostCount * 2))`, triggers at 70% for one 60-second
point, and adds exactly 10. The 100-user run peaked at 67% and correctly did not
scale. The 150-user run sampled approximately 94%, alarmed at 11:53:34 SGT, changed
desired 50->60, and launched the added instances at 11:53:42. The approximately
160-second load wave had already ended. The following occupancy sample fell below
70%, so there was no second +10. The mechanism works outside event mode, but a
one-minute alarm plus EC2 boot/warm cannot rescue a short burst; scheduled prewarm is
the event safeguard.

Three slots per GPU was not tested or promoted. The role was denied
`autoscaling:SuspendProcesses`, so a single-target restart could not be isolated from
ASG replacement. Given the 130/150 result at two slots, switching 50 live targets to
three without a canary would be an unsafe capacity claim. The fixed GPU was also
verified serving training (3001), gateway (3002), and legacy inference (3003), with
an inference Python process holding about 952 MiB GPU memory. Removing legacy
inference reduces contention risk for training/gateway, but the optimized chatbot TTS
route uses the ASG and therefore does not directly become faster.

Current live event actions set min/desired 50 at 13:30 SGT on 2026-08-04 and restore
min/desired 1 at 16:00. The existing 07:00/19:00 recurring baseline actions remain;
the earlier August 3 event was still live at the 11:36 SGT read-back with min 50 /
desired 56, and its legacy `vcs-staging-scale-down` action remains scheduled to
restore min/desired 1 at 17:00 on August 3. The August 3 and August 4 pairs are
separate. For the active scaling controls, the 70%
occupancy alarm was enabled/OK, the rejection alarm was telemetry-only, and
`vcs-staging-tg-3002` remained healthy.

#### LT v20 baseline tier and temporary three-slot experiment (2026-07-31)

This experiment preserves all earlier results. The occupancy policy is now tiered:
while fewer than five targets are healthy, a 70% one-minute sample sets exact
capacity five. At five or more healthy targets, the separate fleet policy adds ten.
This prevents two overlapping baseline requests from changing desired capacity 1->11
while keeping +10 increments for a meaningful fleet. Both policies were applied and
read back; actions were disabled during the fixed-50 A/B measurements.

The warm script was generalized to the configured concurrency. One three-slot canary
passed ten rounds, but only 38/49 remaining targets passed the same mandatory gate.
Including the canary, readiness was 39/50; 11 worker restarts failed during deep warm.
No three-slot user load was run because a fleet that fails readiness is already a
failed candidate. Two slots were restored and passed 50/50.

The restart also exposed a safety-check flaw: the old readiness probe accepted a
boot-time public-prime line even if the worker had restarted later. An immediate
100-user control consequently failed before a fresh public route proof. The probe now
requires the public-prime log timestamp to be at least as new as the current worker
start, so stale evidence fails closed. A dedicated public re-prime then returned
100/100 verified WAVs in 12.20 seconds (p50/p95 6.22/9.74 seconds).

After re-prime, the fixed 50-GPU/two-slot real-flow controls produced:

| Users / turn | Heard | First audio fastest / average / p50 / p95 / slowest | Complete response fastest / average / p50 / p95 / slowest |
|---|---:|---:|---:|
| 100 / 1 | 100 | 3.38 / 6.61 / 5.69 / 11.17 / 13.20 | 33.36 / 70.84 / 69.70 / 98.79 / 113.51 |
| 100 / 2 | 43 | 2.76 / 4.70 / 4.16 / 9.20 / 11.21 | 13.80 / 41.80 / 40.60 / 70.97 / 74.25 |
| 100 / 3 | 35 | 3.03 / 5.50 / 4.79 / 9.16 / 9.21 | 24.62 / 46.78 / 47.92 / 65.64 / 65.80 |
| 150 / 1 | 138 | 5.69 / 14.39 / 13.29 / 33.59 / 33.69 | 33.86 / 84.02 / 87.22 / 119.08 / 136.48 |
| 150 / 2 | 22 | 3.25 / 7.02 / 5.52 / 12.50 / 19.25 | 26.99 / 59.34 / 55.65 / 90.30 / 100.94 |
| 150 / 3 | 15 | 3.08 / 5.25 / 4.19 / 9.22 / 9.22 | 14.91 / 47.63 / 47.25 / 76.78 / 76.78 |

| Users | Complete sessions | Three-turn total fastest / average / p50 / p95 / slowest | Harness wall |
|---:|---:|---:|---:|
| 100 | 33/100 | 96.09 / 136.12 / 136.29 / 172.51 / 177.37 s | 190.64 s |
| 150 | 13/150 | 112.09 / 152.69 / 155.33 / 182.49 / 182.49 s | 185.08 s |

The 100-user run had 67 WebSocket 1006 closures and no TTS HTTP failures. The
150-user run had 125 WebSocket 1006 closures plus twelve first-turn 504s. The ALB
idle timeout is 60 seconds, while turn-one completion p50 was 69.70/87.22 seconds.
The gateway process was not CPU-bound. This strongly implicates a silent WebSocket
during long TTS playback, but it is not proved until a heartbeat or increased-idle-
timeout A/B is run. These responses were much longer than earlier runs, so they are
also evidence that fixed OpenAI output length is required for capacity comparisons.

Verdict: retain two slots. Three slots failed readiness, and two-slot event reliability
is still blocked by WebSocket lifecycle behavior for long answers. Fix and A/B the
heartbeat/idle timeout before treating another 100/150-user burst as acceptance.

#### Browser-keepalive and 50->60 autoscaling A/B (2026-07-31)

This test preserves every earlier result. The complete-flow harness now matches the
browser's application-level WebSocket keepalive: each open session sends
`{"type":"keepalive"}` every 15 seconds while TTS uses separate HTTP requests. The
gateway deliberately ignores this unknown message, but its traffic keeps the
CloudFront/ALB WebSocket from being idle. First TTS chunks used the browser's
`skip_verify` behavior. Production OpenAI prompting, answer length, Live Fast
chunking, and sequential DeanVoice generation were not changed.

The prior no-keepalive controls completed only 33/100 and 13/150. With keepalive,
all four new three-turn runs completed every session with no TTS failure or foreign
user marker:

| Effective fleet / users | Turn | Heard | First audio fastest / average / p50 / p95 / slowest | Complete response fastest / average / p50 / p95 / slowest |
|---|---:|---:|---:|---:|
| 50 GPUs / 100 | 1 | 100 | 4.66 / 12.52 / 12.72 / 13.98 / 14.66 | 16.89 / 45.15 / 45.91 / 58.26 / 68.26 |
| 50 GPUs / 100 | 2 | 100 | 2.42 / 3.88 / 3.82 / 5.04 / 6.62 | 10.46 / 26.56 / 27.22 / 44.62 / 47.48 |
| 50 GPUs / 100 | 3 | 100 | 2.56 / 4.11 / 4.09 / 5.38 / 6.05 | 9.63 / 29.45 / 28.93 / 42.36 / 48.62 |
| 60 GPUs / 100 | 1 | 100 | 5.57 / 13.83 / 13.33 / 22.40 / 25.06 | 24.20 / 36.50 / 33.45 / 51.14 / 61.72 |
| 60 GPUs / 100 | 2 | 100 | 2.17 / 3.26 / 3.18 / 4.53 / 5.23 | 10.42 / 19.01 / 16.49 / 33.44 / 46.69 |
| 60 GPUs / 100 | 3 | 100 | 2.18 / 3.25 / 3.02 / 4.66 / 5.42 | 10.37 / 19.53 / 16.53 / 36.11 / 40.67 |
| 50 GPUs / 150 | 1 | 150 | 4.67 / 8.99 / 7.15 / 14.61 / 31.56 | 17.80 / 33.30 / 29.59 / 64.97 / 76.05 |
| 50 GPUs / 150 | 2 | 150 | 2.34 / 4.22 / 4.09 / 5.74 / 8.63 | 11.51 / 24.04 / 22.99 / 34.14 / 45.53 |
| 50 GPUs / 150 | 3 | 150 | 2.23 / 4.03 / 3.88 / 5.83 / 8.05 | 9.89 / 21.73 / 21.06 / 30.75 / 39.86 |
| 60 GPUs / 150 | 1 | 150 | 5.15 / 9.21 / 7.61 / 14.20 / 16.43 | 15.30 / 28.79 / 27.45 / 43.82 / 57.49 |
| 60 GPUs / 150 | 2 | 150 | 2.17 / 3.64 / 3.61 / 4.62 / 5.96 | 12.83 / 20.99 / 19.82 / 32.49 / 42.55 |
| 60 GPUs / 150 | 3 | 150 | 2.52 / 3.55 / 3.48 / 4.66 / 6.15 | 9.23 / 19.51 / 18.43 / 29.22 / 39.07 |

| Fleet / users | Complete sessions | Three-turn total fastest / average / p50 / p95 / slowest | Harness wall | Keepalives |
|---|---:|---:|---:|---:|
| 50 / 100 | 100/100 | 49.31 / 101.17 / 101.47 / 128.20 / 156.59 s | 159.03 s | 637 |
| 60 / 100 | 100/100 | 48.33 / 75.04 / 68.01 / 107.01 / 130.82 s | 133.52 s | 465 |
| 50 / 150 | 150/150 | 55.49 / 79.06 / 75.20 / 113.10 / 136.07 s | 138.40 s | 733 |
| 60 / 150 | 150/150 | 49.37 / 69.30 / 67.21 / 95.37 / 125.45 s | 128.16 s | 630 |

The tests did not control OpenAI answer length. Average turn-one words were
176.92, 113.83, 102.60, and 97.31 in table order. Fleet comparisons therefore
support session reliability and observed throughput, but cannot attribute every
latency difference to GPU count.

The 50-GPU/100-user run started 06:59:44 UTC and produced a 73% occupancy datapoint
for 07:00. CloudWatch changed the alarm at 07:03:48 and desired capacity 50->60;
the ten EC2 launches began 07:04:01. All 60 targets were healthy by 07:09:27, but
the new targets' public-prime/cloud-init completion ranged through 07:11:30. Reactive
recovery therefore took 11m46s from load start to strict public readiness:

- metric-bucket timestamp to alarm: 3m48s;
- alarm to launch: 13s;
- launch to all targets healthy: 5m26s;
- launch to all public-prime markers: 7m29s.

The 150-user/50-effective-GPU run started at 07:03:32 and ended at 07:05:50, while
the added targets were still warming, so it is a valid pre-scale result. After
60/60 strict readiness, sampled occupancy peaked at 27.5% for the 100-user post run
and 47.5% for the 150-user post run; neither requested a second +10.

This also directly confirms a readiness gap: added targets were ALB-healthy about
two minutes before their public-prime markers completed. A future dedicated warm
target group and hidden warm route should exercise each exact target through the
public stack, then move it into the production target group. The current ALB cannot
guarantee that a target's public request routes back to itself.

The repository desired ALB idle timeout is 300 seconds and includes a standalone
read-back script. Live staging remains 60 seconds because this role was denied
`elasticloadbalancing:ModifyLoadBalancerAttributes`; an administrator must apply it.
Keepalive alone removed the observed WebSocket collapse, so 300 seconds is defense
in depth, not a first-audio improvement.

Suggestion verdicts:

- CloudFront origin timeout: useful for converting marginal 30-second 504s into
  slow successes, but it does not reduce latency and was not changed without first
  auditing the exact TTS behavior/origin.
- Ten-second occupancy: correct direction, but the current AWS Target Optimizer
  metrics are 60-second standard metrics. A real implementation must publish a
  custom high-resolution fleet metric; changing the alarm period alone would be fake.
- Fast Snapshot Restore/gp3 tuning: plausible, but the 5m26s launch-to-health time
  does not isolate EBS reads from Python/CUDA/model initialization. Benchmark disk
  throughput and one canary before enabling per-AZ FSR cost.
- First-sentence streaming: later authorised and deployed to staging as described
  below. The existing conservative first-phrase shortening remains unchanged.

#### Verified text-done-to-first-audio event rehearsal (2026-07-31 evening)

This rehearsal measured only the interval from `assistant.text.done` until the first
TTS chunk returned as a valid RIFF WAV. It excludes microphone upload, transcription,
and OpenAI generation. First-chunk verification remained enabled. Raw per-session JSON
is ignored under `.tmp/`.

| Effective fleet / users | Turn | Heard | First WAV fastest / average / p50 / p95 / slowest |
|---|---:|---:|---:|---:|
| 50 GPUs / 100 | 1 | 100 | 3.54 / 6.36 / 4.89 / 10.29 / 12.56 s |
| 50 GPUs / 100 | 2 | 100 | 1.29 / 2.08 / 1.99 / 2.97 / 7.76 s |
| 50 GPUs / 100 | 3 | 100 | 1.24 / 1.86 / 1.70 / 2.82 / 5.71 s |
| 50 GPUs / 150 | 1 | 149 | 3.05 / 6.45 / 4.45 / 14.43 / 20.55 s |
| 50 GPUs / 150 | 2 | 149 | 1.35 / 3.10 / 2.80 / 5.43 / 10.48 s |
| 50 GPUs / 150 | 3 | 149 | 1.28 / 2.64 / 2.51 / 4.76 / 9.22 s |
| 60 GPUs / 150 | 1 | 150 | 2.76 / 10.96 / 10.48 / 19.55 / 21.28 s |
| 60 GPUs / 150 | 2 | 150 | 1.56 / 2.42 / 2.34 / 3.16 / 4.08 s |
| 60 GPUs / 150 | 3 | 150 | 1.20 / 2.14 / 2.07 / 3.34 / 4.12 s |
| 60 GPUs / 100 | 1 | 100 | 1.91 / 3.56 / 3.42 / 4.69 / 14.61 s |
| 60 GPUs / 100 | 2 | 100 | 1.24 / 1.79 / 1.69 / 2.66 / 2.85 s |
| 60 GPUs / 100 | 3 | 100 | 1.22 / 1.92 / 1.73 / 2.90 / 6.95 s |

Across all three turns, average/p50/p95 first-WAV latency was 3.44/2.22/9.81 s
for 50/100, 4.06/3.14/10.47 s for 50/150, 5.18/2.65/11.82 s for 60/150, and
2.42/2.02/4.19 s for 60/100. Completion was 100/100, 149/150, 150/150, and
100/100 respectively. The one failed 50/150 session produced no completed turn and
timed out after 720 seconds; the other 149 sessions completed. Keepalive counts were
448, 857, 865, and 381. OpenAI response lengths and routing varied, so the slower
60/150 turn one is a real sample and not evidence that adding GPUs always lowers
latency.

The 150-user pre-scale wave produced an 82% occupancy point at 18:45 SGT. CloudWatch
entered ALARM at 18:48:48, desired changed 50->60 at 18:48:51, and all 60 targets
passed health plus per-instance cloud-init/service/public-prime proof at 18:57:38.
Neither post-scale wave crossed 70%, so no second +10 occurred.

The quiet scale-in alarm was broken before this rehearsal: missing request metrics
could move the alarm to ALARM, but Step Scaling received no numeric breach value and
performed no adjustment. The provisioner and live alarm now use
`FILL(requests,0)`, threshold `<1`. In a controlled min-1/desired-3 test, the last
request was at 19:03, the alarm triggered 3->2 at 19:21:26, and the continuously
alarmed policy triggered 2->1 at 19:32:38. The floor is correct, but the conservative
`-1` policy plus target drain/cooldown means additional removals take about 11 minutes
each after the initial 15-minute quiet window. A final public verified TTS smoke on
the baseline route returned HTTP 200 RIFF in 6.28 seconds.

#### First-complete-sentence staging rollout (2026-07-31)

The deployed source/Lambda commit is `fc99271`; the initial rollout documentation
was pushed as `18d82ef`. Staging serves GI bundle `assets/index-DJ5lJmLS.js`.

Staging Live Fast phrase mode now starts the first TTS request once the streamed
assistant text contains a complete sentence and the following sentence has begun.
It no longer always waits for `assistant.text.done`. The boundary waits for following
text, rejects common title abbreviations, and retains the existing first-clip
`skip_verify`, reply cancellation, ordered playback, and full-response fallback.
Live Full and non-phrase modes are unchanged.

The staging Lambda now exposes voice-profile resolution, worker round-trip, and total
Lambda timing headers. The load harness records them separately. The GPU worker's
existing queue-wait header did not survive the public Target Optimizer path, so queue
wait remains unknown rather than being reported as zero.

Verification:

- 79/79 conversation-helper tests, the full Lambda suite, 55/55 live-gateway tests,
  syntax checks, and the GI production build passed.
- Staging Lambda update completed successfully at 08:38:42 UTC. A public request
  returned HTTP 200, RIFF, 1.50 s profile resolution, 3.08 s worker round trip, and
  4.58 s Lambda total. Memory stayed 128 MB because 24-hour metrics showed no
  throttles/errors and request duration is dominated by the upstream synthesis wait.
- CloudFront invalidation `IONUVY9UTZQMX6G7BH74G7841` completed and staging served
  `assets/index-DJ5lJmLS.js`.
- A real deployed-browser typed conversation played first audio in 12.42 s on the
  new session and 3.26/2.96 s on two warm turns. These are smoke observations, not a
  population benchmark or proof of improved p95.
- A one-user real WebSocket -> OpenAI -> public TTS run completed successfully. It
  measured 2.06 s speech-to-text-complete, 3.40 s first TTS chunk, and 5.46 s
  speech-to-first-audio. The first chunk contained 0.40 s profile resolution and
  2.42 s worker round trip. This harness still waits for full text, so it is a
  backend timing control rather than an early-sentence A/B.

Autoscaling detection was not changed by this rollout. Live behavior remains a
one-minute 70% occupied-slot alarm: below five healthy GPUs it sets exact capacity
five, and at five or more it adds ten. The observed 3m48s detection and 11m46s
load-to-strict-readiness remain current evidence. Scheduled prewarm is still required
for a sudden event burst.

The SSM polling fix is unrelated to speed. It only retries a readiness question while
the instance is still answering instead of falsely labelling that instance failed.
Strict exact-target public priming also remains future work: it requires a warm target
group/promotion lifecycle because the production ALB can route a public probe to a
different healthy target.

The 32-GPU/50-user wall time was 109.51 seconds. The 32-GPU/100-user wall
time was 122.12 seconds. Both incomplete 100-user sessions had already produced valid
turn-one voice and later closed WebSocket code 1006; they were not TTS capacity
timeouts. The hot 51-GPU/100-user wall time was 121.67 seconds and the hot
51-GPU/50-user wall time was 114.14 seconds. No foreign marker was accepted as a
successful session.

Closed-loop saturation results:

| Fleet / virtual users | Hold | Requests | Valid WAV | Failures | Latency p50 / p95 | Capacity/scaling observation |
|---|---:|---:|---:|---:|---:|---|
| 32 / 100, short text, verification skipped | 90 s | 3,186 | 3,186 | 0 | 2.28 / 5.99 s | One-to-two slots still appeared free; no scale |
| 32 / 100, realistic text, verification skipped | 120 s | 2,427 | 2,427 | 0 | 3.86 / 11.31 s | Two slots remained at busiest sample; no scale |
| 32 / 128, realistic text, verification skipped | 240 s | 5,007 | 4,972 | 34x504 + 1x503 | 4.19 / 15.41 s | One slot remained at sampled points; strict rule did not scale |
| 32 / 192, realistic text, verification skipped | 180 s | 3,948 | 3,773 | 173x504 + 2x503 | 4.91 / 21.83 s | Zero-capacity minute; desired 32->51 |
| 50 / 300, realistic text, verification skipped | 180 s | 6,415 | 6,132 | 273x504 + 10x503 | 4.48 / 21.28 s | Sampled free capacity remained; no scale |
| 50 / 500, realistic text, verification skipped | 240 s | 9,543 | 8,195 | 1,323x504 + 25x503 | 7.19 / 25.58 s | Real zero-capacity alarm; desired 50->80 |

The 192-user run was deliberately excessive to verify the strict alarm, not an
accepted user target. Its zero-capacity metric minute began at 20:20 SGT; CloudWatch
entered ALARM at 20:23:43, launch began at 20:23:56, and all 19 new instances passed
cloud-init, inference service, real-route warm, and Target Optimizer checks between
20:28:28 and 20:28:31. This is about 4m32s-4m35s from EC2 launch and about 8m45s
from the beginning of the metric minute. The detection delay includes CloudWatch
metric publication and alarm evaluation, not EC2 startup.

### Warm-up ownership and burst findings

The GI student build does **not** call `/models/select` or send a browser warm request
when a student enters. It reads the pinned `deanvoice-v1` profile and starts the
WebSocket/TTS flow when the student uses chat. The administrative Live page does call
model selection, which loads weights and warms references, but that client flow is not
part of the deployed GI website.

This separation is intentional. If 50 students entering the page each loaded the same
model and sent a throwaway inference, the preparation itself would create a redundant
50-request warm-up burst. Every ASG instance instead prepares once during bootstrap:

1. Start `gpu-inference-worker`.
2. Load/check the pinned GPT and SoVITS weights.
3. Cache the primary reference and five auxiliary references.
4. Run reference/throwaway synthesis.
5. Call the real `/inference/tts` route and require a RIFF WAV.
6. Start Target Optimizer only after every previous step succeeds.
7. In v17, wait for the event batch to converge, send two realistic requests through
   the public CloudFront route, and allow timed-out backend work to settle.

A server-side warm request covers GPU weights, references, and the real worker route.
It does not pre-create every student's WebSocket, OpenAI session, Lambda execution
environment, ALB connection, or unique response text. That is why the first production
turn can be slower even after correct GPU warm-up.

### Lambda cold Live-route diagnosis (2026-07-31)

Request-level timing proved that the large first-turn penalty is not primarily GPU
capacity. During the 60-GPU/150-user burst, Lambda had 142 cold environments, zero
throttles, and only 128.7/136.7/144.0 ms init p50/p95/max. The first-turn median still
contained 5.38 seconds outside the Live handler timer.

A direct Function URL cold test reproduced the delay without CloudFront. Its first
playable WAV took 11.23 seconds: 1.72 seconds profile resolution, 3.24 seconds worker
round trip, 4.96 seconds in the Live handler, 0.29 seconds response-body transfer,
and 5.98 seconds between the request and handler-accounted response work. GPU queue
wait and Lambda capacity retries were both zero.

The decisive no-GPU probe deployed the same code and posted an invalid Live TTS body.
The first request took 5.22 seconds client-side and 4.618 seconds in Lambda; the same
environment's immediate repeat took 0.256 seconds client-side and 1.95 ms in Lambda.
The cold REPORT recorded only 128.57 ms Init Duration. Therefore about 4.6 seconds is
the router's first dynamic import of `live/index.js`, which occurs during invocation
and before the Live handler timer starts. A `/api/config` warmup does not load this
route, and provisioned concurrency alone would not execute the lazy import.

A reversible memory A/B reduced the cold no-GPU Lambda duration from 4.618 seconds at
128 MB to 1.071 seconds at 512 MB (77%). Commit `b44e4d2` then made 512 MB the staging
baseline, eagerly imports the Live handler during Lambda environment initialization,
and makes GI freeze/send the active profile's GPT/SoVITS refs for the conversation.
Any request that initializes the router now loads Live; the existing GPU bootstrap
public prime also continues to call the real TTS route. Provisioned concurrency remains
a future option and is not configured.

The deployed eager-import no-GPU probe took 0.716 seconds client-side and 15.71 ms in
the first invocation, versus 5.220 seconds and 4.618 seconds before. Its immediate
repeat took 0.242 seconds client-side and 1.85 ms in Lambda. A pinned real-flow smoke
measured zero profile-resolution time, 3.04 seconds to the first complete playable WAV,
and 1.71 seconds on the next turn.

After 50/50 strict GPU readiness, browser-parity three-turn reruns completed 100/100
and 150/150. Timing below is completed assistant text to completed playable first WAV;
it is not physical speaker-onset timing. Session totals sum the three first-WAV values.

| Users | Turn | Average / fastest / slowest | p50 / p95 |
|---:|---:|---:|---:|
| 100 | 1 | 3.61 / 2.49 / 5.74 s | 3.49 / 4.78 s |
| 100 | 2 | 1.87 / 1.02 / 6.05 s | 1.79 / 2.72 s |
| 100 | 3 | 1.88 / 1.08 / 2.92 s | 1.84 / 2.71 s |
| 100 | three-turn sum | 7.36 / 5.15 / 11.35 s | 7.26 / 9.22 s |
| 150 | 1 | 5.08 / 1.47 / 22.35 s | 4.01 / 12.82 s |
| 150 | 2 | 3.15 / 1.83 / 12.11 s | 2.72 / 6.00 s |
| 150 | 3 | 2.83 / 1.03 / 18.72 s | 2.54 / 5.23 s |
| 150 | three-turn sum | 11.07 / 6.92 / 29.37 s | 9.80 / 19.28 s |

Profile resolution was 0 ms p50 on every turn and at most 1 ms on first-turn p95.
Cold-marked and warm first-turn Lambda environments had similar non-handler p50
(about 0.25-0.27 seconds), proving the old 4.6-second lazy-import block was removed.
The remaining 150-user tail is capacity admission: first-turn retry count/sleep reached
7/9.75 seconds at p95. One-minute occupied-slot samples peaked at 55%, so the 70%
autoscaling alarm correctly did not fire and no post-scale rerun was applicable.

Snapshot behavior remains request-scoped. The GI change added the full saved-model
snapshot to the lecturer chatbot conversation. The regular Live page already sends
its selected GPT/SoVITS snapshot for both Fast and Full modes. Direct inference/TTS
callers that provide only `voiceProfileId`, or omit a complete model/reference
snapshot, still use the saved-profile resolver. This avoids repeated S3 reads when a
caller already has an immutable selection without disabling normal profile resolution.

The 150-user first-turn p95 was 12.82 seconds: 12.30 seconds was inside the
Lambda/worker path and 9.75 seconds of that was capacity-retry sleep. The 22.35-second
maximum retried 12 times and slept 19.75 seconds; it was warm and resolved no profile.
Turn three also had two distinct transit outliers. The 18.72-second maximum spent only
2.17 seconds in Lambda/worker and 16.55 seconds in client/CloudFront/response transit;
the next transit outlier spent 9.50 seconds outside Lambda. Treat capacity admission as
the p95 problem and investigate those rare transit outliers separately. Provisioned
concurrency cannot remove either tail.

A simultaneous burst can also be slower than a short ramp. Separate EC2 GPUs do not
share compute with each other, but two requests placed on one `g6.xlarge` share that
GPU's compute and memory bandwidth. With 50 users and 32 two-slot GPUs, up to 18 GPUs
may temporarily carry a second user while the remainder carry one. Staggering arrivals
lets early jobs use more of their GPU before later jobs overlap, usually improving
first-audio p95 and retry pressure at the cost of a longer arrival window. The next
comparison must keep the simultaneous 150-user burst as the stress case and repeat the
same workload with arrivals distributed across 30-60 seconds.

Target Optimizer is a concurrency gate, not a durable queue. A request rejected at
zero advertised capacity waits inside Lambda before retrying. A slot can finish during
that wait and appear free until the retry returns. ALB/Target Optimizer does not provide
global retry priority; `X-VCS-Capacity-Retry` only moves an admitted retry ahead of
normal entries in that selected worker's local queue. Do not describe the current
system as end-to-end priority.

### Next capacity experiment

Treat the following as one coordinated experiment rather than independent tuning:

1. Publish fleet occupied slots, total slots, no-capacity responses, and pending
   admissions every 10 seconds. Scale-out should consider no-capacity/pending demand
   directly instead of depending only on averaged occupied-slot percentage.
2. Evaluate a shorter jittered retry sequence against a centralized fair admission
   queue. Require bounded waiting, FIFO/fairness evidence, no retry storm, and no
   starvation before replacing the current backoff.
3. For a known 150-user simultaneous event, schedule and strictly warm more capacity
   than the current 50-GPU rehearsal floor. Do not wait for reactive scale-out, which
   cannot prepare new GPUs before a short burst ends.
4. Run the same 150-user, three-turn workload twice: once as a simultaneous burst and
   once with arrivals spread over 30-60 seconds. Compare first-audio p50/p95/max,
   no-capacity counts, pending admissions, retry sleep, errors, and GPU-hours.
5. Keep the simultaneous result as the worst-case capacity test and use the ramped
   result as the more realistic arrival model; do not substitute one for the other.

### Candidate improvements and tradeoffs

The current recommendation for the August event remains scheduled EC2 prewarming plus
the tested bounded retries. The following are post-event experiments, not approved
changes:

| Option | Potential benefit | Downside / risk |
|---|---|---|
| Retry more frequently with 200-500 ms jitter | Reduces short periods where a newly free slot waits for the next Lambda retry | More Lambda/ALB attempts, cost, reject noise, and thundering-herd risk; still no global priority |
| Shared durable priority queue/dispatcher | Buffers bursts and can order retries ahead of new work globally | Changes synchronous TTS into a job API; adds storage, dispatcher availability, fairness/starvation rules, and client polling/WebSocket completion |
| SageMaker Asynchronous Inference | Managed request queue, long jobs, S3 results, and scale-to-zero support | Near-real-time rather than streaming; requires S3 input/output and API redesign, container/model migration, cold-start handling, and cannot provide immediate first audio |
| SageMaker real-time endpoint | Managed model endpoint and autoscaling surface | Still has reactive cold-start delay; requires a compatible serving container and migration from current worker/session contracts; sustained GPU endpoint cost |
| EC2 Auto Scaling warm pool, stopped | Preserves initialized EBS and can use lifecycle hooks before service | Stopping loses RAM/GPU model state, so Python/model reload still occurs; EBS and lifecycle complexity remain; must benchmark against the 272-275 s final AMI |
| EC2 warm pool, running | Near-immediate scale-out | Costs almost the same as active prewarmed GPUs, making the existing schedule simpler |
| Hibernated warm pool | Could preserve RAM where supported | Requires supported instance/AMI configuration, stores RAM on EBS, and GPU/process restoration must be proven; do not assume CUDA state survives correctly |
| EBS Fast Snapshot Restore or deliberate block pre-read | May reduce the snapshot-backed first-read portion of cold start | Extra per-AZ cost and operational work; does not remove Python/model initialization and needs phase-timed proof |
| High-resolution custom capacity metric | Can check utilization every 10 seconds and evaluate a true 30-second window more precisely than the current one-minute sampled Target Optimizer metric | New agent/publisher, CloudWatch cost, missing-data/failure semantics, and alarm maintenance |
| Proactive utilization scale-out | Scale when roughly 50-75% of GPU synthesis slots remain occupied for three consecutive 10-second samples, leaving headroom during the 4.5-minute instance startup instead of waiting for rejected traffic at zero capacity | May launch costly GPUs for short bursts or users who stop immediately; requires a reliable fleet-wide utilization metric, cooldown, and event rehearsal before replacing the strict alarm |
| Base-first fleet with overflow-only routing | Could keep requests on a fixed 50-GPU/100-slot base until every base slot is occupied, then route retries to a separate overflow ASG and target group | Requires a capacity-aware router because ALB weights are probabilistic, plus two target groups, retry/failure handling, and separate fleet operations. It would also queue work on the base while paid overflow GPUs sit idle after scaling. Do not prefer this over the pooled fleet; if the goal is lower cost or later scale-out, load-test a higher occupancy threshold (for example 85-90%) or several consecutive high samples first, because either choice increases burst queueing risk. |
| Multi-AZ private subnets | Better resilience and regional capacity options | Additional NAT/network cost, cache duplication, routing validation, and more infrastructure permissions |
| WebSocket reconnect/resume | Addresses the two code-1006 session losses | Conversation resumption, duplicate-event handling, idempotency, and UI state become more complex |
| One synthesis slot per GPU | More predictable single-user latency | Roughly doubles required GPUs and cost for the same concurrent population |

Future user activity cannot be predicted precisely: users pause between messages,
leave sessions, or submit another turn at different times. A proactive threshold can
therefore reduce cold-start impact, but it should be treated as a headroom policy rather
than a prediction of exact user count.

In this proposal, **busy means an occupied synthesis slot**, not merely an instance
that is powered on. The deployed worker advertises two tested synthesis slots per GPU:
one active generation makes that GPU 50% occupied, while two simultaneous active
generations make it full. Fleet utilization is occupied slots divided by total slots.
For example, 32 GPUs provide 64 slots; 32 simultaneous generations equal 50% fleet
utilization even if they are distributed one per GPU. Queued work should be reported
separately because it indicates demand already exceeds immediately available slots.

The preferred experiment is to publish occupied and total slots every 10 seconds and
scale after three consecutive samples at roughly 50-75% utilization: a real 30-second
window. The current standard one-minute Target Optimizer/CloudWatch metric cannot
reliably implement that exact window and remains unchanged. An absolute trigger such
as 10-30 busy GPUs may be added only as a minimum guard for large fleets; by itself it
would scale too late on a small fleet and too early on a large fleet. Use a slow
scale-in policy, a scale-out cooldown, and compare rejected requests, first-audio
latency, launched GPU-hours, and false scale-outs before promoting this policy.

### Multi-user training and Live Full roadmap

Training and Live Full are not yet horizontally scalable in the same sense as short
DeanVoice inference.

The training worker currently has one bounded FIFO queue stored in process memory and
runs one job at a time on the fixed training GPU. This is safe for concurrent
submissions but is not durable or horizontally distributed: a worker restart loses
queued entries, all users share one failure domain, and wait time grows with each
multi-stage training job.

Two credible training directions should be prototyped after the event:

| Training option | Required work | Benefit | Downside |
|---|---|---|---|
| Durable queue + training ASG/AWS Batch | Put job definitions and status in SQS plus DynamoDB/S3; claim with leases; run one isolated job per GPU; publish checkpoints/progress; autoscale from backlog or estimated GPU-hours | Reuses the current pipeline/container and allows several users to train independently | Queue/lease/idempotency/cancellation complexity, EC2 capacity management, duplicate-job protection, idle GPU cost, and more operational ownership |
| SageMaker Training Jobs | Package the complete GPT-SoVITS/v2ProPlus pipeline, checkpoints, dependencies, input/output contract, metrics, and network/IAM into a training image and submit one managed job per user | Managed job isolation, logs, retries, S3 artifacts, and per-job GPU lifecycle | Container migration effort, startup/cache time, service quotas, potentially higher per-job cost, progress/SSE integration work, and no benefit for real-time inference |

Whichever training platform is selected must use immutable job IDs and per-job S3
prefixes, checkpoint safely, make completion idempotent, support cancellation, enforce
per-user concurrency/cost limits, and never automatically replace the globally active
voice profile. A completed model should become selectable only after artifact and
metadata validation. Queue depth alone is a weak scaling metric when jobs vary greatly;
estimated remaining GPU time is preferable but harder to calculate.

Live Full persists manifests, chunks, previews, finals, cancellation markers, and
events in S3, so another inference target can hydrate a session. However, its synthesis
lease is currently worker-local. Two targets concurrently mutating the same hydrated
session could still race, and initial generation is one long accepted request that
occupies a GPU slot. Before claiming fully distributed Live Full, implement:

1. A distributed session lease with TTL and fencing tokens, or deterministic
   session-to-worker ownership with safe failover. Local scheduler locks are not enough.
2. Conditional manifest revisions and idempotency keys for regenerate/restore/
   insert/delete so stale workers cannot overwrite newer chunk state.
3. Durable asynchronous job state and shared progress delivery. A short REST request
   should enqueue generation and return a session/job ID; browser SSE/WebSocket should
   resume after reconnect without duplicating events.
4. Autoscaling from queued and active estimated GPU work, separated by model/voice
   locality. Raw request count underrepresents a long Full job.
5. Per-user fairness and limits so one long document or repeated regeneration cannot
   occupy every GPU.
6. Optional chunk-level parallelism only after measuring voice consistency. Independent
   chunks can be synthesized on separate GPUs, but final ordering, cancellation,
   retries, loudness normalization, version history, and deterministic reconstruction
   must be reconciled by one coordinator.
7. Failure tests covering worker loss during generation, duplicate delivery, stale
   lease expiry, concurrent edits, model-version changes, S3 delay/failure, and final
   WAV reconstruction.

The simplest first Live Full improvement is distributed lease/version correctness
while keeping one session on one GPU. Parallel chunk generation can reduce total time,
but may introduce inconsistent prosody/voice quality between GPUs, consumes more fleet
capacity per user, and makes regeneration and cancellation substantially more complex.
Do not parallelize chunks merely because shared S3 hydration exists.

AWS references:

- [SageMaker Asynchronous Inference](https://docs.aws.amazon.com/sagemaker/latest/dg/async-inference.html)
- [Autoscale an asynchronous endpoint](https://docs.aws.amazon.com/sagemaker/latest/dg/async-inference-autoscale.html)
- [EC2 Auto Scaling warm pools](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-warm-pools.html)
- [Warm-pool lifecycle hooks](https://docs.aws.amazon.com/autoscaling/ec2/userguide/warm-pool-instance-lifecycle.html)

### AWS permissions needed

Keep discovery and implementation permissions in separate, short-lived sessions. Scope
write access to resources tagged `Environment=staging` and the staging S3 prefix wherever
the AWS action supports resource conditions.

Read-only audit:

- `sts:GetCallerIdentity`, plus `sts:AssumeRole` on
  `arn:aws:iam::329599637774:role/Liu_Teng_Yu_Intern2026`
- EC2/Auto Scaling/ELB describe actions; CloudFront get/list; Lambda get/list; S3
  `ListBucket` for `echolect-staging/*` plus bucket configuration reads
- CloudWatch metric/alarm reads, CloudWatch Logs describe/get/filter, Service Quotas
  get/list, and SSM describe/list/get-command-invocation

Staging implementation:

- EC2 launch-template, image, security-group-rule, capacity-reservation, tag, and
  run/terminate actions needed by the approved design
- Auto Scaling create/update/tag/attach-target-group, policy, scheduled-action,
  lifecycle-hook, instance-refresh, and warm-pool actions
- ELB create/modify/tag target groups, target registration, target health, and listener
  rule changes (Target Optimizer requires a new target group)
- `iam:PassRole` limited to the existing staging EC2 instance profile and
  `iam:CreateServiceLinkedRole` only if the Auto Scaling service-linked role is absent
- SSM `SendCommand`/session access to staging instances; Secrets Manager or Parameter
  Store read for the instance role that retrieves runtime secrets
- CloudWatch `PutMetricData`, log delivery, dashboard/alarm writes, and SNS notification
  writes for the staging observability resources
- Service Quotas `RequestServiceQuotaIncrease` for the Seoul EC2 G/VT quota if the
  applied vCPU quota is too low
- Lambda configuration/code/concurrency writes only if retry, event-mode, or monitoring
  changes are implemented; S3 object access restricted to
  `arn:aws:s3:::interns2026-small-projects-bucket-shared/echolect-staging/*`

CloudFront changes are not expected for the preferred design because its ALB origin DNS
stays stable. Load-test runners need no AWS write permission when run externally; an
  AWS-hosted distributed runner additionally needs its own CloudFormation/ECS/Fargate,
  ECR, S3, CloudWatch Logs, and `iam:PassRole` permissions.

**Permissions actually denied during the 2026-07-28 rollout:**

- `ec2:CreateLaunchTemplate` (hard blocker; scope to launch templates named
  `vcs-staging-gpu-inference*`)
- `autoscaling:CreateLaunchConfiguration` (fallback also denied; granting the launch
  template path is preferred)
- `elasticloadbalancing:ModifyTargetGroupAttributes`
- `servicequotas:ListServiceQuotas`
- `sqs:ListQueues`, `dynamodb:ListTables` (not required by the selected S3-backed
  session design)
- `ssm:SendCommand`, `ssm:GetCommandInvocation` (interactive `ssm:StartSession` works)

**Confirmed 2026-07-29:** launch-template, target-group-attribute, quota, Lambda, S3,
CloudFront, service-linked-role, ASG, `ssm:SendCommand`, and
`ssm:GetCommandInvocation` access works after assuming the deployment role.
`ssm:DescribeInstanceInformation` remains denied but is not required for command
execution.

The launch-template path also needs `ec2:CreateLaunchTemplateVersion`,
`ec2:ModifyLaunchTemplate`, `ec2:RunInstances`, `ec2:CreateTags`, and
`iam:PassRole` limited to `VoiClo_GPU`. Auto Scaling needs
`autoscaling:CreateAutoScalingGroup`, `UpdateAutoScalingGroup`,
`PutScalingPolicy`, `PutScheduledUpdateGroupAction`, and describe actions. The listener
cutover needs `elasticloadbalancing:ModifyRule`. Confirm the Seoul On-Demand G/VT quota
is at least 64 vCPUs for the proposed 16 x `g6.xlarge` event fleet.

## 11. Known gaps / pending admin work (updated 2026-07-28)

1. **Automatic idle-check invocation exists but its resource is not auditable by this
   role.** CloudWatch showed exactly one Lambda invocation every five minutes. The
   commands below are retained as a reference for a classic EventBridge rule only;
   do not create a duplicate until an administrator identifies the existing invoker.
```powershell
aws events put-rule --region ap-northeast-2 --name vcs-staging-gpu-idle-stop --schedule-expression "rate(5 minutes)"
aws lambda add-permission --region ap-northeast-2 --function-name Liu_Teng_Yu_Intern2026-Voice_Cloning_Project-staging --statement-id AllowEventBridgeGpuIdleStop --action lambda:InvokeFunction --principal events.amazonaws.com --source-arn arn:aws:events:ap-northeast-2:329599637774:rule/vcs-staging-gpu-idle-stop
aws events put-targets --region ap-northeast-2 --rule vcs-staging-gpu-idle-stop --targets "Id=1,Arn=arn:aws:lambda:ap-northeast-2:329599637774:function:Liu_Teng_Yu_Intern2026-Voice_Cloning_Project-staging,Input='{\"rawPath\":\"/api/instance/idle-check\",\"requestContext\":{\"http\":{\"method\":\"POST\"}}}'"
```
   Console: EventBridge → Rules → Create rule → Schedule rate(5 minutes) → target the `-staging` Lambda → target input = Constant (JSON) `{"rawPath":"/api/instance/idle-check","requestContext":{"http":{"method":"POST"}}}` (Lambda permission is auto-added via console). Verify: Lambda Monitor tab shows an invocation every 5 min.
2. Leftover `voice-gpu-alb-dev` (`…/app/voice-gpu-alb-dev/17b83508f5602cd7`) + `vcs-dev-tg-3001/3002/3003` to delete (~$20/mo, serves nothing — artifact of the early naming flip). Admin (`elasticloadbalancing:Delete*` denied): `aws elbv2 delete-load-balancer --region ap-northeast-2 --load-balancer-arn <arn above>`, then delete the 3 TGs. ⚠️ `voice-gpu-alb` (April 2026, no suffix) is dev's REAL ALB — do not delete. Optional extra cleanup our role can do: deregister April AMI `ami-0a0a13fc71687e5cc` + snapshot `snap-04c1cb16d3a338c33` (~$2.5/mo); keep golden image `ami-06338e47a2f1bae6a`.
3. Both Lambda Function URLs (dev + staging) are public (`NONE`) — harden to AWS_IAM + CloudFront OAC.
4. Rotate the OpenAI API key (it lived in the dev box's unit file; staging keeps it in `live-gateway/.env`).
5. Optional: scoped `vcs-lambda-staging` exec role instead of the shared one.
6. Ask admin whether NAT gateways get auto-cleaned — whitelist `nat-0dadc68ca781b8df9` (see §5 history).
7. Current live inference state is tagged AMI `ami-0cf96ffb91690b17c`, launch-template
   v39/default, ASG min/desired 1 and max 192, and two slots per GPU. Fresh-boot
   acceptance on instance `i-0c92f3224029284ee` proved unified commit `30234eb`, zero
   tracked/runtime drift, and inference plus gateway readiness. Model-aware
   coordinator admission/reassignment/scale-out is authoritative; legacy ALB occupancy
   alarms are telemetry-only. Health grace is 1,200 seconds because fresh deep warm and
   public prime exceeded the former 600-second grace. See “Model-aware lecture capacity”
   above for the current decision rule.
8. Validation instance `i-015de451bff24a73b` is stopped but remains registered as an
   unused target because this role is denied deregistration and termination. An
   administrator should deregister it from `vcs-stg-opt-3103` and terminate it; attempts
   on 2026-08-01 were denied for both actions, and the
   stopped EBS volume continues to incur storage cost.
9. Fresh v15 validator `i-0eb2ca68edb88d6d7` is stopped and also requires
   administrator termination because this role was denied `ec2:TerminateInstances`.
10. Only one NAT-backed private subnet currently exists (`ap-northeast-2a`). A
   production-resilient fleet should add another private subnet/AZ before relying on
   multi-AZ capacity. Route edits are admin-only for this role.
