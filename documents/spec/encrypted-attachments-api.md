# 添付暗号文の保存と鍵更新

元ToDo1163のM4-C/M8-Bに必要なAPI・PG接続の有限実装。Coreの契約は `encrypted-attachments-core.md`。旧形式の移行、全クライアント、GUI、Railway、製品の22条件全体は未完了。

## 保存契約

`/api/encrypted/boxes/:boxId/items/:itemId/attachments/:attachmentId` のPUTは次の公開JSONだけを受け取る。

```json
{"expectedStateRevision":1,"item":{"expectedVersion":1,"envelope":"<次のEncryptedItemオブジェクト>"},"expectedVersion":0,"envelope":"<EncryptedAttachmentオブジェクト>"}
```

DELETEでは添付の `envelope` を `keyEpoch` に置き換える。GETには `?revision=<stateRevision>` が必要。項目と添付の版は独立し、新規添付は0→1、更新はn→n+1。親項目は必ず生存し、その次の暗号文も同じ取引で保存する。通常の項目PUTは添付行を変更しない。参照配列の意味・順序と添付の認証はクライアントのCoreが照合し、サーバーは暗号文を読まない。

Rustは公開形式・余分な属性・安全整数・canonical Base64・公開長を検査する。Nodeは添付本文の元JSONをRustへ渡し、重複属性と小数表記がJSON.parseで失われる前にも拒否する。SQLも厳密形式を再検査する。名前・実本文・ルート鍵を送信・保存しない。

SQLの1回の要求が1取引になる。既存のボックス→利用者→session→確認済み所属のロック順で、現在世代・現在の共有鍵・書込み権限を確認する。応答を失った再送は、元の状態指定を含む要求のハッシュ、項目の完全一致、添付または削除記録の完全一致、現在の確定後状態版がそろう場合だけ200・書込みなし。別内容・古い状態・片方だけ一致は409。削除済み添付IDは全世代で予約し、親項目の削除記録も再作成を拒否する。

1ボックスの技術上限は生存添付1024件・保存された全公開envelopeのUTF8合計1GiB。SQLの `octet_length(envelope::text)` で測り、同じ再送を二重加算しない。1個の本文1MiB・名前4096 UTF8 bytesはCoreの上限。HTTPは既存2MiBのままで、親項目暗号文を含む実要求全体もこの上限内に収める。追加料金・外部保存先は作らない。

## 一括鍵更新

所有者の `sharing-snapshot` は生存添付がある場合だけ件数・保存bytesを追加する。`sharing-snapshot/attachments?revision=...&after=<itemId>:<attachmentId>` は100件ずつID・添付版・世代を返す。同じ状態版の `sharing-snapshot/items/:itemId/attachments/:attachmentId?revision=...` で暗号文を取得する。

`rotations/:operationId/items/:itemId/attachments/:attachmentId` のPUTで、`expectedVersion` と、新世代・次の添付版でCoreが封じ直した `envelope` を仮置きする。仮置きの重複は同内容だけ成功し、容量を二重加算しない。既存の期限・status・再開・abortを使う。

確定は元の状態版に対し、全生存項目と全生存添付のID・版・世代を両方向で照合する。新しい項目暗号文内の添付参照、新しい添付、新しい所有者鍵包み、残る共有配布、除名と旧トークン削除を同じ取引に含む。欠落・追加・並行編集・削除・容量・期限・認可変更・書込み故障では原状態を保持する。添付0件の応答は既存の厳密SDK形式を保つ。添付のあるボックス向けSDK・WASM・各クライアントは別途接続する。

新テーブルは `encrypted_attachments`、`encrypted_attachment_tombstones`、`encrypted_rotation_attachments`。既存 `backend/native/src/encrypted-schema.sql` と同じ移行経路で導入し、共有の認可付き移行ロックを維持する。復元の既知テーブル一覧、全公開テーブルの比較、失敗時の全行・xmin証拠に3表を加える。

## 有限受入

既存の正式Rust受入ツールに `--encrypted-attachments` を追加する。Nodeモードでは指定manifestの既存PostgreSQLだけを使い、`passshare1163_attach_<random>` の専用DBを作成・回収する。親のサーバー・DBを停止しない。Dockerモードの既存所有記録と回収は保つ。

```text
passshare-encrypted-storage-acceptance --local-postgres <absolute-owned-fixture-manifest> --encrypted-attachments <formal-native-binary>
```

Core→正式Node→独立PG→Coreで名前・任意bytes・参照順の全文一致、最大本文、通常編集保持、独立CAS、削除予約、原状態保持、101件pagination、全添付を含む鍵更新と除名、実dumpと別DBへの全公開テーブル復元を確認する。SQLモック・memory成功・Core単体成功を正式PG受入へ転用しない。本番RTO/RPO、旧形式移行や全clientの受入とは区別する。

2026-10-11の有限子で、native77件、省略0、受入ツール単体12件と実PGのSQL輸送2件（大SQL・専用DB100回読取り）、復元ツール18件が成功した。3クレートのall-targets Clippy `-D warnings` も成功。通常のnextestから外す制御用の子検査は、親検査が子プロセスとして使う。PG輸送2件は明示指定で実行した。

正式Node→専用PG→Coreの実添付受入は1020判定、省略0で成功した。101件pagination、名前と全bytes・参照順、最大本文、CAS・再送・削除予約、認可変更、書込み故障、全添付の鍵更新・失効、全公開テーブルの隔離復元と現在の認可・鍵状態照合を含む。SDKの厳密な添付0件のsnapshot/status/commitも実APIで成功。既存backend101件も成功し、DB/CLI等の7スイートは条件不足で省略した。これらの単体検査を実PG受入へ転用していない。

GPT-5.5の独立レビューはMust 0件。除名後の旧・新Connectトークン検査の追加提案を反映し、追加差分レビューも指摘0件。途中のDTO必須属性漏れ、本文なしGETの元JSON渡し、復元一覧の並び、backend検査の正式バイナリ指定漏れを修正した。補助psqlは途中2回失敗し、うち1回で終了2を確認した。[psqlの公式仕様](https://www.postgresql.org/docs/16/app-psql.html)では接続中断を示す。発生源は未特定であり、修復済みとは主張しない。書込みを再送せず、秘密値を出さない分類・終了情報を追加し、その後の全受入と専用DB100回読取りは成功した。

全workspace・doctest・CI・配布イメージ・WASM・各クライアント・旧形式移行・Railwayは親の統合後検査へ残す。M4-C/M8-Bや原22条件全体の完了には数えない。
