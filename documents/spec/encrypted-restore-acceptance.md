# 暗号化した架空データのDB復元受入

共有ToDo1163のM4/M8に必要な証拠の一部を、既存のRust受入ツールで確認する。
この部品は元の22条件、M4、M8、本番サービスの復旧、全クライアントの完了を意味しない。
旧 `tools/restore-drill-rs` の平文演習を暗号化復元の証拠として扱わない。

## 明示した実行方式

```text
passshare-encrypted-storage-acceptance --encrypted-restore <production-native-binary>
passshare-encrypted-storage-acceptance --encrypted-restore --image <prebuilt-production-image>
passshare-encrypted-storage-acceptance --local-postgres <absolute-owned-fixture-manifest> --encrypted-restore <production-native-binary>
```

Nodeではリポジトリの実Express APIと指定したproduction nativeバイナリを使う。
配布イメージ方式は既存と同じ事前取得済みPostgreSQLとAPIイメージを使う。
`--image` を省略した代替方式に置き換えない。
他の受入方式との混在、不明なオプション、任意の `DATABASE_URL` は受け付けない。

PCでの方式ではmanifestの `fixtureOnly`、`ownershipId`、サーバーPID、実行ファイル、
PostgreSQL 16とサーバー内の `owner_id` を既存の手順で照合する。
サーバーは停止しない。元DB、古いバックアップの復元先、最新バックアップの復元先は
この実行が毎回生成した別DBを使い、親の画面用DBを使わない。

## データと合格条件

1. 架空の3アカウントが実APIで登録し、Coreで作ったアカウント識別鍵を暗号化保存する。
   所有者から2人へ正式に招待し、確認後にCoreで包んだ共有鍵を配布する。
2. 暗号化した101項目を実APIで保存する。追加・未知フィールド、配列の順序、複数URL、
   添付メタデータ、入れ子の値を含むDTO全体を保持する。1項目を正式に削除して削除記録を残す。
3. 失効前に `pg_dump --format=custom` を実行する。その後、既存の共有鍵更新受入の
   実API手順で世代を2へ進め、1人を除名する。更新後に最新のdumpを取得する。
4. 全publicテーブルをdumpし、`pg_restore` で生成したSQLを別DBへ
   `psql --single-transaction --file=-` と `ON_ERROR_STOP=1` で実行する。
   全テーブル名、全行・全列のJSONB内容、重複件数を順序に依存せずハッシュで照合する。
   オブジェクトのキー順序だけを正規化し、配列の順序は変えない。
   `xmin` は復元で変わるためDB間比較から除き、元DBの保持検査では含める。
5. 復元先の所有ID、接続中のDB名、接続用途が一致し、元DBと接続先が異なることを検査する。
   所有・用途記録はdump対象外の専用スキーマに置く。復元後のpublicの所有IDも照合する。
   書き込み前に用途と空DBを検査し、その復元先だけで `--clean --if-exists` を使う。
   PostgreSQLが初期作成するpublicスキーマも正しく扱う。
   nativeの制約検査関数にはpublic内の別関数を修飾無しで呼ぶものがある。
   `pg_restore` の空の検索先では暗号文のCOPYで失敗するため、生成SQLの最初の検索先設定だけを
   `pg_catalog, public` へ置き換える。DBオブジェクトやCOPY本文の開始前であることを検査し、
   関数定義・行内容・元DBの設定を変更しない。未知のヘッダーは拒否する。
6. 古い復元先には実際に除名メンバーの所属が戻る。しかし現在の元DBから読んだ
   アカウント・認証・招待・世代・所属・共有鍵・識別鍵・更新履歴・削除記録が一致しないため、APIを起動しない。
   最新の復元先でも所有IDや用途が異なる場合は起動を拒否する。
7. 一致した最新の復元先だけで実APIを起動する。復元したアカウント識別鍵と所有者鍵を
   パスワードから再度Coreで開き、残存メンバーの復元した識別鍵で共有鍵を開く。
   全101項目を取得し、所有者と残存メンバーが復号したDTO全体を事前期待値と比較する。
8. 除名メンバーの保持していた認証で取得・書き込み・共有鍵取得を拒否する。
   保持していた古い鍵は新世代の全項目を復号できない。
   削除項目の取得と新世代の鍵による再作成も拒否する。
9. dump前後と復元・検証後に、元DBの全publicテーブルの全行と `xmin` を照合する。
   演習中に元DBは変えない。検証終了時は、この実行が作ったDBとAPIだけをDropで片付ける。
   元DBの保持は演習中の条件であり、この実行が作った元fixture DBも終了時には削除する。

## 制限と出力

archiveは上限64MiBのメモリ内に保持し、dump/restoreプロセスの起動・入力・出力回収には
60秒の共通期限を設ける。DB作成も60秒で打ち切り、作成先を起動前から所有登録する。
通常のSQL期限と所有資源のDropを維持する。
通常のfixture SQLもDockerでは `exec -i`、psqlでは `-f -` を使い、全文を標準入力へ送る。
SQLをBase64で運び、1行1列の `SELECT convert_from(decode(...))` の結果を `\gexec` で
そのまま1回のサーバー要求として実行する。SQL全文をプロセス引数やログへ出さない。
単に `-f -` で文を分割したり、全呼び出しを `--single-transaction` で包んだりしない。
元の単一 `-c` と同じ暗黙トランザクションと複数結果の出力を保つ。
この実行単位は [PostgreSQL 16のpsql仕様](https://www.postgresql.org/docs/16/app-psql.html) の
`-c` と `\gexec` の規則に従う。
呼び出し元を確認すると、通常の読取・更新・複数文DDLのほか、識別鍵と共有鍵の制約検査に
明示的なBEGIN/COMMITがあり、暗号化操作の拒否検査にはBEGIN/ROLLBACKがある。
関数定義の中のBEGIN、引用・改行・コメントも分割しない。
トランザクション外で実行するDB作成・削除は、別の所有fixture制御のままにする。
入力の書込と両出力の回収を同時に進め、呼び出し元が渡した絶対期限を更新しない。
終了していないI/Oスレッドをjoinしない。失敗時は子プロセスをkillして最大2秒でreapし、
回収できなければ既存の後片付け失敗フラグを立てる。新規依存は追加しない。
プロセスの異常終了、期限超過、内容不一致、後片付け失敗を成功に読み替えない。
秘密値、暗号文、パスワード、認証文字列、DTO本文、PostgreSQLエラー本文を報告しない。
失敗は静的な分類、成功は件数とfixture測定だけを出力する。

`fixture_only_rto_ms` は最新の復元先作成開始から全検証終了までの時間である。
`fixture_backup_age_ms` は最新dump開始から検証終了までの経過時間で、業務のRPOではない。
`fixture_rpo_lost_committed_rows=0` は、最新dump後に元fixtureへ書き込まず、全行一致と
元DB保持を確認した場合だけ出す。本番障害、接続切替、実業務再開のRTO/RPOではない。

現在の資格照合元は、この演習中にAPIを停止して保持した元fixture DBである。
元DB自体を失う本番障害に備えた独立保全や、外部の全クライアントを閉じて再開する仕組みは
本演習の対象外である。古い鍵・暗号文・平文を取得済みの人から、それらを回収できるとは言わない。
添付はメタデータの照合であり、実ファイルの暗号化・復号の証拠ではない。

## 検証記録

SQLの標準入力経路には、Docker不要の子プロセス対照検査がある。
256KiBを超える入力を書いている間に両出力を回収する成功対照、入力を読まない子の期限超過、
早期終了による書込失敗、8MiBの出力上限超過、起動前に期限切れになった要求を検査する。
所有PostgreSQLの実検査は、通常の `LocalPostgres::start` でこの実行専用DBを作り、
所有ID・用途・DB名を照合する。引用・改行・日本語を含む300KiB以上のSQLで全値を照合し、
暗黙トランザクション、複数結果、エラー時のDML/DDL巻き戻し、明示的COMMIT/ROLLBACK、
トランザクション外のVACUUM、Dropでの専用DB削除を検査する。
この実検査は明示的な所有manifestを必要とし、通常のunit testでは実行しない。

```powershell
$env:PASSSHARE_SQL_FIXTURE_MANIFEST='<absolute-owned-fixture-manifest>'
cargo test --locked --manifest-path tools/encrypted-storage-acceptance/Cargo.toml -p passshare-encrypted-storage-acceptance contract_tests::sql_transport_live_large_sql_preserves_single_request_semantics -- --ignored --exact --nocapture
```

2026-10-10、SQL経路の最終ソースで書式検査、nextest 12件、Clippy全対象
（警告をエラー扱い）が成功した。nextestで省略した2件は子プロセス専用対照と
明示manifestが必要な実DB検査である。後者は指定の所有PostgreSQL 16.15で別に実行し、
1件成功と専用DBの後片付けを確認した。既存101項目の条件と拒否検査は変更していない。
この修正のDocker配布イメージ方式は担当のPCでは実行しておらず、CI成功は未確認である。
途中の試行ではWindowsの改行比較を修正したほか、DB操作が静的分類 `other` で2回失敗した。
その2回の原因は取得済みの静的ログからは特定できていない。削除が失敗した専用DB1件は、
用途・所有ID・DB名を照合してそのDBだけを削除した。失敗ログも保持している。

2026-10-10、基点 `a6aa864` の既存Core/API/SDKを使い、指定の所有サーバーで
`--local-postgres ... --encrypted-restore ...` を実行した。終了コード0と
`encrypted storage mode=node acceptance and owned fixture cleanup passed` を確認した。

| 検査 | 実測結果 |
|---|---|
| 暗号化内容 | 101項目、残存共有鍵1件、アカウント識別鍵3件、削除記録1件 |
| DB復元 | 失効前・失効後の実custom dumpをそれぞれ別DBへ復元し、全public表の内容と件数が一致 |
| 元DB保持 | dump前後、全復元・API検証後の全public行と `xmin` が一致 |
| 再開判定 | 旧バックアップの除名メンバー復活を確認した上でAPI起動を拒否。所有ID・用途・世代の不一致も拒否 |
| Core / 実API | 復元した識別鍵・所有者鍵・共有鍵を開き、全101項目を所有者と残存メンバーが全文復号して一致 |
| 失効・削除 | 保持した古い認証の読取・書込・鍵取得を拒否。古い鍵は全新世代項目を復号できず、削除項目の取得・再作成も拒否 |
| fixture測定 | 復元先作成から検証終了まで36,848ms。最新dump開始から検証終了まで50,461ms。最新dump後の失われた確定行0件 |
| 後片付け | 実行が作った元DB・復元DB・APIを削除。親のサーバーは稼働を維持 |

初回の失敗は、通常10秒枠でのDB作成タイムアウト、restoreの検索先による制約関数の
参照失敗、SQL出力先の指定不足、拒否検査用要求の版番号不整合だった。
これらは修正して再実測し、失敗を省略成功に扱っていない。
SQL本文や暗号文をログへ出さず、静的なエラー分類から調査した。

共有Cargoゲート、worktree専用のDドライブの生成先、sccacheを利用した。
最終ソースで書式検査、受入ツールのnextest 9件（省略0件）、Clippy全対象
（警告をエラー扱い）が成功した。実測に使うバイナリのビルドも成功した。
別モデル `gpt-5.6-terra` の指摘で、Node API終了時の無期限待ちを2秒の有限待機へ直し、
検索先の置換が関数本文やCOPY内容へ進まない回帰検査を追加した。
修正後の同モデルによる再確認はMustなしだった。レビュー担当は実DB検証を実行しておらず、
上の実測成功は実装担当の終了コードと検査結果に基づく。

正式Node＋所有記録付きPostgreSQL16.15の再検証は、拒否されたPUTの前後の保持検査を加えた後も
成功した（架空データの復元・検証時間25.268秒）。Docker版PostgreSQLと正式 `--image` の実実行、
およびその新方式のCI成功は確認中。
親の統合時に、既存のCIが用意するnativeと配布イメージで次の追加実行が必要である。
正式Nodeと配布イメージの2方式をCIへ追加済み。新方式の成功結果は確認中であり、
以前のCIの成功だけを本方式の成功に数えない。

```text
tools/encrypted-storage-acceptance/target/debug/passshare-encrypted-storage-acceptance --encrypted-restore backend/native/target/debug/passshare-mutations
tools/encrypted-storage-acceptance/target/debug/passshare-encrypted-storage-acceptance --encrypted-restore --image passshare-todo1163-encrypted-api
```

変更は受入ツール、この仕様書、2方式を実行するCI接続だけで、新規依存やbackend/Core/SDK/他のtoolの変更はない。
この測定で親の22条件やM4/M8の達成を宣言しない。
