# 暗号文セッションSDK（Rust）

共有ToDo #1163 / #1175、M4の一部です。`crates/passshare-connect` の `EncryptedSessionClient` は、
[暗号文保存API](encrypted-storage-api.md) と [所有者キーバンドルAPI](owner-key-bundle-api.md) を
呼ぶ Rust SDK です。既存の `ConnectClient`（Connectトークン用）とは別で、変更していません。
**M4全体は完了していません。** 下の「残り」を参照してください。

## 追加したもの

- 認証は呼出元が渡す **セッションのBearer**。Connectトークンではありません。`Debug` では伏せ字です。
- メソッド: `state` / `enable_empty_box` / `list` / `get_item` / `put_item` /
  `get_owner_key` / `put_owner_key`。パスは `<base>/api/encrypted/...` に固定です。
- 暗号文はCoreの `EncryptedItem` / `WrappedPasswordBoxKey` をそのまま使います。
  所有者バンドル用に `OwnerKeyBundle`（format 1・16バイトsalt・wrapped）と `validate()` を追加しました。
- SDKは鍵を持たず、復号も暗号化パスワードの受け取りもしません。AEADの検証は、呼出元が自分で決めた
  期待文脈を使い、Coreの `decrypt_item` / `unwrap_for_owner` で行います。

## 安全側の決め事

- ベースURL: `https` のみ。`http` はリテラルの `localhost` / `127.0.0.1` / `[::1]` に限ります。
  ユーザー名・パスワード・クエリ・フラグメント・`..`（`%2e` 含む）・`\`・`%2f` は拒否します。
- リダイレクトは追従しません（3xxはそのままエラー）。接続10秒・全体30秒。プロキシは使いません。TLS検証の無効化はありません。
- 応答は最大 約1.4MB（最大の暗号文のBase64＋枠）で打ち切ります。エラー本文は16KiBまでです。
- ID は26桁の英小文字・数字。期待版は0〜9007199254740990。`put_item` の送信版は期待版+1。
  nonceは24バイト、暗号文は16〜1048592バイトのcanonical Base64です。
- 応答は未知フィールドを拒否し、保存先・項目・世代・版を構造的に検査します。`put_item` / `put_owner_key` の応答は
  送信内容と完全一致が必要です。`get_owner_key` は呼出元の期待文脈と違えば `ContextMismatch` です。
  サーバーの応答から期待文脈を作ることはありません。
- エラーはHTTPステータスと `PSxxx` コードだけを持ちます。本文・トークン・パスワードは含みません。
  正式APIの `error` フィールドからコードを取り出し、成功は契約どおりHTTP200だけを受け付けます。
  401/403/404/409/429/503 はそのまま返し、409（`PS015` 版の競合）も自動再試行や代替保存をしません。
- `put_owner_key`: 期待版0はパスワード不可、1以上は **現在のログインパスワード** が必須です。暗号化パスワードは扱いません。
  パスワードは上書き時の本文にだけ入ります（送信用バッファのゼロ化まではしていません）。

## 検証

`encrypted_client.rs` 内のテストが、ローカルのTCP fixture（`std::net`＋スレッド、有限の期限）で実際のHTTPの
パス・ヘッダー・JSONを観測します。Core生成の暗号文でPUT/GET往復と `decrypt_item`、リダイレクトでの
Authorization非転送、不正URL・ID・版、応答サイズ上限、エラーの秘密非表示、期待文脈の不一致を確認します。
これら19件の検査とClippyは成功しました。欠落状態・HTTP200以外・有効化応答の形式・
100件のページで最後の項目と一致しないカーソルや欠落カーソルも拒否します。
`tools/encrypted-storage-acceptance` はSDKを使って、正式Node／配布DockerとPostgreSQLに対する
有効化、状態、項目の保存・取得・一覧、所有者バンドル取得と409のコードを検査します。
2026-10-09に正式Nodeと正式配布Dockerの両方で全受入が成功し、検査用サーバーとDBも回収しました。
同期したCore処理の間もHTTP接続を処理するため、検査ツールは1スレッドの非同期実行環境を動かし続けます。
一度の`block_on`ごとに実行環境が止まる構成で発生した通信失敗を保存し、同じSDKとAPIで修正後の成功を確認しました。

## 残り（このSDKでは未提供）

アプリ／UI／worker への組み込み、端末での安全な鍵保管、全クライアント対応、共有鍵の配布・失効・世代更新、
復旧、平文移行、暗号化した添付、プラン上限、公開環境での受入です。ブラウザ・WASM向けの接続もありません。
SDKの合格だけでM4を完了にしません。
