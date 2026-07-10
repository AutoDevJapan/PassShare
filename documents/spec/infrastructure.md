# PassShare インフラ構成 (SSOT)

> 最終更新: 2026-05-30（dev/preview: seed データ、stg のみ prd レプリカ refresh）

## Railway プロジェクト ID

| リソース | ID / URL |
|---------|----------|
| Project | `82730a82-b4d4-47d0-b578-f951465465fc` |
| Backend Service | `29539998-d8d9-4e41-82a5-f71ca223f96c` |
| postgres-dev | `43bc8dc5-c9c9-4fa3-9b7e-fd9079fd5c0a` |
| postgres-stg | `7234bbc3-c482-4009-9c88-03063521ffd1` |
| postgres-prd-v2 | `1509c487-cf03-4c50-8c9d-8781d53ee19a`（production 用） |
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

| 論理環境 | Vercel | Git ブランチ | Railway Environment | DB | Backend デプロイ |
|---------|--------|-------------|---------------------|-----|-----------------|
| **prd** | Production | —（手動 promote） | `production` | `postgres-prd-v2`（独立） | **手動** `deploy-prd.yml` |
| **stg** | Preview (`stg` ブランチ) | `stg` | `staging` | `postgres-stg`（デプロイ時 prd から refresh） | **手動** `deploy-stg.yml` |
| **preview** | Preview | PR / feature ブランチ | `preview` | `postgres-dev`（dev と共有） | PR 時 `deploy-preview.yml` |
| **dev** | Development | **`main`（検知）** | `development` | `postgres-dev`（**seed データ**） | **`main` push 自動** `deploy-dev.yml` |

> SSOT: [ADR 008](../adr/008-deploy-pipeline-dev-first.md) — `main` マージは dev Backend デプロイのみ。prd 自動デプロイは廃止。

### DB 共有ルール

- `preview` と `dev` は **同一 PostgreSQL インスタンス** (`postgres-dev`) を参照する
- `stg` / `prd` はそれぞれ独立した PostgreSQL インスタンスを使用する
- **local / preview / dev** は `backend/src/db/dev-seed.js` の **同一 seed データ**（デモユーザー・パスワードボックス・サンプルアイテム）を使用する。Backend 起動時に idempotent に適用
- **stg デプロイ前**に `scripts/railway-db-replica.mjs` で prd DB を refresh する（レプリカブランチ `replica-{run_id}-{sha}`）
- **prd デプロイ前**に prd DB の snapshot を取得し GitHub artifact に保存する
- CI（GitHub Actions）から stg 向け `pg_dump` / `pg_restore` は **Postgres サービスの TCP proxy** 経由（`DATABASE_PUBLIC_URL` または Railway GraphQL `tcpProxies` + `POSTGRES_*`）。backend の `DATABASE_URL`（`.railway.internal`）は CI から到達不可
- refresh 手順（stg のみ）: `pg_dump`（prd）→ 対象 DB で `DROP SCHEMA public CASCADE` → `pg_restore`（`--single-transaction --exit-on-error`）
- 各 Postgres サービス（`postgres-dev` / `postgres-stg` / `postgres-prd-v2`）には **TCP proxy（port 5432）** が stg refresh 用に必要。未設定時は `railway-db-replica.mjs` が Railway API で自動作成する

### Dev seed（local / preview / dev）

| 項目 | 値 |
|------|-----|
| Email | `dev@passshare.local` |
| Password | `DevPassShare1!` |
| Password box ID | `abcdefghijklmnopqrstuvwxyz` |
| Password box name | `Demo Password Box` |

手動適用: `APP_ENV=dev DATABASE_URL=... pnpm --dir backend run db:seed`

## Vercel 環境変数

| 変数 | Production | Staging | Preview | Development |
|------|-----------|---------|---------|-------------|
| `VITE_APP_ENV` | `prd` | `stg`（stg ブランチ） | `preview` | `dev` |
| `VITE_API_BASE_URL` | Railway prd API URL | Railway stg API URL | Railway dev API URL | Railway dev API URL |

### Preview 環境変数の自動同期

CLI の Preview 向け `vercel env add` はブランチ指定を要求するため、REST API 経由で同期する。

| トリガー | ワークフロー | 動作 |
|---------|-------------|------|
| PR 作成 / 更新 | `sync-vercel-env.yml` | head ブランチ向け Preview env を upsert（Dependabot PR は secrets 非注入のため skip） |
| `stg` / `develop` push | 同上 | 該当ブランチ向け Preview env を upsert |
| 手動 (`workflow_dispatch`) | 同上 | baseline + 全 Preview デフォルト + 全 remote ブランチ |

スクリプト: `scripts/sync-vercel-env.mjs`（`VERCEL_TOKEN` 必須、`upsert=true` + `gitBranch: null` で全 Preview ブランチにも対応）

### Vercel ビルド（monorepo）

Root Directory は `frontend`。`@passshare/connect`（`file:../packages/connect-js`）を解決するため、`frontend/vercel.json` の `installCommand` で connect-js を先に install + build してから frontend を install する。

### セキュリティ監査（CI）

| トリガー | ワークフロー | 動作 |
|---------|-------------|------|
| PR / main push | `security-audit.yml` | `cargo audit` + 各パッケージ `pnpm audit --audit-level=high`（pnpm-lock がある場合） |
| PR / main push | `quality-gate.yml` | 上記 + 統合ゲート（job `security`） |

SSOT: [vulnerability-sla.md](../security/vulnerability-sla.md), [audit-checklist.md](../security/audit-checklist.md)

### Dependabot（npm）

| 対象 | ポリシー |
|------|---------|
| UI workspace（`frontend/`, `apps/desktop/`, `apps/mobile/`, `packages/extension/`）の `vite` | **メジャー upgrade は ignore** — 4 workspace を同一 PR で統合対応（Issue 起票 → 一括 PR） |
| 同上の `@vitejs/plugin-react` | **メジャー upgrade は ignore** — 同上 |
| 上記以外 | daily / weekly スケジュールで通常どおり PR |

### Dependabot（cargo）

| 対象 | ポリシー |
|------|---------|
| `rand` | **メジャー upgrade は ignore** — API 移行（例: `thread_rng` → `rng`）を Issue/PR で対応 |

設定: `.github/dependabot.yml`

### 統合 Quality Gate（CI）

| トリガー | ワークフロー | 動作 |
|---------|-------------|------|
| PR / main push | `quality-gate.yml` | Rust Docker + Docker E2E (PG) + Backend + Connect SDK + Web E2E + Extension + Desktop/Mobile smoke + Security + Benchmark → job `gate` |

個別ワークフロー（`backend-test.yml`, `frontend-e2e.yml`, `desktop-build.yml` 等）は引き続き並行実行。Quality Gate が Epic #36 の完了条件 SSOT。

### Docker E2E（CI）

| トリガー | ワークフロー | 動作 |
|---------|-------------|------|
| PR / main push | `quality-gate.yml` | `docker compose run backend-e2e` — PostgreSQL + Connect API + op-cli E2E |

```bash
docker compose -f docker/docker-compose.test.yml run --rm backend-e2e
```

### ステージング smoke

| トリガー | ワークフロー | 動作 |
|---------|-------------|------|
| 手動 | `stg-smoke.yml` | `scripts/stg-smoke.mjs` — stg Backend health + Connect |

SSOT: [staging-acceptance.md](../runbooks/staging-acceptance.md)

### Web ドキュメント・法務（Epic #37）

| パス | 内容 |
|------|------|
| `/docs` | ドキュメントハブ |
| `/docs/user-guide` | ユーザーガイド |
| `/docs/extension` | 拡張機能インストール |
| `/faq` | FAQ |
| `/terms` | 利用規約（草案） |
| `/privacy` | プライバシーポリシー（草案） |

SSOT: [documents/guides/](../guides/), [documents/legal/](../legal/)

### Backend テスト（CI）

| トリガー | ワークフロー | 動作 |
|---------|-------------|------|
| PR / main push | `backend-test.yml` | pnpm test + migrate:verify + Connect 型 drift チェック |

SSOT: [audit-checklist.md](../security/audit-checklist.md), [connect-api-gap-analysis.md](./connect-api-gap-analysis.md)

### Frontend E2E（CI）

| トリガー | ワークフロー | 動作 |
|---------|-------------|------|
| PR / main push | `frontend-e2e.yml` | Playwright signup → CRUD → logout + frontend build |

### Desktop ビルド（CI）

| トリガー | ワークフロー | 動作 |
|---------|-------------|------|
| PR / main push | `desktop-build.yml` | Rust smoke + Tauri 3 OS ビルド（MSI/DMG/AppImage/deb） |

SSOT: [desktop-release.md](../runbooks/desktop-release.md)

### Mobile ビルド（CI）

| トリガー | ワークフロー | 動作 |
|---------|-------------|------|
| PR / main push | `mobile-build.yml` | Rust smoke + mobile frontend build + mobile auth API tests |
| PR / main push | `extension-build.yml` | Extension unit tests + MV3 build + extension auth API + Playwright popup smoke |

SSOT: [mobile-store-release.md](../runbooks/mobile-store-release.md)

### Extension ビルド（CI）

| トリガー | ワークフロー | 動作 |
|---------|-------------|------|
| PR / main push | `extension-build.yml` | Extension unit tests + MV3 build + extension auth API + Playwright popup smoke |

SSOT: [extension-store-release.md](../runbooks/extension-store-release.md)

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
| `WEB_ORIGIN` | カスタムフロントドメイン（任意）。未設定時はプロジェクト prefix に束縛した Vercel オリジン（`pass-share-frontend.vercel.app` と `pass-share-frontend-git-*` プレビュー）のみ CORS 許可。任意の `*.vercel.app` は信頼しない（[#46](https://github.com/AutoDevJapan/PassShare/issues/46), [#315](https://github.com/AutoDevJapan/PassShare/issues/315)） |
| `OP_CONNECT_TOKEN` | Connect API Bearer トークン（`/v1/*` 必須） |
| `TRUST_PROXY_HOPS` | 信頼するフロントプロキシのホップ数（`req.ip` 算出用）。省略時は `local`=0 / それ以外=1（Railway エッジ 1 段）。生の `X-Forwarded-For` は信頼せず per-IP スロットルのバイパスを防ぐ（[#316](https://github.com/AutoDevJapan/PassShare/issues/316)）。プロキシ段数変更時のみ設定 |
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
| `RAILWAY_API_TOKEN` | Railway アカウント / ワークスペーストークン（GraphQL preflight 等） |
| `RAILWAY_PROJECT_TOKEN` | （推奨）Preview 環境スコープの **Project Token** — `railway up` 用。未設定時は `RAILWAY_API_TOKEN` + `railway link` にフォールバック |
| `RAILWAY_PROJECT_ID` | PassShare Railway プロジェクト ID |
| `RAILWAY_SERVICE_ID` | backend サービス ID |
| `RAILWAY_PREVIEW_ENV_ID` | preview 環境 ID |
| `RAILWAY_DEVELOPMENT_ENV_ID` | development 環境 ID（`deploy-dev.yml` 必須） |
| `RAILWAY_STAGING_ENV_ID` | staging 環境 ID |
| `RAILWAY_PRODUCTION_ENV_ID` | production 環境 ID |
| `RAILWAY_DATABASE_PUBLIC_URL_PRD` | （任意）CI 用 prd Postgres TCP proxy URL — API 解決失敗時の override |
| `RAILWAY_DATABASE_PUBLIC_URL_DEV` | （任意）CI 用 dev Postgres TCP proxy URL |
| `RAILWAY_DATABASE_PUBLIC_URL_STG` | （任意）CI 用 stg Postgres TCP proxy URL |
| `VERCEL_TOKEN` | Vercel トークン |
| `VERCEL_ORG_ID` | `masashi-matsumotos-projects-c5830f3d` |
| `VERCEL_PROJECT_ID` | `prj_itSKGa2HAEj3UNHnsCdPQEF5nziE` |
| `STG_OP_CONNECT_TOKEN` | stg Connect API Bearer（`stg-smoke.mjs` 任意） |
| `STG_WEB_URL` | stg / Preview Web URL（`stg-web-smoke.mjs` — `run_web_ui: true` 時） |

### 秘密情報ローテーション

Railway / Vercel / GitHub Secrets のローテーション手順と Smoke テストは [secret-rotation Runbook](../runbooks/secret-rotation.md)（Issue [#47](https://github.com/AutoDevJapan/PassShare/issues/47)）を参照。

### GitHub Actions デプロイ

| ワークフロー | トリガー | 先 | DB 前処理 |
|-------------|---------|-----|----------|
| `deploy-dev.yml` | `main` push | Railway development | prd → dev refresh |
| `deploy-stg.yml` | 手動（`deploy-stg` 入力） | Railway staging | prd → stg refresh |
| `deploy-prd.yml` | 手動（`deploy-prd` 入力） | Railway production | prd snapshot |
| `deploy-preview.yml` | PR（Dependabot 除く） | Railway preview | なし（`RAILWAY_PROJECT_TOKEN` 必須 — 未設定時 skip） |

- `railway up` は **リポジトリルート** から実行する（`working-directory: backend` 不可）
- Railway サービスの `rootDirectory` が `backend` のため、`backend/` だけをアップロードするとビルドが失敗する
- **backend の本番デプロイは GitHub Actions のみ** を使用する（Railway 側の GitHub 自動デプロイは無効化済み）
- デプロイ CI は `scripts/railway-deploy-with-replica.sh` → `scripts/railway-deploy-ci.sh`（`railway-deploy-preflight.mjs` + DB replica + `railway up --detach` + 最大 3 回リトライ + デプロイ後 `/health/db` smoke）。`--ci` は Metal builder 上で export 直後に誤 fail するため使わない。
- **Preview deploy**（`deploy-preview.yml`）は `@railway/cli@3.20.2` を使用（account token + `--project` フラグ）。v4 は Project Token 必須のため preview のみ v3 を pin。
- `RAILWAY_TOKEN` は `RAILWAY_PROJECT_TOKEN`（推奨）または `RAILWAY_API_TOKEN` から export する（#208）。

### デプロイ失敗 vs DB 障害の切り分け

| 症状 | 原因 | 確認方法 |
|------|------|----------|
| CI で `Failed to upload code with status code 404` | `RAILWAY_API_TOKEN` のみ設定で CLI が未認証（`RAILWAY_TOKEN` 未 export） | `railway-deploy-ci.sh` が `RAILWAY_TOKEN` を export。`railway-deploy-preflight.mjs` で project/service/environment を事前検証 |
| CI で `Project Token not found` | Account token を `railway up` に使用 | Preview 用 **Project Token** を `RAILWAY_PROJECT_TOKEN` secret に設定（Railway → Project → Settings → Tokens → preview 環境）。未設定時は `deploy-preview.yml` が skip（#208） |
| CI で `load metadata for docker.io/...` 後に `Deploy failed` | Railway ビルド（Docker Hub メタデータ取得）の一時失敗 | Railway ビルドログ。`/health/db` はデプロイ前の旧リビジョンのまま 200 のことがある |
| `/health` 200 だが `/health/db` 503 `database: unreachable` | `DATABASE_URL` 未設定・Variable Reference 切れ・Postgres 停止 | Railway Variables + Postgres サービス状態 |
| `/health/db` 503 `database: not_configured` | backend に `DATABASE_URL` がない | preview/stg/prd 各環境の Variable Reference を確認 |
| `migrate:verify` pass だが DB 不通 | **正常** — `migrate:verify` は `schema.js` の静的検証のみ（ live DB 非接続） | デプロイ後 smoke: `curl .../health/db` |

全環境 smoke（手動）:

```powershell
@(
  "https://pass-share-backend-production.up.railway.app/health/db",
  "https://pass-share-backend-staging.up.railway.app/health/db",
  "https://pass-share-backend-preview.up.railway.app/health/db",
  "https://pass-share-backend-development.up.railway.app/health/db"
) | ForEach-Object { Invoke-RestMethod $_ }
```

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

Given stg 受入が完了している
When GitHub Actions で deploy-stg.yml を手動実行する
Then postgres-stg が prd レプリカで refresh され staging backend がデプロイされる

Given stg 受入と deploy-stg が完了している
When GitHub Actions で deploy-prd.yml を手動実行する
Then prd DB snapshot が作成され production backend がデプロイされる

Given main ブランチに push する
When deploy-dev.yml が実行される
Then development backend がデプロイされ postgres-dev に dev seed が適用される（production にはデプロイしない、prd レプリカ refresh は行わない）
```

## 関連ドキュメント

- [ADR 001: Vercel + Railway 環境構成](../adr/001-vercel-railway-environments.md)
- [MVP 機能仕様](./feature-passshare-mvp.md)
