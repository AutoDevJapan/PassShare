# 添付のWASM workerとRust SDK接続

元ToDo1163のM4-C/M8-Bに必要な有限の接続部品。Core/APIの暗号・保存・認可処理は再実装しない。GUI、旧形式移行、Android実機、正式PostgreSQLを通したSDKの統合受入、配布assets、最終pipelineと元22条件の受入は親担当の工程である。

## 不透明bindingと独立した期待値

`CloudPasswordBox` の私有Sessionが既存 `PasswordBoxKey` を使う。`encrypt_attachment(name, owned_bytes, expected_attachment_context)` はCoreの `AttachmentPlaintext` を暗号化する。`decrypt_attachment(envelope, expected_attachment_context, attachment_source)` は認証した名前とbytesだけを持つ `CloudAttachment` を返す。raw鍵getter、SDK内の暗号処理、サーバーへの平文送信はない。bindingを直接使う呼出元は返却ハンドルをfreeし、JSの返却bufferを使い終わったら消す。

期待添付contextは必須の独立入力で、次のCore型のJSON文字列である。

```json
{"passwordBoxId":"<26 lower alphanumeric>","itemId":"<26 lower alphanumeric>","attachmentId":"<26 lower alphanumeric>","attachmentVersion":1,"keyEpoch":1}
```

復号ではさらに次の `attachmentSource` のJSON文字列を必須とする。4個の属性だけを受け付け、null、未知・重複属性、不正整数を拒否する。

```json
{"itemEnvelope":"<EncryptedItem JSON string>","expectedItemContext":{"passwordBoxId":"<box>","itemId":"<item>","itemVersion":3,"keyEpoch":1},"itemSnapshotRevision":17,"attachmentSnapshotRevision":17}
```

呼出元は信頼して保持する状態版で項目と添付を取得し、独立した項目版・ボックス・世代から `expectedItemContext` を選ぶ。Rustは両snapshot版の正のsafe integerと一致を確認し、項目暗号文をCoreで認証する。完全な項目DTOの `attachments` にある `{attachmentId,attachmentVersion,keyEpoch}` を独立expectedと照合する。参照は1024件以内、重複IDなし、現世代であり、対象参照が必須。順序を変更せず、ファイル名や本文を参照欄に要求しない。

期待値を受信添付envelope自身から作ってはならない。snapshot版は輸送元を呼出元が保持した証拠であり、暗号文が状態版を認証しているとは主張しない。SDKの同revision取得、独立項目期待値、Rustの認証済み参照照合を組み合わせる。未接続のGUIがこの取得手順を実行したとは扱わない。

所有者・受信者ともSessionのbox/epochだけで添付を扱う。受信者は既存の独立PeerContextで得た鍵を使い、owner wrap/recoveryの拒否を保つ。identityだけ、boxだけ、両方、両方なしの4状態を保ち、添付操作は世代を進めず、identity-onlyの5分期限や信頼UI入力による期限管理を変更しない。

## version 1の有限binary surface

Web共有画面のsnapshotは、添付がある場合に正式APIが返す `liveAttachmentCount` と
`liveAttachmentBytes` を両方保持します。添付がない旧応答では、両方の省略だけを0として扱います。
片方だけの省略、型違い、不正整数、件数・容量の上限超過、未知の属性は拒否します。
実WASMとTypeScriptの接続検査に正常2形式と不正8形式を加え、Cloud WASM CIにも接続します。
添付ありのsnapshotを古い7属性だけの応答検査で拒否する不整合を修復するための条件です。

既存の文字列要求を維持し、添付暗号化だけに構造化cloneの `{message,bytes}` を加える。余分な外側属性を拒否し、bytesは通常の `Uint8Array` または `ArrayBuffer` のみ。SharedArrayBuffer、null、JSON数値配列、Base64文字列を拒否する。入力本文は1MiB以内、名前4096 UTF8 bytes以内。Workerを通すWeb transportは所有権をtransferし、部分viewは専用コピーへ移して元viewを消す。

| command | message内の追加必須属性 | 成功結果 |
| --- | --- | --- |
| encryptAttachment | expectedGeneration, expectedAttachmentContext, name | 既存形の文字列返信、envelope |
| decryptAttachment | expectedGeneration, expectedAttachmentContext, envelope, attachmentSource | `{message,bytes}`、message内にname |

両messageには `version:1`, 正のsafe integer `requestId`, `command` を含む。復号要求は従来どおり文字列であり、binary入力を付けてはならない。成功した復号返信のmessageには既存のversion/requestId/generation/locked/identityLocked/okとnameだけを含み、bytesは別のUint8Arrayとしてtransferする。本文1MiB、名前4096 UTF8 bytes、source 2,000,000 UTF8 bytes、envelope 1,500,000 UTF8 bytes、文字列message全体6MiB+4096の上限を保つ。

未知属性、null、不正型、超過、context不一致、古いgeneration、再生要求は固定エラーで拒否し、有効な私有鍵を置き換えない。正しいlockは遅着・再生でも両鍵を破棄し、世代を進める。終了後に鍵へ到達できない。強制終了時の全メモリ消去は保証しない。

Rustのowned入力、DTO、暗号化・復号フレーム、返信文字列は既存zeroize/Zeroizing経路で通常終了・エラー時に消す。Worker内の処理済みJS mutable入力も消す。Web transportは `releaseAttachment`、終了・scope切替・取消・遅着返信でmutable返却bufferを消し、取消済み結果を復元しない。JSのimmutable文字列、WASM境界の一時コピー、全メモリの消去は保証しない。

容量は1ファイルずつ有限で、本文の入力をJSON/base64へ変換しない。WASMへのowned入力コピー、Core DTO/フレーム、返却暗号文Base64またはJSの返却byte bufferは同時生存し得る。最大本文の実Node境界検査を行うが、全プロセスのピークmemoryや全コピー消去を実測したとはしない。

## Rust SDKの実API輸送

`EncryptedSessionClient` は次を追加する。expectedはCoreの公開 `AttachmentContext` であり、raw鍵を受け取らない。

- `get_attachment(revision, expected)`：添付GETに必須revisionを付け、Core公開DTOの厳密形式と全contextを照合する。
- `put_attachment(expectedStateRevision, AttachmentItemWrite, attachmentExpectedVersion, envelope, expectedNextContext)`：`{expectedStateRevision,item:{expectedVersion,envelope},expectedVersion,envelope}` を送る。item版は正、添付の新規版は0→1、各版は独立。
- `delete_attachment(expectedStateRevision, AttachmentItemWrite, expectedCurrentContext)`：添付envelopeの代わりに `keyEpoch` を送る。実APIどおりHTTP200で `{stateRevision,itemVersion,deleted:true,keyEpoch}` を受け取る。

PUT/DELETEの状態版は実SQLの契約どおり開始版+2、項目版は+1。PUTの添付版も+1。状態版に2を足せない要求と、item版・PUT添付版に1を足せない要求を拒否する。DELETEはsafe integerの最大添付版でも、その版自体を増やさないので送信できる。要求wrapper全体を既存HTTPの2MiB以内に計数する。

`SharingRotationClient` は100件ずつの `snapshot_attachments`、同revisionの `snapshot_attachment`、`stage_attachment` を追加する。stageは独立した次の添付context、旧expectedVersionとenvelopeだけを使い、実ルート `rotations/:operationId/items/:itemId/attachments/:attachmentId` へ送る。operation/各ID/版/世代の応答を照合する。

cursorは `<itemId>:<attachmentId>` 全体をopaqueなquery値としてURL encodeする。分割した値をpathへ入れたり、Unicode/path正規化を行ったりしない。両IDは26桁lower alphanumeric、ページは昇順・重複なし・100件上限・同revision/epochを確認する。nextCursorは100件の最終組だけ、それ未満では必須null。

snapshotの `liveAttachmentCount/liveAttachmentBytes`、status/commitの `attachmentCount` を明示optionalにする。nullや不正整数は拒否し、0件の旧応答はそのまま維持する。snapshotではcount/bytesが両方あるか両方ないことを確認する。statusのcountは仮置き済み件数で、まだ0件なら実APIも属性を省略する。省略を添付対応サーバー・全集合・容量検査の証明に使わない。添付ありの呼出元は独立した最終件数を `commit_rotation_with_attachments` / `rotation_status_with_attachments` に渡し、committed結果の完全一致を要求する。

既存のno-proxy、redirect拒否、再試行なし、session認証、固定エラー秘匿を再利用する。従来APIの応答read boundは変更せず、添付GETだけ公開envelopeを収める1,404,000 bytesにする。SDK parseはAEAD認証、現在の認可、仮置き容量、全生存集合・保存総量の証明ではない。Coreと正式API/PGの取引がそれぞれを担当する。

## 親の配布工程と検査

親はCore添付入力に加え `packages/cloud-wasm/src/attachment.rs` と変更済みworker/lib/Cargo.toml/Cargo.lock、js-sys依存を正式WASM入力へ反映し、全input・manifest・生成JS/WASMを照合する。この子は配布JS/WASMやmanifestを変更しない。検証用Node bindingsは所有登録した一時領域にだけ生成する。

2026-10-11、所有登録した専用target、共有Cargo gate、sccacheで以下を確認した。

- `cargo nextest run --locked -p passshare-connect --no-fail-fast`：50件成功、省略0。添付の実loopback HTTP7件を含む。実APIのSQLを参照した要求・返信の契約検査であり、Node→正式PGを通したSDK受入ではない。
- `cargo nextest run --locked --manifest-path packages/cloud-wasm/Cargo.toml --no-fail-fast`：42件成功、省略0。私有Sessionの拒否と公開bindingの直接成功、認証済み参照と同snapshot版の拒否を含む。
- 実WASMのNode境界：`attachments` 1件、`shared_api` 5件、`shared_key` 1件、`wasm` 4件の計11件成功、省略0。添付はactual `start_worker`、通常ArrayBuffer/Uint8Arrayのtransfer、00/ff/Unicode名、0/最大/超過、各wrong context、wrong key、改変、用途分離、未知/null/type、不正整数、replay/stale/lock、受信者scopeとowner-only拒否を含む。通常Rustのnative検査をWASM成功へ転用しない。
- `web_transport_acceptance`：一時生成した実WASMと実CloudWorker TypeScriptで、最大本文、transferによる入力detach、独立context/同revision、返却buffer消去、cancel/late、返却bufferを再transferした後のlock、循環した不正context入力の消去、既存4状態・identity-only期限・信頼UI入力・共有画面lifetimeの検査が成功。Nodeのsurface fixtureであり、実Chrome GUIの証拠ではない。
- 両packageのall-targets Clippy `-D warnings`、関連Rustファイルのrustfmt、CloudWorkerのstrict TypeScript型検査が成功。両packageのdoctestコマンドも成功したが対象は各0件。

GPT-5.5の独立読取レビューは、実SQLが仮置き0件のcountを省略する根拠を照合した再レビューでMust 0。当初の省略拒否提案は実APIの正常なpendingを拒否するため採用せず、その正例と確定時の件数欠落拒否を検査・文書へ追加した。全集合/総量の証明には使わない。

detached buffer/circular contextの処理、公開native bindingの成功検査、文書の未受入表記の追加差分レビューもMust 0。検査・レビューの全文と結果JSONは `D:/CC/Evidence/passshare-1163-attachments-20261011-428a7237/` に保全する。

途中でテストDTOの必須ボックス参照漏れ、添付以外の応答上限拡張、実APIの状態版+2との不一致、Node fixtureの変数名重複を修正した。失敗を成功件数へ加えない。Core/APIの既存処理・固定v1 vector・root lock・他クライアント・配布manifest/JS/WASMは変更していない。GUI、旧形式移行、正式HTTP→PGのSDK受入、Android、全workspace、CI、正式配布は親へ残す。
