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

## ドキュメント

- [MVP 仕様](documents/spec/feature-passshare-mvp.md)
- [質問リスト](質問リスト.md)

## ライセンス

MIT
