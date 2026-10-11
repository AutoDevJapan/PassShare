# 暗号化した添付のWeb画面

元ToDo1163の添付画面の有限実装。質問1558591837231386664に対する回答
1558639394934751324（2026-10-11T00:36:29.872Z）のa案を使う。
承認は見た目に限り、公開・鍵配布・課金・名称の変更を含まない。

## 画面と保存

暗号化画面の項目フォームで、タグ欄の下に添付一覧を置く。名前・バイト数、
追加・取替・取消・取得・削除、端末での暗号化の説明を表示する。
1ファイル1MiB（1,048,576バイト）まで。空ファイルと任意の種類を扱い、
同名ファイルも別添付として追加できる。全10言語に文言を用意する。
削除と取替は保存まで保留し、取消で元の名前・容量を戻せる。

ReactはFile入力、表示、workerとHTTPの輸送だけを担当する。実バイトは
`CloudWorker.encryptAttachment`のtransferでRustへ渡す。ファイル名も暗号化する。
サーバーには公開ID・版・状態版・暗号文だけを送り、名前や実本文を送らない。

`editAttachmentItem`は元の全文JSON、独立した次のItemContext、
`{form,action:"add"}`または`{form,action:"replace"|"remove",attachmentId}`を受け取る。
Rustが既存フォーム編集処理を使い、参照の順序、未知属性、URL属性、未編集の版を保持する。
追加IDはRustで生成する。取替は対象添付版だけ+1、削除は対象参照だけ除去する。
他の参照、項目の追加属性を投影し直さない。参照の必須属性、重複、現世代、上限はRustで検査する。
復号時も参照の追加属性を許容し、必須ID・版・世代を認証済み項目と照合する。

新規項目は既存の項目PUT（expectedVersion=0）で先に作成する。
確認した項目IDを保持し、各添付を既存の原子PUT/DELETEで親項目と同時保存する。
項目の作成だけをフォームの成功に数えず、全添付の保存とworker復号確認後に閉じる。
このAPIには項目と複数添付をまとめて作成する取引がない。途中で失敗した場合は
成功確認済みの項目・添付を保持し、未保存のファイルとフォームをその場に残す。
失敗した削除で原添付を削除済みとして表示しない。

原子保存の状態版は+2、項目版は+1、PUTの添付版は+1。返信の全公開フィールドを照合する。
書込みは自動再送しない。応答喪失ではフォームを凍結し、同じID・版・nonce・本文の
明示的な再送だけを認める。新しいcreateを生成しない。409では原下書きを保持して
再送を無効にし、取消後の再読込を要求する。

取得は状態版を保持して項目snapshotと添付を取得する。独立した項目版・参照版・世代と
同じsnapshot版をRustへ渡し、添付envelope自身から期待contextを作らない。
返却bytesは取得後にreleaseし、Blob URLは解放する。取消・unmount・background・idle・
logout・user/box/epoch切替ではFile参照とfile入力を解除し、mutable bufferを消去する。
取消が処理中ならworkerを終了してロックする。遅着結果から下書きを復元しない。
JS文字列、File/Blob自体、強制終了時の全メモリーの消去は保証しない。

## 共有受信者の状態と項目取得

親の統合では`GET /api/encrypted/boxes/:boxId/attachment-state`から
`{stateRevision,keyEpoch}`だけを取得する。独立して保持した世代と一致を確認し、
その状態版を`GET /api/encrypted/boxes/:boxId/items/:itemId/attachment-snapshot?revision=...`
と添付GETへ渡す。項目snapshotもRustの同じ添付認可処理を使い、ボックスのロックを
保持した状態で現在の確認済み所属・共有鍵・sessionと状態版を確認する。
状態版が変わった場合は409で拒否し、画面の下書きを保持する。

所有者専用の`sharing-snapshot`とメンバー一覧・鍵管理情報は変更しない。
API応答の世代は既存の鍵や期待contextを書き換える根拠にしない。
添付権限の403では既存項目の編集入力を保持して添付操作を無効にする。
共有受信者の正式API・画面の成功は最終検査で確認するまで未達である。

## 検査と配布

`pnpm --dir frontend install --frozen-lockfile`と
`pnpm --dir apps/mobile install --frozen-lockfile --ignore-scripts`で既存の検査依存を用意する。
`node --test frontend/tests/attachments-ui.test.mjs`はReact hostと実HTTP輸送関数を検査する。
実React rendererの寿命検査と、決定的なsurface fixtureの操作検査を区別する。
workerとサーバーのfixture成功を実暗号・正式PG・Chromeの証拠に数えない。
Rust workerの関連検査は全文JSON、参照順、未知属性、item17/file17、誤ID・版・
重複・上限の正負を検査する。

WASM入力（item_edit.rs/worker.rs/attachment.rs）が変わるので、親は正式の生成CIを実行し、
manifest指紋と生成JS/WASMをその最終ソースへ一致させる。子はmanifestと配布assetsを変更しない。
Viteのtested-cloud-assets検査が旧生成物を拒否することは期待される停止であり、build成功に数えない。
旧root269件、旧WASM受入を今回のRust入力の成功として再利用しない。
実ChromeのFileChooser・ダウンロード・320pxのja/en/ru、正式PGを通したフォーム受入、
最終CI・公開と元22条件全体は親の統合工程に残す。

2026-10-11の子の最終Rust入力で、WASMパッケージ限定nextestは43件成功・省略0。
関連添付だけの確認は4件成功・39件をフィルターで省略した。全workspaceは実行していない。
all-targets Clippyとrustfmtは成功、doctestコマンドは成功したが対象0件。
Webのhost/輸送検査は24件成功・省略0（うち実Reactの寿命検査5件）。
全文TypeScript型検査と10言語481キーの検査も成功した。
最初のRust検査は参照の追加属性を拒否する旧期待で1件失敗し、保持契約へ修正して再確認した。
Vite buildは配布WASMとの指紋不一致で停止し、成功に数えていない。
