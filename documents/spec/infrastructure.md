# PassShare インフラ構成 (SSOT)

> 最終更新: 2026-10-06（prd フロントは custom domain `pass-share.bm1314.net` で配信、[#374](https://github.com/AutoDevJapan/PassShare/issues/374)）

## Railway プロジェクト ID

| リソース | ID / URL |
|---------|----------|
| Project | `82730a82-b4d4-47d0-b578-f951465465fc` |
| Backend Service | `29539998-d8d9-4e41-82a5-f71ca223f96c` |
| postgres-dev | `43bc8dc5-c9c9-4fa3-9b7e-fd9079fd5c0a` |
| postgres-stg | `7234bbc3-c482-4009-9c88-03063521ffd1` |
| 本番の現稼働DB | `4fdfda2d-ed50-4396-9797-25ea7720f720`、passshare-postgres-preserved-1177（PG18、永続volume） |
| postgres-prd-v2 | `1509c487-cf03-4c50-8c9d-8781d53ee19a`（旧本番、切替後の更新は同期されない） |
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

## Backend ヘルスチェック / コールドスタート耐性（#368）

### ヘルスチェックエンドポイント

| パス | 種別 | 挙動 |
|------|------|------|
| `/health` | liveness | DB 非依存で常に 200。Railway の `healthcheckPath`（`backend/railway.toml`）に設定。 |
| `/health/db` | readiness | `SELECT 1` を実行し、DB 到達可否で 200 / 503 を返す。 |

### 事象と根本原因

本番フロント初回ロード時、`/api/auth/csrf` が Railway エッジ（`railway-hikari`）から数回 **503** を返し、リトライで 200 に回復する事象が観測された（[#368](https://github.com/AutoDevJapan/PassShare/issues/368)）。原因はアイドル後 / 再デプロイ直後の **コンテナ・コールドスタート**で、healthy replica が存在しない一瞬の窓でエッジが 503 を返すため。この窓は `app.listen` より前に発生するため、**バックエンドのコード単体ではこの 503 窓そのものを消せない**。

### アプリ側で実装済みの緩和

- **フロント: バックオフ付きリトライ**（`frontend/src/lib/auth-api.ts` の `fetchWithRetry`）— transient `502 / 503 / 504` は全メソッドで、ネットワーク例外は冪等な GET のみ、指数バックオフ + フルジッターで最大 4 回リトライして 503 窓を吸収する。ユーザに `Failed to fetch` を見せずに初回リクエストを成立させる。
- **バックエンド: DB プールウォームアップ**（`backend/src/app.js` の `warmUpPool`）— 起動時に best-effort で `SELECT 1` を短いリトライ付きで実行し、コールドスタート直後の初回 DB リクエストが接続確立レイテンシを払わずに済むようにする。失敗しても非 fatal（liveness は維持される）。

### 純インフラ側の推奨（本タスク対象外・手動対応が必要）

- **prd Backend サービスの min replicas を 1 以上にする / app sleep を無効化する** — コールドスタート窓そのものを恒久的に解消する唯一の手段。実インフラ操作は本タスクのスコープ外のため、別途手動対応が必要（Railway の service settings）。
- （任意）`healthcheckPath` を readiness（`/health/db`）へ切替えると、DB 接続確立後にのみトラフィックが流れる。ただし DB の一過性障害でサービス全体が unhealthy 判定 → 再起動ループに陥るリスクがあるため、現状は liveness（`/health`）を維持する。

## 環境マッピング

| 論理環境 | Vercel | Git ブランチ | Railway Environment | DB | Backend デプロイ |
|---------|--------|-------------|---------------------|-----|-----------------|
| **prd** | Production | —（手動 promote） | `production` | `passshare-postgres-preserved-1177`（永続PG18） | 現設定と保全を確認した手動配備 |
| **stg** | Preview (`stg` ブランチ) | `stg` | `staging` | `postgres-stg`（デプロイ時 prd から refresh） | **手動** `deploy-stg.yml` |
| **preview** | Preview | PR / feature ブランチ | `preview` | `postgres-dev`（dev と共有） | PR 時 `deploy-preview.yml` |
| **dev** | Development | **`main`（検知）** | `development` | `postgres-dev`（**seed データ**） | **`main` push 自動** `deploy-dev.yml` |

> SSOT: [ADR 008](../adr/008-deploy-pipeline-dev-first.md) — `main` マージは dev Backend デプロイのみ。prd 自動デプロイは廃止。

### DB 共有ルール

- `preview` と `dev` は **同一 PostgreSQL インスタンス** (`postgres-dev`) を参照する
- `stg` / `prd` はそれぞれ独立した PostgreSQL インスタンスを使用する
- **local / preview / dev** は `backend/src/db/dev-seed.js` の **同一 seed データ**（デモユーザー・パスワードボックス・サンプルアイテム）を使用する。Backend 起動時に idempotent に適用
- **stg デプロイ前**に `scripts/railway-db-replica.mjs` で prd DB を refresh する（レプリカブランチ `replica-{run_id}-{sha}`）
- **prd配備の開始前**に現稼働DBのバックアップ取得・対象・由来・復元可能範囲を確認する。実dumpをGitHub artifactへ保存しない。旧ジョブ内の一時snapshotを永続保全と数えない
- CI（GitHub Actions）から stg 向け `pg_dump` / `pg_restore` は **Postgres サービスの TCP proxy** 経由（`DATABASE_PUBLIC_URL` または Railway GraphQL `tcpProxies` + `POSTGRES_*`）。backend の `DATABASE_URL`（`.railway.internal`）は CI から到達不可
- refresh 手順（stg のみ）: `pg_dump`（prd）→ 対象 DB で `DROP SCHEMA public CASCADE` → `pg_restore`（`--single-transaction --exit-on-error`）
- 各 Postgres サービス（`postgres-dev` / `postgres-stg` / `postgres-prd-v2`）には **TCP proxy（port 5432）** が stg refresh 用に必要。未設定時は `railway-db-replica.mjs` が Railway API で自動作成する

### ログイン throttle / lockout ストア（#378）

- ログイン失敗ロックアウト（`login_failures`）と per-IP スロットル（`login_ip_requests`）の状態は **既存の PostgreSQL を流用**して共有する。**Redis は追加しない**（新規インフラ依存を増やさない方針）
- これにより backend を水平スケールしても **多重インスタンス間でロックアウト/スロットルが共有**され、デプロイ・再起動をまたいで **状態が維持**される
- ストア選択は `backend/src/auth/login-guard-store.js` が担う。既定は `memory-*` / `pg-*` の auth store と同じく **`DATABASE_URL` の有無**（pool あり → pg / なし → memory）。環境変数 `LOGIN_GUARD_STORE`（`pg` | `memory`）で明示上書き可能
- **local / test はインメモリのまま**（依存追加なしで動作）。TTL は `LOGIN_LOCKOUT_MS` / `LOGIN_IP_WINDOW_MS` に対応し、`expires_at` フィルタ＋opportunistic sweep でストア側失効
- テーブルは `backend/src/db/auth-schema.js`（auth store migration）で作成。実 DB を使う共有検証は `backend/test/login-guard-pg.integration.test.js`（Docker backend-e2e で実行）

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
| `VITE_API_BASE_URL` | `/backend/prd` | `/backend/stg` | `/backend/dev` | `/backend/dev` |

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
| PR / main push / nightly schedule | `security-audit.yml` | `cargo audit` + 各パッケージ `pnpm audit --audit-level=high`（pnpm-lock がある場合） |

依存 advisory 監査は `security-audit.yml` の単一 SSOT（`quality-gate.yml` の重複 `security` job は削除、#325）。新規 CVE 公開で無関係 PR が赤くならないよう **PR では非ブロッキング（`continue-on-error`）**、**main push + nightly schedule では hard gate**。`cargo-audit` は SHA-pin した `taiki-e/install-action` のプリビルドバイナリで導入（ソースビルドの crates.io flakiness 回避）。

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
| PR / main push | `quality-gate.yml` | Rust Docker + Docker E2E (PG) + Backend + Connect SDK + Web E2E + Extension + Desktop/Mobile smoke + Benchmark → job `gate` |

`quality-gate.yml` が Backend / Connect / Web E2E テストの単一 SSOT（重複ワークフローは統合済み、#325）。依存 advisory 監査は `security-audit.yml` に集約（PR は非ブロッキング、main + nightly schedule で hard gate）。`desktop-build.yml` 等のビルド系ワークフローは引き続き並行実行。Quality Gate が Epic #36 の完了条件 SSOT。

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
| PR / main push | `quality-gate.yml`（jobs `backend` / `connect-types` / `connect-js`） | pnpm test + migrate:verify + Connect 型 drift チェック |

SSOT: [audit-checklist.md](../security/audit-checklist.md), [connect-api-gap-analysis.md](./connect-api-gap-analysis.md)

### Frontend E2E（CI）

| トリガー | ワークフロー | 動作 |
|---------|-------------|------|
| PR / main push | `quality-gate.yml`（job `frontend`） | Playwright signup → CRUD → logout + frontend build |

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
│   ├── production  → passshare-postgres-preserved-1177
│   ├── staging     → postgres-stg
│   ├── preview     → postgres-dev  (Variable Reference)
│   └── development → postgres-dev  (Variable Reference)
├── postgres-dev   (shared by preview + development)
├── postgres-stg
├── passshare-postgres-preserved-1177 (current production)
└── postgres-prd-v2 (old source; no updates synchronized)
```

各 backend 環境の Variables:

| 変数 | 値 |
|------|-----|
| `APP_ENV` | `prd` / `stg` / `preview` / `dev` |
| `DATABASE_URL` | 対応する Postgres の Variable Reference |
| `WEB_ORIGIN` | カスタムフロントドメイン。**prd はカスタムドメイン `https://pass-share.bm1314.net` を設定して配信**（bare `pass-share-frontend.vercel.app` alias は現状デプロイ未アタッチで 404、[#374](https://github.com/AutoDevJapan/PassShare/issues/374)）。未設定時はプロジェクト prefix に束縛した Vercel オリジン（`pass-share-frontend.vercel.app` と `pass-share-frontend-git-*` プレビュー）のみ CORS 許可。任意の `*.vercel.app` は信頼しない（[#46](https://github.com/AutoDevJapan/PassShare/issues/46), [#315](https://github.com/AutoDevJapan/PassShare/issues/315)） |
| `VERCEL_TEAM_SLUG` | Vercel スコープ（チーム/ユーザ）スラッグ（例 `masashi-matsumotos-projects-c5830f3d`）。**preview backend にのみ設定**。ブランチ名が長く Vercel がプレビュー URL のプロジェクト prefix を切り詰めた場合（例 `pass-share-fron-git-<hash>-<slug>.vercel.app`）でも当該 origin を CORS 許可する。スラッグ suffix は自スコープ専有のため任意の `*.vercel.app` は信頼せず #315 の境界を維持（[#358](https://github.com/AutoDevJapan/PassShare/issues/358)）。prd では未設定 |
| `OP_CONNECT_TOKEN` | Connect API Bearer トークン（`/v1/*` 必須） |
| `TRUST_PROXY_HOPS` | 信頼するフロントプロキシのホップ数（`req.ip` 算出用）。省略時は `local`=0 / それ以外=1（Railway エッジ 1 段）。生の `X-Forwarded-For` は信頼せず per-IP スロットルのバイパスを防ぐ（[#316](https://github.com/AutoDevJapan/PassShare/issues/316)）。プロキシ段数変更時のみ設定 |
| `DATABASE_CA_CERT` | DB 接続の TLS 検証に用いる CA 証明書（PEM 文字列）。設定時は `rejectUnauthorized: true` でサーバ証明書を検証。`*.railway.internal`（私設ネットワーク）接続では TLS 不要のため無視。公開/プロキシホスト（`railway.app` / `rlwy.net` / `sslmode=require` 等）は既定で証明書検証必須（[#323](https://github.com/AutoDevJapan/PassShare/issues/323)） |
| `DATABASE_SSL_ALLOW_INSECURE` | `true` の時のみ公開ホストの TLS 証明書検証を無効化する明示的オプトアウト（MITM リスクあり・非推奨）。既定は検証有効（[#323](https://github.com/AutoDevJapan/PassShare/issues/323)） |
| `METRICS_TOKEN` | `/metrics`（RSS/uptime 等の内部情報）の認証トークン。設定時は `Authorization: Bearer <token>` 必須で、不一致は 404。未設定時は `local` 以外のデプロイ環境で `/metrics` を無効化（404）し無認証の情報漏洩を防ぐ（[#323](https://github.com/AutoDevJapan/PassShare/issues/323)） |
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
| `deploy-dev.yml` | `main` push | Railway development | dev seed。本番refreshなし |
| `deploy-stg.yml` | 手動（`deploy-stg` 入力） | Railway staging | prd → stg refresh |
| `deploy-prd.yml` | 手動（`deploy-prd` 入力） | Railway production | prd snapshot |
| `deploy-preview.yml` | PR（Dependabot 除く） | Railway preview | なし（`RAILWAY_PROJECT_TOKEN` 必須 — 未設定時 skip） |

- `railway up` は **リポジトリルート** から実行する（`working-directory: backend` 不可）
- Railway サービスの `rootDirectory` が `backend` のため、`backend/` だけをアップロードするとビルドが失敗する
- 通常のbackend本番配備は既存手動フローを使用する。2026-10-06の固定mainは、全CI・配備前snapshotを確認し既存OAuth CLIで配備した。必要な現設定・稼働source・資格失効を照合する手順は[本番リリースRunbook](../runbooks/production-release.md#固定ソースの配備記録2026-10-06)を参照する。Railway側のGitHub自動配備は今回有効化していない
- デプロイ CI は `scripts/railway-deploy-with-replica.sh` → `scripts/railway-deploy-ci.sh`（`railway-deploy-preflight.mjs` + DB replica + `railway up --detach` + 最大 3 回リトライ + デプロイ後 `/health/db` smoke）。`--ci` は Metal builder 上で export 直後に誤 fail するため使わない。
- Preview配備は現行`deploy-preview.yml`のCLIと対象環境を照合する。古いCLI版の説明をOAuth実証や現在の認証方式の根拠にしない。
- 既存CIスクリプトではProject tokenは`RAILWAY_TOKEN`、Account/Team tokenは`RAILWAY_API_TOKEN`に分ける。後者を前者へexportしない。今回の手動配備は既存OAuthログインを使い、両環境変数を指定していない。

### デプロイ失敗 vs DB 障害の切り分け

| 症状 | 原因 | 確認方法 |
|------|------|----------|
| CIのupload認証失敗 | token種別・対象project/service/environment・認証方式を照合 | Account tokenは`RAILWAY_API_TOKEN`のまま使用し、`RAILWAY_TOKEN`を解除。現在のpreflightとCLIを確認する |
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

## 2026-10-06の現設定との照合

本番backendの稼働接続は新しい永続PG18へ切替済み。日次保持6日の設定と手動snapshotの復元は[運用記録](../audits/operations-readiness.md#2026-10-06の再現可能な演習とrailway実検証)へ保存した。元8表の保全と、固定e7の稼働44ファイル・実API15項目は別の確認である。

旧本番DBを参照する履歴やprovision用の例を、現在の稼働先として採用しない。既存GitHub配備・レプリカ用の保存先IDとPostgreSQLクライアントの互換性は、この切替で検証したものではない。これらの処理を起動する前に、対象IDが現稼働DBであることと、dump取得側のバージョンがPG18を扱えることを確認する。未確認のジョブ内dumpを永続バックアップと数えない。

Webの同一サイト経路は[認証経路の仕様](./web-auth-routing.md)を参照する。元のRailway絶対URLをブラウザから使用すると、SameSite=Lax Cookieが別サイト扱いで拒否される。環境別の相対接頭辞とVercel外部rewriteを使用し、本番接頭辞は正式ホストだけへ許可する。ソース設定とVercelの実build値は別々に照合する。
