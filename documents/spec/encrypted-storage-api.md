# 暗号文保存API

共有ToDo #1163 / #1175、M4のサーバー保存契約。全クライアント・鍵配布・復旧・平文移行は未完です。
この契約の合格を、製品全体がサーバーに秘密値を読まれないことの証拠にはしません。

## 有効化と互換性

正式な `backend/src/index.js` → `createApp` から登録します。
PostgreSQL、native実行ファイル、`PASSSHARE_ENCRYPTED_STORAGE=true` のすべてが必要です。
初期状態は無効。クライアント・鍵・移行・プラン上限が未完のまま既存の本番へ有効化しません。
検査は専用プロセスでこの設定を明示し、本番の設定を変更しません。

API登録後も既存ボックスは `compatibility` のままです。所有者が空のパスワードボックスを
明示的に有効化すると `encrypted` になります。平文項目があれば409で拒否して原本を保持します。
解除・平文移行・鍵の世代更新はこのAPIでは提供しません。
名前・ID・版・鍵世代・更新時刻は公開メタデータです。タイトル・種類・フィールド等の本文は暗号文に入れます。

## 認証

既存のセッションと本人確認済み所属を使い、DB操作のたびに再確認してロックします。
有効化は所有者のみ、書込みは所有者または確認済みメンバーのみです。
Cookieの変更にはCSRFのCookieとヘッダーの一致が必要です。
クライアント種別を名乗るだけではCSRFを省略しません。
Bearerは既存のセッション用トークンを使用し、Connectトークンとは区別します。

## HTTP契約

すべて `/api/encrypted` に登録します。

| 操作 | 相対パス | 本文・応答 |
|---|---|---|
| GET | `/boxes/:boxId` | `{mode,keyEpoch}`。互換状態の世代はnull |
| POST | `/boxes/:boxId/enable` | `{keyEpoch:1}`。同じ有効化の再送は成功 |
| GET | `/boxes/:boxId/items?after=:itemId` | `{items:[{itemId,itemVersion,keyEpoch}],nextCursor}`。ID順で最大100件 |
| GET | `/boxes/:boxId/items/:itemId` | 保存した `EncryptedItem` の全JSON |
| PUT | `/boxes/:boxId/items/:itemId` | `{expectedVersion,envelope}`。成功は200と保存した全暗号文 |

新規は期待版0・送信版1です。更新は現在版n・送信版n+1、期待版は0〜9007199254740990です。
ボックスIDと項目IDは26桁の英小文字・数字です。`format:1`、contextの保存先とIDがURLに一致し、
送信版は期待版+1、鍵世代は現在世代に一致する必要があります。
nonceは24バイト、暗号文は16〜1048592バイトのcanonical標準Base64です。
未知フィールド・平文の付加・未知形式・過大本文・範囲外の数値・保存先の違いは400になります。
現在版との競合は409 `PS015`、鍵世代の違いは409 `PS056`、切替前の保存は409 `PS055`です。
未認証401、権限不足403、対象なし404、保存サービスの故障503で、平文への代替保存はしません。
JSONのキー順と空白は正規化しますが、各値と暗号文は保持します。
同じ期待版の同時更新は1件だけ成功します。応答を失って再送したときは409となり、GETで確定結果を確認します。

サーバーは公開ヘッダーとDB状態だけを検査します。鍵を持たないのでAEADの正当性は判定できません。
クライアントは応答をCoreの `decrypt_item(envelope, expectedContext)` で検証してから利用します。
期待する保存先・項目・版・世代を、サーバーの応答だけから信用してはいけません。

## 旧経路との境界と削除

有効化したボックスは旧 `/v1/vaults/:vaultUuid` 経路から409で拒否します。
Expressのパラメーターで判定し、URLエンコード・大文字・末尾slashによる別経路を防ぎます。
Connect認証の後、旧routerの前に境界を置きます。互換ボックスの旧操作は維持します。

DBの旧項目INSERT/UPDATEにも境界トリガーを設け、旧書込みと切替を親ボックスの行ロックで直列化します。
平文書込みが先なら切替を拒否し、切替が先なら平文書込みを拒否します。
SQLSTATE `P0055` はHTTPの409 `PS055`に変換します。

状態と暗号文の両テーブルに `connect_vaults` への連鎖削除を指定します。
退会時の本人だけのボックス削除で暗号文も消え、他人の共有ボックスの暗号文は保持します。
メモリ保存・別Map・専用の削除フックはありません。

## Rustと配布

production nativeは公開JSONヘッダーの厳密検査だけを担い、Coreの暗号依存を持ちません。
実際のCore暗号化との整合は独立したRust受入toolで検証します。
`backend/native` のCargo.lockは単独で解決し、Coreやroot manifestのないbackend-only配置でビルドします。
既存のDockerfileとRailwayのビルド文脈は維持します。

専用の受入ホストを廃止し、正式index.jsと同じセキュリティヘッダー/CORS/認証の順序で検査します。
受入toolは暗号鍵をクライアント側のプロセス内にだけ持ち、DBとAPIへ送りません。
検証DBは一意名と作業番号で分け、終了時にコンテナと関連ボリュームを回収します。

```sh
cargo nextest run --locked --manifest-path backend/native/Cargo.toml -p passshare-mutations --test-threads 10
cargo nextest run --locked --manifest-path tools/encrypted-storage-acceptance/Cargo.toml --workspace --test-threads 10
cargo run --locked --manifest-path tools/encrypted-storage-acceptance/Cargo.toml -- /owned/native-target/debug/passshare-mutations
docker build -t passshare-todo1163-encrypted-api backend
cargo run --locked --manifest-path tools/encrypted-storage-acceptance/Cargo.toml -- --image passshare-todo1163-encrypted-api
```

生成先は担当用に分け、共有Cargoゲートとsccacheを使います。同じrootソースの全検査を重ねません。
PostgreSQL fixtureは `postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24`
を事前ロードし、両モードとも `--pull=never` で使います。imageモードは正式Dockerfileで
作った実行ファイルをそのまま使い、ホストのnativeファイルをマウントして置き換えません。
呼出元が自分のAPIイメージを削除し、toolが自分のコンテナ・ボリューム・networkを回収します。
`.github/workflows/encrypted-storage.yml` に独立toolの検査とNode／image両モードを登録しました。

## 確認できたことと残条件

2026-10-08のWindows実受入で、正式index.js経路からCoreの全JSONを暗号化してPUT/GET・DB保存・
再起動後の復号まで確認しました。native41件、Coreとの整合2件も成功しました。
拒否後の原本保持、同時更新の成功1／競合3、版・世代・保存先・未知フィールドの拒否、
未確認／除名済みメンバーと失効済みセッションの拒否、CookieのCSRF、旧HTTP／DB経路の拒否、
互換ボックスの保持、平文書込みと切替の競合、本人だけのボックス削除時の連鎖削除を確認しました。
CIと別モデルレビューは候補ごとに別途記録します。源本体の成功を配布イメージの成功に転用しません。
退会APIのmain `682ab55` を統合したソースでnative45件、tool3件、正式Nodeと
PostgreSQLの全受入を再確認しました。配布イメージとLinux CIの結果は別に確認します。

残条件は全クライアント接続、端末での鍵保管、WASM、共有鍵の確認・配布・失効・復旧、
平文移行と故障時の原本保持、暗号化した添付、プラン上限、削除契約、公開環境での受入です。
設定を有効にしただけ、またはボックスの保存契約が通っただけでM4を完了にしません。
