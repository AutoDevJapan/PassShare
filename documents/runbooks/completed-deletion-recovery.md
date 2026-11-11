# 確定したボックス削除を古い復元点へ再適用する

関連: [#593](https://github.com/AutoDevJapan/PassShare/issues/593)、[#600](https://github.com/AutoDevJapan/PassShare/issues/600)、[商用条件](../spec/commercial-packaging.md)、[保持仕様](../spec/support-data-lifecycle.md)。

この手順は復元先の停止中に、現在の確定済み削除を反映する。削除受付を新しく承認したり、バックアップ内の古い資格を有効にしたりする処理ではない。元の本人確認・共有・暗号鍵・取消記録の照合がすべて終わるまで、API、worker、外部ネットワークを開かない。

確定削除のtransactionは`commercial_deletion_journal`へ削除ID・Box ID・確定時刻だけを保存する。アカウント退会後にも古いbackupを照合できるよう、user/contractへのcascade参照を持たない。項目本文、添付、鍵、認証値、内容指紋は記録しない。対象を復活させ得るbackupがなくなり、その復元経路を閉じたと確認するまで必要な記録として保持する。新しい固定年数・無期限保持・有料保管先をこの実装で決めない。

## 実行する順序

時刻はPostgreSQLのマイクロ秒6桁UTC表現のまま出力・比較し、JavaScript Dateのミリ秒変換で差を落とさない。再開gateは入力にある行だけでなく、現在の正本と復元先の全journal行・時刻の一致も検査する。余分な行や1マイクロ秒の差も合格にしない。正本はDB名だけで識別せず、正規運用記録にあるPostgreSQL clusterのsystem identifierとdatabase OIDを実接続で照合する。古いコピーへ接続した後に、その識別子を「信頼済み」として採用し直さない。物理cloneがcluster IDも複製する場合は正規接続先の照合も必要で、この数値だけであらゆる複製を認証できるとはしない。

reapply設定には正規運用記録の`currentSourceSystemIdentifier`と`currentSourceDatabaseOid`を文字列で指定する。照会できる既存DB権限がなければ資格を増設せず、その手順を未達として扱う。gateは正本・target双方のjournalとtargetのBox/冪等記録をロックして照合し、別client接続を検出した場合も合格にしない。

1. 現在の正本DBと既存の復元一覧から、復元元・時点・現在の削除記録のsource ID、停止した復元先DB名、復元操作IDを照合する。古いarchiveに付属するjournalやchecksumを「現在」の根拠にしない。
2. DB資格をコマンド引数へ渡さず、正規の秘密環境変数へ設定する。設定JSONには値ではなく`databaseUrlEnv`名を指定する。CLIは`PASSSHARE_..._DATABASE_URL`名だけを受ける。
3. `node backend/scripts/deletion-recovery.mjs export <設定JSON絶対path>`で現在の最小journalを非公開保存先へ新規出力する。上書きしない。出力されたSHA-256とsource IDを、archiveとは独立した既存の運用記録へ保存・読み返す。stdoutは件数・hash等のみで、削除済みBox一覧は出さない。独立保全先の実保存・保持期間検証は別の運用受入として必要である。
4. API/workerを停止し、復元先への接続を分離する。`prepare-closed`を同じCLIで呼び、明示したtarget DB/source ID/操作IDをclosed markerへ固定する。他client接続があれば拒否する。既存markerの対象を勝手に置換しない。markerだけを外部ネットワーク停止の証拠にしない。
5. 実`pg_restore`は停止した復元先にだけ行う。archive内にclosed markerがない場合は、外部接続を止めたまま`prepare-closed`で固定する。正式backendはclosed markerを検出すると起動を拒否する。
6. `reapply`を同じCLIで呼ぶ。信頼済みのSHA/sourceと読み込む同一bytesを照合し、現在の正本DBへも別の正規接続を行う。正本journalの共有ロックを取得して現在の全記録とdigestが一致することを再確認し、再適用中の新しい削除確定を待機させる。target DB/操作ID/closed marker/他client不在を確認する。新機能導入前のarchiveにjournal表がなければ、closed targetのtransaction内で正式schemaを追加する。対象Boxだけを消し、古い作成記録を最小tombstoneへ変え、journalとcheckpointを同transactionで確定する。新しい正本・target側削除記録を落とす古いjournal・競合IDは拒否する。
7. 結果JSONの`deletionGateQualified:true`・`APIStillClosed:true`を確認し、削除対象不在、無関係対象の全行・版不変、冪等な再適用を確認する。この合格だけでAPIや本人資格を再開しない。既存の本人・共有・鍵・最新取消の全復元gateへ結果を結び、再開はその正規手順で別途判断する。
8. 検証dumpと秘密設定は用途終了後に回収する。最小journalの独立保全を、削除済み一時dumpのmetadataだけで達成したとしない。

設定は`format:"passshare-deletion-recovery-v1"`、`databaseUrlEnv`、`sourceId`を共通に持つ。exportは`outputPath`、prepare-closedは`targetDatabase`と`restoreOperationId`、reapplyはさらに`journalPath`、独立記録の`trustedJournalSha256`、現在の正本を指す別の`currentSourceDatabaseUrlEnv`名と`currentSourceDatabase`を持つ。削除gateも現在の正本へ再接続して一致を再確認する。ただしその結果の後に正本が変わり得るので、最終切替は既存手順どおり正本側の書込みも停止して最新の全資格を照合する。操作対象は正規DB接続権限を持つ運用担当に限定し、公開HTTP endpointを作らない。

実受入は架空の2users/Boxを作り、削除前の本物PGDMPを隔離復元して対象復活のREDを確認した後、正式APIでの削除・退会→CLI export→prepare-closed→reapply→対象不在/他Box全行xmin不変/同じjournal再送/起動拒否を検査する。公式provider決済、本番データ削除、自動期日処理、journal独立保全先の永続運用までをこのテストで完了としない。
