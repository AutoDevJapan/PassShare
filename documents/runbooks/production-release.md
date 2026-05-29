# 本番リリース Runbook

> Issue [#107](https://github.com/AutoDevJapan/PassShare/issues/107)  
> 親 Epic: [#36](https://github.com/AutoDevJapan/PassShare/issues/36)

## 概要

PassShare v2.0 のリリースフロー:

1. **main マージ** → dev Backend 自動デプロイ（prd レプリカ refresh 付き）
2. **dev 検証 OK** → stg 手動デプロイ
3. **stg 受入 OK** → prd 手動デプロイ
4. tag / Desktop / CHANGELOG

SSOT: [ADR 005](../adr/005-deploy-pipeline-dev-first.md), [infrastructure.md](../spec/infrastructure.md)

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

- prd DB → dev (`postgres-dev`) refresh
- Railway development backend デプロイ
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

1. GitHub → Actions → **Deploy Production Backend** → Run workflow
2. 確認入力: `deploy-prd`
3. prd DB snapshot（artifact 保存）→ production backend デプロイ
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
2. 直前の green デプロイを **Redeploy**
3. `/health` と `/health/db` を確認

### Frontend（Vercel）

1. Vercel Dashboard → Deployments → 直前の Production deployment
2. **Promote to Production**

### DB

- prd デプロイ artifact の snapshot から `pg_restore`（Run ID 付き dump）
- PITR — Railway プラン依存 + [secret-rotation.md](./secret-rotation.md)

## Hotfix

1. `main` から `hotfix/<summary>-YYYYMMDD` ブランチ
2. 修正 + Quality Gate green → PR → `main` マージ
3. dev 自動デプロイで検証
4. 必要なら `deploy-stg.yml` / `deploy-prd.yml` を手動実行

## 演習記録

| 日付 | 種別 | 実施者 | 結果 | 備考 |
|------|------|--------|------|------|
| 2026-05-28 | パイプライン変更 | — | ✅ ADR 005 | main → dev、stg/prd 手動 |

## 関連

- [release-versioning.md](../spec/release-versioning.md)
- [staging-acceptance.md](./staging-acceptance.md)
- [secret-rotation.md](./secret-rotation.md)
- [ADR 005](../adr/005-deploy-pipeline-dev-first.md)
