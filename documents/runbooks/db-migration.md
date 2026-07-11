# DB マイグレーション Runbook（Issue #56）

> SSOT: `backend/src/db/schema.js`  
> 最終更新: 2026-05-28

## 方針

PassShare backend は起動時に `store.migrate()` で `CREATE TABLE IF NOT EXISTS` を実行する。破壊的 DDL は本番前に stg で検証する。

## 環境別手順

| 環境 | タイミング | 手順 |
|------|-----------|------|
| preview | PR マージ前 | CI `backend-test` → `migrate:verify` pass + deploy smoke `/health/db` |
| dev | develop push | Railway 自動デプロイ → 起動時 migrate |
| stg | stg ブランチ push | Railway staging デプロイ → smoke `/health/db` |
| prd | main マージ | Railway production デプロイ → smoke `/health/db` |

## CI 検証

```bash
pnpm --dir backend migrate:verify
pnpm --dir backend test
```

`.github/workflows/quality-gate.yml`（job `backend`）が PR / main push で実行する。

## Rollback 方針

1. **スキーマ追加（非破壊）:** 旧バイナリは新カラムを無視可能 — ロールバック = Railway 前リリースへ redeploy
2. **破壊的変更（将来）:** 別途 forward-only マイグレーション Issue を起票。本番では `ALTER` 前に stg で 24h  soak
3. **データ復旧:** Railway Postgres の Point-in-Time Recovery（プラン依存）— 漏洩時は [secret-rotation.md](./secret-rotation.md) 参照

## Smoke（デプロイ後）

```bash
curl -sS "$OP_CONNECT_HOST/health/db" | jq .
curl -sS -H "Authorization: Bearer $OP_CONNECT_TOKEN" "$OP_CONNECT_HOST/v1/vaults" | jq .
```
