# ステージング受入テスト Runbook

> Issue [#106](https://github.com/AutoDevJapan/PassShare/issues/106)  
> 親 Epic: [#36](https://github.com/AutoDevJapan/PassShare/issues/36)  
> Operational Readiness Epic: [#205](https://github.com/AutoDevJapan/PassShare/issues/205) — SSOT: [operational-readiness.md](../spec/operational-readiness.md)

## 目的

`stg` 環境へ promote する前に、全クライアントの smoke を実施し、本番相当の品質を確認する。

## 環境 URL（SSOT: [infrastructure.md](../spec/infrastructure.md)）

| コンポーネント | URL |
|---------------|-----|
| Backend API | https://pass-share-backend-staging.up.railway.app |
| Web ポータル | Vercel Preview（`stg` ブランチ） |

## 自動 smoke（CLI）

```powershell
# Backend + Connect API
node scripts/stg-smoke.mjs

# Web UI（Vercel Preview / stg）— Issue #207
# STG_WEB_URL=https://... node scripts/stg-web-smoke.mjs

# Cross-client（Web API → op-cli → sync）— Issue #214
# docker compose -f docker/docker-compose.test.yml run --rm backend-e2e

# 失敗時は exit 1 — CI workflow_dispatch または手動実行
```

## Web / CLI / Desktop 自動化マトリクス（Issue #205）

| クライアント | ローカル | CI（PR / main） | stg / preview |
|-------------|---------|----------------|---------------|
| **Web** | [local-dev-web.md](./local-dev-web.md) — Playwright E2E | Quality Gate `frontend` job | `stg-web-smoke.mjs` + `stg-smoke.yml` |
| **CLI (op)** | [op-cli.md](./op-cli.md) — `cargo build -p op-cli` | Quality Gate `docker-e2e` — `op-cli-e2e.test.js` | 手動 `op vault list`（stg token） |
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

`.github/workflows/stg-smoke.yml` — `workflow_dispatch` で stg smoke を実行。

| Job | Secrets | 内容 |
|-----|---------|------|
| `api-smoke` | `STG_OP_CONNECT_TOKEN`（任意） | `stg-smoke.mjs` — Backend / Connect |
| `web-ui-smoke` | `STG_WEB_URL` + `run_web_ui: true` | `stg-web-smoke.mjs` — Playwright UI CRUD |

## 関連

- [production-release.md](./production-release.md)
- [production-v2.md](../spec/production-v2.md)
