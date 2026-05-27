# PassShare インフラ構成 (SSOT)

> 最終更新: 2026-05-27（Railway プロジェクト再作成済み）

## Railway プロジェクト ID

| リソース | ID / URL |
|---------|----------|
| Project | `82730a82-b4d4-47d0-b578-f951465465fc` |
| Backend Service | `29539998-d8d9-4e41-82a5-f71ca223f96c` |
| postgres-dev | `43bc8dc5-c9c9-4fa3-9b7e-fd9079fd5c0a` |
| postgres-stg | `7234bbc3-c482-4009-9c88-03063521ffd1` |
| postgres-prd-v2 | `1509c487-cf03-4c50-8c9d-8781d53ee19a`（production 用） |
| postgres-prd（旧・未使用） | `610efe3e-86cf-4537-b4f6-4417b34bc229` — API トークンでは削除不可。Railway UI から手動削除可 |
| production env | `c1a3cdfc-9aa3-420d-b101-e6497714ccb9` |
| staging env | `c807d209-0624-4e13-aff6-61332cd0bb29` |
| preview env | `9bed9d58-203f-4bb5-bb17-858bcb3e2513` |
| development env | `0951c467-6bc3-418f-af75-a96e810f4946` |

### Backend URL

| 環境 | URL |
|------|-----|
| prd | https://pass-share-backend-production.up.railway.app |
| stg | https://pass-share-backend-staging.up.railway.app |
| preview | https://pass-share-backend-preview.up.railway.app |
| dev | https://pass-share-backend-development.up.railway.app |

## 概要

| レイヤー | プラットフォーム | 役割 |
|---------|----------------|------|
| Frontend | Vercel (`pass-share-frontend`) | Web ポータル（Vite） |
| Backend API | Railway (`pass-share-backend`) | Connect API `/v1` + ヘルスチェック |
| Database | Railway PostgreSQL | 環境別 DB |

## 環境マッピング

| 論理環境 | Vercel | Git ブランチ | Railway Environment | DB |
|---------|--------|-------------|---------------------|-----|
| **prd** | Production | `main` | `production` | `postgres-prd-v2`（独立） |
| **stg** | Preview (`stg` ブランチ) | `stg` | `staging` | `postgres-stg`（独立） |
| **preview** | Preview | PR / feature ブランチ | `preview` | `postgres-dev`（dev と共有） |
| **dev** | Development | `develop` | `development` | `postgres-dev`（preview と共有） |

### DB 共有ルール

- `preview` と `dev` は **同一 PostgreSQL インスタンス** (`postgres-dev`) を参照する
- `stg` / `prd` はそれぞれ独立した PostgreSQL インスタンスを使用する

## Vercel 環境変数

| 変数 | Production | Staging | Preview | Development |
|------|-----------|---------|---------|-------------|
| `VITE_APP_ENV` | `prd` | `stg`（stg ブランチ） | `preview` | `dev` |
| `VITE_API_BASE_URL` | Railway prd API URL | Railway stg API URL | Railway dev API URL | Railway dev API URL |

### Preview 環境変数の自動同期

CLI の Preview 向け `vercel env add` はブランチ指定を要求するため、REST API 経由で同期する。

| トリガー | ワークフロー | 動作 |
|---------|-------------|------|
| PR 作成 / 更新 | `sync-vercel-env.yml` | head ブランチ向け Preview env を upsert |
| `stg` / `develop` push | 同上 | 該当ブランチ向け Preview env を upsert |
| 手動 (`workflow_dispatch`) | 同上 | baseline + 全 Preview デフォルト + 全 remote ブランチ |

スクリプト: `scripts/sync-vercel-env.mjs`（`VERCEL_TOKEN` 必須、`upsert=true` + `gitBranch: null` で全 Preview ブランチにも対応）

## Railway 構成

```
PassShare (project)
├── pass-share-backend (service)
│   ├── production  → postgres-prd-v2
│   ├── staging     → postgres-stg
│   ├── preview     → postgres-dev  (Variable Reference)
│   └── development → postgres-dev  (Variable Reference)
├── postgres-dev   (shared by preview + development)
├── postgres-stg
└── postgres-prd-v2
```

各 backend 環境の Variables:

| 変数 | 値 |
|------|-----|
| `APP_ENV` | `prd` / `stg` / `preview` / `dev` |
| `DATABASE_URL` | 対応する Postgres の Variable Reference |
| `WEB_ORIGIN` | カスタムフロントドメイン（任意）。未設定時は `*.vercel.app` のみ CORS 許可（[#46](https://github.com/AutoDevJapan/PassShare/issues/46)） |
| `OP_CONNECT_TOKEN` | Connect API Bearer トークン（`/v1/*` 必須） |
| `PORT` | Railway が自動設定（省略可） |

## セットアップ手順

### 1. Railway（DB + API）

```powershell
# 初回のみログイン
railway login

# プロジェクト・DB・サービスを作成
.\scripts\setup-railway.ps1
```

### 2. Vercel（Frontend）

```powershell
.\scripts\setup-vercel.ps1
```

### 3. GitHub Secrets（CI 用）

| Secret | 説明 |
|--------|------|
| `RAILWAY_API_TOKEN` | Railway プロジェクトトークン |
| `RAILWAY_PROJECT_ID` | PassShare Railway プロジェクト ID |
| `RAILWAY_SERVICE_ID` | backend サービス ID |
| `RAILWAY_PREVIEW_ENV_ID` | preview 環境 ID |
| `RAILWAY_STAGING_ENV_ID` | staging 環境 ID |
| `RAILWAY_PRODUCTION_ENV_ID` | production 環境 ID |
| `VERCEL_TOKEN` | Vercel トークン |
| `VERCEL_ORG_ID` | `masashi-matsumotos-projects-c5830f3d` |
| `VERCEL_PROJECT_ID` | `prj_itSKGa2HAEj3UNHnsCdPQEF5nziE` |

### GitHub Actions デプロイ

- `railway up` は **リポジトリルート** から実行する（`working-directory: backend` 不可）
- Railway サービスの `rootDirectory` が `backend` のため、`backend/` だけをアップロードするとビルドが失敗する
- **backend の本番デプロイは GitHub Actions のみ** を使用する（Railway 側の GitHub 自動デプロイは無効化済み）

### 旧 Railway プロジェクト（profound-growth）

| 項目 | 値 |
|------|-----|
| Project ID | `123ba0fb-eac6-479e-bd7e-79210bfbd968`（**未使用・削除候補**） |
| 症状 | main push 時に `profound-growth - PassShare` チェックが `Deployment failed` になる |
| 原因 | `rootDirectory` 未設定のままモノレポ全体をビルドしようとする |
| 対応 | 2026-05-27: サービス `7f409e25-...` の GitHub 連携を `serviceDisconnect` で解除済み |

Railway UI から旧プロジェクト自体を削除してよい（現行は `82730a82-...` の PassShare プロジェクト）。

## 受入基準 (ATDD)

```gherkin
Given Vercel プロジェクト pass-share-frontend が GitHub main と連携している
When main ブランチに push する
Then frontend/ の Vite ビルドが成功し Production デプロイが完了する

Given Railway に postgres-dev / postgres-stg / postgres-prd-v2 が存在する
When preview 環境と development 環境の backend を起動する
Then 両方とも postgres-dev に接続できる

Given stg ブランチに push する
When Railway staging 環境にデプロイする
Then postgres-stg のみを参照し postgres-dev には接続しない
```

## 関連ドキュメント

- [ADR 001: Vercel + Railway 環境構成](../adr/001-vercel-railway-environments.md)
- [MVP 機能仕様](./feature-passshare-mvp.md)
