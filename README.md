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

# デスクトップ UI（React + Tauri）
cd apps/desktop
npm install
cargo tauri dev
```

## モノレポ構成

```
crates/passshare-core/   — 暗号・ドメイン・ストレージ
apps/desktop/            — Tauri デスクトップ（React + src-tauri）
frontend/                — Web ポータル（Vercel）
backend/                 — API（Railway）
documents/spec/          — 仕様（SSOT）
docker/                  — テスト用 Docker 環境
scripts/                 — Vercel / Railway セットアップ
```

## インフラ

| 環境 | Frontend (Vercel) | Backend (Railway) | DB |
|------|-------------------|-------------------|-----|
| prd | Production（手動 deploy） | production | postgres-prd-v2 |
| stg | Staging（手動 deploy） | staging | postgres-stg |
| preview | Preview / PR | preview | postgres-dev |
| dev | Development / **`main` push** | development | postgres-dev |

詳細: [インフラ仕様](documents/spec/infrastructure.md)

### 初回セットアップ

```powershell
# Railway（要 railway login）
.\scripts\setup-railway.ps1

# Vercel（要 npx vercel login）
.\scripts\setup-vercel.ps1
```

## ドキュメント

- [v2.0 本番完全版仕様](documents/spec/production-v2.md)
- [ADR 003: マルチクライアント](documents/adr/003-multi-client-architecture.md)
- [ADR 004: 認証・認可](documents/adr/004-auth-authorization-model.md)
- [MVP 仕様](documents/spec/feature-passshare-mvp.md)
- [デザインシステム](documents/spec/design-system.md)
- [デスクトップ UI](documents/spec/desktop-ui.md)
- [ランディングページ UI](documents/spec/landing-page-shell.md)
- [ランディングコンテンツ](documents/spec/landing-page-content.md)
- [UI 仕上げ（i18n / 検索 / 背景）](documents/spec/ui-polish.md)
- [インフラ仕様](documents/spec/infrastructure.md)
- [質問リスト](質問リスト.md)

## ライセンス

PassShareのオリジナルコードは [GNU AGPL version 3 only](LICENSE)（`AGPL-3.0-only`）で提供します。AGPLの条件を満たす商用利用も可能で、商用利用という理由だけで支払いは必要ありません。

AGPLの条件によらず利用したい場合は、別途有料の商用ライセンスを契約できます。条件・対象範囲は個別契約で定めます。お問い合わせ: contact@autodevjapan.com（AutoDevJapan）。詳細は [商用ライセンスの案内](COMMERCIAL-LICENSE.md) を参照してください。

第三者の依存ライブラリ・素材・同梱コードには各権利者のライセンスが適用され、その表示と条件を保持します。別途の商用契約によって第三者の条件が免除されるものではありません。
