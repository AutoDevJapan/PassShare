# Rust SDK: 共有鍵の配布と一括鍵更新

## 正式Webの接続範囲（ToDo1163、2026-10-11）

Webの `CloudSharingPanel` / `sharing-api.ts` は、承認済みの配置で本人コードの表示・コピー、
相手から別の連絡手段で受け取る64hexコードのRust照合、初回grant保存とself grant復元を接続する。
コード確認前は共有ボタンを無効にする。以前渡した内容を回収できないことを表示する。
ja/en/ruを含む10localeの文言を用意し、320px向けの折返しを指定する。実Chromeの計測は親の受入。

所有者は開いたボックスと同じWorkerへ自身のidentityを専用パスワードで開く。
正式snapshotの全memberページを同revisionで取得し、期待owner/epoch・ページ順・件数を検査する。
独立確認したrecipient descriptorと現所属からRustが共有文脈を選び、既存CoreのAuth HPKEで包む。
正式PUTは `{expectedStateRevision,keyEpoch,expectedVersion:0,envelope}`。
返信のgrantVersion=1、epoch、revision>=開始revision、暗号文全JSONの一致を確認する。
同じaccount/box/recipient/epochのWeb Lock内で暗号文だけのpendingを保存し、
応答喪失後も同じエンベロープを使い、成功確認後にre-read一致を確認して除く。

受信者は自分のidentityを開き、独立確認したsenderとrecipientの指紋・版、正式member一覧の現所属、
正式box stateのepochをRustへ渡す。self envelopeから期待値を作らない。
正式 `/grants/me` の全contextを期待値と照合し、`sharedReceiveUnlock` 後は既存の
`EncryptedItemsPage` でfull JSONを読み、編集時も原文全体をRustへ渡す。
受信者のowner wrap/recoveryMaterialは引き続き拒否する。
確認済みmemberと公開鍵確認は別条件で、PUT/self GETの現所属認可はサーバーにも必要。

**M4-BのWeb除名は未接続。** encrypted boxは旧simple removeを呼ばず、成功表示もしない。
UIは「添付を含む鍵更新の接続が未完了」と表示し、除名を無効にする。
互換保存でのみ、正式stateまたは機能off時のauthoritative Connect metadataで互換を確認して旧経路を維持する。
全項目snapshot、添付、new owner bundle、remaining grants、commitを原子的に扱う契約の完成後に親が接続する。
添付を落としてrotation成功にはしない。原ToDoの22条件、M4/M5全体をdoneにしない。

検証用 `packages/cloud-wasm/examples/web_transport_acceptance.rs` はRustがNodeを起動して、
生成した実WASM、実TypeScript transport、実React部品・認証providerを呼ぶ。
Nodeのmessage/clock/event/HTTPとmember状態は合成。React 19.2.7と同版のreact-test-rendererは
所有記録付きの一時フォルダだけに置き、リポジトリの依存やlockを変更しない。
3公開WASM suites、native39件、strict code・旧owner経路・full JSON・取消/遅着・アカウント切替・
pin欠落・peer変更・5分identity-only・trusted input・時計停止/逆行・資格情報変更を対象とする。
実行するexampleの引数は、Node用生成bindings、frontendのtypescript、repo root、react-test-rendererの4絶対パス。
正式API/PG/Chrome、配布assets/manifest、最終workspace/CIは親scope。

このWeb子での実行結果: frozen install、SDK build、frontend型検査、10locale/438キーの検査、
cloud-wasm native39件、WASMのwasm4件/shared_api5件/shared_key1件、release wasm32 build、
native all-targets Clippy、doc（0例）、実release WASM＋TypeScript/Reactの受入exampleが成功した。
Reactの取消・遅着・unmount・account切替・pin欠落・別パスワードでの復元・peerコード不一致/変更、
認証providerで同じ資格情報の保持と資格情報変更時の施錠を確認した。
共有画面の実部品でも、encrypted boxでの旧除名呼出し拒否、互換保存での従来除名、
資格情報変更後に遅れて返った招待確認コードの破棄を確認した（HTTPは合成）。
frontend buildは `packages/cloud-wasm/src/worker.rs` の指紋不一致で失敗した。
これは未更新の正式配布assets/manifestを成功と扱わない結果で、親の正式CI取得後まで未完了である。
CI、workspace全件、正式Node/API/PG、Chrome/320px計測、rotation/添付の原子的受入は実行していない。

この文書は originalToDo1163 の Rust SDK 通信部分を記録する。実装は
`crates/passshare-connect/src/sharing_client.rs`。共有開始から失効までの正式な受入、
M4、全クライアントの完成を示すものではない。

## 契約の参照先と変更範囲

契約は `backend/native/src/encrypted-schema.sql` の共有処理と
`backend/src/encrypted/sharing-rotation-router.js` の実際の HTTP ルートに合わせた。
当初指定された `backend/native/src/sharing-rotation-router.js` は存在せず、
ルーターの実体は上記 Node 側にある。設計記録
`D:/CC/Work/passshare-finish-1163-20261010/shared-rotation-design-result.md` も参照した。
本実装はこれらの契約ファイルを変更しない。

既存 `EncryptedSessionClient` では `endpoint`、`send`、`send_expected`、`decode`、
`b64_len` の可視性だけを `pub(crate)` にした。関数本体・identity API・既存テストは変更しない。
Core、依存関係、manifest、並行担当の backend・tools・CI・共有API文書は変更対象外。
`lib.rs` に新しい公開型と Core の共有鍵 DTO、項目文脈、固定 suite を公開する。

## 通信と公開 API

`SharingRotationClient::new(&session)` は既存 `EncryptedSessionClient` を clone して保持する。
所有権を渡す `From<EncryptedSessionClient>` も利用できる。
新しい HTTP client を構築せず、URL 検査、機密属性付きセッション Bearer、
環境変数の proxy を使わない設定、redirect 拒否、cookie を保持しない設定、
接続・要求の期限、応答サイズ制限、エラー本文の非公開化をそのまま利用する。
SDK に自動再送はない。abort は既存の `send_expected(..., 204)` を使用し、
空本文・Content-Length・Transfer-Encoding の検査と `Connection: close` を引き継ぐ。

以下の相対パスはすべて `/api/encrypted/boxes/:boxId` 配下。

| SDK メソッド | HTTP | 要求または期待値 | 応答型 |
|---|---|---|---|
| `put_initial_grant` | PUT `grants/:recipientId` | `InitialGrantRequest` と独立した `SharedKeyExpectation` | `InitialGrantReply` |
| `get_self_grant` | GET `grants/me` | 必須の `SharedKeyExpectation` | `SelfGrantReply` |
| `sharing_snapshot` | GET `sharing-snapshot` | 呼び出し元が保持する所有者ID | `SharingSnapshot` |
| `snapshot_members` | GET `sharing-snapshot/members` | snapshot の `revision`、任意の `after` | `SharingMembersPage` |
| `snapshot_items` | GET `sharing-snapshot/items` | 同じ `revision`、任意の `after` | `SharingItemsPage` |
| `snapshot_item` | GET `sharing-snapshot/items/:itemId` | 同じ `revision` と期待する `SharingItemSummary` | Core `EncryptedItem` のみ |
| `start_rotation` | PUT `rotations/:operationId` | `RotationExpectation` と `OwnerKeyBundle` | `RotationStartReply` |
| `stage_item` | PUT `rotations/:operationId/items/:itemId` | `RotationItemRequest` | `RotationItemReply` |
| `stage_grant` | PUT `rotations/:operationId/grants/:recipientId` | `RotationGrantRequest` と `SharedKeyExpectation` | `RotationGrantReply` |
| `commit_rotation` | POST `rotations/:operationId/commit` | 保存した `RotationExpectation` と現在のログインパスワード | `RotationCommitReply` |
| `rotation_status` | GET `rotations/:operationId` | 保存した `RotationExpectation` | `RotationStatusReply` |
| `abort_rotation` | DELETE `rotations/:operationId` | 保存した `RotationExpectation`、本文なし | `()` |

開始の JSON は `expectedStateRevision`、`expectedKeyEpoch`、`expectedOwnerBundleVersion`、
`removeAccountId`、`bundle` の5フィールド。
項目の仮置きは `expectedVersion` と `envelope`、共有鍵の仮置きは `envelope` のみ。
確定の JSON は厳密に `{"currentPassword": ...}`。公開 `RotationCommitRequest` も同じ型を表す。
その Debug 表示はパスワードを伏せる。ほかの API にログインパスワードを渡す引数はない。
秘密鍵・暗号化パスワードを受け取る API はない。

## 検査と信頼の境界

整数は JS の安全な範囲内で検査する。世代・版・変更番号は1以上、件数・仮置きバイト数は0以上。
初回配布の `expectedVersion` は0のみ。鍵更新の新世代、所有者バンドル版、仮置き項目版は
それぞれ旧値の＋1であり、上限での加算を送信前に拒否する。
処理ID・解除先・配布先・応答の UUID は小文字ハイフン付き36文字かつ非nilを要求し、
Connect ID は Core の検査に従う。公開 DTO は未知フィールド、型違い、必須値の欠落・null を拒否する。
`nextCursor` と status の `result` は必須であり、明示的 null のみを許可する。
公開 DTO のデコードだけでは期待値との一致を証明しない。SDK メソッドが応答を検査して返す。

共有鍵は Core の `WrappedSharedPasswordBoxKey` と `SharedKeyContext` をそのまま使用する。
format=1、固定 HPKE Auth suite、canonical padded standard Base64 の enc=32バイト、
ciphertext=48バイトを検査する。enc の最上位ビットが0であり、little-endian 座標が
2^255−19未満であることも確認する。低位数点の DH 拒否、AEAD と送信者の認証は Core の責任。
SDK は暗号処理や指紋の hash 計算を実装しない。

`SharedKeyExpectation` は呼び出し元が独立して保持する文脈と公開記述子2つを含む。
両記述子は Core `validate_public` で確認し、box・送信者・受信者・世代・identity版・
64文字小文字hexの指紋を文脈と一致させる。自分の共有鍵GETでもこの期待値が必須。
応答を期待文脈の供給元にしてはいけない。
復号は Core `unwrap_for_recipient` に独立して照合済みの公開鍵と期待文脈を渡して実施する。
サーバーから取得した記述子の自己整合や招待確認は、公開鍵を信用する根拠にはならない。

初回PUTは配布版1・対象世代・返されたenvelope全体の完全一致を検査する。
同一内容の再送で現在の変更番号が進んでいる可能性があるため、応答の変更番号は開始時以上を許す。
一括確定は開始時の変更番号より厳密に大きいことを要求する。
行更新やトリガーの数で増分が変わるため、＋1ちょうどとは仮定しない。

## スナップショットと再送

header は `stateRevision`、`keyEpoch`、`ownerAccountId`、`ownerBundleVersion`、
`memberCount`、`liveItemCount`、`grantCount` のみ。
`ownerCount` フィールドを追加したり仮定したりしない。
単一所有者と現在世代の所有者用バンドルはサーバー契約が要求し、SDK は所有者IDと正のバンドル版を確認する。
メンバー役割は契約の `owner`、`member`、`readonly`。

全ページと各項目取得に同じ revision を送る。応答ページの revision は完全一致を要求する。
各ページは100件以下で、IDを厳密昇順とし、すべて `after` より後にする。
100件なら末尾IDと同じ nextCursor、それ未満なら null が必要。
最初のページの件数は header の件数と100の小さい方に一致させる。
項目の版・世代・box・itemIDと暗号文のサイズを照合する。

複数ページは返されたカーソルを次の `after` に渡して最後まで取得する。
取得後に `SharingSnapshot::validate_complete_members` と `validate_complete_items` を呼ぶ。
この検査は全件の件数、並び、重複、所有者がひとりであること、配布済み件数と世代を照合する。
単一ページのメンバー応答にはSDKが同じ全件検査を実施する。
件数と形式の一致は、悪意あるサーバーが同数の暗号文を差し替えないことの暗号学的証明ではない。
最終確定時の正確な集合の検査はサーバー契約、復号後の内容確認は呼び出し元の責任。

`RotationExpectation` の処理ID・基準変更番号・基準世代・基準バンドル版・解除先は
開始前に決めて保存し、応答を失っても同じ値を使う。既知の最終件数は `Some`、不明なら `None`。
開始は pending または committed＋result の二形態だけを許す。
確定・開始時の確定済み再送・status内の確定結果は、処理ID、新世代、バンドル版、解除先と
既知の最終件数を照合する。status は pending/expired なら result=null、committed なら
同じ処理の確定結果と件数、stagedBytes=0を要求する。expiresAt は実際の PostgreSQL JSON 形式の
日付・時刻・任意の小数秒・明示オフセットを検査する。

確定結果はその処理の履歴であり、後続の更新後にも正しく返り得る。
過去の結果を現在の snapshot と比較して拒否しない。現在状態を知るには別途 snapshot を取得する。
SDK は変更番号や世代を自動で上書きする状態キャッシュを持たない。
409はそのまま返し、SDKが再暗号化や再送を自動実施することはない。

## テストコードの状態と残る受入

TCP fixture のユニットテストコードを追加した。全ルートの path/header/query/JSON、
実CoreのHPKE共有鍵の復号、入力拒否前後の正常通信、指紋・文脈・宛先の不一致、
座標・Base64・サイズ・整数・未知フィールド・null・欠落、ページ順序とカーソル、
履歴再送、仮置き応答、statusの整合、401/403/409とbounded errorの非公開化、
redirect先へのBearer非送信、abortの204 framingを対象にしている。
fixture のスレッドとTCP read/writeには期限があり、Dropでも停止・joinする。
固定sleepの経過だけを根拠にした assertion はない。暗号鍵と資格情報の材料は実行時に生成する。

**この担当ではテスト・ビルド・Clippy・Docker・commit・pushを実行していない。**
Rustfmtによるソース整形のみ実施した。テストはコード追加のみであり、成功実績ではない。
親担当が既存の検査手順に組み込み、コンパイル、関連テスト、正式なAPI/DBとの相互接続、
共有開始から一括更新・失効までのE2E、CI、別モデルのレビューを実施する必要がある。
正式な受入では失われたHTTP応答の再送、競合、仮置きの不足と余分な集合、
残存受信者への配布、全DTO保持、旧鍵と新鍵の復号結果も確認する。
