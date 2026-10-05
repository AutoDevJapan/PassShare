# Web ローカル開発 Runbook

> Issue [#206](https://github.com/AutoDevJapan/PassShare/issues/206)  
> 親 Epic: [#205](https://github.com/AutoDevJapan/PassShare/issues/205)

## 目的

開発者が **1 コマンド（または明文化された手順）** で Web の主要フロー（サインアップ → パスワードボックス CRUD → ログアウト）をローカル検証できるようにする。

## 前提

| ツール | バージョン |
|--------|-----------|
| Node.js | 22.x |
| pnpm | 10.11.0（`corepack enable` 推奨） |
| Rust | 1.86以降。`backend/native` の保存用実行ファイルを構築する |
| Playwright | リポジトリ root の devDependency |

PostgreSQL は **Playwright E2E では不要**（backend は in-memory store）。Connect API + PostgreSQL 統合は [Docker E2E](#postgresql-統合-docker) を参照。

## クイックスタート（推奨 — E2E 1 コマンド）

リポジトリ root から:

```powershell
node scripts/local-web-e2e.mjs
```

内部で以下を実行:

0. Rustの保存用実行ファイルを固定した依存一覧から構築し、APIへ実行先を渡す
1. root / backend / connect-js / frontend の依存インストール
2. connect-js ビルド
3. Playwright Chromium インストール（未インストール時）
4. `pnpm exec playwright test --project=chromium`（backend + frontend を webServer で自動起動）

## 手動開発（UI をブラウザで触る）

### 1. 依存インストール

```powershell
pnpm install --frozen-lockfile
pnpm --dir backend install --frozen-lockfile
pnpm --dir packages/connect-js install --frozen-lockfile
pnpm --dir packages/connect-js run build
pnpm --dir frontend install --frozen-lockfile
```

### 2. Backend 起動（ターミナル 1）

先に保存用のRust実行ファイルを構築します。このPCのエージェントはCargoの割当を確認してから実行します。正式Dockerイメージではビルドと配置をDockerfileが行います。

```powershell
cargo build --manifest-path backend/native/Cargo.toml --release --locked --bin passshare-mutations
$env:PASSSHARE_MUTATIONS_BIN = (Resolve-Path 'backend/native/target/release/passshare-mutations.exe').Path
$env:APP_ENV = "local"
$env:PORT = "8080"
node backend/src/index.js
```

Linux/macOSでは拡張子なしの `backend/native/target/release/passshare-mutations` を絶対パスで指定します。未配置なら新しい保存操作は503となり、入力を保持します。単にAPIのhealthが成功しても保存機能の導入確認にはしません。

このPCでエージェントが実画面を検査する場合は、ログイン済みのオーナーのChromeに専用タブを作り、終わったら閉じます。CIのChromium検査と区別します。

確認: http://127.0.0.1:8080/health → `{ "status": "ok" }`

**Dev seed（自動）:** `APP_ENV=local` では Backend 起動時にデモユーザーが作成される。

| 項目 | 値 |
|------|-----|
| Email | `dev@passshare.local` |
| Password | `DevPassShare1!` |

ログインせずにサインアップから試すこともできる。

### 3. Frontend 起動（ターミナル 2）

```powershell
pnpm --dir frontend dev --host 127.0.0.1 --port 5173
```

確認: http://127.0.0.1:5173 — サインアップ / ログイン / パスワードボックス CRUD

### 4. Playwright E2E（任意 — ターミナル 3）

backend / frontend が **未起動** の場合、Playwright が webServer で自動起動する:

```powershell
pnpm exec playwright test e2e/web/auth-crud.spec.ts --project=chromium
```

既に dev サーバーが動いている場合は `reuseExistingServer` により再利用される。

## PostgreSQL 統合（Docker）

Connect API + PostgreSQL の統合確認:

```powershell
docker compose -f docker/docker-compose.test.yml run --rm backend-e2e
```

## CI との対応

| ローカル | CI |
|---------|-----|
| `node scripts/local-web-e2e.mjs` | Quality Gate `Web (Playwright + build)` |
| `pnpm exec playwright test` | Quality Gate `Web (Playwright + build)`（`quality-gate.yml` job `frontend`） |

## トラブルシュート

| 症状 | 対処 |
|------|------|
| `playwright` が見つからない | root で `pnpm install` |
| frontend が API に接続できない | backend が 8080 で起動しているか確認 |
| E2E がタイムアウト | `pnpm exec playwright install chromium --with-deps` |
| port 5173 / 8080 が使用中 | プロセスを停止するか `PORT` / vite `--port` を変更 |

## 関連

- [operational-readiness.md](../spec/operational-readiness.md)
- [staging-acceptance.md](./staging-acceptance.md)
- `e2e/web/auth-crud.spec.ts`
- `playwright.config.ts`
