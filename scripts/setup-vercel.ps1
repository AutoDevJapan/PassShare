#Requires -Version 5.1
<#
.SYNOPSIS
  PassShare Vercel プロジェクトをリンクし環境変数を設定する。

  事前条件: npx vercel login 済み
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Split-Path -Parent $PSScriptRoot
$FrontendDir = Join-Path $Root "frontend"
$Scope = "masashi-matsumotos-projects-c5830f3d"
$ProjectId = "prj_itSKGa2HAEj3UNHnsCdPQEF5nziE"

function Add-VercelEnv {
  param(
    [string]$Key,
    [string]$Value,
    [string[]]$Targets
  )
  foreach ($target in $Targets) {
    Write-Host "Setting $Key for $target"
    $Value | npx vercel env add $Key $target --scope $Scope --force 2>$null
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "Failed to set $Key for $target (may already exist)"
    }
  }
}

Push-Location $FrontendDir
try {
  Write-Host "Linking Vercel project..."
  npx vercel link --yes --scope $Scope --project $ProjectId

  Write-Host "Setting environment variables..."
  Add-VercelEnv -Key "VITE_APP_ENV" -Value "prd" -Targets @("production")
  Add-VercelEnv -Key "VITE_APP_ENV" -Value "stg" -Targets @("staging")
  Add-VercelEnv -Key "VITE_APP_ENV" -Value "preview" -Targets @("preview")
  Add-VercelEnv -Key "VITE_APP_ENV" -Value "dev" -Targets @("development")

  # API URLs: Railway デプロイ後に実 URL に更新すること
  $placeholderDev = "https://pass-share-backend-dev.up.railway.app"
  $placeholderStg = "https://pass-share-backend-stg.up.railway.app"
  $placeholderPrd = "https://pass-share-backend-prd.up.railway.app"

  Add-VercelEnv -Key "VITE_API_BASE_URL" -Value $placeholderDev -Targets @("preview", "development")
  Add-VercelEnv -Key "VITE_API_BASE_URL" -Value $placeholderStg -Targets @("staging")
  Add-VercelEnv -Key "VITE_API_BASE_URL" -Value $placeholderPrd -Targets @("production")

  Write-Host "Building frontend..."
  npm install
  npm run build

  Write-Host "Deploying preview..."
  npx vercel deploy --scope $Scope

  Write-Host @"

Vercel セットアップ完了。

残タスク:
1. Railway backend URL が確定したら VITE_API_BASE_URL を更新
2. Vercel Custom Environment 'staging' を stg ブランチに紐付け
3. develop ブランチを Development 環境に紐付け
"@
}
finally {
  Pop-Location
}
