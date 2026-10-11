# ADR 008: Backend デプロイパイプライン（main → dev、手動 stg/prd）

## Status

Superseded (2026-10-12, ToDo2379) — [ADR001のPrd-only決定](./001-vercel-railway-environments.md)と[現在のインフラ仕様](../spec/infrastructure.md)へ置換。

## 置き換えた決定

以下のdev-first構成は履歴として保存する。現在の配備手順には使わない。

- 公開dev/stg/previewの作成・配備は廃止し、main/PRから非Prdへ配備するworkflowを削除する。
- Backendの手動配備は維持するが、対象は既存Prdの明示IDと現在のmainソースだけに限定する。FrontendのGit配備もmainのProductionだけに限定する。
- DBは現稼働PG18 `passshare-postgres-preserved-1177`を使用する。旧 `postgres-prd-v2`を現在のDBと取り違えない。production snapshotは現Prdだけを読む一時dumpであり、dev/stgへのrefreshや有料backupを必要としない。実dumpをartifactへ保存しない。
- localhostとPR CIの隔離試験、一時DBは維持する。必要成果の移行とPrd実確認、旧provider資源の廃止確認は別途行う。
- 人間レビューを求める規則は変更しない。

## 旧決定の履歴（以下は運用しない）

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
