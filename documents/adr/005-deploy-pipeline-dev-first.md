# ADR 005: Backend デプロイパイプライン（main → dev、手動 stg/prd）

## Status

Amended (2026-05-30) — dev/preview は seed、stg のみ prd レプリカ

## Context

`main` へのマージで `deploy-prd.yml` が Railway production へ自動デプロイしていた。Quality Gate は pass しても production deploy が失敗し、意図しない本番リリースリスクもあった。

要件:

- `main` マージ = **dev 環境への Backend デプロイトリガー**（検知役）
- dev で問題なければ **stg は手動デプロイ**
- stg デプロイ時は **prd DB のレプリカ** を stg Postgres に反映してからデプロイ
- **prd へのデプロイは手動**（stg 受入後）
- **local / preview / dev** は本番データではなく **同一 dev seed** を使用する

## Decision

### Git トリガー

| ワークフロー | トリガー | Railway 環境 | DB 前処理 |
|-------------|---------|--------------|----------|
| `deploy-dev.yml` | `push` → `main` | development | **なし**（起動時 dev seed） |
| `deploy-stg.yml` | `workflow_dispatch`（確認入力 `deploy-stg`） | staging | prd → stg refresh |
| `deploy-prd.yml` | `workflow_dispatch`（確認入力 `deploy-prd`） | production | prd snapshot + artifact |
| `deploy-preview.yml` | PR → `main` | preview | **なし**（起動時 dev seed） |

### DB 方針

| 論理環境 | データソース |
|---------|-------------|
| local / preview / dev | `backend/src/db/dev-seed.js`（Backend 起動時 idempotent 適用） |
| stg | prd レプリカ refresh（`scripts/railway-db-replica.mjs`） |
| prd | 本番データ（snapshot のみ、refresh なし） |

stg refresh スクリプト: `pg_dump` → `DROP SCHEMA public CASCADE` → `pg_restore`（`--single-transaction --exit-on-error`）

### Frontend（Vercel）

- **変更なし**: `main` → Vercel Production、`develop` → Development
- Backend の論理 dev トリガーは `main`、Frontend の Production とは独立

## Consequences

- `main` マージだけでは **本番 Backend は更新されない**
- stg/prd は Actions → Run workflow から明示的に実行
- dev / preview は **本番データをコピーしない**（`operations.md` と一致）
- preview と dev は `postgres-dev` を共有 — 同一 seed が両方に適用される
- GitHub Secret **`RAILWAY_DEVELOPMENT_ENV_ID`** が必須

## Alternatives Considered

- main マージごとに prd → dev refresh: **却下** — 開発 DB に本番データを置く必要がなく、FK 依存で restore が脆い
- Neon 式 DB branching: Railway ネイティブ非対応のため stg のみ pg_dump 方式を採用
- `stg` ブランチ push 自動デプロイ: 手動のみに変更（受入後の明示デプロイ）
