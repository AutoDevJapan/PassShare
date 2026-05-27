#Requires -Version 5.1
<#
.SYNOPSIS
  PassShare Railway プロジェクトを再作成する。

.DESCRIPTION
  - PassShare プロジェクト
  - postgres-dev / postgres-stg / postgres-prd
  - pass-share-backend サービス（4 環境）
  preview + development は postgres-dev を共有する。

  事前条件: railway login 済み
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Split-Path -Parent $PSScriptRoot
$BackendDir = Join-Path $Root "backend"

function Assert-RailwayAuth {
  railway whoami | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Railway に未ログインです。`railway login` を実行してください。"
  }
}

function New-RailwayProject {
  param([string]$Name)
  Write-Host "Creating Railway project: $Name"
  railway init --name $Name
}

function Add-Postgres {
  param([string]$ServiceName)
  Write-Host "Adding PostgreSQL: $ServiceName"
  railway add --database postgres --service $ServiceName
}

Push-Location $BackendDir
try {
  Assert-RailwayAuth

  if (-not (Test-Path ".railway")) {
    New-RailwayProject -Name "PassShare"
  }

  Write-Host @"

次の手順を Railway ダッシュボードで完了してください:

1. サービス追加
   - pass-share-backend (Empty Service, Root: backend/)
   - postgres-dev (PostgreSQL)
   - postgres-stg (PostgreSQL)
   - postgres-prd (PostgreSQL)

2. 環境作成 (Settings > Environments)
   - production (default)
   - staging
   - preview
   - development

3. backend 各環境の Variables
   - APP_ENV: prd / stg / preview / dev
   - DATABASE_URL: Variable Reference
     * production  -> postgres-prd
     * staging     -> postgres-stg
     * preview     -> postgres-dev
     * development -> postgres-dev

4. GitHub Secrets に ID を登録
   - RAILWAY_PROJECT_ID
   - RAILWAY_SERVICE_ID
   - RAILWAY_PREVIEW_ENV_ID
   - RAILWAY_STAGING_ENV_ID
   - RAILWAY_PRODUCTION_ENV_ID
   - RAILWAY_API_TOKEN

5. 初回デプロイ
   railway up --environment production
"@

  Write-Host "`nDeploying backend to production (初回)..."
  railway up --detach
}
finally {
  Pop-Location
}
