# 添付暗号文の保存と鍵更新

WASM worker / Rust SDKへの有限接続は [encrypted-attachments-client.md](encrypted-attachments-client.md) を参照する。GUI・全クライアント・旧形式移行と親の最終受入は引き続き未完である。

元ToDo1163のM4-C/M8-Bに必要なAPI・PG接続の有限実装。Coreの契約は `encrypted-attachments-core.md`。旧形式の移行、全クライアント、GUI、Railway、製品の22条件全体は未完了。

## 保存契約

`/api/encrypted/boxes/:boxId/items/:itemId/attachments/:attachmentId` のPUTは次の公開JSONだけを受け取る。

```json
{"expectedStateRevision":1,"item":{"expectedVersion":1,"envelope":"<次のEncryptedItemオブジェクト>"},"expectedVersion":0,"envelope":"<EncryptedAttachmentオブジェクト>"}
```

DELETEでは添付の `envelope` を `keyEpoch` に置き換える。GETには `?revision=<stateRevision>` が必要。項目と添付の版は独立し、新規添付は0→1、更新はn→n+1。親項目は必ず生存し、その次の暗号文も同じ取引で保存する。通常の項目PUTは添付行を変更しない。参照配列の意味・順序と添付の認証はクライアントのCoreが照合し、サーバーは暗号文を読まない。

### 共有受信者による現在の状態版の取得

`GET /api/encrypted/boxes/:boxId/attachment-state` は本文・queryなしで、次の2属性だけを返す。

```json
{"stateRevision":1,"keyEpoch":1}
```

通常のボックスstateはmodeと世代だけを返す。`grants/me` も `grantVersion`・`keyEpoch`・`envelope` だけで状態版を返さず、`sharing-snapshot` とその一覧は所有者専用である。そのため、添付操作に必要な状態版を現在の閲覧権限で取得する経路を追加する。所有者用snapshotの認可・応答は変更しない。

この経路も `passshare_attachment_operation` を使い、実添付GETと同じ順序でボックス・利用者・session・確認済み所属・暗号化状態をロックする。所有者、または現在世代の自身への鍵配布がある確認済み受信者だけが取得できる。readonlyの受信者は状態版と添付を読めるが、添付PUT/DELETEの既存書込み制限は変わらない。ロック取得後にもsessionの現在の期限・失効を再確認する。行・xmin・状態版を更新しない。

成功応答はJavaScript安全整数の状態版と世代だけで、所有者鍵包み・秘密鍵・所属一覧・配布一覧・項目本文は含まない。未認証・期限切れ・失効session・Connectトークンは401、未確認・鍵未配布・旧世代配布・除名・他ボックスの所属は403、不在ボックスと機能無効時の経路は404。暗号化未開始の自分のボックスは既添付経路と同じ409。退会後の資格は復元でも復活させない。

GET以外の変更メソッドは経路なしの404、ExpressがGETへ送るHEADは400とする。OPTIONSは既存CORSの204を維持する。本文・query・無効IDは400。静的パスの大文字小文字と末尾スラッシュは既存Express経路の扱いを維持し、ボックスIDは既存Rustの小文字英数字26文字を要求する。Cookie・Bearerの認証、no-store、既存CORSとレート制限を使う。

機能無効では既存Expressの404（非JSONの場合もある）の扱いを維持する。UI担当は `frontend/src/lib/sharing-api.ts` の既存requestと同じく、JSONを読む前にHTTP状態を確認する。添付用の要求だけをこのGETへ接続し、所有者の共有管理で使う `getSnapshot` はそのまま使う。成功本文は2属性の完全一致と正の安全整数を確認する。

UI担当は所有者・共有受信者ともこのGETから得た `stateRevision` を、添付GETの `revision` とPUT/DELETEの `expectedStateRevision` に使える。親項目の版・添付版・次の暗号文は既存のCAS契約で別途指定する。公開の世代は競合検出用に限り、Coreの信頼contextや鍵pinへ昇格させない。鍵・contextは確認済み自身grantとクライアントが保持する独立した情報から得る。409を受けても本文や権限を自動で変更・再送しない。frontend/WASMへの接続は別担当が行う。

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

## 2026-10-11 状態版取得APIの追加検査（元1163）

作業元は `1c41ab17bc4aa51e502b5805acf0a0bd111214bc`、専用branchは `feat/todo1163-attachment-state`。API本体はnative単体82件・backend単体125件が成功し、両方とも省略0。nativeのall-targets Clippy `-D warnings` と正式バイナリのビルドも成功した。frontend/WASM・Core・SDK・root Cargo/lock・署名には変更していない。

検査対象のAPI本体のGit blobは、`backend/native/src/encrypted_attachment.rs` が `593b01c9c013826778129ee04df10d6e7a1536f1`、SQLが `61843e7ce1ede621286e7566fc80a8a1f0ea31a5`、Node routerが `ed046d4ccad8df1175366e107902eddcc45acc43`。受入ツールの直前版 `dba713353c316aa838accf3fb5c4afb736b08cc2` では単体15件とall-targets Clippyが成功した。通常のnextestは5件を省略し、内訳は制御用の子検査1件・Docker専用2件・明示実行の実PG2件。実PG2件はさらに前のツール版 `0169bd1bf5723fff99031721fbcdc10584f5facb` に対して別々に実行し、各1件成功・19件をフィルターで除外した。大SQLの単一要求・ロールバックと専用DB100回読取りを確認した。変更していないSQL輸送検査の成功を、新API全件成功へ転用しない。

正式Node→専用PG→Core受入は途中まで成功し、全体成功ではない。所有者と確認済み・現在配布済み受信者の厳密2属性、未確認（現在grantがあっても不可）・未配布・他ボックス・無効ID・無認証・Connect/旧トークンの拒否、body/query/method/alias、cookie-CSRF/CORS/no-store、実ロック待機中のsession失効・期限切れを確認した。受信者が返された状態版で実添付GET/PUT/DELETEを行い、独立したcontextと自身grantから得た鍵で名前・全bytes・参照順・JSON全体を照合する検査も通過した。既存CAS・厳密公開形式・正確な再送・SQL故障時のロールバック・101件一覧と全公開テーブルの別DB復元も通過した。全体の成功判定数は出ていないため件数を推定しない。

最初の実受入は `APP_ENV=test` のCORS許可originをlocalhostと誤認した検査で失敗し、既存の本番Web originへ期待値だけを修正した。次は機能無効のHTML 404をJSONとして読もうとする検査で失敗し、既存検査と同じHTTP状態＋行不変の判定へ直した。3回目は後半の制御用psqlの状態版SELECTが終了2で失敗した（stderr86 bytes、SQLSTATE抽出なし）。psql失敗の発生源は未特定で、修復済みとは主張しない。要求の再送、期限・権限の緩和は加えていない。退会後・機能無効の最終確認、除名後の追加した行不変判定を含む全件成功は未達である。

現在の受入ツールblob `c47161d36c3f25d0ce91fc127dfa60bdfafa8cea` は、実ファイルGETも新APIの公開状態版を使うようにした。復号contextの世代は独立保持の値を使い、APIの世代とは一致だけを確認する。この最後の変更後のビルド・nextest・Clippy・全件受入は未実行。共有ゲート待機中に空きメモリ14217MiB（13.88GiB）、CPU79.35%を実測し、指定の16GiBを下回ったため待機中の自分の検査を停止した。親CIでこの版を確認する。親の既成功root workspace269件・doctestは繰り返していない。

既存ChatGPT OAuth経由の固定GPT-5.5で本体と各追加差分を独立レビューし、Mustは0件だった。レビュー指摘に従い、行不変の説明はパスワードボックス関連行へ限定する。`state_hash` は利用者とsessionを除き、所属・招待・トークン・鍵・項目・添付・削除記録・仮置きを全属性とxmin込みで比較する。利用者/sessionは失効を注入するため別に扱う。機能無効の404の本文形式自体は固定せず、UIと検査はHTTP状態を先に判定する。

Dockerの `version` は30秒で応答せず、自分の診断クライアントだけを終了した。配布イメージ受入とCIは未実行である。親で正式イメージを用意し、既存ツールの `--encrypted-attachments --image <owned-image>` でも同じ追加検査を実行する。原1259/2300判定の成功を今回のAPIの成功には数えない。元22条件全体は未完、達成率は未確定である。

検査は親PG68512/50196の実プロセス・所有nonceを照合し、毎回用途印付きの自分専用DBだけを作った。最初の2回と復元先は正式ツールで回収した。3回目の残存DBも、所有・用途印の再照合と接続0件を確認して通常DROPで回収した。親DB・サーバーを停止していない。C1/peerの画面用fixtureは使わず、正式ツールの合成利用者だけを使用した。新ToDo・push・PR・merge・GH設定・Discord送信・本人への質問は行っていない。
