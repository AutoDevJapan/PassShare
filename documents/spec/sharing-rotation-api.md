# パスワードボックスの共有鍵配布と参加解除

2026-10-11の有限Web子は、既存のaccount identity/member lookup、grant PUT/self GETを
frontendのWorker経路へ接続するソースを追加した。API・Core・DB契約は変更しない。
sender/recipientの指紋を別手段で確認し、独立した期待文脈でRustが包む/復元する。
未確認・除名済みmemberのGET/PUT拒否は正式サーバー側にも必要で、UIの確認だけで認可しない。
Webのencrypted box除名はrotationと添付の原子的契約が未接続のため無効にし、
旧参加解除へ迂回したり、添付を省いた確定・成功表示を行わない。
正式WASM配布・API/PG/Chromeの受入と全体CIは親scopeで未完了。

この仕様は、共有鍵の配布から参加解除時の暗号鍵更新までを一つの受入単位とする。
元のToDo 1163 / 1175の22条件を置き換えず、製品全体の完成を意味しない。
暗号化した所有権の移行（元のM5条件）は、引き続き別のプロトコル実装と受入が必要である。
UIの配置に関する判断待ちは、このAPIの実装・検証を止めない。

すべてのパスは `/api/encrypted/boxes/:boxId` を基準とする。
HTTPの公開は `PASSSHARE_ENCRYPTED_STORAGE=true` のときだけ。
既存のログインセッションで認証し、Connectトークンは使わない。
Cookie認証の変更要求はCSRF検査を受ける。クライアント種類を示すヘッダーでは省略しない。
Bearerを使う場合もログインセッションのトークンが必要である。
すべての応答は `Cache-Control: no-store`。

共有プロトコルの当面の対象は、所有者が**ひとり**のボックスである。
複数所有者の状態では、この仕様の共有・スナップショット・更新操作を409で拒否する。
既存の所有者の項目・所有者用バンドルAPIは、この制限の対象に加えない。
複数所有者や所有権の移行が技術的に不可能だという意味ではない。

## 公開形式と認可

ボックス・項目IDは既存の26文字の小文字英数字。
アカウントIDと処理IDは小文字のUUIDで、nil UUIDは不可。
数字はJSONの整数で、0が明示的に認められたものを除き1以上、最大9007199254740991。
要求・各下位オブジェクトは既知のフィールドだけを許可する。
Base64は標準アルファベット・padding付きのcanonical形式を要求する。
共有鍵の公開点はcanonical X25519座標とし、低位数点のDH失敗判定はクライアントのCoreで行う。

サーバーは公開形式・文脈・保存版・所属・identityの一致を確認する。
秘密鍵・ボックス鍵・暗号化パスワードを受け取らず、復号可能性を保証しない。
Nodeは認証・再認証・SQL実行のアダプターであり、RustはSQLと引数の計画を返す。
業務上の状態判定と変更は、PostgreSQLの同じトランザクションで行う。

所属の確認、公開鍵の真正性の確認、鍵の配布は別々の条件である。
鍵のない参加者も招待を受諾でき、確認済み相手の公開identity APIにアクセスできる。
しかし、所有者以外の項目一覧・取得・作成・更新・削除には、確認済みの現所属と現在世代の配布行が必要。
配布済みでも書き込み権限のない役割には、既存の書き込み制限を維持する。
配布する側・受け取る側は、別経路で確認して保持した相手の指紋をCoreで照合する。
招待の確認コードやサーバー上のidentityの一致は、指紋確認を代替しない。

共有鍵 `envelope` は既存Coreの次の形式。

```json
{
  "format": 1,
  "suite": "hpke-auth/0x0020/0x0001/0x0003",
  "context": {
    "passwordBoxId": "<boxId>",
    "senderAccountId": "<owner UUID>",
    "recipientAccountId": "<recipient UUID>",
    "keyEpoch": 1,
    "senderIdentityVersion": 1,
    "recipientIdentityVersion": 1,
    "senderKeyId": "<64 lowercase hex>",
    "recipientKeyId": "<64 lowercase hex>"
  },
  "enc": "<canonical Base64: 32 bytes>",
  "ciphertext": "<canonical Base64: 48 bytes>"
}
```

両者の所属への複合FKとidentityへのFKで保存行を結び付ける。
両者のidentity版とkeyIdは、保存時に登録済みの不変の公開identityと照合する。
公開identityの更新はDBでも禁止し、秘密seedの包み直しだけを既存APIで許可する。
共有エンベロープと所有者用バンドルは各2KiB以内。

## 鍵の配布

| 操作 | 要求 | 成功応答 |
|---|---|---|
| `PUT /grants/:recipientId` | `{expectedStateRevision,keyEpoch,expectedVersion:0,envelope}` | 200 `{grantVersion:1,keyEpoch,stateRevision,envelope}` |
| `GET /grants/me` | 本文・queryなし | 200 `{grantVersion:1,keyEpoch,envelope}` |
| `DELETE /grants/:recipientId` | 本文・queryなし | 認可後に409。単独の配布削除は認めない |

作成には現在の変更番号と世代が一致することが必要。
現在世代に同じエンベロープが保存済みなら、現在の認証・所属・両者のidentityを先に確認してから成功させる。
この完全一致の再送は、元の変更番号が古くても行・時刻・変更番号を更新しない。
同じ世代の異なるエンベロープへの置換は409。
本人の取得は未参加・未確認なら403、確認済みで未配布なら404。

## 同じ変更番号で取得するスナップショット

| 操作 | 応答 |
|---|---|
| `GET /sharing-snapshot` | `{stateRevision,keyEpoch,ownerAccountId,ownerBundleVersion,memberCount,liveItemCount,grantCount}` |
| `GET /sharing-snapshot/members?revision=R&after=ID` | `{stateRevision,members:[{accountId,role,membershipConfirmed,keyGranted}],nextCursor}` |
| `GET /sharing-snapshot/items?revision=R&after=ID` | `{stateRevision,items:[{itemId,itemVersion,keyEpoch}],nextCursor}` |
| `GET /sharing-snapshot/items/:itemId?revision=R` | 項目の既存エンベロープ |

所有者のみ取得できる。参加者一覧は未確認の所属も含む。
一覧はID昇順、各ページ最大100件。`after` は最初のページでは省略する。
`revision` は桁だけからなる正のsafe integerで、先頭の0は不可。
余分なquery、重複queryによる配列、空のカーソル、不正なIDは400。
全ページと各暗号文を同じRで取得し、途中の変更があれば409。
GETや取消要求には本文を送らない。`Content-Length: 0` でExpressが作る空オブジェクトは本文なしへ正規化する。
本文付きのGET、transfer encoding付きのGETは400。

`state_revision` は、生存項目・所有者用バンドル・配布行・所属の実際の変更と世代更新で進む。
削除済みIDの再送、配布の完全一致再送、仮置きでは進めない。
identityの初回登録では進めない。identityの準備状況はスナップショットに混ぜず、配布時に別途取得・確認する。
変更番号の増加量を1に固定しない。クライアントは大小と一致だけで扱う。

## 参加解除の仮置きと一括確定

処理IDはクライアントが生成し、再送でも同じIDを使う。
開始本文は次のオブジェクト。`bundle` は文字列ではなく、既存の所有者用バンドルのオブジェクトである。

```json
{
  "expectedStateRevision": 42,
  "expectedKeyEpoch": 3,
  "expectedOwnerBundleVersion": 7,
  "removeAccountId": "<confirmed nonowner UUID>",
  "bundle": { "format": 1, "salt": "<16 bytes Base64>", "wrapped": {
    "format": 1,
    "context": { "passwordBoxId": "<boxId>", "ownerAccountId": "<owner UUID>", "keyEpoch": 4 },
    "nonce": "<24 bytes Base64>", "ciphertext": "<48 bytes Base64>"
  } }
}
```

| 操作 | 要求 | 成功応答 |
|---|---|---|
| `PUT /rotations/:operationId` | 開始本文 | `{operationId,status:"pending"}`。確定済みの同じヘッダー再送は `{operationId,status:"committed",result}` |
| `PUT /rotations/:operationId/items/:itemId` | `{expectedVersion,envelope}` | `{operationId,itemId,itemVersion,keyEpoch}` |
| `PUT /rotations/:operationId/grants/:recipientId` | `{envelope}` | `{operationId,recipientAccountId,keyEpoch}` |
| `POST /rotations/:operationId/commit` | `{currentPassword}` | 確定結果 |
| `GET /rotations/:operationId` | 本文・queryなし | `{operationId,status,itemCount,grantCount,stagedBytes,expiresAt,result}` |
| `DELETE /rotations/:operationId` | 本文・queryなし | 未確定の仮置きを破棄して204。存在しないIDへの取消も204 |

開始時にR・旧世代・所有者用バンドル版・解除対象B・新バンドルを不変に固定する。
ボックスごとの未確定処理はひとつ。Bは確認済みの所有者以外の参加者。
未配布の確認済みBを解除する場合も同じ更新プロトコルを用いる。
新世代は旧世代＋1、新所有者用バンドルも同じボックス・同じ所有者・新世代でなければならない。

項目は現在存在する生存IDだけを受け付け、旧版＋1の暗号文を1件ずつ仮置きする。
残す配布先は、旧世代の実際の配布先からBだけを除いた集合である。
確認済みでも未配布のDは、この操作で新たに配布しない。
ヘッダーと各仮置きは、未確定状態で同じJSONの再送なら無更新で成功し、異なる内容は409。
仮置き中に公開状態が変われば、以後の仮置きと確定は409。取消して新しいスナップショットから始める。
確定済みの仮置きへの書き込みは409。確定後の再送確認はcommitまたはstatusを使う。

クライアントのCoreは、全JSONを保持したままDTO内の `version` だけを＋1にして再暗号化する。
未知フィールド、custom fields、配列、添付メタデータを既知DTOへの変換で落とさない。
新所有者用バンドルから復元した鍵でも暗号文を開き、版以外のJSONが元と一致することを確定前に検証する。

確定は全生存ID・旧版の集合と残す配布先の集合を両方向の差分で照合する。
現在のR・所有者・旧世代・バンドル版・解除対象の所属も再確認する。
欠落・余分なID・旧版違い・Bの混入・以前未配布だった相手の追加は、書き込み前に拒否する。
全項目、新所有者用バンドル、新配布行、Bの所属解除、B宛てのpending招待の無効化、
BのConnectトークンの削除、世代と変更番号、確定結果を同じトランザクションで更新する。
削除済みIDの記録は消さず、旧世代・旧版も変更しない。IDの予約は全世代で維持する。

確定結果は次の形で、現在の状態ではなくその処理の履歴を表す。

```json
{
  "operationId": "<UUID>", "status": "committed", "keyEpoch": 4,
  "stateRevision": 55, "ownerBundleVersion": 8, "removedAccountId": "<B UUID>",
  "itemCount": 5, "grantCount": 2
}
```

応答を失った後のcommit再送も、現在のセッション・現在の所有者・再認証を先に確認する。
その後、記録済みの同じ確定結果を返し、世代・項目版・変更番号を再び進めない。
所有者が変わった場合やセッションが失効した場合には履歴も返さない。
確定済みの処理は取消できず409。

Bの失効は確定時点。仮置き中は旧状態でアクセスできる。
確定後のBの項目アクセスは403、残る参加者による旧世代の書き込みは409。
Bが保持済みの旧鍵・旧暗号文・平文の利用は、参加解除後も可能なものとして扱う。

## ロック・再認証・旧経路

ロック順は親ボックス、UUID順のユーザー、セッション、UUID順の所属、招待、
暗号化状態、処理行、所有者用バンドル、配布行、項目行。
退会は対象親ボックスもID順にロックし、後から対象が増えた場合は409でやり直す。
全待機が終わった後に `clock_timestamp()` でセッション期限と現在の確認済み役割を再確認する。
確定・旧所有権譲渡・退会では、その時点の資格情報のSHA-256も照合する。

commitのログインパスワードは既存の共有ログイン防御で照合する。
NodeからSQLへ渡すのは照合時のログインハッシュのSHA-256だけで、パスワードやArgon2ハッシュは送らない。
`currentPassword` をnative入力から除くのはcommitだけ。
他の新要求でこのフィールドを送れば未知フィールドとして400になる。
再認証前のIP・アカウント防御に加え、通常処理は600回/分の予算、commitは既存の厳しい再認証予算も使う。
SQL障害は入力内容や詳細を返さず、固定の503。safe integer上限などの状態競合は409。
業務上の拒否は書き込み前に判定し、書き込み開始後の例外では全変更を取り消す。

旧参加解除は、暗号化ボックスの確認済み所属なら変更前に409。
旧所有権譲渡は、暗号化ボックスなら変更前に409。
退会は、存続する暗号化ボックスへの所属がある間は409。先に所有者による原子的な参加解除を完了させる。
自分だけが所有するボックスを削除する退会と、互換保存のボックスでの従来操作は維持する。
これらの制限はDBの状態で判定し、HTTPの機能フラグを戻しても解除しない。

既存アダプターの変更点は、役割変更・参加解除・招待作成/受諾/辞退/取消へセッションIDを渡すこと。
所属変更・招待操作・旧所有権譲渡・退会の判定はSQLへ接続する。
signup/seedの信頼済み所属追加は、セッション作成前の内部操作として維持するが、暗号化ボックスへの新しい所属追加には使えない。
認証済みのボックス作成にもセッションIDを渡し、同じトランザクションで再確認する。

## 容量・保存・移行

HTTP/nativeの2MiB上限を維持し、全ボックスの暗号文をまとめて送らない。
単一項目は既存上限の平文1MiB＋タグに対応する暗号文とし、保存JSONは1500000 bytes以内。
仮置き件数はその時点の生存項目・残す配布行の数以内。
仮置き総量は `min(1GiB, 生存項目数×1500000 + 残す配布先数×2048 + 2048)` bytes以内。
DB上の総量カウンターを同じトランザクションで更新し、同じ行の再送では加算しない。
上限を超える場合は確定前に409。この容量上限は全ボックス更新方式への切替理由にはしない。

未確定処理の期限は開始から24時間で、再送では延長しない。
期限切れの仮置き・確定は410、statusは `expired` を返す。
新しい開始が成功する際に、そのボックスの期限切れの未確定データを回収する。
期限切れの同じIDは再利用せず、取消後に新しいIDで始める。
新しい常駐サービス・保存先・追加費用は不要。
途中の再起動後も仮置きを継続できる。
確定後は全仮置き暗号文とヘッダーの新バンドルを削除し、ヘッダーのSHA-256と最小限の確定履歴だけを残す。

既存の項目・所有者用バンドルへ、必須・未知フィールド・型・canonical Base64・文脈・サイズの厳格なCHECKを追加する。
式は `IS TRUE` でNULLによる制約の通過を防ぐ。
追加して既存行を検証し、既存の有効行の暗号文や時刻を書き換えない。
無効な既存行を見つけた移行は失敗させ、データを書き換えてごまかさない。
変更番号は列の追加時に1を初期値とする。過去の変更回数の推定はしない。

## 親担当が実行する受入

この実装担当はビルド・テスト・Docker・コミット・pushを実行しない。
新しいRustモジュールのplanner単体テストを親担当の検査へ含める。
SDK・Core・受入ツール・workflowは親担当と別担当が接続し、次を正式Nodeと配布イメージの両方で確認する。

1. 実際の招待とimmutable identityを使った配布で、BがCoreで取得・復号し、未知フィールドを含む全DTOを読み書きできる。
2. 未配布・未確認の参加者を拒否し、公開identity APIへの正当なアクセスは維持する。
3. A/B/Cへ配布し、Bの解除後にAの新バンドルとCの新共有鍵で全項目を開ける。未配布Dは新世代も未配布。
4. ID・版・残す配布先の欠落と追加、並行編集・削除・所属変更・所有者用バンドル変更を拒否する。
5. 旧解除・譲渡・退会とフラグoffで迂回できず、拒否時に一切の公開状態が変わらない。
6. 実際のロック待機中のセッション期限切れ・失効・資格情報変更を拒否する。待機はDBのblocking情報で観測する。
7. 全項目更新後・所属解除後のSQL障害で全行を取り消し、応答喪失後のcommit再送でも二重更新しない。
8. 100件超のページ、総量2MiB超、最大級の1項目、再起動、期限切れ、取消、上限付近の版と変更番号を確認する。
9. 同じヘッダー・stage・grant再送で行と変更番号が変わらず、確定後に仮置き暗号文が残らない。削除済みIDは全世代で再利用不可。
10. 有効な既存データへの繰り返し移行と、欠落値・null・未知フィールド・不正Base64を直接SQLで拒否することを確認する。

実Core→正式Node/配布イメージ→PostgreSQL→実Coreの復号が通るまで、この受入単位を完了と数えない。
