# 共有鍵の暗号部品（Core）

共有ToDo #1163 / #1175、M4の一部です。パスワードボックスの鍵を、別アカウントの公開鍵に向けて
クライアントだけで包む・開くCoreの部品です。保存・配布・API・画面とWASMの公開APIへの接続は未実装です。
本番では有効にしておらず、この部品だけでM4を完了にしません。

実装: `crates/passshare-core/src/cloud_crypto/shared_keys.rs`（`cloud_crypto` から再公開）。
既存の項目暗号・所有者バンドル（[owner-key-bundle-api.md](owner-key-bundle-api.md)）の形式と鍵導出は変えていません。

## 方式

- RFC 9180 HPKE の **Auth モード** の single-shot。組み合わせは固定で
  DHKEM(X25519, HKDF-SHA256)（KEM 0x0020）/ HKDF-SHA256（KDF 0x0001）/ ChaCha20Poly1305（AEAD 0x0003）。
  ライブラリは `hpke` 0.14.1（必要な機能だけ有効）。DH・KDF・HPKEは自作しません。
- Base モードは使いません。送り手は自分のアカウント鍵で認証し、受け手は信頼済みの送り手公開鍵を指定します。

## アカウント鍵

- `AccountIdentity` は32バイトの秘密を持つ不透明な型です。Debug・Clone・シリアライズ・秘密の取り出しはありません。
  OSの乱数（`getrandom::fill`、失敗は `PS054`）で作り、HPKEの `DeriveKeyPair` で鍵ペアにします。
  破棄時に秘密のバッファを消去しますが、メモリ全体の消去は保証しません。
- 文脈は `{accountId, identityVersion}`。nilのUUIDは不可、版は1〜9007199254740991です。
- 端末での保存は、既存のローカル `MasterKey` と XChaCha20Poly1305 で包みます（`passshare.cloud.account-identity`
  の専用AADで、所有者バンドル・項目とは混ざりません）。追加のソルト・KDFはありません。
  包んだ形式は `{format:1, context, nonce, ciphertext}` で、秘密・公開鍵そのものは含みません。
  別の `MasterKey`・アカウント・版では開けません。
  復元には別途信頼した `expected_key_id` が必須です。同じアカウント・版で包まれた別の秘密への
  差し替えも、復元後の公開鍵の指紋が一致しなければ拒否します。
  HPKEの一時秘密鍵は固定依存のx25519-dalekのDrop/zeroizeで消去します。
  一時鍵の32バイト乱数はOSから先に取得し、消費分を即座に消去します。未使用分も破棄時に消去します。
  固定したHPKEが32バイトを1回消費することを既知解で検査し、依存更新時には再確認します。
- 公開側 `PublicAccountIdentity` は `{accountId, identityVersion, publicKey, keyId}`。
  `publicKey` は32バイトのcanonicalな標準Base64、`keyId` は公開鍵のSHA-256の小文字16進64桁です。

## 包んだ鍵の形式

```json
{"format":1,"suite":"hpke-auth/0x0020/0x0001/0x0003",
 "context":{"passwordBoxId":"<26桁の英小文字・数字>",
   "senderAccountId":"<UUID>","recipientAccountId":"<UUID>","keyEpoch":1,
   "senderIdentityVersion":1,"recipientIdentityVersion":1,
   "senderKeyId":"<64桁16進>","recipientKeyId":"<64桁16進>"},
 "enc":"<32バイトのBase64>","ciphertext":"<48バイトのBase64（鍵32+タグ16）>"}
```

- 文脈は固定順のJSONにして、ラベルを分けたうえでHPKEの `info` と AEAD の `aad` の両方に入れます。
- 未知のフィールド、`format`・`suite` の違い、長さの違い（Base64の復号前に確認）、canonicalでないBase64、
  canonicalでないX25519の点（最上位ビット・2^255-19以上）は拒否します。
  小さい位数の点はHPKEのDHの検査で拒否されます。
- 同じ文脈でも毎回新しい `enc` と暗号文になります。

## API

- `PasswordBoxKey::wrap_for_recipient(&self, sender: &AccountIdentity, recipient: &PublicAccountIdentity, context)`
- `PasswordBoxKey::unwrap_for_recipient(envelope, recipient: &AccountIdentity, sender: &PublicAccountIdentity, expected)`

どちらも不透明な `PasswordBoxKey` だけを扱い、生の鍵を呼び出し側へ渡しません。
信頼済みの公開鍵の構造を先に検査し、文脈が実際の送り手・宛先の公開鍵（アカウント・版・keyId）と
一致しなければ `PS050` です。期待する送り手・宛先・世代は、呼び出し側が自分で信頼した値を渡します。
包んだ鍵やサーバーの応答から導いてはいけません。
サーバーには秘密も展開済みのボックス鍵も渡りません。

## 安全性の範囲と制限

- **公開鍵の信頼は呼び出し側の責任です。** 帯域外の確認か固定した公開鍵が必要です。
  M3の画面での指紋の照合は未実装です。
- HPKE自体は再送・ダウングレードを防ぎません。防いでいるのは、文脈への結び付けと、
  呼び出し側が信頼する版・世代の指定です。最新の世代かどうかの判断は呼び出し側に残ります。
- RFC 9180 9.1.1 のとおり、Authモードは受け手の秘密鍵が漏れると送り手のなりすまし（KCI）を許します。
  受け手の秘密鍵の漏えいに対する前方秘匿性もありません。否認防止（署名）でもありません。
- 世代の更新は、新しいボックス鍵と新しい世代を残るメンバーにだけ包むことで、除外したメンバーが
  **今後の** 項目を読めなくするだけです。既に渡った鍵・平文を取り消すことはできません。
- 未実装: メンバー権限に基づく保存・配布、原子的な世代更新と項目の再暗号化、復旧、移行、
  各クライアント（Web・デスクトップ・モバイル・拡張・WASM）との接続。

## 検証（テスト）

Coreの単体テストで次を確認します: A→Bの往復（JSON経由、追加フィールド・配列を含む項目の復号）、
Cの拒否と宛先の付け替え、送り手の信頼鍵・文脈の各フィールド・`enc`・暗号文の改ざん、未知フィールド、
canonicalでない値・長すぎる値、毎回の乱数化、小さい位数の点、アカウント鍵の包み直しと
別の鍵・アカウント・版の拒否、世代更新後にBが新しい項目とCの包みを開けないこと（古い鍵での古い項目は読める）。

RFC 9180 付録 A.2.3（同じ組み合わせのAuthモード）の公開テストベクトルとの相互運用テストは、
`crates/passshare-core/tests/fixtures/rfc9180-a2-3-auth.json` にRFCの値をそのまま置いて実行します
（キー: `ikmE ikmR ikmS pkEm pkRm pkSm enc info` と、暗号化の sequence 0 の `aad pt ct`、小文字16進）。
送信側の乱数経路でも公式の`enc`・暗号文と一致し、32バイトを1回だけ消費して消去することを確認します。
2026-10-09に共有鍵のnative11件とClippy、実WASM Node1件が成功しました。
WASMの公開API・JavaScriptからの鍵操作は未実装で、wasm32でCoreを実行する検査だけです。
