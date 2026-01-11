# デプロイメントガイド

## 概要

| コンポーネント | サービス | URL |
|----------------|----------|-----|
| フロントエンド | Vercel | https://passshare.dev |
| バックエンドAPI | Railway | https://passshare-api.up.railway.app |
| データベース | Railway PostgreSQL | （内部接続） |

## Vercel（フロントエンド）

### 初回セットアップ

```bash
# Vercel CLIインストール
npm i -g vercel

# プロジェクトリンク
cd frontend
vercel link
```

### 環境変数

| 変数 | 値 |
|------|-----|
| `VITE_API_URL` | https://passshare-api.up.railway.app |

### デプロイ

```bash
# プレビューデプロイ
vercel

# 本番デプロイ
vercel --prod
```

### 自動デプロイ

GitHubリポジトリをVercelに接続すると、`main`ブランチへのプッシュで自動デプロイされます。

## Railway（バックエンド + DB）

### 初回セットアップ

1. Railway でプロジェクト作成
2. PostgreSQL プラグイン追加
3. GitHub リポジトリ接続（`backend/` ディレクトリ指定）

### 環境変数

Railway PostgreSQL接続時、`DATABASE_URL` は自動設定されます。

| 変数 | 説明 |
|------|------|
| `DATABASE_URL` | PostgreSQL接続URL（自動） |
| `DEBUG` | `false` |
| `SECRET_KEY` | ランダム文字列 |
| `GITHUB_TOKEN` | GitHub API トークン（オプション） |
| `GITHUB_REPO` | `bm1314/passshare` |

### デプロイ

GitHubへのプッシュで自動デプロイ。

手動デプロイ:

```bash
# Railway CLIインストール
npm i -g @railway/cli

# ログイン
railway login

# デプロイ
cd backend
railway up
```

### マイグレーション

デプロイ時に自動実行されます（`railway.json` の `startCommand` 参照）。

手動実行:

```bash
railway run alembic upgrade head
```

## Electron（デスクトップアプリ）

### ビルド

```bash
cd frontend

# Windows
pnpm electron:build:win

# macOS
pnpm electron:build:mac

# Linux
pnpm electron:build:linux
```

### 出力先

`frontend/release/` に以下が生成されます:

- Windows: `.exe` インストーラー
- macOS: `.dmg` / `.zip`
- Linux: `.AppImage` / `.deb`

### コード署名（本番）

Windows/macOSでの配布には署名が必要です。

**Windows:**
- EV コード署名証明書を取得
- `electron-builder.yml` に `certificateSubjectName` を追加

**macOS:**
- Apple Developer Program に登録
- `electron-builder.yml` に `identity` を追加
- Notarization 設定

## Capacitor（モバイルアプリ）

### 初期化（初回のみ）

```bash
cd frontend

# iOS
pnpm cap:add:ios

# Android
pnpm cap:add:android
```

### ビルド & 同期

```bash
# Webビルド + ネイティブ同期
pnpm cap:sync
```

### 開発

```bash
# iOS（Xcode起動）
pnpm cap:open:ios

# Android（Android Studio起動）
pnpm cap:open:android
```

### 実機テスト

```bash
# iOS
pnpm cap:run:ios

# Android
pnpm cap:run:android
```

### ストア公開

**iOS (App Store):**
1. Xcode でアーカイブ
2. App Store Connect にアップロード
3. 審査提出

**Android (Google Play):**
1. Android Studio で署名付きAPK/AAB生成
2. Google Play Console にアップロード
3. 審査提出

## CI/CD（GitHub Actions）

### 推奨ワークフロー

```yaml
# .github/workflows/deploy.yml

name: Deploy

on:
  push:
    branches: [main]

jobs:
  frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: amondnet/vercel-action@v25
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}
          vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}
          working-directory: frontend
          vercel-args: --prod

  # Railway は GitHub 連携で自動デプロイ
```

## 環境別設定

| 環境 | フロントURL | API URL |
|------|-------------|---------|
| 開発 | http://localhost:5173 | http://localhost:8000 |
| ステージング | https://passshare-staging.vercel.app | https://passshare-api-staging.up.railway.app |
| 本番 | https://passshare.dev | https://passshare-api.up.railway.app |
