# 隔離環境の受入テスト Runbook（旧ステージング手順）

> Issue [#106](https://github.com/AutoDevJapan/PassShare/issues/106)  
> 親 Epic: [#36](https://github.com/AutoDevJapan/PassShare/issues/36)  
> Operational Readiness Epic: [#205](https://github.com/AutoDevJapan/PassShare/issues/205) — SSOT: [operational-readiness.md](../spec/operational-readiness.md)

## 目的

公開stg/previewの配備は廃止した。従来の受入項目はlocalhostとPR CIの隔離試験で維持する。Prd実確認は[本番リリースRunbook](./production-release.md)で別途行う。

## 環境 URL（SSOT: [infrastructure.md](../spec/infrastructure.md)）

| コンポーネント | URL |
|---------------|-----|
| Backend API | localhost / CI一時DBを使うAPI |
| Web ポータル | localhost / CIの開発server |

## 自動 smoke（CLI）

```powershell

# Backend + Connect API（Prdと旧公開環境を指定しない）
$env:STG_BACKEND_URL = 'http://localhost:3000'
node scripts/stg-smoke.mjs

# Web UIは local-dev-web.md のlocalhost E2Eを使用する

# Cross-client（Web API → op-cli → Desktop sync）— Issue #214

# 事前に op-cli をビルド: cargo build -p op-cli --release
docker compose -f docker/docker-compose.test.yml run --rm backend-e2e

# 失敗時は exit 1。stg-smoke workflowは廃止。Quality Gateの隔離試験を使用する
```

## Cross-client 統合 smoke（Issue #214）

`backend/test/cross-client.integration.test.js` が Web → CLI → Desktop を **同一 vault / item** で 1 本に連鎖する:

1. Web API: signup → vault（自動作成）→ item 追加
2. op-cli: `op read op://<vault>/<item>/password` が同じ password を返す
3. Desktop sync: pull で Web 追加 item がローカルに反映される
4. Desktop sync: ローカル item を push
5. op-cli: Desktop が push した item を読める（ループ完結）

実行（Quality Gate `Docker E2E` ジョブと同一）:

```powershell
cargo build -p op-cli --release
docker compose -f docker/docker-compose.test.yml run --rm backend-e2e
```

### 失敗時 triage

| 症状 | 切り分け |
|------|---------|
| `op ... failed`（op-cli ステップ） | `OP_CLI_BIN`（`/app/target/release/op`）が存在するか、`cargo build -p op-cli --release` 済みか。単体で `op-cli-e2e.test.js` が pass するか確認 |
| signup / connect-token が 4xx | backend の `APP_ENV=local` seed と CSRF（`GET /api/auth/csrf`）を確認。`cloud-sync.integration.test.js` の切り分けと共通 |
| pull / push 件数が不一致 | `runCloudSync` の fingerprint 差分（`helpers/desktop-cloud-sync-flow.js`）。同期済み item を localItems に含めているか |
| PostgreSQL 接続不可 | compose の `postgres` healthcheck、`DATABASE_URL` を確認 |
| op-cli が別 vault を参照 | `OP_CONNECT_TOKEN` を signup ユーザーの accessToken に上書きしているか（固定 `test-connect-token` は別ユーザー） |

## Web / CLI / Desktop 自動化マトリクス（Issue #205）

| クライアント | localhost | CI（PR / main） | 受入先 |
|-------------|---------|----------------|---------------|
| **Web** | [local-dev-web.md](./local-dev-web.md) — Playwright E2E | Quality Gate `frontend` job | localhostのWeb E2E |
| **CLI (op)** | [op-cli.md](./op-cli.md) — `cargo build -p op-cli` | Quality Gate `docker-e2e` — `op-cli-e2e.test.js` | 隔離DBのConnectトークン |
| **Desktop** | [local-dev-desktop.md](./local-dev-desktop.md) | Quality Gate `desktop-smoke` — Rust `smoke_*` + cloud-sync integration | 手動 MVP + クラウド同期 smoke |

## 受入チェックリスト

### Backend / Connect API

- [ ] `GET /health` → `{ "status": "ok" }`
- [ ] `GET /health/db` → `{ "status": "ok" }`
- [ ] `GET /v1/vaults`（Bearer トークン）→ 200
- [ ] Item CRUD（作成 → 取得 → 更新 → 削除）→ 各 2xx

### Web ポータル

- [ ] サインアップ / ログイン
- [ ] パスワードボックス CRUD
- [ ] ログアウト
- [ ] 320px 幅で主要画面が崩れない

### Desktop

- [ ] アプリ起動 + パスワードボックス解錠
- [ ] Connect CRUD
- [ ] クラウド同期（push / pull）smoke
- [ ] 設定 → 更新確認（ネットワーク接続時）

### Mobile

- [ ] アプリ起動 + ログイン
- [ ] Connect CRUD smoke
- [ ] 生体認証 / PIN ロック（実機）

### Extension

- [ ] MV3 ビルド成果物をロード
- [ ] ポップアップログイン + Item 一覧
- [ ] オートフィル smoke（テストページ）

## 実施記録

| 日付 | 実施者 | Backend | Web | Desktop | Mobile | Extension | 結果 |
|------|--------|---------|-----|---------|--------|-----------|------|
| | | | | | | | |

## CI 連携

旧`.github/workflows/stg-smoke.yml`は削除した。Quality Gateのfrontend、docker-e2e、desktop-smokeと他の隔離試験は維持する。旧stg URLを省略時に使う補助を、そのまま実Prdへ向けない。Prd実確認でデータを作成・変更する操作は、対象と必要性を別途確認する。

## 関連

- [production-release.md](./production-release.md)
- [production-v2.md](../spec/production-v2.md)
