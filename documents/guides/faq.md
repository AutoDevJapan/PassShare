# FAQ / トラブルシューティング

> Issue [#114](https://github.com/AutoDevJapan/PassShare/issues/114)  
> Web: `/faq`  
> 最終更新: 2026-05-28

## マスターパスワードを忘れた

マスターパスワードは PassShare サーバーに保存されません。現在、緊急キットの値だけで端末版のボックスを開く機能はありません。マスターパスワードと .pbox のバックアップを安全に保管してください。紛失時の復旧を保証できません。

## クラウド同期で競合が出る

Desktop → 設定 → クラウド同期で競合一覧を確認し、「ローカル優先」または「クラウド優先」を選択してください。

## 拡張機能にログインできない

- `OP_CONNECT_HOST` が正しい Backend URL を指しているか確認
- Web でログイン後、拡張用 refresh トークンが発行されているか確認
- 拡張を再読み込みしてから再ログイン

## API が 401 を返す

- Connect Bearer トークン期限切れ → 各クライアントから再ログイン
- CLI 利用時は `OP_CONNECT_TOKEN` が最新か確認

## コピーしたパスワードが消えない

Desktop / Web の設定でクリップボード自動消去秒数を確認（デフォルト 30 秒）。OS 側のクリップボード履歴は PassShare の制御外です。

## 関連

- [user-guide.md](./user-guide.md)
- [connect-api-monitoring.md](../runbooks/connect-api-monitoring.md)
