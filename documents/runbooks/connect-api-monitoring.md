# Connect API 監視 Runbook（Issue #57）

> 最終更新: 2026-05-28

## エンドポイント

| Path | 用途 | 期待 |
|------|------|------|
| `/health` | Liveness（Railway healthcheckPath） | 200, `status: ok` |
| `/health/db` | DB 接続 | 200 + `database: connected` |
| `/metrics` | JSON メトリクス（PassShare 拡張） | 200, uptime / memory / DB 状態 |

## Railway アラート（推奨設定）

1. Railway Dashboard → `pass-share-backend` → **Observability**
2. **Deployment failed** — 即時通知（Slack / Email）
3. **Healthcheck failure** — 3 回連続失敗で通知（`/health`）
4. カスタム監視（外部）— 5 分間隔で以下を HTTP チェック:
   - `GET /health`
   - `GET /health/db`

## ダッシュボード

| 項目 | ソース |
|------|--------|
| デプロイ状態 | Railway Deployments |
| HTTP エラー率 | Railway Metrics / Logs |
| DB 接続 | `/health/db` 外部 synthetic |
| プロセスメモリ | `/metrics` → `memoryRssBytes` |

## インシデント対応

1. `/health` が 503 → Railway ログ確認 → 直近デプロイ rollback
2. `/health/db` が 503 → `DATABASE_URL` Variable Reference を確認 → [db-migration.md](./db-migration.md)
3. Connect 401 急増 → [secret-rotation.md](./secret-rotation.md) のトークン手順
