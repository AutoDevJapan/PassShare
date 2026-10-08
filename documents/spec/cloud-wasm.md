# クライアント側のWASM暗号化境界

M4のCoreをWebと拡張から使うための接続部です。これだけで全クライアントの暗号化や
共有・復旧・移行が完成したとは扱いません。APIへ自動登録せず、本番の設定を変えません。

`packages/cloud-wasm` は既存Coreを再利用するRust製WASMです。root Coreをコピーせず、
nativeと同じXChaCha20-Poly1305、保存先・版・世代のAEAD、Argon2idを使います。
乱数はWASMのJavaScript用getrandomバックエンドを使います。

- `CloudPasswordBox(ownerContext)` が鍵を生成し、WASMのRustオブジェクトだけに保持します。
- `wrap_for_owner(encryptionPassword)` が16バイトの新しいsaltと所有者用の暗号化鍵を返します。
  Argon2idはCoreの64MiB・3回・並列度4で、bundle形式1に固定します。
  Coreの既定値には連動せず、形式1専用の費用を直接指定します。パスワードはNFCに
  正規化し、OSごとの結合文字の表現差で鍵が開けなくなることを防ぎます。
- `unlock(bundle, encryptionPassword, expectedOwner)` が暗号化鍵から再開します。
  保存先・所有者・世代は呼出元が期待値として渡し、bundleの値だけを信用しません。
- `encrypt_item` は項目の全JSONを暗号化し、公開ヘッダーと暗号文だけを返します。
- `decrypt_item` は期待する保存先・項目・版・世代を照合して全JSONを復号します。
- `lock()` が鍵を解放・消去します。以後の暗号化・復号・鍵の暗号化は拒否します。

生鍵の取得・JSON化・HTTP・ファイル書込み・ログ出力は提供しません。秘密の入力文字列は
Rust側で消去し、正常に解析した平文JSONの文字列とプロパティ名も処理後に消去します。
復号した返却バッファもJSへコピーしたあとRust側で消去します。Argon2のzeroizeも有効にします。
JavaScript側の入力・返した復号JSON・画面状態は呼出元が保持するため、画面を閉じるときに
別途消去する必要があります。WASMだけでJavaScriptの全メモリ消去を保証しません。

ここへ渡す暗号化パスワードはアカウントのログインパスワードと別です。サーバーの認証APIへ
送らず、変更・復旧の方法や操作画面を全クライアントの鍵設計と合わせて検証します。
所有者用bundleのサーバー保存、端末の安全な鍵保管、メンバーへの鍵配布・失効・復旧、
旧平文移行、添付とプラン上限は引き続き元の販売条件です。

## 検証

独立Cargo workspaceのnative検査、Clippy、wasm32ビルド、実WASMのNode受入を分けます。
`tests/wasm.rs` はWASMへコンパイルしてNodeで実行し、乱数、全JSON、鍵を解放した後の
再開、誤パスワード・期待版違い、施錠後の拒否を確認します。Web画面の検査ではありません。
ブラウザでの実行とUI接続は別に確認します。
Argon2処理と鍵保持は専用Workerへ置き、画面を停止させず、施錠・背景移行時には
鍵を消去してWorkerを終了する接続を次に確認します。項目JSONは値を保持し、キーの順序は正規化します。
固定の公開架空データ `tests/format1-vector.json` は形式1の復号互換性を検査するため保持します。
