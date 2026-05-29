# ADR 005: Backend デプロイパイプライン（main → dev、手動 stg/prd）

## Status

Accepted (2026-05-28)

## Context

`main` へのマージで `deploy-prd.yml` が Railway production へ自動デプロイしていた。Quality Gate は pass しても production deploy が失敗し、意図しない本番リリースリスクもあった。

要件:

- `main` マージ = **dev 環境への Backend デプロイトリガー**（検知役）
- dev で問題なければ **stg は手動デプロイ**
- stg デプロイ時は **prd DB のレプリカ** を stg Postgres に反映してからデプロイ
- **prd へのデプロイは手動**（stg 受入後）
- dev / stg / prd いずれもデプロイ前に **DB レプリカブランチ**（スナップショットまたは refresh）を作成

## Decision

### Git トリガー

| ワークフロー | トリガー | Railway 環境 | DB 前処理 |
|-------------|---------|--------------|----------|
| `deploy-dev.yml` | `push` → `main` | development | prd → dev refresh |
| `deploy-stg.yml` | `workflow_dispatch`（確認入力 `deploy-stg`） | staging | prd → stg refresh |
| `deploy-prd.yml` | `workflow_dispatch`（確認入力 `deploy-prd`） | production | prd snapshot + artifact |
| `deploy-preview.yml` | PR → `main` | preview | なし（PR 検証用） |

### DB レプリカ

- スクリプト: `scripts/railway-db-replica.mjs`（Railway API で `DATABASE_URL` 解決 → `pg_dump` / `pg_restore`）
- ラベル: `replica-{GITHUB_RUN_ID}-{sha7}`
- prd スナップショットは GitHub Actions artifact に保存

### Frontend（Vercel）

- **変更なし**: `main` → Vercel Production、`develop` → Development
- Backend の論理 dev トリガーは `main`、Frontend の Production とは独立

## Consequences

- `main` マージだけでは **本番 Backend は更新されない**
- stg/prd は Actions → Run workflow から明示的に実行
- dev refresh は `postgres-dev` を上書きする（preview 環境と共有 — preview も prd レプリカデータになる）
- GitHub Secret **`RAILWAY_DEVELOPMENT_ENV_ID`** が必須

## Alternatives Considered

- Neon 式 DB branching: Railway ネイティブ非対応のため pg_dump 方式を採用
- `stg` ブランチ push 自動デプロイ: 手動のみに変更（受入後の明示デプロイ）
