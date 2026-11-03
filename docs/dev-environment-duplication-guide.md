# Dev Environment Guide

> Current-state guide as of 2026-08-03. The earlier duplication proposal in this
> file was superseded after dev was aligned with staging. Do not create a `-dev`
> Lambda, `echolect-dev/` prefix, `develop` branches, or a nightly dev schedule.

## Sources of truth

Read these before deployment work:

1. `docs/staging-architecture.md` — resource-level dev/staging inventory and live
   operating notes.
2. `scripts/deploy.config.json` — values consumed by the deployment scripts.
3. Mirrored project memory `docs/Voice Cloning Internship/docs/deployment.md` —
   operator workflow and role boundaries.

Live-read AWS before mutation when credentials are valid. Documentation records the
last verified state; it is not a substitute for a live read-back.

## Environment ownership

Both environments are in AWS account `329599637774`, primarily in
`ap-northeast-2`. Operators assume
`arn:aws:iam::329599637774:role/Liu_Teng_Yu_Intern2026`. Frontend and application
artifacts use the shared bucket in `ap-southeast-1`, separated by prefix.

| Resource | dev | staging |
|---|---|---|
| Source branch | `separate-containers-new` | `codex/staging-multi-user-scaling` — must point at the same commit as dev (both `51c2607`+ on 2026-11-03) |
| Fixed GPU | `VoiClo-GPU-Seoul` (`i-03f258d470a2fa73f`) | `voice-gpu-staging` (`i-0f0da8be59367f7a8`) |
| Lambda | `Liu_Teng_Yu_Intern2026-Voice_Cloning_Project` | `Liu_Teng_Yu_Intern2026-Voice_Cloning_Project-staging` |
| Training CloudFront | `d3dghqhnk7aoku.cloudfront.net` | `d1qh0ebsvevhy3.cloudfront.net` |
| Live TTS CloudFront | `doovx82fh9tfs.cloudfront.net` | `dfzrfr93t2ruf.cloudfront.net` |
| Dean/GI chatbot CloudFront | `d2o0cbe2zunqkr.cloudfront.net` | `d25sg72wp8oj5g.cloudfront.net` |
| Extra kiosk chatbot | none | `d3k2rz0hqm8nxi.cloudfront.net` |
| S3 application prefix | `echolect/` | `echolect-staging/` |
| Worker access | SSM | SSM |

The two Lambdas use the existing
`Liu_Teng_Yu_Intern2026-LambdaExecutionRole`. The fixed EC2 workers and staging ASG
workers use the `VoiClo_GPU` instance profile. The Auto Scaling service-linked role
belongs to the staging ASG path only.

## Deliberate differences

Dev matches the staging application shape after substituting dev-specific Lambda,
ALB, CloudFront, and S3 origins, but it deliberately does not match staging capacity
management:

- dev is one fixed GPU and has no ASG, scaling alarms, ASG scheduled actions, or
  fixed start/stop schedule;
- dev Lambda has `GPU_SCHEDULE_ENABLED=false` and no inference ASG name (2026-11-03: it had been
  left `true` with a 0–0 window, which force-stopped the dev GPU within 5 minutes of every start);
- `VoiClo-gpu-idle-stop` invokes the dev Lambda idle check every five minutes;
- user activity starts the dev GPU, and idle-check may stop it after inactivity;
- staging owns `vcs-staging-gpu-inference`, reactive scaling, recurring 07:00/19:00
  Singapore actions, and event-specific capacity actions.

Other deliberate differences: staging alone has Faculty, Live MC, the text kiosk, ElevenLabs stock
voices and the lecturer table; dev alone has learner analytics. Dev's Lambda opens unsigned staff
synthesis with `LIVE_AUTH_DEMO_ONLY=true`; staging uses `LIVE_AUTH_EXEMPT_ORIGINS`. Both gateways
exempt only their Live Fast origin (plus MC on staging). Access hardening is identical: IAM Lambda
URLs, ALB `X-VCS-Origin-Verify` rules, 60 s CloudFront origin timeouts.

Do not copy staging ASG or schedule configuration into dev. Do not point either
environment at the other environment's Lambda, ALB, CloudFront distribution, or S3
prefix.

## Deployment

Use the environment-aware scripts from the repository root:

```powershell
.\scripts\deploy-client.ps1 -Env dev -Mode training
.\scripts\deploy-client.ps1 -Env dev -Mode live-fast
.\scripts\deploy-client.ps1 -Env dev -Mode chatbot
.\scripts\deploy-lambda.ps1 -Env dev
.\scripts\deploy-worker.ps1 -Env dev
```

Inspect the script parameters before use; deployment is a mutating action. Verify
the assumed AWS account, branch, target IDs, service health, CloudFront status, and
public routes after each deployment.

## Git publication state

GitHub `separate-containers-new` was verified synchronized through operations/docs
commit `8b963eb` on 2026-08-03. The deployed dev host intentionally remains at
application commit `070a99a`; later commits through `8b963eb` did not change the
application component trees. Re-read local, origin, and host revisions before any
future deployment rather than assuming they still match this snapshot.
