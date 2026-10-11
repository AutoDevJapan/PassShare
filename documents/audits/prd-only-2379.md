# PassShareのPrd統一（ToDo2379）

2026-10-12時点で配備処理を既存Prdだけへ限定する変更を準備した。実環境の廃止と最終配備は未完であり、この文書を完了報告として扱わない。

## 対象と保持対象

- GitHub APIの実所有者はAutoDevJapan、repository IDは1131498455。旧originの組織名もAPIでは同じ現リポジトリへ転送された。既存の担当の成果と作業先は変更していない。
- Vercelの既存projectは`prj_itSKGa2HAEj3UNHnsCdPQEF5nziE`、accountは`team_Hh2mAEEcMesxsuaVTP5DMxui`。sourceの所有者・repo・IDを照合した。
- 既存URLは`https://pass-share.bm1314.net/`。Prdのfrontend sourceは`2f57263558c8b483288d389d5f74223a4fc0b688`でREADYだった。
- Railwayのproject、backend、production環境と現PG18 DBは[インフラ仕様](../spec/infrastructure.md)のIDと照合した。backend内の接続先hostと現DBのprivate domainを、秘密値を出力せずSHA-256で比較し一致した。
- 現Prd DB `4fdfda2d-ed50-4396-9797-25ea7720f720`とvolume `70b71256-4c1d-4ffa-bb8e-3e3e5a310d37`を保持する。旧PG16 DBは現Prdへの接続先ではない。旧環境の廃止前に内容とconsumerを照合する。
- CIのDocker、一時DB、localhostの開発は維持する。新しいサイト・project・有料保管を作成しない。人間レビューを求める規則を書き換えない。

## 実確認済みの範囲

| 項目 | 結果と限界 |
|---|---|
| source/所有者 | GitHub APIとVercel project linkのIDが一致。作業先のclient guardはfalse |
| 新規Previewの停止 | 正式APIで`previewDeploymentsDisabled=true`へ更新し、GETで読戻した。Prd IDとREADYを維持 |
| 過去配備 | ページ送りを完了し1,116件を取得。非Prdは879件で、停止設定だけでは削除されていない |
| CLI配備のsource | Git metadataのcommit `537884c`を現repoのAPIと照合。repo IDの欠けた別配備のcommit `b52c17a`も現repoで確認 |
| 既存画面 | オーナーのChromeでトップページ、Webアプリの保護された遷移、ログイン画面を確認。認証後の画面操作は未確認 |
| Prd API | 同じ既存URLで合成アカウントを作成し、ログイン、項目保存、再ログイン後の保持、JSON書出しを用いた変更と復元、ログアウトを確認。14操作が成功 |
| 検査データ | 当該検査の合成利用者と専有ボックスだけを回収。不在をDBで確認。利用者0・項目0・既存ボックス1を保持 |
| 購入 | サイトのrouteとbackendに購入・課金処理がない。`frontend/src/App.tsx`と商用提供仕様が根拠。実決済は行っていない |
| DB | 現Prd11表、旧Prd8表、stg11表、dev27表。全表の件数と主キーを読み取った。現Prd・旧Prd・stgの利用者/項目/添付は0で、残る既存ボックスの主キーと行のdigestが一致 |
| devの内容 | 利用者1・項目1・所属1が`backend/src/db/dev-seed.js`の既知デモと一致。既存ボックスの安定したmetadataはPrdと一致。削除済み利用者の操作応答も捨てず一時暗号化保全し、全27表の復元内容を照合済み |
| OAuth/cron/webhook | サイトの認証は既存パスワード方式。サイト用Google OAuthのsource参照なし。Railway cron/branch triggerは空、GitHub hooks取得成功。CodeQL/security auditの定期CIは保持。拡張配布用OAuthは対象外として保持 |
| DNS | 既存PrdホストのCNAMEを読み取った。DNS変更なし。ドメイン事業者へのアクセスなし |

初回API検査は検査側のWebRequestSessionに残ったConnect用Authorizationでログアウトが401になった。HTTPヘッダーの持越しを修正して成功した。製品の認証不具合として扱わない。初回回収SQLの引用処理も修正し、自作fixtureの作成時刻・識別子・専有と内容を限定して回収した。失敗の証跡は残す。

## 配備変更と検査

- mainからのdev配備、PRのPreview配備、stg配備・稼働stg smokeを廃止する。
- Prd配備はmainの清潔なsourceと既存project/service/environment IDに限定する。PG18の現DBだけを一時snapshotの対象とし、refresh・旧DB・別環境を接続前に拒否する。
- snapshotはアップロード範囲外の専用一時フォルダーへ置き、成功・失敗時に回収する。GitHub artifactへDBを保存せず、proxyや有料保管を新しく作らない。
- VercelのGit配備はmainのみ。旧dev/stgへのrewriteを除き、環境変数の同期はPrdだけにする。
- 関連回帰27件、Bashの拒否検査3件、JS/Bash/PowerShell構文、actionlintとmigration静的検査は成功した。最終CIと別モデルレビューは未完。
- Prd snapshotに必要な現DBのIDをGitHub secretへ設定した。認証値は表示・記録していない。

## 未完了の受入

新たな修正ごとの別モデルレビュー・同じPR headの全CI、Prdへの実配備とsource照合、認証後の実画面、旧環境の安全な廃止、削除後の不在、非Prdが再作成されない観測を残す。root workspace/doctestは検証済みで、Rustの同じ最終ソースを重ねて検査しない。

### 初回統合後の状態

PR712は候補`7cf59422`の全CI・独立レビューMust0を確認し、`e4cf91fb`へ統合した。候補と統合後のtreeは一致する。root workspaceは280件・省略0、doctest成功。独立した復元検査ツールは20件成功し、既存のDocker受入1件の省略を維持した。旧devは一度だけ暗号化して保全し、独立一時DBへの復元で全27表の件数・主キー・正規化した全内容が一致した。一時DBも不在を確認した。

本番配備run38171037340は、現PG18のTCP proxyがないためsnapshot段階で停止し、backendのアップロードは実行していない。現Prdと旧環境は保持した。公開接続や有料保管を追加せず、既存サービスの非公開SSHを使う保全処理へ修正する。

修正したGoの処理で現Prdから実取得し、コンテナ内の検査と取得元/転送後のSHA-256一致を確認した。既存認証をコピーせず使う経路に加え、一時認証の登録・取得・この呼出しのIDだけの解除も実確認した。取得物は一時的に暗号化して保管し、検査用の平文ファイルを回収する。修正PRのCI、独立レビュー、再配備と画面、環境廃止は引き続き未完。

PR714は`61521aa2`の全CI（47成功、任意Cursor3件は利用枠による省略）と独立レビューMust0を確認し、`331d0e5c`へ統合した。統合後のtreeも一致した。VercelのPrdは同sourceでREADYとなったが、backend配備run38180632380は非公開SSH取得で停止し、アップロードしていない。手動認証の成功とCI用認証による取得成功を区別し、Prd機能確認や旧環境廃止の完了とは扱わない。

新しいrunnerのSSHホスト信頼を検証した。信頼先が空の対照では終了255で接続が拒否され、既存の信頼済み公開ホスト鍵を指定した対照では、厳密な鍵検証を維持したまま現PG18への読み取り専用markerが返った。オーナーのSSH設定と秘密鍵は変更・コピーしていない。CIにはこの公開鍵、batch mode、厳密な検証を設定し、検証済みRailway CLI 5.41.2へ固定する。raw stderrを出さず、固定した原因分類と終了コードを記録する。新修正のCI・レビュー・CI用認証での再配備は引き続き確認する。SSHの検証を無効にする代替は使わない。

恒久証跡は`D:/CC/Tools/prd-only-2344/remaining-products/results/PassShare-evidence/`、製品台帳は同じresultsの`PassShare.json`へ保存する。親2344と元製品の受入全体は、この有限作業だけでは完了しない。
