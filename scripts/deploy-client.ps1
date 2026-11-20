param(
  [Parameter(Mandatory)][ValidateSet('dev','staging')] [string]$Env,
  [Parameter(Mandatory)][ValidateSet('training','live-fast','chatbot','chatbot-text','mc','record','studio')] [string]$Mode,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$cfg = (Get-Content "$PSScriptRoot\deploy.config.json" -Raw | ConvertFrom-Json).$Env
$repo = Resolve-Path "$PSScriptRoot\.."
# 'chatbot' is the original kiosk target and its build mode is configurable per
# environment (both environments currently ship the gi build there).
# 'chatbot-text' is the second kiosk distribution and always ships the chatbot
# build: the Live Voice Chat UI with the typed-question composer.
$buildMode = if ($Mode -eq 'chatbot-text') {
  'chatbot'
} elseif ($Mode -eq 'chatbot' -and $cfg.chatbotBuildMode) {
  [string]$cfg.chatbotBuildMode
} else {
  $Mode
}
# chatbot-text shares its build mode with chatbot but needs different origins
# baked in, so its env override is named after the target, not the build mode.
$envName = if ($Mode -eq 'chatbot-text') { 'chatbot-text' } else { $buildMode }
$envSrc = "$repo\client\env\$Env\$envName.env"
$envDst = "$repo\client\.env.$buildMode.local"
$dist = "$repo\client\dist-$buildMode"
$target = $cfg.clientTargets.$Mode
$distro = $cfg.distributions.$Mode
if (-not $target -or -not $distro) { throw "No $Mode deployment target is configured for $Env" }

# kiosk modes must be built from the chatbot branch's client tree
if ($Mode -eq 'chatbot' -or $Mode -eq 'chatbot-text') {
  Push-Location $repo
  $current = (git branch --show-current).Trim()
  Pop-Location
  if ($current -ne $cfg.chatbotBranch) {
    throw "chatbot builds must run from branch '$($cfg.chatbotBranch)' (current: '$current')"
  }
}

if ($DryRun) {
  Write-Host "[dry-run] build client --mode $buildMode with $envSrc; sync $dist -> $target; invalidate $distro ($Env)"
  exit 0
}
$hasEnvOverride = Test-Path -LiteralPath $envSrc
$envBackup = $null
# Distinct from $envBackup on purpose. "I made a backup" and "I overwrote the
# destination" are different questions, and they diverge precisely when the
# backup fails: the override was then never copied in, so $envDst still holds
# the developer's untouched file and cleanup must leave it alone. Keying the
# cleanup off $envBackup alone deletes the very file this block exists to
# protect.
$envDstOverwritten = $false
$clientLocationPushed = $false
try {
  if ($hasEnvOverride) {
    # .env.<mode>.local may hold a developer's private local-server settings.
    # Preserve it while the deployment-specific override owns that filename.
    if (Test-Path -LiteralPath $envDst) {
      # Beside the file rather than in $env:TEMP with a random name: if this
      # process is killed mid-build (a 40s vite build is an easy Ctrl-C target)
      # the finally block never runs, and a backup the developer cannot find is
      # the same as no backup. This path is covered by .gitignore's `.env.*`.
      $backupPath = "$envDst.deploy-backup"
      # Assign only after Copy-Item succeeds. A failed backup must never make
      # cleanup mistake an empty/partial file for a restorable copy.
      $envBackup = (Copy-Item -LiteralPath $envDst -Destination $backupPath -Force -PassThru).FullName
    }
    Copy-Item -LiteralPath $envSrc -Destination $envDst -Force
    $envDstOverwritten = $true
  }
  Push-Location "$repo\client"
  $clientLocationPushed = $true
  npm run "build:$buildMode"
  if ($LASTEXITCODE -ne 0) { throw "vite build failed" }
} finally {
  if ($clientLocationPushed) {
    Pop-Location
  }
  if ($envDstOverwritten) {
    if ($envBackup) {
      # A throw in finally would replace the real build error with a confusing
      # one AND leave the deployment override sitting in the developer's local
      # file. Warn with the path instead, so the copy is recoverable by hand.
      try {
        Copy-Item -LiteralPath $envBackup -Destination $envDst -Force -ErrorAction Stop
        Remove-Item -LiteralPath $envBackup -Force -ErrorAction SilentlyContinue
      } catch {
        Write-Warning "Could not restore $envDst from backup. Your original file is at $envBackup - restore it by hand. ($($_.Exception.Message))"
      }
    } else {
      Remove-Item -LiteralPath $envDst -Force -ErrorAction SilentlyContinue
    }
  }
}
# Cache headers are load-bearing, and the two files types need opposite ones.
#
# Everything under assets/ is content-hashed by Vite, so a given URL's bytes can
# never change: cache it forever. index.html is the one unhashed file and it is
# the map to those hashes, so it must be revalidated on every load.
#
# Uploading with no Cache-Control at all (which this script did until 2026-08-21)
# leaves the browser to invent its own heuristic freshness for index.html. A
# returning visitor then runs a stale index.html pointing at the previous build's
# hashed bundle, which --delete has already removed from the bucket -> 403 -> a
# blank page that only a hard refresh clears. The CloudFront invalidation below
# does not help: the stale copy is in the browser, past every edge.
#
# --delete stays: assets/ is not a shared namespace, and the deleted files are
# exactly the ones no current index.html references. `videos/` is excluded from
# it on gi because those are uploaded out of band and are not part of the build.
$deleteArgs = if ($buildMode -eq 'gi') { @('--delete', '--exclude', 'videos/*') } else { @('--delete') }
aws s3 sync $dist $target $deleteArgs --exclude "index.html" --cache-control "public,max-age=31536000,immutable" --region $cfg.s3Region
if ($LASTEXITCODE -ne 0) { throw "s3 sync failed" }
# cp, not sync: sync compares size and mtime, so an unchanged index.html would be
# skipped and would keep whatever headers it already has.
#
# Hashed assets may be cached, but the SPA shell must be revalidated on every open.
# Otherwise a browser can reuse yesterday's index.html and execute a deleted bundle
# until the user manually refreshes.
aws s3 cp "$dist\index.html" "$target/index.html" `
  --cache-control "no-cache, no-store, must-revalidate" `
  --content-type "text/html" `
  --region $cfg.s3Region
if ($LASTEXITCODE -ne 0) { throw "index.html cache metadata update failed" }
aws cloudfront create-invalidation --distribution-id $distro --paths "/*"
if ($LASTEXITCODE -ne 0) { throw "invalidation failed" }
Write-Host "Deployed $Mode client to $Env"
