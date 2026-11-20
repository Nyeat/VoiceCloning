$ErrorActionPreference = 'Stop'

$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
$OutDir = Join-Path $Root '.dist'
$ZipPath = Join-Path $OutDir 'voice-cloning-function-url.zip'

Push-Location $Root
try {
  if (-not (Test-Path 'node_modules')) {
    npm ci
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
