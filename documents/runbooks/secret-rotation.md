# 秘密情報ローテーション Runbook

> SSOT for Issue [#47](https://github.com/AutoDevJapan/PassShare/issues/47)  
> 最終更新: 2026-05-27

## 目的

Railway / Vercel / GitHub に保存される秘密情報を、漏洩疑い・定期ローテーション・担当者変更時に安全に更新する手順を定義する。

## 対象シークレット一覧

| シークレット | 保存場所 | 用途 | ローテーション頻度（目安） |
|-------------|---------|------|---------------------------|
| `OP_CONNECT_TOKEN` | Railway Variables（各環境） | Connect API レガシー Bearer（local/dev/stg/preview のみ。`prd` では無効） | 四半期 / 漏洩時 |
| `DATABASE_URL` | Railway Variables（Postgres 参照） | Backend → PostgreSQL | 漏洩時 / DB パスワード変更時 |
| `RAILWAY_API_TOKEN` | GitHub Secrets | CI から Railway デプロイ | 漏洩時 / 担当者変更時 |
| `VERCEL_TOKEN` | GitHub Secrets | CI から Vercel env 同期 | 漏洩時 / 担当者変更時 |
| per-user Connect トークン | PostgreSQL `connect_tokens` | ユーザー単位 Connect API | 失効 API / パスワード変更 |
| Web セッション | PostgreSQL `sessions` | Cookie セッション | ログアウト / パスワード変更で全失効 |

**非シークレット（ローテーション不要）:** `APP_ENV`, `PORT`, `WEB_ORIGIN`, `VITE_APP_ENV`, `VITE_API_BASE_URL`

## 事前準備

1. メンテナンス窓を確定（`prd` はユーザー影響あり）
2. 対象環境を 1 つに限定（dev → stg → prd の順を推奨）
3. [infrastructure.md](../spec/infrastructure.md) の Project / Service ID を手元に用意
4. ローテーション実施者は Railway / Vercel / GitHub の Admin 権限を持つこと

## 共通手順

```text
1. 新しい値を生成（下記「生成方法」参照）
2. プラットフォームに新値を設定
3. Backend サービスを再デプロイ（Railway: Redeploy または main へ空コミット + CI）
4. 「ローテーション後 Smoke 手順」を実行
5. 旧値を無効化（トークン revoke / 旧 DB パスワード削除）
6. 本 Runbook の「実施記録」に日時・実施者・対象を記載
```

### 生成方法

| 種別 | コマンド例 |
|------|-----------|
| Bearer トークン | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| Railway API トークン | Railway Dashboard → Account Settings → Tokens → Create |
| Vercel トークン | Vercel Dashboard → Settings → Tokens → Create |

---

## 1. `OP_CONNECT_TOKEN` のローテーション

**対象:** local / dev / preview / stg（`APP_ENV=prd` では使用しない）

### 手順

1. 新トークンを生成（64 文字 hex 推奨）
2. Railway → `pass-share-backend` → 対象 Environment → Variables
3. `OP_CONNECT_TOKEN` を新値に更新
4. サービスを Redeploy
5. クライアント（`op` CLI / Desktop / スクリプト）の Bearer トークンを新値に更新
6. Smoke 手順の Connect 項目を実行

### 影響

- ローテーション完了まで、旧トークンでの `/v1/*` 呼び出しは 401 になる
- Web 認証（Cookie セッション + per-user Connect トークン）は影響を受けない

---

## 2. `DATABASE_URL` / Postgres パスワードのローテーション

### 手順

1. Railway → 対象 Postgres プラグイン → **Reset Password**（または新ユーザー作成）
2. `pass-share-backend` の Variables で `DATABASE_URL` を Variable Reference 経由で再リンク（手入力の `${...}` は展開されない）
3. Backend を Redeploy
4. Smoke 手順の DB 項目を実行

### 影響

- Redeploy 中は DB 接続エラー（503 `/health/db`）の可能性あり
- セッション・ユーザーデータは Postgres 内に保持（パスワード変更のみでは消えない）

### ロールバック

新パスワードが機能しない場合、Postgres プラグインで再度 Reset し `DATABASE_URL` を更新して Redeploy。

---

## 3. `RAILWAY_API_TOKEN`（GitHub Secret）のローテーション

### 手順

1. Railway で新しいアカウント / ワークスペーストークン（Account / Team Token）を発行（`RAILWAY_API_TOKEN` は Project Token ではない）
2. GitHub → PassShare → Settings → Secrets → `RAILWAY_API_TOKEN` を更新
3. `workflow_dispatch` または main への merge でデプロイ Workflow を 1 回実行
4. Smoke 手順を **prd または対象環境** で実行

### 影響

- 更新前に走っている CI は旧トークンで失敗する可能性あり
- 更新後は次回 Workflow から新トークンが使われる

---

## 4. `VERCEL_TOKEN`（GitHub Secret）のローテーション

### 手順

1. Vercel で新トークンを発行
2. GitHub Secrets の `VERCEL_TOKEN` を更新
3. PR 作成または `sync-vercel-env.yml` を `workflow_dispatch` で実行
4. Vercel Preview / Production の Frontend がビルド成功することを確認

### 影響

- Preview env 同期 Workflow が一時的に失敗する
- 既デプロイ済み Frontend は影響を受けない

---

## 5. per-user Connect トークン / Web セッションの失効

コード上の失効経路（ローテーションというよりインシデント対応）:

| 操作 | 効果 |
|------|------|
| `POST /api/auth/logout` | 当該セッション失効 |
| パスワード変更（将来実装） | 全セッション + Connect トークン失効 |
| DB から `connect_tokens` / `sessions` 行削除 | 該当ユーザー強制ログアウト |

漏洩疑いの Connect トークンは、対象ユーザーのログアウト + `connect_tokens` 削除 + 再ログインで再発行。

---

## ローテーション後 Smoke 手順

環境ごとに Backend URL は [infrastructure.md](../spec/infrastructure.md) を参照。

### Backend API

```powershell
$BASE = "https://pass-share-backend-staging.up.railway.app"  # 対象環境に置換

# 1. Liveness
curl -sS "$BASE/health" | ConvertFrom-Json | Select-Object status, environment

# 2. Database（503 の場合は DATABASE_URL / Redeploy を確認）
curl -sS "$BASE/health/db" | ConvertFrom-Json | Select-Object status, database
```

**期待結果:** `status: ok`, `database: connected`（DB ローテーション時）

### Connect API（`OP_CONNECT_TOKEN` ローテーション時）

```powershell
$TOKEN = "<new-op-connect-token>"
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/v1/vaults"
```

**期待結果:** HTTP 200, JSON 配列（空でも可）

### Web 認証（任意・stg/prd）

1. Vercel Frontend を開く
2. サインアップまたはログイン
3. ブラウザ DevTools → Network で `/api/auth/me` が 200
4. ログアウトでセッション Cookie がクリアされること

### Frontend（`VERCEL_TOKEN` ローテーション時）

1. Vercel Dashboard → Deployments → 最新 Production が **Ready**
2. ブラウザで Frontend URL を開き、コンソールに CSP 違反がないこと

---

## 全環境 OP_CONNECT 設定（Issue #59）

`OP_CONNECT_HOST` はクライアント向け Backend URL。`OP_CONNECT_TOKEN` は **local / dev / preview / stg** のレガシー Bearer（`prd` では per-user トークンのみ）。

| 環境 | `OP_CONNECT_HOST` | `OP_CONNECT_TOKEN` | Smoke |
|------|-------------------|--------------------|-------|
| prd | https://pass-share-backend-production.up.railway.app | 未使用（per-user） | `/health` + Web ログイン → Connect |
| stg | https://pass-share-backend-staging.up.railway.app | Railway Variables | `/v1/vaults` 200 |
| preview | https://pass-share-backend-preview.up.railway.app | Railway Variables | 同上 |
| dev | https://pass-share-backend-development.up.railway.app | Railway Variables | 同上 |
| local | `http://127.0.0.1:3000` | `.env` または shell export | 同上 |

### 一括 Smoke（PowerShell）

```powershell
$envs = @{
  stg = "https://pass-share-backend-staging.up.railway.app"
  preview = "https://pass-share-backend-preview.up.railway.app"
  dev = "https://pass-share-backend-development.up.railway.app"
}
foreach ($name in $envs.Keys) {
  $base = $envs[$name]
  Write-Host "=== $name ==="
  curl -sS "$base/health" | ConvertFrom-Json | Select-Object status, environment
  curl -sS "$base/metrics" | ConvertFrom-Json | Select-Object database, uptimeSeconds
}
```

`OP_CONNECT_TOKEN` 付き Connect smoke は環境ごとの Railway Variables から取得し、[ローテーション後 Smoke 手順](#ローテーション後-smoke-手順) を実行する。

---

## 受入基準 (Issue #47)

```gherkin
Given 本 Runbook が documents/runbooks/ に存在する
When 運用担当者が OP_CONNECT_TOKEN をローテーションする
Then 「ローテーション後 Smoke 手順」に従って検証できる

Given DATABASE_URL をローテーションした
When Backend を Redeploy する
Then /health と /health/db が ok を返す
```

## 実施記録

| 日付 | 実施者 | 対象シークレット | 環境 | Smoke 結果 | 備考 |
|------|--------|-----------------|------|------------|------|
| | | | | | |

## 関連ドキュメント

- [infrastructure.md](../spec/infrastructure.md) — 環境 URL / Variables
- [auth-api.md](../spec/auth-api.md) — セッション / Connect トークン
- [ADR 004: 認証・認可](../adr/004-auth-authorization-model.md) — 脅威モデル
