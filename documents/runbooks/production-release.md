# 本番リリース Runbook

> Issue [#107](https://github.com/AutoDevJapan/PassShare/issues/107)  
> 親 Epic: [#36](https://github.com/AutoDevJapan/PassShare/issues/36)

## 概要

PassShare v2.0 のリリースフロー:

1. **main マージ** → dev Backend 自動デプロイ（架空dev seed、本番レプリカのrefreshなし）
2. **dev 検証 OK** → stg 手動デプロイ
3. **stg 受入 OK** → prd 手動デプロイ
4. tag / Desktop / CHANGELOG

SSOT: [ADR 008](../adr/008-deploy-pipeline-dev-first.md), [infrastructure.md](../spec/infrastructure.md)

## 環境マッピング

| 論理環境 | Git ブランチ | Backend デプロイ | Frontend |
|---------|-------------|-----------------|----------|
| dev | `main`（検知） | 自動 `deploy-dev.yml` | Vercel Development |
| stg | `stg` | 手動 `deploy-stg.yml` | Vercel Preview (stg) |
| prd | — | 手動 `deploy-prd.yml` | Vercel Production (`main`) |

## Promote（dev → stg → prd）

### 1. main マージ（dev）

```powershell
git checkout main
git pull origin main
# PR マージ後、deploy-dev.yml が自動実行される
```

- Railway development backend デプロイ（**dev seed** を起動時適用 — prd レプリカ refresh なし）
- smoke: `https://pass-share-backend-development.up.railway.app/health/db`

### 2. stg 手動デプロイ

前提: [staging-acceptance.md](./staging-acceptance.md) の dev 検証 ✅

1. GitHub → Actions → **Deploy Staging Backend** → Run workflow
2. 確認入力: `deploy-stg`
3. prd DB → stg (`postgres-stg`) refresh → staging backend デプロイ
4. smoke:
   ```powershell
   $env:STG_BACKEND_URL = "https://pass-share-backend-staging.up.railway.app"
   node scripts/stg-smoke.mjs
   ```

### 3. prd 手動デプロイ

前提:

1. stg 受入チェックリスト ✅
2. CHANGELOG `[Unreleased]` 更新済み
3. 配備前のバックアップ取得済みで、対象・由来・取得時刻・復元可能な範囲を確認済み。満たせない間は下記Run workflowを起動しない

1. GitHub → Actions → **Deploy Production Backend** → Run workflow
2. 確認入力: `deploy-prd`
3. ジョブ内でsnapshot後に配備へ進む。途中で上記の前提を確認する停止はない。実DB dumpをGitHub artifactへ保存せず回収する処理で、永続した本番保全を保証しない
4. smoke:
   ```powershell
   $env:STG_BACKEND_URL = "https://pass-share-backend-production.up.railway.app"
   node scripts/stg-smoke.mjs
   ```
5. SemVer tag — [release-versioning.md](../spec/release-versioning.md)
6. Desktop — [desktop-release.md](./desktop-release.md)
7. CHANGELOG 確定

## Rollback

### Backend（Railway）

1. Railway Dashboard → 対象環境 → Deployments
2. 現DBスキーマとの互換性と必要な認証修正を維持する版を確認して **Redeploy**。単に直前の成功版へ戻さない
3. `/health` と `/health/db`、現在の資格による保存と旧資格の拒否を確認

### Frontend（Vercel）

1. Vercel Dashboard → Deployments → 直前の Production deployment
2. **Promote to Production**

### DB

- 稼働DBと現在の更新を先に保全し、別の隔離DBへ復元する。公開artifactの実DB dumpを復元元にしない
- 本番の現在の永続DB・日次保持設定は[運用Runbook](./operations.md#railway-postgresql)で照合する。元PG16へ戻して新しい更新を消さない
- PITRは対象サービスの実設定を確認して利用する。本番の有効化は未実施。復元した古い資格・退会・取消・鍵を現在の記録へ合わせ、全経路の拒否と認可を確認するまで再開しない

## Hotfix

1. `main` から `hotfix/<summary>-YYYYMMDD` ブランチ
2. 修正 + Quality Gate green → PR → `main` マージ
3. dev 自動デプロイで検証
4. 必要なら `deploy-stg.yml` / `deploy-prd.yml` を手動実行

## 演習記録

| 日付 | 種別 | 実施者 | 結果 | 備考 |
|------|------|--------|------|------|
| 2026-05-28 | パイプライン変更 | — | ✅ ADR 008 | main → dev、stg/prd 手動 |

## 関連

- [release-versioning.md](../spec/release-versioning.md)
- [staging-acceptance.md](./staging-acceptance.md)
- [secret-rotation.md](./secret-rotation.md)
- [ADR 008](../adr/008-deploy-pipeline-dev-first.md)

## 固定ソースの配備記録（2026-10-06）

共有ToDo1177では既存Railway CLIのOAuthログインを使用し、APIキー指定のワークフローを起動していない。全42検査が成功したmain `e7d076c0449b3a233f015c3b6e003ab2796e8bd9` を変更のない専用作業フォルダーから対象プロジェクト・本番環境・backendサービスのIDを明示して配備した。実際のアップロード先、Dockerfileによるnative build、稼働44ソースファイルの一致と正式API15項目を確認した。

先に本番の手動snapshotを取得した。切替前の保全先snapshot復元で元8表の件数・全文指紋が一致した証拠と、配備後のsource一致・API資格失効は別の判定である。この限定経路をstaging全受入、署名された配布物、全クライアント、契約上の提供開始と同一に扱わない。[匿名証拠](../audits/evidence/1177-live-operations-20261006.json)と[復旧手順](./operations.md)を参照する。
