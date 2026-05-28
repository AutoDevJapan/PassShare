# 本番リリース Runbook

> Issue [#107](https://github.com/AutoDevJapan/PassShare/issues/107)  
> 親 Epic: [#36](https://github.com/AutoDevJapan/PassShare/issues/36)

## 概要

PassShare v2.0 の本番リリースは **stg 受入 pass → main マージ → 自動デプロイ → smoke → tag** の順で実施する。

## 環境マッピング

| 論理環境 | Git ブランチ | Backend | Frontend |
|---------|-------------|---------|----------|
| stg | `stg` | Railway staging | Vercel Preview (stg) |
| prd | `main` | Railway production | Vercel Production |

SSOT: [infrastructure.md](../spec/infrastructure.md)

## Promote（stg → prd）

### 前提

1. [staging-acceptance.md](./staging-acceptance.md) のチェックリストがすべて ✅
2. `main` 上の Quality Gate CI が green
3. CHANGELOG の `[Unreleased]` セクションが更新済み

### 手順

1. **stg ブランチを main に fast-forward マージ**（または PR 経由）
   ```powershell
   git checkout main
   git pull origin main
   git merge origin/stg
   git push origin main
   ```
2. **Backend 自動デプロイ** — `deploy-prd.yml` が Railway production へ deploy
3. **Frontend 自動デプロイ** — Vercel Production が `main` をビルド
4. **Smoke（本番）**
   ```powershell
   $env:STG_BACKEND_URL = "https://pass-share-backend-production.up.railway.app"
   node scripts/stg-smoke.mjs
   ```
5. **SemVer tag 作成** — [release-versioning.md](../spec/release-versioning.md) 参照
   ```powershell
   git tag -a v2.0.0 -m "PassShare v2.0.0"
   git push origin v2.0.0
   ```
6. **Desktop リリース** — [desktop-release.md](./desktop-release.md)（GitHub Releases + updater 署名）
7. **CHANGELOG 確定** — `[Unreleased]` を `[2.0.0] - YYYY-MM-DD` に移動

## Rollback

### Backend（Railway）

1. Railway Dashboard → production → Deployments
2. 直前の green デプロイを **Redeploy**
3. `/health` と `/health/db` を確認

### Frontend（Vercel）

1. Vercel Dashboard → Deployments → 直前の Production deployment
2. **Promote to Production**

### Desktop

- 前バージョンの GitHub Release 成果物を再公開（updater が `latest.json` を参照）

### DB

- 非破壊スキーマ: 旧バイナリ redeploy で十分 — [db-migration.md](./db-migration.md)
- データ破損時: Railway PITR + [secret-rotation.md](./secret-rotation.md)

## Hotfix

1. `main` から `hotfix/<summary>-YYYYMMDD` ブランチを作成
2. 修正 + テスト + Quality Gate green
3. PR → `main` へマージ（patch バージョン bump）
4. 上記 Promote 手順 4–7 を省略版で実施
5. 必要に応じて `stg` へ cherry-pick

## 演習記録

| 日付 | 種別 | 実施者 | 結果 | 備考 |
|------|------|--------|------|------|
| 2026-05-28 | ドライラン（手順レビュー） | — | ✅ Runbook 作成 | Epic #36 |

## 関連

- [release-versioning.md](../spec/release-versioning.md)
- [staging-acceptance.md](./staging-acceptance.md)
- [secret-rotation.md](./secret-rotation.md)
