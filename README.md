# PassShare

非 IT エンジニア向けのパスワードマネージャー。Rust で暗号化コアを実装し、Tauri デスクトップアプリで操作します。

## 特徴（MVP）

- **パスワードボックス**: マスターパスワード1つでログイン情報を安全に保管
- **ローカル保存**: 端末内に暗号化。サーバーに平文を送らない
- **パスワード生成**: ワンクリックで強力なパスワードを作成
- **検索**: サイト名・URL・ユーザー名からすぐ見つける

## 必要環境

- Rust 1.75+
- Docker（テスト実行用）
- Node.js 20+（デスクトップ UI ビルド時）

## セットアップ

```bash
# コアのテスト（Docker）
docker compose -f docker/docker-compose.test.yml run --rm test

# コアのテスト（ローカル）
cargo test -p passshare-core
```

## モノレポ構成

```
crates/passshare-core/   — 暗号・ドメイン・ストレージ
apps/desktop/            — Tauri デスクトップ（src-tauri + ui/）
frontend/                — Web ポータル（Vercel）
backend/                 — API（Railway）
documents/spec/          — 仕様（SSOT）
docker/                  — テスト用 Docker 環境
scripts/                 — Vercel / Railway セットアップ
```

## インフラ

| 環境 | Frontend (Vercel) | Backend (Railway) | DB |
|------|-------------------|-------------------|-----|
| prd | Production / `main` | production | postgres-prd |
| stg | Staging / `stg` | staging | postgres-stg |
| preview | Preview / PR | preview | postgres-dev |
| dev | Development / `develop` | development | postgres-dev |

詳細: [インフラ仕様](documents/spec/infrastructure.md)

### 初回セットアップ

```powershell
# Railway（要 railway login）
.\scripts\setup-railway.ps1

# Vercel（要 npx vercel login）
.\scripts\setup-vercel.ps1
```

## ドキュメント

- [MVP 仕様](documents/spec/feature-passshare-mvp.md)
- [デザインシステム](documents/spec/design-system.md)
- [ランディングページ UI](documents/spec/landing-page-shell.md)
- [インフラ仕様](documents/spec/infrastructure.md)
- [質問リスト](質問リスト.md)

## ライセンス

MIT
