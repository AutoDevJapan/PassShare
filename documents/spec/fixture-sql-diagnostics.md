# 有限なfixture SQL故障診断

対象はstandaloneの `tools/encrypted-storage-acceptance` のみ。通常SQLとDB作成・所有確認・回収で、同じ子プロセス処理と非秘密の診断型を使う。製品のSDK/API/Coreや原ToDo1163の22条件を変更しない。

## 観測と秘密の境界

SQL本文、stdoutの行、stderr本文、資格、暗号文、任意の識別子・エラー文字列を失敗値に保持したり表示したりしない。失敗値のDebug/Displayも、固定ラベル・数値・Boolean・許可した識別子だけで構成する。SQLは標準入力のBase64と `\gexec` で単一要求として送り、DB作成・回収も元の `-c` と同じ要求単位を保つ。

- 工程は `fixture_query`、`attachment_state_hash`、`selected_db_readiness`、`create_database`、`drop_database`、`verify_ownership`、`fixture_control` の固定列挙。SQL本文や識別子から可変ラベルを作らない。DB制御では固定の操作prefixをこの列挙へ対応させる。添付の全行/xmin照合だけを最小の呼び出し変更で識別する。
- 呼び出し元は許可したソースのbasenameと行番号のみ。クライアントも `psql`、`docker_exec`、`suppressed` の固定値。実行ファイル・環境変数・接続文字列を表示しない。
- spawn成否、子PID、入力完了/成否、両出力の回収完了/バイト数、終了コード、kill要求、reap結果、全I/O workerのjoin結果、I/O取消要求を記録する。
- `milestones_ms` は処理開始からspawn、入力完了、stdout完了、stderr完了、終了観測までの経過時間。未観測はNoneとし、最後に処理全体の実測時間を出す。spawnより前の期限は呼び出し元の絶対期限で判定する。
- OS番号とI/O種別の配列順はspawn、stdin、stdout、stderr、wait、kill、Windows I/O取消。番号がないエラーでも、固定種別で `not_found` などを識別する。OSの文章を転記しない。
- SQLSTATEは行頭のseverity、数字だけのpsql stdin行番号prefix後、またはlibpq接続prefix後のseverityを受け、最初のエラーだけ固定リストと照合する。CONTEXT/DETAIL本文中のseverityや、最初の未知SQLSTATEの後に値として現れるコードは採用しない。未知の5文字もそのまま出さない。既知のrelation/functionだけ、製品スキーマまたはfixture所有マーカーと完全一致した名前を許可する。
- WinSock番号はlibpqの `(0xHEX/DECIMAL)` の両値が同じ10000以上12000未満の数値で、libpqの接続エラー行にある場合だけ数値として出す。任意のOS名や括弧内本文は出さない。
- SQLSTATEがない場合も接続拒否、送受信切断などを固定分類で識別する。未知の終了2/3はそれぞれpsql接続/SQL終了として記録する。Dockerの場合は外側CLIの終了コードなので、内側psqlの原因を確定したとは扱わない。入力失敗も独立したtransport分類として残す。

## 寿命と失敗の扱い

入力と両出力を並行して処理する。入力失敗だけで即座にreturn/killせず、元の期限内で子の終了と診断を回収する。出力上限・読取/待機エラー・期限超過はkillし、最大2秒でreapと回収を進める。Windowsで残った同期I/Oはこの回収期限内に取消を要求する。未終了workerを無期限にjoinしない。回収できなければ後片付け失敗として記録し、成功に読み替えない。

通常SQLの上限8MiB、DB制御の上限16KiB、通常15秒、DB作成/削除60秒、既存のstatement/lock timeoutを維持する。期限延長・自動再送・許容・skipを故障の修復に使わない。

通常SQLまたはDB制御のqueryが失敗したときは、同じ選択DB（CREATEの場合は作成に使ったcatalog DB）に無秘密の `SELECT 1` を一度だけ実行して直後の接続状態を観測する。別の3秒期限、接続2秒/statement2秒を使う。Docker execには環境指定を明示して内側へ渡す。これは失敗したSQLの再送ではなく、元の失敗判定を変えない。回収用Dropでは新たな診断queryを増やさず、元の所有確認と処理失敗のmetadataを残す。

## 有限な検証

関連toolのnextest、Clippy、buildだけを実行する。入力停止、両pipeを満たす出力、早期終了、出力上限、spawn失敗、秘密canaryを含むSQL/row/資格/未知SQLSTATEの抑止を試験する。明示した所有PG16の専用DBでは、ゼロ除算、欠落relation、SQL構文、statement timeout、未知エラーのcanary抑止、自分で確保して解放したポートのTCP拒否を確認したうえでの接続拒否、同じDB内のadvisory lock、同じDB内の自分の接続終了を試す。別の専用DBでは、自分の作成済みDB名だけを使ったCREATE重複故障を起こし、元の42P04失敗を保ったままcatalog readinessと元DB保持・回収を確認する。各失敗の終了/reap/joinと接続復帰を確認し、作成した名前に限る照会でDrop後の不在を確認する。

親PGの停止・設定変更・全DB列挙、親の画面用DBへの操作はしない。検証した構造改善と、過去の原因確定を区別する。初回の86byte・SQLSTATEなし・終了2だけから、過去の原因を断定できない。同じソースの成功再実行を原因修復の根拠にしない。
