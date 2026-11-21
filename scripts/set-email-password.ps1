# Sets EMAIL_PASS (an SMTP app password) on the main Lambda of an environment,
# merged into its live environment so nothing else changes. The password is
# typed into a hidden prompt; it is never printed, logged or written to disk.
#
#   .\scripts\set-email-password.ps1 -Env staging
#   .\scripts\set-email-password.ps1 -Env dev
#
# Needs AWS credentials for the project role (the same ones deploy-lambda.ps1 uses).
# Gmail: create an app password at https://myaccount.google.com/apppasswords
# (needs 2-Step Verification on the account); paste the 16 letters, no spaces.
param(
  [Parameter(Mandatory)][ValidateSet('dev','staging')] [string]$Env
)
$ErrorActionPreference = 'Stop'
$cfg = (Get-Content "$PSScriptRoot\deploy.config.json" -Raw | ConvertFrom-Json).$Env
$fn = $cfg.lambdaFunction
$region = $cfg.region

$secure = Read-Host -AsSecureString "App password for EMAIL_USER on $Env (input hidden)"
$plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
$plain = ($plain -replace '\s', '')
if (-not $plain) { throw 'No password entered' }

$current = aws lambda get-function-configuration --region $region --function-name $fn --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "get-function-configuration failed for $fn" }
$vars = @{}
foreach ($p in $current.Environment.Variables.PSObject.Properties) { $vars[$p.Name] = [string]$p.Value }
$vars['EMAIL_PASS'] = $plain

$file = [IO.Path]::GetTempFileName()
try {
  @{ Variables = $vars } | ConvertTo-Json -Depth 4 -Compress | Set-Content -Path $file -Encoding ascii
  aws lambda update-function-configuration --region $region --function-name $fn --environment "file://$file" --query LastModified --output text | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'update-function-configuration failed' }
} finally {
  Remove-Item $file -Force -ErrorAction SilentlyContinue
  $plain = $null
}
Write-Host "EMAIL_PASS set on $fn ($Env). Use 'Send me a test email' on the Voice Studio overview to check it."
