#Requires -Version 5.1
<#
.SYNOPSIS
  PassShare Vercel プロジェクトをリンクし環境変数を設定する。

  事前条件:
  - npx vercel login 済み、または VERCEL_TOKEN 環境変数
  - Node.js 18+
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Split-Path -Parent $PSScriptRoot
$FrontendDir = Join-Path $Root "frontend"
$SyncScript = Join-Path $Root "scripts/sync-vercel-env.mjs"
$Scope = "masashi-matsumotos-projects-c5830f3d"
$ProjectId = "prj_itSKGa2HAEj3UNHnsCdPQEF5nziE"

function Get-VercelToken {
  if ($env:VERCEL_TOKEN) {
    return $env:VERCEL_TOKEN
  }

  $AuthPath = Join-Path $env:APPDATA "com.vercel.cli\Data\auth.json"
  if (Test-Path $AuthPath) {
    return (Get-Content $AuthPath -Raw | ConvertFrom-Json).token
  }

  throw "VERCEL_TOKEN is not set and Vercel auth.json was not found. Run 'npx vercel login' first."
}

Push-Location $FrontendDir
try {
  $env:VERCEL_TOKEN = Get-VercelToken
  $env:VERCEL_PROJECT_ID = $ProjectId
  $env:VERCEL_TEAM_SLUG = $Scope

  Write-Host "Linking Vercel project..."
  npx vercel link --yes --scope $Scope --project $ProjectId

  Write-Host "Syncing environment variables via REST API..."
  node $SyncScript --baseline --all-preview-defaults --sync-remote-branches

  Write-Host "Building frontend..."
  npm install
  npm run build

  Write-Host "Deploying preview..."
  npx vercel deploy --scope $Scope

  Write-Host @"

Vercel セットアップ完了。

Preview ブランチ向け env は PR 作成時に GitHub Actions (sync-vercel-env) が自動同期します。
手動で全ブランチを再同期する場合:
  node scripts/sync-vercel-env.mjs --baseline --all-preview-defaults --sync-remote-branches
"@
}
finally {
  Pop-Location
}
