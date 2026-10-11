#Requires -Version 5.1
<# Synchronize only the existing Vercel production env; deployment uses main Git integration.
   Required: existing CLI OAuth session (or VERCEL_TOKEN), VERCEL_PROJECT_ID, VERCEL_ORG_ID. #>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
if ($env:VERCEL_PROJECT_ID -ne 'prj_itSKGa2HAEj3UNHnsCdPQEF5nziE' -or -not $env:VERCEL_ORG_ID) {
  throw 'Specify the existing production VERCEL_PROJECT_ID and VERCEL_ORG_ID. No projects are created or linked.'
}
Push-Location $Root
try {
  $Branch = git branch --show-current
  if ($LASTEXITCODE -ne 0 -or $Branch -ne 'main') { throw 'Production synchronization requires main.' }
  if (-not $env:VERCEL_TOKEN) {
    $AuthPath = Join-Path $env:APPDATA 'com.vercel.cli/Data/auth.json'
    if (-not (Test-Path -LiteralPath $AuthPath)) { throw 'Existing Vercel CLI OAuth session is required.' }
    $env:VERCEL_TOKEN = (Get-Content -LiteralPath $AuthPath -Raw | ConvertFrom-Json).token
  }
  node (Join-Path $Root 'scripts/sync-vercel-env.mjs') --baseline
  if ($LASTEXITCODE -ne 0) { throw 'Production environment synchronization failed.' }
}
finally {
  Pop-Location
}
