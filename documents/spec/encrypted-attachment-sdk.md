# 受信者向け添付のRust SDK読取

既存の[添付クライアント仕様](encrypted-attachments-client.md)と[正式API仕様](encrypted-attachments-api.md)を補足する。対象は `EncryptedSessionClient` の有限な接続部品であり、元ToDo1163全体、全クライアント、販売条件の完了を表さない。

## 独立した期待値と通信契約

- `get_attachment_state(box_id, expected_key_epoch)` は `GET /api/encrypted/boxes/:boxId/attachment-state` を1回送る。返信は型付き `AttachmentState { state_revision, key_epoch }` の2属性だけを受け付ける。鍵世代は呼出側が独立して保持した期待値と照合する。この公開状態はCASの入力であり、鍵pin、認可、暗号認証の根拠ではない。
- `get_attachment_snapshot(state_revision, expected_item_context)` は `GET /api/encrypted/boxes/:boxId/items/:itemId/attachment-snapshot?revision=...` を1回送る。既存 `EncryptedItem` を厳密に復号前解析し、公開envelope構造と、独立した `ItemContext` のボックス・項目・項目版・鍵世代を全て照合する。owner向けsharing-snapshotは維持する。
- 呼出側は同じ状態版で項目と添付を取得する。項目をCoreで独立期待contextに対して認証し、順序を含む完全DTOを保持する。認証した添付参照から添付の期待contextを選び、`get_attachment` の結果をCoreで認証する。項目版や鍵世代を受信envelopeから採用しない。状態版はサーバーのロック内CAS照合であり、暗号文自体が状態版を認証しているとは扱わない。

状態版・項目版・鍵世代の読取範囲は1〜9,007,199,254,740,991。最大安全整数も読める。変更操作で必要な後続版の上限は変更しない。未知・欠落・同名JSON属性、null、型違い、安全整数外、不一致contextは拒否する。公開状態にはボックスIDがないため、ボックスは呼出側の検証済みルートで指定する。

既存transport/decode/envelope検証を再利用し、新しい依存を足さない。HTTP401/403/409を維持する。HTTPはloopbackのみ、他はHTTPSを要求し、転送先へのsession転送、proxy、自動再送を拒否する。応答のサイズ上限と固定診断を維持し、新しい秘密値を診断やDebugへ加えない。SDKは鍵を保持せず、期待contextやpinを書き換えない。

## 受入範囲

既存loopback SDK試験に、正確なルート・独立context・最大安全整数・属性の欠落/重複/未知・整数の拒否・401/403/409・転送先へ要求しないこと・送信回数の検査を加える。正常要求の対照後に不正入力がHTTPへ到達しないことも確認する。

正式受入toolは、現在の受信者が実SDKで公開状態→同状態版の項目→添付GET/PUT/DELETEを行う。公開状態の手書きHTTP成功をSDK成功へ読み替えない。実要求を転送する既存tapで各操作が1回だけ送信されたことを確認し、観測した操作だけを `SDK_REQUESTS` に加える。

Coreで全JSON・順序・全名前・全bytesを照合する。正確なPUT/DELETEの明示再送、古いCAS/状態版の409、古いgrant、除名後の旧/新sessionとConnect tokenの403/401、全rowとxminの不変条件を確認する。所有者向けsnapshot、公開状態の認可・transport・ロック待ち後の期限切れ/取消拒否、既存の回転・復元・容量・SQL rollback受入を残す。

正式Nodeと所有情報を照合した専用PostgreSQLで全件受入する。Docker配布image/Linux CI、root workspace最終検査とdoctest、Chrome画面、正式配布と元22条件は親担当の工程に残る。
