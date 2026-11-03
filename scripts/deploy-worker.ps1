param(
  [Parameter(Mandatory)][ValidateSet('dev','staging')] [string]$Env,
  [string]$SshKey = "$env:USERPROFILE\Downloads\PC_SYNC\VoiClo-Gpu-Seoul.pem",
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$cfg = (Get-Content "$PSScriptRoot\deploy.config.json" -Raw | ConvertFrom-Json).$Env
$relaySetup = if ($Env -eq 'staging') {
  'sudo install -d -m 0755 /etc/systemd/system/gpu-inference-worker.service.d; sudo install -o root -g root -m 0644 systemd/gpu-inference-worker-relay-health.conf /etc/systemd/system/gpu-inference-worker.service.d/relay-health.conf; sudo systemctl daemon-reload;'
} else {
  'sudo rm -f /etc/systemd/system/gpu-inference-worker.service.d/relay-health.conf; sudo systemctl daemon-reload;'
}
$gatewayEnvTemplate = if ($Env -eq 'dev') {
  'live-gateway/.env.livegateway.deployment'
} else {
  'live-gateway/.env.livegateway.deployment.staging'
}
$gatewayEnvKeys = @(
  'CORS_ORIGIN',
  'LIVE_AUTH_ENABLED',
  'ENTRA_TENANT_ID',
  'ENTRA_AUDIENCE',
  'ENTRA_ALLOWED_EMAIL_DOMAINS',
  'LIVE_AUTH_LOADTEST_SECRET',
  'TRANSCRIPT_TABLE_NAME',
  'TRANSCRIPT_TABLE_REGION',
  'TRANSCRIPT_TTL_DAYS',
  'TRANSCRIPT_STORE_SYNTHETIC',
  'TRANSCRIPT_STORE_ASSISTANT'
)
if ($Env -eq 'staging') {
  $gatewayEnvKeys += @('FACULTY_ENTRA_ALLOWED_EMAIL_DOMAINS', 'LIVE_AUTH_EXEMPT_ORIGINS', 'LECTURER_TABLE_NAME')
}
$gatewayEnvSetup = "node scripts/merge-env-file.mjs $gatewayEnvTemplate live-gateway/.env $($gatewayEnvKeys -join ' ');"
$remote = "set -e; cd /home/ubuntu/VoiceCloning; git -c safe.directory=/home/ubuntu/VoiceCloning fetch origin; git -c safe.directory=/home/ubuntu/VoiceCloning checkout $($cfg.branch); git -c safe.directory=/home/ubuntu/VoiceCloning pull --ff-only; npm --prefix gpu-worker ci --omit=dev; npm --prefix gpu-inference-worker ci --omit=dev; npm --prefix live-gateway ci --omit=dev; $gatewayEnvSetup $relaySetup sudo systemctl restart gpu-worker gpu-inference-worker voice-live-gateway; for attempt in `$(seq 1 40); do curl -sf localhost:3001/healthz >/dev/null && curl -sf localhost:3003/healthz >/dev/null && curl -sf localhost:3002/readyz >/dev/null && break; sleep 3; done; curl -sf localhost:3001/healthz; curl -sf localhost:3003/healthz; curl -sf localhost:3002/readyz"

if ($DryRun) { Write-Host "[dry-run] $($cfg.workerAccess) to $($cfg.instanceId): $remote"; exit 0 }

if ($cfg.workerAccess -eq 'ssm') {
  $cmdId = aws ssm send-command --region $cfg.region --instance-ids $cfg.instanceId --document-name AWS-RunShellScript --parameters "commands=['$remote']" --query "Command.CommandId" --output text
  if ($LASTEXITCODE -ne 0) { throw "ssm send-command failed" }
  Write-Host "SSM command $cmdId sent; waiting..."
  # `aws ssm wait command-executed` gives up after ~100 s, while npm ci plus a
  # cold worker restart regularly takes longer; poll until a terminal status.
  $deadline = (Get-Date).AddMinutes(15)
  do {
    Start-Sleep -Seconds 10
    $invocation = aws ssm get-command-invocation --region $cfg.region --command-id $cmdId --instance-id $cfg.instanceId --output json | ConvertFrom-Json
  } while ($invocation.Status -in @('Pending', 'InProgress', 'Delayed') -and (Get-Date) -lt $deadline)
  [pscustomobject]@{
    Status = $invocation.Status
    Out = $invocation.StandardOutputContent
    Err = $invocation.StandardErrorContent
  } | ConvertTo-Json
  if ($invocation.Status -ne 'Success') { throw "remote worker deploy failed: $($invocation.Status)" }
} else {
  # staging: public IP rotates on stop/start — always look it up
  $ip = aws ec2 describe-instances --region $cfg.region --instance-ids $cfg.instanceId --query "Reservations[0].Instances[0].PublicIpAddress" --output text
  if ($ip -eq 'None' -or [string]::IsNullOrWhiteSpace($ip)) { throw "instance $($cfg.instanceId) has no public IP (stopped?)" }
  ssh -o StrictHostKeyChecking=no -i $SshKey "ubuntu@$ip" $remote
  if ($LASTEXITCODE -ne 0) { throw "remote deploy failed" }
}
Write-Host "Deployed workers to $Env ($($cfg.instanceId), branch $($cfg.branch))"
