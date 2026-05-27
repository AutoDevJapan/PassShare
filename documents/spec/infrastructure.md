# PassShare インフラ構成 (SSOT)

> 最終更新: 2026-05-27

## 概要

| レイヤー | プラットフォーム | 役割 |
|---------|----------------|------|
| Frontend | Vercel (`pass-share-frontend`) | Web ポータル（Vite） |
| Backend API | Railway (`pass-share-backend`) | ヘルスチェック / 将来の API |
| Database | Railway PostgreSQL | 環境別 DB |

## 環境マッピング

| 論理環境 | Vercel | Git ブランチ | Railway Environment | DB |
|---------|--------|-------------|---------------------|-----|
| **prd** | Production | `main` | `production` | `postgres-prd`（独立） |
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

## Railway 構成

```
PassShare (project)
├── pass-share-backend (service)
│   ├── production  → postgres-prd
│   ├── staging     → postgres-stg
│   ├── preview     → postgres-dev  (Variable Reference)
│   └── development → postgres-dev  (Variable Reference)
├── postgres-dev   (shared by preview + development)
├── postgres-stg
└── postgres-prd
```

各 backend 環境の Variables:

| 変数 | 値 |
|------|-----|
| `APP_ENV` | `prd` / `stg` / `preview` / `dev` |
| `DATABASE_URL` | 対応する Postgres の Variable Reference |
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

## 受入基準 (ATDD)

```gherkin
Given Vercel プロジェクト pass-share-frontend が GitHub main と連携している
When main ブランチに push する
Then frontend/ の Vite ビルドが成功し Production デプロイが完了する

Given Railway に postgres-dev / postgres-stg / postgres-prd が存在する
When preview 環境と development 環境の backend を起動する
Then 両方とも postgres-dev に接続できる

Given stg ブランチに push する
When Railway staging 環境にデプロイする
Then postgres-stg のみを参照し postgres-dev には接続しない
```

## 関連ドキュメント

- [ADR 001: Vercel + Railway 環境構成](../adr/001-vercel-railway-environments.md)
- [MVP 機能仕様](./feature-passshare-mvp.md)
