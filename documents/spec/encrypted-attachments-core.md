# 添付の実バイト暗号化（Coreの契約）

元ToDo1163のM4-A/M4-C/M8-Bに向けた部品。HTTP、WASM、各クライアント、移行・復旧の接続と受入は未完であり、元の22条件の達成を意味しない。既存の項目・鍵包み・互換保存モードは変更しない。

## 型と暗号化

`passshare_core::cloud_crypto` は `AttachmentContext`、`EncryptedAttachment`、`AttachmentPlaintext` を公開する。鍵は既存 `PasswordBoxKey` の内部に保持し、`encrypt_attachment(&plaintext, &context)` と `decrypt_attachment(&envelope, &expected)` で使う。鍵のraw公開はない。

公開形式は次のフィールドだけ。各階層の余分な属性・欠落・重複属性は、直接JSONからのDeserializeで拒否する（JSON Valueへの変換で消えた重複は復元できない）。構造体を直接作るRust呼出元にも暗号処理時に同じ検査を行う。`validate_public()` は形式検査であり、認証・所属・削除状態の検査ではない。

```json
{"format":1,"context":{"passwordBoxId":"<26 lowercase letters/digits>","itemId":"<26 lowercase letters/digits>","attachmentId":"<26 lowercase letters/digits>","attachmentVersion":1,"keyEpoch":1},"contentBytes":0,"nonce":"<24 bytes canonical standard Base64>","ciphertext":"<canonical standard Base64>"}
```

添付版と鍵世代は整数1〜9007199254740991。添付版は項目JSONの版と独立した、保存された添付エンベロープの版。本文・名前の変更と鍵更新では添付版を進める。通常の項目編集だけでは添付を包み直す必要はない。項目の暗号化JSONには添付ID・添付版・世代の参照を配列の元の順序で保持し、その認証済み参照と信頼済みの現在状態からexpectedを作る。受信エンベロープ自身からexpectedを作らない。

既存XChaCha20Poly1305、256bitボックス鍵、OSの乱数による書込みごとの新しい192bit nonceを使う。AADはUTF-8の空白なしJSONで、以下のタプルをこの順序でSerializeしたもの。contextのキー順は上の型宣言の順序。

```text
["passshare.cloud.attachment",1,context,contentBytes]
```

ボックス・項目・添付ID、添付版、鍵世代、公開本文長を認証する。用途は項目、所有者鍵、account identity、共有鍵の各用途から分離する。形式は1に固定し、未知の形式は拒否する。Base64は標準アルファベット、必要なpadding付き、空白なし、末尾の未使用bitは0。nonce・暗号文は復号前に検査する。

暗号化する平文DTOは名前（UTF-8）と任意の実バイト。JSON/base64にせず、`nameByteLength:u32 big-endian || name UTF-8 || file bytes` の1つのフレームを暗号化する。復号後も名前長、UTF-8、本文長を検査する。外側に名前・本文・本文のハッシュを持たせない。本文長と暗号文長から概算の名前長は分かる。

`AttachmentPlaintext::new(String, Vec<u8>)` は所有権を受け取り、失敗時も破棄して消去する。返値はDebug/Clone/serdeを持たず、Zeroize/ZeroizeOnDropで名前と本文を消す。getterは借用のみ。呼出元が作ったコピーや入力元のbufferの消去は呼出元の責任。暗号化フレームはタグを含め一度に確保し、復号はZeroizing bufferを所有した上でin-placeで行う。認証失敗・平文解釈失敗・乱数失敗の通常エラー経路でbufferを破棄する。プロセス強制終了時の消去は保証しない。診断は固定エラー、検査のassertは真偽値で、秘密値を表示しない。

## 有限の容量

調査した既存 `backend/src/connect/router.js` / `store/pg-store.js` と `documents/spec/openapi/connect-api.yaml` にはファイル固有の最大値がなく、既存 `backend/src/app.js` のJSON本文制限は2MiB。1PUX全体の取込制限は添付1個の契約ではない。このCoreでは新料金を伴わない技術上限を採用する。

| 対象 | 上限 |
|---|---:|
| 実本文（空ファイル可） | 1,048,576 bytes（1MiB） |
| 名前（空の名前可） | 4,096 UTF-8 bytes |
| 平文フレーム | 1,052,676 bytes |
| 暗号文（タグ16 bytes込み） | 1,052,692 bytes |
| 暗号文のBase64文字数 | 1,403,592 ASCII bytes |

本文長は整数0〜1048576。復号前の暗号文長は `4 + contentBytes + 16` 以上、その値＋4096以下。全上限は32bitのWASMでも表現可能。項目JSONの既存1MiB制限へファイル実本文を入れない。1添付ずつ送るJSONの固定context/nonceを含むエンベロープは1,404,000 bytes以内で、最小のPUT wrapperを含めても既存2MiB本文制限以内に収まる。HTTP接続では実際のwrapperを含む本文を計数し、一度に複数添付を送らない。

WASM接続では実本文をUint8ArrayからCoreへ渡し、JSON数値配列や入力側base64の追加膨張を避ける。JS↔WASMの入力コピー・平文DTO・フレーム・返却Base64・JS文字列の同時生存容量を計数する。1ファイルずつ処理し、使用後のJS bufferも消去する。これはWASMの実容量やHTTP成功を実測した証拠ではない。

プランの個別容量は別途現在の製品契約から検査する。保存では全envelopeの実bytesと添付件数、仮置きでは現在の全生存集合を基に総量を計数し、同一再送で二重加算しない。追加保存先・常駐処理・課金を作らない。

## 親担当が接続する未完の状態管理と受入

- HTTPは独立expectedVersionによるCAS、新規0→1、更新n→n+1、現在世代・現在所属・権限を取引内で確認する。添付版をsafe integerの上限から増やす操作は拒否する。公開形式をサーバーでも検査し、AEAD認証はCoreで行う。
- 過去に削除した添付IDは、項目IDとの組に対する削除記録で全世代の再作成を拒否する。項目自体の削除IDも既存契約どおり予約する。Coreは状態を保持しないため、古い有効暗号文の復号や削除IDの暗号化自体を拒否する機能ではない。
- sharing snapshotを添付集合にも拡張し、同じstateRevisionで全生存添付のID・版・世代と実暗号文を取得する。鍵更新は全添付を新鍵・新世代・次の添付版へ包み直し、項目JSONの参照も更新する。添付・項目・鍵bundle・共有配布・所属解除を同じ一括確定へ含め、欠落・追加・並行編集・削除を拒否する。
- 移行・復元では項目DTOと全添付の実bytes・名前・参照順・版を再読取で照合し、故障時に原本を保持する。既存互換APIの平文name/contentを暗号文APIの保存欄へ混ぜない。
- backend、Rust SDK/CLI、全client、WASMへ接続する。WASMビルドのCore入力宣言へ `crates/passshare-core/src/cloud_crypto/attachments.rs` を含め、変更したcloud_crypto.rsとともに正式ビルドからmanifestを生成する。この子は生成WASM/manifestを変更しない。
- Core→正式HTTP→PostgreSQL→Coreと実GUIで、複数添付の原内容と順序、0/最大/超過、独立した改変/wrongkey/wrongcontext、失効、CAS、削除ID再利用拒否、鍵更新・移行・復旧を受入する。Core単体成功をM4/M8や元22条件全体の完成に数えない。

## この子で確認した結果

2026-10-11、専用target・共有Cargoゲート・sccacheで `cargo nextest run --locked -p passshare-core` が140件成功（添付49件、既存91件）、失敗0・省略0。`cargo clippy --locked -p passshare-core --all-targets -- -D warnings` と変更Rustファイルのrustfmt確認も成功。全workspace・doctest・WASMビルド・HTTP/GUI・CIは、この子では実行せず親の統合後検査へ残す。

GPT-5.5による独立した読取レビューはMust 0件。復号DTOの容量を構築時に指定する提案は、現状も空の各fieldへ1回だけコピーし、再確保で平文を残す経路がないため採用しない。未完の受入という見出しの明示は反映した。Claudeは週次利用上限、当初指定したGPT-5.4はChatGPTアカウント非対応のため、利用可能な別モデルへ切り替えて確認した。
