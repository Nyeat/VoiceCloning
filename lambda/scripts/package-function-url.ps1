$ErrorActionPreference = 'Stop'

$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
$OutDir = Join-Path $Root '.dist'
$ZipPath = Join-Path $OutDir 'voice-cloning-function-url.zip'

Push-Location $Root
try {
  # Every runtime dependency must be in the zip (2026-11-23: a package built
  # without nodemailer made every Voice Studio email fail on the live Lambda).
  $deps = @((Get-Content 'package.json' -Raw | ConvertFrom-Json).dependencies.PSObject.Properties.Name)
  $missing = @($deps | Where-Object { -not (Test-Path (Join-Path 'node_modules' $_)) })
  if (-not (Test-Path 'node_modules') -or $missing.Count -gt 0) {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
    $missing = @($deps | Where-Object { -not (Test-Path (Join-Path 'node_modules' $_)) })
    if ($missing.Count -gt 0) { throw "Missing dependencies after npm ci: $($missing -join ', ')" }
  }

  if (-not (Test-Path $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir | Out-Null
  }

  if (Test-Path $ZipPath) {
    Remove-Item -LiteralPath $ZipPath -Force
  }

  $items = @(
    'index.js',
    'router.js',
    'package.json',
    'package-lock.json',
    'config',
    'analytics',
    'learners',
    'chatbot-prompt',
    'inference',
    'instance',
    'live',
    'models',
    'pronunciation-dictionary',
    'shared',
    'studio',
    'training',
    'training-library',
    'training-audio',
    'transcribe',
    'upload',
    'voice-profile',
    'voice-profile-configs',
    'node_modules'
  )

  $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
  if ($tar) {
    & $tar.Source -a -cf $ZipPath @items
    if ($LASTEXITCODE -ne 0) {
      throw "tar failed with exit code $LASTEXITCODE"
    }
  } else {
    Compress-Archive -Path $items -DestinationPath $ZipPath -Force
  }
  Write-Host "Created $ZipPath"
} finally {
  Pop-Location
}
