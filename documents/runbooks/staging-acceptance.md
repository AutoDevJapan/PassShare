# ステージング受入テスト Runbook

> Issue [#106](https://github.com/AutoDevJapan/PassShare/issues/106)  
> 親 Epic: [#36](https://github.com/AutoDevJapan/PassShare/issues/36)

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

# 失敗時は exit 1 — CI workflow_dispatch または手動実行
```

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

`.github/workflows/stg-smoke.yml` — `workflow_dispatch` で stg smoke を実行（Secrets: `STG_OP_CONNECT_TOKEN`）。

## 関連

- [production-release.md](./production-release.md)
- [production-v2.md](../spec/production-v2.md)
