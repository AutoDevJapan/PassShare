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
| devの内容 | 利用者1・項目1・所属1が`backend/src/db/dev-seed.js`の既知デモと一致。追加ボックスと操作状態の最終照合は未完 |
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

別モデルレビュー、同じPR headの全CI、全workspace/doctest、main統合、Prdへの実配備とsource照合、認証後の実画面、旧環境の安全な廃止、削除後の不在、非Prdが再作成されない観測を残す。

恒久証跡は`D:/CC/Tools/prd-only-2344/remaining-products/results/PassShare-evidence/`、製品台帳は同じresultsの`PassShare.json`へ保存する。親2344と元製品の受入全体は、この有限作業だけでは完了しない。
