# PassShare 商用見積・契約ライフサイクル決定エンジン

この文書は `backend/native` の `passshare-mutations` に追加した商用条件の判定 ABI を定義する。これは見積と契約ライフサイクルの**決定案**を返す部品であり、実際の支払い、契約保存、解約保存、自動削除、書き出し許可の DB 反映、M8-D または原22条件の完了証明ではない。

## ABI

入力は既存の native mutation と同じく標準入力の JSON で渡し、出力は `status`、失敗時 `code` / `message`、成功時 `body` を持つ JSON とする。入力上限、JSON 解析失敗、未知コマンドの扱いは既存 `passshare-mutations` の規約に従う。

### `commercial-quote`

税込 JPY の公開価格から見積を作る。

必須入力:

```json
{
  "command": "commercial-quote",
  "currency": "JPY",
  "plan": { "type": "team", "administrators": 1, "members": 4 },
  "setup": {
    "installationCompanies": 1,
    "supportHours": 2,
    "maintenanceMonthlyJpy": 10000
  }
}
```

`plan.type` は `personal` または `team`。個人版は `users` が1以上、チームは `administrators` と `members` がそれぞれ1以上でなければならない。`setup.maintenanceMonthlyJpy` は明示見積がある場合だけ `10000..200000` の整数で渡し、不要な場合は `null` を渡す。導入社数と支援時間は0以上の整数で、暗黙の最低料金や割引は作らない。

固定価格:

- 個人版: 1人あたり月額980円
- チーム管理者: 1人あたり月額1,980円
- チーム通常メンバー: 1人あたり月額500円
- 初回導入: 1社10,000円
- 導入支援: 1時間10,000円
- 保守: 月額10,000円から200,000円まで、明示見積がある場合だけ

通貨が `JPY` 以外、負数、小数、文字列数値、未知プラン、未知フィールド、必須フィールド不足は `400 PS018` で拒否する。

### `commercial-lifecycle-decision`

`operation` ごとに契約ライフサイクルの決定案を返す。DB 認可や契約保存は行わない。

#### `renewal-preview`

契約開始日と同じ日を毎月の更新日にする。存在しない日だけ月末へ丸め、次月以降は契約開始日の元の日に戻す。例: `2026-01-31 -> 2026-02-28 -> 2026-03-31`。

```json
{
  "command": "commercial-lifecycle-decision",
  "operation": "renewal-preview",
  "contractStart": "2026-01-31",
  "cycles": 3
}
```

日付は `YYYY-MM-DD` の Gregorian calendar date で、時刻・タイムゾーンは扱わない。`cycles` は1から120まで。

#### `seat-increase-quote`

増席の残期間見積を返す。呼び出し側は検証済みの `periodStart`、`periodEnd`、`changeDate` を渡す。期間は `periodStart` 以上 `periodEnd` 未満の半開区間として扱う。残日数の正確な分数を必ず返し、丸めた円額は `roundingPolicy` が `ceil-jpy` または `floor-jpy` のときだけ別項目で返す。丸めなしは `none`。

増席は、同じ入力で得た `quote` を `acceptedQuote` にそのまま渡すまで決定扱いにしない。最初の見積では `acceptedQuote: null` を明示し、`requires-explicit-acceptance` を受け取る。必須項目が欠けた入力は400で拒否する。受諾する内容が変わっている場合は `409 PS015` を返す。見積のハッシュは内容の照合用であり、本人認証や支払いの証明ではない。

#### `seat-decrease`

減席は現在の支払済み期間へは反映せず、次回更新日からの決定案を返す。現在期間の自己都合返金は0円として返す。

#### `cancel`

解約は支払済み期間の終わりまで利用を残す決定案を返す。違約金は0円、自己都合の日割り返金は0円。実際の解約保存は行わない。

#### `post-end-export`

契約終了日から30暦日の書き出し案を返す。`contractEnd` は支払済み期間の終了境界で、期間は終了日以上、終了日+30日未満とする。例として3月1日に終了する場合は3月30日までが対象となり、3月31日は対象外となる。応答の `exportWindowEndExclusive` は含まれない境界を示す。これは本人確認、所属、所有者、鍵の権限を復活させるものではない。現在の本人確認・所属・書き出しスコープがあるという呼び出し側の検証済み主張が必要。

## actor 主張

終了後の書出し判定に渡す終了日と要求日も、呼び出し側が提示する日付である。成功応答は`dateSource: "provided_calendar_dates"`と、契約状態および現在の日付を独立には確認していないことを返す。利用者が送った日付を実アダプタの認可に使わず、サーバー側の契約記録と現在の日時から算出する。

アクセス判断を返す operation では `actor` を必須とする。

```json
{
  "sessionValid": true,
  "accountRemoved": false,
  "identityConfirmed": true,
  "billingAdministrator": true,
  "membershipActive": true,
  "hasExportScope": true
}
```

この native 部品は DB を読まないため、`actor` は呼び出し側が検証済みとして渡す主張である。成功応答には `assertionSource: "provided_assertions"` と `independentlyCheckedIdentity: false` を返す。`billingAdministrator` は契約・請求管理だけの目的であり、パスワードボックス所有者、所属、鍵アクセスを意味しない。

6つの主張はすべてJSONの真偽値で渡す。null、数値、文字列、配列などは400で拒否する。`sessionValid: false` は `401 PS024`、削除済みアカウントは `403 PS061`、未確認本人は `403 PS062` で拒否する。請求操作で `billingAdministrator` が真でない場合は `403 PS063`、終了後書き出しで現在の所属または書き出しスコープがない場合は `403 PS064`。

## 数学ポリシー

- 金額は税込の最終支払額で、整数 JPY のみ扱う。
- 入力数量と返却する整数はJSONの数値として正確に扱える上限9,007,199,254,740,991までとする。乗算・合計金額・残期間分数の分子もこの上限を検査する。計算中はchecked arithmeticでオーバーフローを拒否する。
- 小数、負数、文字列数値、未知値、必須値不足は拒否する。
- 月次更新は契約開始日の元の日を anchor day とし、存在しない月だけその月の最終日に丸める。丸められた日を次月の anchor にしない。
- 残期間見積は `additionalMonthlyJpy * numeratorRemainingDays / denominatorPeriodDays` を正確な分子・分母で返す。
- 丸め円額は `roundingPolicy` の明示がある場合だけ `proposedRoundedJpy` に分けて返す。丸めなしは `null`。
- 日付は1900年から9999年のcalendar dateのみで、タイムゾーン、時刻、日末表現はこの部品では選ばない。実アダプタは契約で決めた日付と時刻の対応を明示してから利用する。

## 未完の本番アダプタ・検収チェックリスト

### 認証付き見積・受諾の永続化

`POST /api/commercial-contracts` は現在の本人セッションから所有者を決め、
`requestId`、`currency`、`plan`、`setup` だけを受け付ける。
既存Rust見積を保存し、同じ本人・requestIdの再送は同番号を返す。
同じ要求番号で金額や内容が変わる場合は409。支払済み、契約所有者、
利用権限などを利用者の入力から設定しない。

本人は返された `quoteHash` を `POST /api/commercial-contracts/:id/accept`
へ送ってその見積を受諾する。受諾は再送しても日時を変えず、状態は
`accepted_unpaid` にとどめる。支払い、提供開始、契約の法的成立、書出し
許可や製品利用権限をこのAPIだけで確定しない。一般のメール受信は認証に使わない。
GETは現在の本人だけが照会できる。PostgreSQLでセッションと本人をロックし、
行ロック後のセッション期限も確認する。メモリ保存経路は503で拒否する。
退会時は外部キーで見積と受諾記録を削除する。実際の有料契約の保存義務や
保持期間を、この未払い見積の削除仕様で置き換えない。

この経路は支払いプロバイダに接続しておらず、公式test modeの決済受入ではない。
更新・解約・返金・終了後export・データ削除の製品認可は引き続き未達である。

### 未払い受諾の取消

本人の現在のセッションで `POST /api/commercial-contracts/:id/cancel` に
`quoteHash` と `revision` を渡すと、取消時刻と版を契約正本へ保存する。
これは未払い見積の受諾を撤回する処理であり、有料サブスクリプションの
期間末解約・返金・アカウント削除ではない。二重要求は同じ取消日時と版を返す。
他人の契約、見積不一致、古い版は拒否する。

取消後の再受諾と新規支払い証拠は409で拒否し、有料権限を復活させない。
取消前に保存した同じ署名イベントの再送は冪等に受け付ける。
更新日・支払済み期間・返金残額・export期限の正本と、それに基づく
有料権限の付与と失効は引き続き別の未完工程である。

- 支払いプロバイダ連携を実装する。今回の native 部品は外部 HTTP や決済を呼ばない。
- 契約、見積受諾、増席、減席、解約の DB 永続化を実装する。
- 解約後の実データ書き出し許可、認可、監査ログ、期限切れ処理を DB 側で実装する。
- 終了後30日の書き出し猶予が、本人確認・所属・所有者・鍵アクセスの復活にならないことを API で検査する。
- 単独所有データ削除、共同データの所有者移管、削除保留、復元不能化を実装し、契約表示と同期する。
- 重複請求や当方不具合による未提供期間の返金処理を別アダプタで実装する。
- 購入前表示、規約、特定商取引法表記、問い合わせ導線、法務レビューを完了する。
- M8-D または原22条件の完了は、この文書と native unit test だけでは主張しない。


### Sandbox 支払い期間の台帳（テスト証跡）

署名済みの Stripe sandbox の支払いイベントを初めて受理したとき、`commercial_paid_periods` に 1 行を記録する。開始日はイベント時刻を JST（UTC+9）の暦日にしたもの、終了日は native の `renewal-preview` が返す次の更新日である。この JST の対応は、テスト証跡の期間を決めるための仮定であり、商用契約の発効日・時刻の正本ではない。実契約の発効日と時刻の対応は、本番の課金経路を実装するときに別途決める。

- 期間の識別は、プロバイダアカウントとイベント ID の組、およびアカウントと PaymentIntent の組で一意とする。同じイベントの再送は期間を増やさない。別のイベント ID で同じ PaymentIntent が届いた場合は 409 とする。
- 行は `provider_test_sandbox` の証跡だけを許可する制約を持つ。`paid`、`entitlementsGranted`、`entitlementEffective` は常に false で、この台帳から有料権限を付与しない。
- 取消済みの契約への新規支払いイベントは409。検証済みsandbox返金は後節に従い既存支払いへ結び、その他の未対応イベントは400とする。これは本番返金、契約終了後の自動削除や販売開始の完了ではない。

- 一意インデックスは起動時の移行で作る。既存の DB に同じアカウントと PaymentIntent の行が複数あると移行は失敗するため、導入前に重複が無いことを確認する（本番の台帳は導入前は空）。この変更より前に保存されたイベントの再送では期間行を補わない。期間の金額は、受理した見積の月額と一致したイベントだけが記録するため、台帳側には別の金額制約を置かない。


### live 支払い証跡と権限状態（受け口は既定で閉鎖）

live の支払い証跡は、sandbox 台帳とは別のテーブル（`commercial_live_contracts`、`commercial_live_periods`）と別の受け口（`POST /api/commercial-events/stripe-live`）で扱う。受け口は `PASSSHARE_COMMERCIAL_LIVE_ENABLED=true`、live の署名 secret、live のアカウント ID、有効なendpoint scopeがそろうまで 503 を返す。これらの設定は販売開始の承認とは別で、この変更では有効にしない。

- 契約の起点日は、最初の live 支払いの JST 暦日とし、以後の更新日は毎月その日（存在しない月だけ月末）とする。承認済みの「契約日と同じ日を毎月の更新日とする」を、最初の支払日からの周期として実装した解釈である。見積の受諾日とは別の日付で、契約画面には起点日を表示する。
- 期間は起点日と周期番号から native の更新計算で決める。入金の到着時刻や到着順では動かさない。周期 N は周期 N-1 が記録済みのときだけ受理し、先着した場合は 409 としてプロバイダの再送を待つ。同じ周期の別の支払い、同じ PaymentIntent の別イベント、内容が変わった再送は 409。
- 有効な権限になるのは `provider_live` の期間だけ。sandbox の期間は `test_evidence_only` で、権限は常に false。期間は JST の暦日で `[開始, 終了)` の半開区間、日付はサーバーの時計で判定する。
- 期間末解約は所有者だけが予約でき、支払済みの最終日まで利用できる。この要求は内部の解約予約であり、プロバイダの定期課金を停止したとの確認ではない。解約後に成立した課金や時刻の前後が確定できない支払いは捨てず、`refund_review` として保存する。同じイベントの再送は冪等で、有効期間には含めない。本人だけが `GET /api/commercial-contracts/:id/payment-exceptions` で金額・PaymentIntent・周期を照会できる。返金は未実行と明記し、実返金・プロバイダ解約連携が整うまで販売は有効にしない。支払済みの契約は、未払い受諾の撤回では取り消せない。
- 契約終了後 30 暦日の書き出しは、サーバー側の日付で窓だけを判定する。API は `proposalOnly:true`、`windowOpen` と `authorized:false` を返す。所属や鍵のスコープを検証したことにはせず、実データの書き出し認可を付与しない。
- `PASSSHARE_STRIPE_LIVE_ENDPOINT_SCOPE` は署名secretを取得したendpointの種類に合わせる。省略時は既存互換の `connect` とし、署名済み `event.account` と設定accountの一致を必須にする。`direct` は [Stripe の Your account scope](https://docs.stripe.com/connect/webhooks) に対応し、`event.account` が省略またはnullの形式だけを認め、設定済みaccountへ記録する。endpoint・専用secret・accountが同じ所有アカウントに属することを設定時に確認し、利用者の本文からscopeを選ばせない。不明なscopeは503。いずれもEventとPaymentIntentの `livemode:true` を要求し、sandbox通知を有料権限へ昇格しない。
- 初回導入費用のある見積は対象外で、月額JPYと支払額が一致するものだけを受理する。
- 減席の次回更新は後節の保存・署名支払い経路で扱う。実返金と重複請求の解消、30 日後の単独データ削除、製品機能ごとの有料制限（提供機能は技術検証後に確定）は未実装。増席は次節の経路で扱う。

### 増席の保存・同意・支払い待ち・適用

契約所有者は `POST /api/commercial-contracts/:id/seat-quotes` に
`requestId`、`requestedPlan`、`roundingPolicy` を渡す。
現在のプランは契約正本（未変更なら受諾済み見積）、期間は有効な支払済み期間、
変更日はサーバーのJST日付から取得する。利用者が現在プラン・期間・時刻・金額を指定することはできない。
既存のnative計算で残日数の分数と金額を表示し、丸め方も見積へ含める。
`none`の場合は厳密額が整数JPYになる支払いだけを受理する。暗黙の丸めや料金変更は行わない。

同じ要求ID・同じ見積の再送は同じ番号を返し、異なる内容は409。
`POST .../seat-quotes/:change/accept` に保存済み見積ハッシュを渡して初めて
`accepted_unpaid` になる。同意しただけでは現在プラン・席数・Box所属・鍵を変更しない。

閉鎖既定のlive受け口で、署名・account・JPY・所有者・契約・見積・周期・金額を照合する。
同意済みで現在の日付・期間・契約版が一致するときだけプランと席数版を同一トランザクションで更新する。
同じ署名イベントは再送しても1回分、他プラン変更後の旧見積は再適用しない。
期間台帳と増席台帳で同じPaymentIntentまたはイベントを二重消費しないよう識別子を排他する。
更新の月額は適用済みの現在プランから算出し、過去の支払い再送は過去の署名内容で冪等に受け付ける。

同意後に日付・期間・版が変わってから届いた正規支払いは、権限を増やさず
`refund_review` として金額・イベント・PaymentIntentを保存する。
本人の `payment-exceptions` から照会できるが、実返金は実行していない。
core/selfhostの利用権、Boxの所属・所有権・鍵をこの課金処理から新たに付与・剥奪しない。
減席は増席経路では拒否し、次節の独立した次回更新予約で扱う。

### 減席の次回更新予約と支払い

所有者は `POST .../:id/seat-decrease-quotes` に `requestId` と `requestedPlan` を送る。
保存済み契約・現在の有効な支払周期・現在の席数から、次回更新日、減席後の月額、
変更しない保守料金、現期間の返金0円を計算し、見積ハッシュと基準の席数版を保存する。
現在のプランと席数版は変えない。同じ要求IDの別内容は409。
`POST .../seat-decrease-quotes/:change/accept` でそのハッシュへ明示同意して予約する。
同じ同意の並行・再送は冪等で、新しい予約への同意は古い予約をsupersededにする。
古い予約の再同意、基準版・周期・期間が変わった見積は409。SQL待機後もDB時計の期間を再確認する。
見積・予約の閲覧はその本人の現在有効なsessionだけに限定する。

次周期の検証済みlive支払いには通常の契約・所有者・契約見積・周期に加え、
`seatDecreaseId` と `seatDecreaseQuoteHash` が必要。保存された同意、JPYの正確な金額、
契約anchorから導出した開始日、周期、基準版を一致させて初めて、支払周期の `billing_plan` と
予約への参照を同じトランザクションで保存する。予約はfundedとなる。
通知が早く届いても現在の支払周期の席数を減らさず、サーバーのJST日付が次周期に入ると
その周期の保存済みプランを返す。現在周期で別途支払済みの増席もその周期にだけ合成する。
旧 `current_plan` は更新要求のプランとlegacy周期の補完に保持し、前払い済み周期を遡って書き換えない。

同意済みでも予約がsuperseded・版や対象期間が不一致となった支払いは、
`commercial_plan_payment_exceptions` に金額・イベント・PaymentIntent・元の見積参照を保存する。
支払済み期間や席数へは加算せず、本人向けの `payment-exceptions` に返金確認が必要と表示する。
減席の同意・ハッシュまでは一致した検証済み支払いの金額不一致も、実受領額を例外台帳へ保存し、
サービス期間へ加算しない。署名済みの成立済み資金をHTTPエラーだけで捨てず、再送は冪等に確認扱いとする。
同イベントの再送は冪等で、期間・増席・例外台帳のイベント／PaymentIntent競合は同じロック順で409。
これは返金の実行ではない。既に次周期が入金済みなら新しい減席予約の受諾ではなく請求調整が必要で、
差額の実処理は引き続き未達である。

受信順だけで予約置換より前の正当な支払いを無効にしない。署名対象の成功秒が保存済みの
置換・追加成立の秒より明確に前で、元見積・契約・周期・金額が一致する場合は
historical_fundedとして元の支払期間を保持する。旧予約への再同意は409のままで、
現在の新しい要求はsettlement_reviewへ分ける。同秒や旧時刻不明は自動的に旧予約を復活させない。
旧形式の請求が、同じ契約の既知の旧周期・支払済み追加のプランへ金額上も一意に一致する場合も、
既払期間を失わせずbilling_adjustment_reviewとして保存する。新しい価格を勝手に請求したり、
差額を返金済みと扱ったりしない。Boxの所属や鍵を復活させるものでもない。

増席成立は、所有者の同意と署名付き入金の両方が満たされた時点である。
`commercial_seat_changes.provider_event_created` に検証済み成功秒を、受信日時や同意日時とは別に保存する。
同意済みでも未払いの増席は、その実入金より前に成立した減席支払いを無効にしない。
旧行の成功秒NULLを同意・受信日時で埋めず、確実な順序を証明できない場合は確認扱いを維持する。
増席が支払いまで適用された場合、未入金の旧減席予約はstaleへ移し、現在有効な予約と表示しない。
旧行にscheduledが残る場合も、保存された基準版と現在の版が異なれば読取結果はstaleを示し、
再同意は409。同じ版での通常の再送は冪等にする。これより前に成立した支払いの歴史的照合は保持する。

予約・支払例外と期間の参照は契約scopeをDB外部キーでも一致させる。
復元fixtureは実API同意・署名付き更新・旧予約支払いの例外を非空で作り、全行を比較し、
復元後の金額・期間・プラン・元契約参照と退会cascadeを再確認する。
検証は隔離DBの署名fixtureであり、実課金・本番有料権限付与・販売開始ではない。
Boxの所属・鍵・core/selfhostの利用権をこの料金経路で変更しない。

### 契約に紐づく実暗号文の書き出し

`GET /api/commercial-contracts/:id/export/boxes/:boxId/state` で現在の
`keyEpoch` と `snapshotRevision` を取得する。以後の取得には `epoch` と
`revision` を指定し、変更があれば409として先頭からやり直す。

- `.../items`: 最大10件・暗号文合計4MiBまでの実envelopeとnextCursor。
  `after` は前の応答のcursorだけを利用する。添付本体は別取得。
- `.../items/:itemId/attachment-snapshot`: 同じsnapshotでのitem envelope。
- `.../items/:itemId/attachments/:attachmentId`: 指定itemに属する実添付envelope。

これは期間窓だけの提案とは別の経路である。現在の契約所有者セッション、
有効な支払済み期間または終了後30暦日の窓、現在のBox所属・共有鍵を検査する。
Box→本人/session→契約の順でロックし、既存nativeが生成するSQLでデータ範囲を再認可する。
ロック待ち後も失効・取消・鍵epoch・snapshot版を確認し、応答確定前に期間とsessionを再確認する。
請求管理者の資格だけではBoxへ入れず、書き出し期間は所属や鍵を復活させない。

応答は暗号文のみで、パスワードや復号鍵を取り出さない。所有者が独立して持つ鍵と
contextで復号・検証する。エラーは固定コードだけでSQLや秘密を反射しない。
既存core/selfhost/暗号化APIの利用権はこの追加経路では制限しない。
この経路はページごとの取得であり、クライアントの一括ファイル生成・永続監査台帳・
終了30日後の単独データ削除は別の未完工程として保持する。

共有`createCloudApi`の`getCommercialExportPage`は既存の認証transportでこのitem経路を取得し、
独立して取得したBox・key epoch・snapshot revisionを応答と照合する。最大10件のenvelopeを
検査し、異なるcontext・重複・逆順cursor・scope不一致を拒否する。WebのAPI入口とnativeの
既存CloudSessionから同じ処理を利用できる。暗号文のshape検査は復号成功ではなく、利用者が
既に保持する鍵・信頼済みcontextによる既存Core/worker検証を引き続き必要とする。
この接続だけで一括ファイル・添付の取得・全client UIの受入を完了とはしない。

共有clientの添付取得は`getCommercialAttachmentItemSnapshot`と
`getCommercialEncryptedAttachment`を同一の独立したrevision/epochで利用する。
親itemのversion/contextと添付ID/version/contentBytesを照合し、既存workerの
`decryptAttachment`へ親envelopeと両snapshot revisionを渡す。shape一致だけを
暗号認証成功とはせず、workerが認証した名前・全bytesを利用後に解放する。
実HTTP/PG/Coreと、模擬HTTPを使う実browser worker受入は別証拠として保持する。

既存の暗号化dump/restore受入では、復元再開を判断する現在の正本に商用契約・
支払期間・増席台帳も含める。復元先の契約期間が異なる場合は再開を拒否する。
同じ受入で復元後の所有者と残留メンバーが新export経路から全暗号文を取得し、
現在の鍵で復号一致すること、取消済みメンバーは拒否されることを検査する。
添付を含む別の実dump/restore受入では、復元した101件の添付から代表3件
（空の内容、任意バイナリ、Unicode名と本文）を商用exportから取得し、元の
暗号化envelope全列と、Coreで復号した名前・全バイトを照合する。親項目の
全フィールドと認証付き添付参照も比較する。他契約は404、現在のBox資格が
ない本人は403、30日窓終了後も403とし、拒否後に全添付が保持されることを
確認する。残る98件も同じarchiveの全行比較と通常添付APIで照合するが、
全101件の商用export、実provider決済、全クライアントUIの証明とは区別する。
この復元検査の課金状態は隔離DBの明示的なSQLfixtureであり、正規決済配送の
成功とは扱わない。署名受理は別のHTTP/PG受入で検査する。

### 解約前に成立した支払い通知の遅着

期間末解約の申込日時はDBの `cancel_requested_at` を保持する。
検証済み `payment_intent.succeeded` の署名対象 `event.created` を
provider成功イベントの発生秒として保存し、受信日時 `received_at` と区別する。
PaymentIntentを作った時刻や利用者の日時指定で支払い成立を代用しない。

解約秒より前の正当な更新分が後から届いた場合は、所有者・契約・見積・金額・通貨・
周期・直前周期の有効性を確認して有効な支払期間に含め、解約の支払済み終端だけを
単調に延ばす。解約申込自体を取消したり、新規の更新を予約したりはしない。
終了後30暦日のexport窓も、その正しい支払済み終端から算出する。

旧版で `refund_review` に分類した行は、元と同じ署名対象bodyの再送を検証した場合だけ
再分類できる。受信日時は保持し、provider秒と再照合日時・理由を別に保存する。
保存済みhashと異なるbodyやPaymentIntentの二重使用は拒否する。
旧行へ不明な支払発生時刻を移行処理で作らない。

provider秒が解約秒と同じ場合は前後の精度が足りないため
`payment_time_boundary_review`、解約後に成立した課金は
`payment_after_cancellation` として確認対象に保存し、自動で権限を付けない。
旧取消時刻不明・前周期未照合も別の確認理由にする。曖昧なケースのprovider照合・
実返金は未達であり、この修正で販売開始を許可しない。本人確認・所属・鍵を復活させない。

CIの既存PostgreSQL jobで商用HTTP検査全件をPG有効のまま実行し、
一般Backend jobのPG skipを成功証明へ流用しない。

支払済み終端の表示 `paidThrough` は将来分を含む最終の有効な支払期間末日を返す。現在利用中の周期末日は `currentPeriodEnd` と分け、前払い済みの次周期を表示から落とさない。

### 書き出しの非公開監査記録

成功した契約exportでは、実データを返す前に同じトランザクションで
`commercial_export_events` へ記録する。契約・実行本人・Box・操作種別・epoch・
snapshot版・対象ID・サーバー時刻だけを保存し、暗号文・復号鍵・パスワード・tokenは保存しない。
監査記録の保存が失敗した場合はデータ応答も失敗させる。記録はサーバーが認可して応答を
確定した証拠であり、ネットワーク配送や利用者による保存の完了証明ではない。

`GET .../export-events` は現在有効な本人sessionとその本人の契約だけを対象にする。
履歴取得も既存の契約トランザクションに含め、本人・session・契約を同じ順序で
共有ロックする。取得待ちの後に期限を再確認し、失効を空履歴の200として返さない。
取消・退会・契約削除はその読取りと直列化する。
第三者への公開を許可するものではなく、`Cache-Control: no-store` を返す。
receipt ID順で100件ずつ取得し、履歴にも秘密値を含めない。
契約・本人の削除時は外部キーで削除する。契約終了30日後の自動削除・法定保持条件の同期は
元の未完工程であり、この監査追加を新しい保存期間の約束にはしない。

### 公式sandboxの返金証跡と支払い正本の対応

既存の署名検証済みtest受け口は `refund.created`、`refund.updated`、`refund.failed` の
JPY Refundを扱う。公式の[Refund object](https://docs.stripe.com/api/refunds/object)と
[event types](https://docs.stripe.com/api/events/types)に従い、署名対象Eventの
`livemode:false` と既存direct/Connect account条件を使う。
Refund objectに `livemode` がないことだけで正規の配送を拒否しない。

元PaymentIntent・accountから既存sandbox支払いを特定し、契約・所有者・金額を
その保存済み正本へ結ぶ。Refund metadataやクライアント入力で契約を移さない。
元支払い未着は409で再送を要求し、成功していない返金を完了扱いにしない。
一つのRefund IDは一度だけ集計し、別の署名イベントによる更新と再送を別の
イベント台帳に結ぶ。[Webhookの順序仕様](https://docs.stripe.com/webhooks#event-ordering)に従い、
`event.created`、受信順、通知に含まれる自己申告だけでは現在状態を確定しない。
通知した状態の集合は `observedStatuses` として順序を付けずに保持する。

現在状態は、同じaccountの認証済みtest APIでPaymentIntentと返金一覧を読み直し、
mode、JPY金額、元支払い、返金ID・作成時刻・金額の一致を確認した場合だけ照合済みとする。
専用の `PASSSHARE_STRIPE_TEST_READ_KEY` はtestのsecret/restricted keyだけを認め、
live keyは使わない。必要なのはPaymentIntentとRefundの読取りであり、返金の作成は行わない。
固定のStripe APIへ公式SDKで照会し、全体5秒・一覧1000件の上限内で完全な一覧を確認する。
資格未設定、取得失敗、modeや結合不一致、一覧未完了なら `status_review`・確定額0を維持する。
旧schemaの現在状態・照合時刻は補作しない。

`pending`、`requires_action`、未照合は確定返金額へ加算せず、照合できた`failed` と `canceled` は
予約合計からも外す。署名済みの返金通知は受領済みの事実なので、並行合計が元支払額を
超えた場合も証跡を失わせず確認対象へ保存し、確定額へ加算しない。
返金実行前の上限判定や返金API呼出しは別の未完工程である。
`confirmedAmountJpy` は `statusCheckedAt` のAPI照合時点でsucceededかつ金額の矛盾がない
場合の集計であり、顧客の銀行への着金実証ではない。
正本・イベント・契約の複合FKを持ち、退会cascadeを復元fixtureでも確認する。

`GET .../test-refunds` は有効な契約所有者sessionだけに、非公開・no-storeで
100件ずつ返す。元の有効期間・席数・Boxの所属・鍵は変更しない。
GETの金額・受領時刻・`observedStatuses` は保存済みの通知事実で、現在状態とは区別する。
`providerStatus`・`confirmedAmountJpy`・`statusBasis`・`statusCheckedAt` は照合のprojectionであり、
reader未設定で起動した場合は、古い照合cacheがDBにあってもreview・0・unverified・nullを返す。
このGETは履歴やcache自体を書き換えない。reader設定時のcacheも最終照合時点のsnapshotであり、
その後の現在状態を保証するものではない。再照合POSTは新しいAPI読取りを試み、取得不能なら
cacheの資格を失効させるが、署名通知の台帳・元支払いの事実は消さない。
`POST .../test-refunds/:receipt/reconcile` は同じ本人認可・CSRF条件の下でAPI照合を再実行する。
本文は空オブジェクトだけを受け入れ、利用者が状態・取得資格・金額を申告する経路にはしない。
復元演習は検証image専用launcherから同じAPI factoryを起動し、外部providerだけを
private loopbackのHTTP simulatorへ置き換える。現在状態は通知と別に設定し、公式SDKの
認証付き読取りを経由して非空の照合済みcache・時刻・状態とjournalを作る。
launcherとsimulatorは本番imageへ含めず、report metadataにも実Stripeでないことを記録する。
この演習はAPI資格・状態値の保存と復元のテストであり、公式sandboxでの実配送・実照合は
別の受入で確認する。
これは公式sandboxの返金状態を受領する経路であり、返金APIの実行、live返金、
本番有料権限付与、販売開始、原M8全体の完了ではない。

### 支払い正本に紐づく返金申請の受付

`POST /api/commercial-contracts/:id/refund-requests` は、現在有効な契約所有者の
sessionで `requestId`、`paymentIntentId`、`amountJpy`、`reason` を受け取る。
所有者・金額・イベントhash・見積hashは保存済みの署名付き支払い正本から取得する。
対象は同じ契約の署名済みlive支払い1件へ一意に結び付くものに限り、
sandbox台帳を支払済みの根拠にしない。受け口の本番有効化は従来どおり別の操作である。
サーバーは月額期間、入金済みの増席（`applied` と `refund_review`）、減席等の
入金不一致を保存した例外台帳から対象を特定し、実際に記録された受領額を使う。
`paymentSource` はこの正本の区分を返す。同じPIが複数の正本へ該当して一意に
特定できない場合は409とし、利用者の申告で区分や参照先を選ばせない。
各区分は明示した非null参照と複合FKで元の契約・PI・受領額・イベントhashへ結び、
ほかの区分の参照はnullにする。既存の月額申請はID・指紋・受付日時を保って移行する。

理由は `duplicate_charge`、`service_unprovided`、`statutory_right`、`other`。
申請額は正の整数JPYで、対象の記録済み支払額以下とする。
[採用済み条件](commercial-packaging.md)を保持し、理由の受付だけで返金の法的な
可否を判断しない。自己都合の日割り返金を約束せず、重複請求・未提供期間相当と
法令上の権利を審査するための受付記録とする。契約終了後も有効な本人認証があれば
過去の支払いについて申請でき、終了後exportの期限やBox所属・鍵の復活へは結ばない。

同じ契約・requestId・内容の再送は同じ受付番号と日時を返す。並行処理は契約行で
直列化し、同じ番号で内容が変わる場合は409。所有者、支払い状態、承認済み額、
処理日時などを利用者が入力して変更する経路は設けない。
`GET .../refund-requests/:request` は同じ契約所有者だけにno-storeで返す。
行ロック待ちの後にもsession期限を確認し、失効した資格は401、他人の契約は404。

審査記録がない初回受付は `received`、`approvalGranted:false`、`approvedAmountJpy:null`、
`refundExecuted:false` を返す。記録済みの支払額は署名イベント当時の事実であり、
現在の返金可能残額の照会や返金承認ではない。申請の合計を実行済み返金へ加算しない。
担当者の審査・承認記録と現在残額照合は後述の経路で扱う。プロバイダへの返金API、
通知配送、実行時の上限確認は引き続き未達である。支払済み期間・席数・所有権・暗号鍵は変更しない。

受付は元支払い・契約・金額・イベントhashを複合FKで保持する。合成復元fixtureでは
非空の申請を正式HTTP経路で作り、全行・値・FK対応と退会cascadeを検証する。
この退会cascadeは現時点の架空データの挙動であり、有料契約の法定保存義務を
確定したものではない。保存期間を含む販売条件の受入は継続する。

### 返金申請の現在残額照合

`POST .../refund-requests/:request/reconcile` は現在有効な契約所有者のsessionと
空の本文を要求し、保存済みの申請・元支払い・契約・所有者・金額・見積hashに
結び付けて現在残額を照会する。月額期間と支払例外では契約の見積hash、増席では
元の増席見積hashを照合する。行ロック待ちの後はAPI呼出し前に、API待ちの後は
結果返却前に、DB時刻でsession期限を再確認し、
失効した資格へ結果を返さない。Box所属・鍵・支払済み期間を変更しない。

現在資格と支払いbindingを短いtransactionで取得し、DB接続と契約行ロックを解放してから
providerを照会する。同じ契約の並行照会が外部待ちで共有poolを占有しない。
返却後は新しいtransactionで現在session・所有者・申請指紋・元イベントhash・契約/見積と
支払いbindingを再取得し、変化があれば401/404/409で拒否する。照会結果の再利用や
読み取りの外に出したことによる承認・返金実行権限の省略は行わない。

Live読取りは `PASSSHARE_STRIPE_LIVE_READ_KEY`、既存のlive accountとendpoint scopeを
使い、test読取りとは別に構成する。providerへの呼出しはPaymentIntentとRefund一覧の
GETだけで、live mode、同じaccount/PI、JPY受領額、元の所有者・契約・見積を照合する。
一覧は最大10ページ・各100件を5秒の総期限内で読み、切れた一覧は残額0の根拠にしない。
資格なし・取得不能・不正な値・重複ID・未知status・不完全な一覧は
`qualified:false`、`statusBasis:status_review`、金額0、`checkedAt:null`を返す。
前回の成功結果や署名通知当時の額を、現在残額へ流用しない。

照合できた場合は `qualified:true`、`statusBasis:provider_api_live` とDBの確認日時を返す。
`confirmedRefundedJpy`はsucceeded、`reservedRefundJpy`はsucceeded/pending/requires_actionの
合計とし、failed/canceledは予約から外す。`availableRefundJpy`は元受領額から予約合計を
引いた観測値で、申請額がこの範囲にあるかを `requestAmountAvailable` に返す。
これは複数API読取りの観測結果であり、atomicな残額予約・法的な承認・返金実行ではない。
審査記録がない申請では `approvalGranted:false`、`approvedAmountJpy:null`を返す。
記録がある申請では初回受付の再送・本人のGET・残額照合の応答に最新決定を反映する。
いずれも `refundExecuted:false`を維持し、審査記録の `executionAuthorized:false`を返す。
実行経路では別途、現在権限・残額・冪等性を再確認する必要がある。

statusと一覧の扱いはStripe公式の[Refund object](https://docs.stripe.com/api/refunds/object)と
[List refunds](https://docs.stripe.com/api/refunds/list)を参照する。隔離DBと署名fixture、
private HTTP provider simulatorでこのAPIの正常・拒否・期限切れを検証する。
本番live資格の設定、販売有効化、実課金・実返金、法定保存期間の確定はこの変更に含めない。

### 返金担当者の審査記録

`PASSSHARE_COMMERCIAL_REFUND_REVIEWER_IDS`に明示した既存user IDだけが、
有効なsessionで`GET /api/commercial-contracts/refund-review/:request`と
`POST .../:request/decisions`を利用できる。未設定では403で閉じ、メールアドレスや
本文の自己申告、契約所有者であることだけでは担当者資格を取得しない。
この設定の失効は実runtimeへの反映と403の確認までを完了条件とする。

決定は`operationId`、`expectedRevision`、`decision`、`amountJpy`、`reason`だけを受ける。
`approved`は申請額以下の正の整数JPYと、重複・未提供期間・法定権利を確認した理由、
`declined`は0円と証拠不足または自己都合日割り返金対象外の理由を記録する。
これは担当者の判断記録であり、分類だけで法令上の権利を否定する自動判定ではない。
担当者は原申請の理由や署名付き支払い正本・見積hash・受付額を変更できない。

担当者と契約所有者の現在identityを固定順でロックし、担当者session・契約・申請を
取得してから期限を再確認する。承認のprovider待ちはDB接続と契約行lockを保持せず行い、
返却後に担当者資格・session・申請/元支払いbinding・決定版を新しいtransactionで再確認する。
この最終transactionで他の申請の
最新承認額と今回額の合計が残額を超える場合は409。契約行で直列化し、同一申請の
決定版競合は409とする。同じ操作ID・担当者・同じ内容の再送は元のIDと日時を返す。
過去の承認を再送しても最新決定を戻したり、現在残額や返金実行権限を再認可しない。

`commercial_refund_reviews`は原申請の指紋・契約・申請額へ複合FKを持ち、
決定・承認額・担当者・版・確認した残額・DB日時を保存する。申請者のGETには最新の
決定を返し、他人には公開しない。担当者削除時は履歴行を保ち担当者IDをnullとする。
申請/契約の退会cascadeは架空fixtureで検査するが、有料契約の法定保存期間の確定は別である。

`approvalGranted`は記録済みの審査結果を表し、`executionAuthorized:false`と
`refundExecuted:false`を維持する。外部providerとの複数読取りはatomicではないため、
実行経路では承認版・現在資格・現在残額・他の実行・同じprovider冪等キーを再検証する。
この変更は返金API、実返金、通知配送、販売有効化、Box所属/暗号鍵の変更を行わない。

### 公式sandbox専用の返金実行候補

`POST /api/commercial-contracts/:id/test-refund-operations` は明示した既存の返金担当者だけが、
署名検証済みsandbox支払いの契約・所有者・金額・元event hashと見積hashに結び付く承認を保存する。
同じoperationId・同じ内容は再送でき、内容変更や他の承認との合計超過は409となる。
別契約で同じoperationIdを同時承認した場合も、一方だけを保存し他方は409とする。
競合した応答へ別契約の操作内容を返さず、保存済み操作の金額・指紋・日時を保持する。
この台帳は `provider_test_sandbox` の別表であり、Liveの申請・承認記録や有料権限へ昇格しない。
本人と担当者は `GET .../test-refund-operations/:operation` で非公開・no-storeの状態を確認できる。

実行は `POST .../:operation/execute`。専用 `PASSSHARE_STRIPE_TEST_REFUND_EXECUTION_KEY` が未設定なら503。
`sk_test_`/`rk_test_` の資格だけを受け付け、Live資格はAPI呼出し前に拒否する。
現在の担当者sessionと契約bindingをロック後のDB時刻で再確認し、変更不能な承認内容を
`in_flight` としてcommitしてから、DB接続を保持せずproviderへ渡す。
外部通信前に公式SDKで同accountのPaymentIntent・Refund完全一覧を再取得し、test mode、
JPY受領額、所有者・契約・見積hashと現在残額を照合する。
providerへの操作は保存済みの額・PaymentIntentと決定指紋から作る同一冪等キーで行う。
同じ操作metadataを持つ返金が既に見つかれば、再作成せずその結果を照合する。

応答紛失は `uncertain` として保持し、成功と扱わない。結果の保存と、
外部待ち後のsession再認可を分け、失効した要求者へ結果を開示しない。
同じ実行中操作の並行送信は409、確認済み結果の再送は外部操作なしで同じ結果を返す。
[Stripe API v1の冪等キー保持期間](https://docs.stripe.com/api/idempotent_requests)を越える再実行を避け、
初回送信から23時間を過ぎた未確定操作は新しいPOSTを行わず、`POST .../:operation/reconcile` で
現在の同account・同paymentとoperation/decision metadataを持つ返金を読み直す。
状態不明・未着はそのまま保留し、別operationを自動発行しない。
過去の送信が未確定の操作は、後の見積binding不一致・残額不足・認可拒否だけでは
`rejected`へ確定せず、`uncertain`と予約額を保持する。今回送信できないことは、
前回も返金されなかった証拠ではない。元の操作に対応する正確なprovider結果が
確認できた場合にだけ、その結果へ遷移する。

この候補の受入は隔離HTTP/PGとprivate provider simulatorから始める。
公式sandboxの実配送・実API結果は別に確認し、同じ公式test accountと資格の正規出所を照合する。
test返金の成功をLive返金・販売開始・契約の有料権限付与としない。
共同所有権・暗号鍵・支払済み期間は変更しない。長時間実行中のクラッシュ後調停、通知配送、
法定保持/削除、本番Liveの実行承認と運用は引き続き完成条件として保持する。

#### 結果保存失敗と未確定操作の復元検査

返金APIの成功後にDBへの結果保存が失敗しても、commit済みの`in_flight`と
元の操作ID・決定指紋を保持する。再起動後の`execute`再送は409とし、
`reconcile`で同じPaymentIntent・操作ID・決定指紋・金額の結果だけを保存する。
照合済み結果の再送は追加のprovider POSTを行わない。結果不在・決定指紋不一致は
未確定のまま409とし、別の操作や新しい返金を自動発行しない。

隔離HTTP/PG検査ではprivate providerの成功後にDB triggerで結果保存を失敗させ、
API再起動後の照合と追加POSTなしを検査する。合成復元ではHTTP承認からSQLで
`uncertain`/`in_flight`を模擬し、実dump/restoreの全列比較、所有者GET、
不正metadata拒否、正確なprivate provider結果による照合を検査する。
いずれも公式Stripeの実返金・本番資格・有料権限を使う検査ではなく、
結果不在のまま長期間経過した操作の再送運用や通知・法定保持の完成は別に扱う。

### 本人の返金受付・審査履歴の再取得

`GET /api/commercial-contracts/:id/refund-requests`は、現在有効な契約所有者だけに
申請一覧と各申請の最新審査結果をno-storeで返す。受付番号を保持していない場合も、
再ログイン後に保存済みの契約から申請と判断を取得できる。担当者設定やprovider照会を
行う経路ではなく、過去の承認を現在残額や実返金の証拠へ変換しない。

順序は申請UUID昇順、1ページ最大100件で、次ページがある場合だけ最後のUUIDを
`nextCursor`へ返す。`after`以外のqueryや不正/重複cursorは400、他人の契約は404、
認証なし・失効資格は401。行lock待ち後にもsession期限をDB時刻で確認し、失効後に
空の成功や私的な履歴を返さない。ページ間の新しい申請/判断は各読取り時点の履歴として
扱い、全ページのtransaction snapshotは約束しない。通知配送・実返金・保存期間や
削除の完了は、この再取得APIで代用しない。

### 本人が明示した単独所有ボックスの削除受付

契約終了後30日の条件は[承認済み商用条件](commercial-packaging.md)に従う。
`POST /api/commercial-contracts/:id/data-deletion-requests`は、現在の契約所有者かつ
対象パスワードボックスの単独所有者が、再認証して一つの対象を明示する経路である。
課金管理だけでボックス所有権を取得せず、全ボックスの自動削除を開始しない。

本文は`requestId`、`boxId`、`quoteHash`、`expectedContentVersion`、
`expectedAttributeVersion`、`expectedStateRevision`、`expectedKeyEpoch`、
`confirmationBoxId`、`currentPassword`だけを受ける。暗号化されていない対象では
state revisionとkey epochを明示的にnullとする。確認Box IDは選択Box IDと一致させる。
日時、削除済みフラグ、他人のowner主張は受け付けない。再認証値と項目・添付本文は
受付台帳へ保存しない。

サーバーはBox→本人→session→契約の順でロックし、DB現在時刻で資格を確認する。
契約は期間末解約済みで、検証済み有料期間の終了日から30日が経過している必要がある。
sandbox台帳や未払い受諾を有料期間へ昇格しない。他の契約に有効期間・未来期間・
書出し猶予がある場合も保持する。現在の他メンバー、未解決招待、暗号化移行・rotationが
ある対象は拒否する。端末の`.pbox`、共同データ、他のBoxは対象に含めない。

受付は`pending`と版0を返し、同request IDと同内容の再送は同じ受付を返す。
契約・対象・入力が変わる再利用は409。他ownerは404、無資格は401、応答はno-store。
`GET .../data-deletion-requests/:request`で再ログイン／API再起動後にも状態を取得できる。

`POST .../:request/cancel`は`revision`だけを受け、実行前の受付を原子的に`canceled`へ
確定する。取消成功後は削除しない。`POST .../:request/execute`は`revision`、
`currentPassword`、`confirmationBoxId`を受け、期日・所有・session・資格指紋・
有料期間・Box版・暗号世代・項目と添付の内容指紋を再確認する。変化時は元データを
保持して409／401／403とする。成功時はそのBoxだけを削除し、同transactionで
`completed`と日時を保存する。完了再送は保存結果を返し、完了後の取消は409。
アカウント・他Boxの資格・会計契約・支払い／返金記録をこの処理で消さない。
対象Box作成の冪等記録は消すと古い要求で再作成されるため、元のscope識別子だけを
残す`deleted:true`の最小tombstoneへ変える。対象ID・作成結果指紋・要求内容指紋を
除去し、古い同scope要求は409にする。他Box・他ownerのscopeは変えない。

このAPI候補の利用側は認証済みHTTP経路であり、UI画面の追加・本人未確認の見た目変更を
含まない。隔離PG検査は署名fixtureとSQLで期間状態を構成し、公式StripeやPrd有料契約を
使わない。取消と実行、共有化・移管、期間延長、logout／資格期限・password変更を
実ロック待ちに同期して検査する。

元要件の自動期日処理は、受付で承認された対象を既存jobへ接続する次工程として残る。
自動実行の別候補では、`POST .../data-deletion-requests/schedule-due`に同じ明示Box・版・再認証を送って自動実行へ同意する。手動受付を自動対象へ変えない。支払済み期間末で解約が確定し、30日export窓に入った時点から受付でき、`notBefore`は正本の期間末+30日からサーバーが決める。受付中のlogoutはこの明示した将来処理を取消しない。password/recovery変更、所有・共有・内容・期間延長があれば実行せず元データを保持し、新しい同意を必要とする。取消endpointは既存と同じである。

既存backend起動に接続したworkerは最大20件ずつDB時刻で到来を確認し、保持された古い受付で後続が飢餓しないようcursorを進める。Box→本人→契約→受付をlockして現在の所有・共有・移行・内容・credential指紋・最新有料期間を再確認し、削除と最小journal/状態確定を同transactionで行う。資格fingerprintは受付内だけで扱い、passwordや鍵を保存せず、APIへ返さない。既存のcore/selfhost利用権や他Boxの鍵をbillingだけで変更しない。これはまだ別候補であり、独立レビューと正常・負例・競合・非空復元の最終受入前に本番自動削除済みとはしない。
共有・招待の変更後は、その取消で単独所有へ戻っても受付に残す失効時刻で旧同意を無効にする。passwordだけでなく回復キーの再発行も同意指紋を変える。処理中の1件でDB障害が起きた場合は対象を保持して失敗を記録し、次batchはそのIDの後へ進む。同対象は次の全周で再試行し、後続を永久に塞がない。closed復元先ではworker自体も実行を拒否し、復元準備はarchive時点の自動同意を失効させ、現在の所有者の新しい同意なしに再利用しない。
本人の受付GETは、共有失効時刻と現在のcredential指紋の違いから`requiresNewConsent:true`を返し、何も実行されないpendingと区別する。password/recoveryの値や指紋は返さない。
確定済み削除の最小journalと復元先への再適用は[復旧手順](../runbooks/completed-deletion-recovery.md)へ接続する。
最新削除台帳の独立保全、本番復元後の削除再適用の運用受入、法定保持期間・監査記録の
保持契約、全クライアントの表示／受入も未完である。受付台帳の退会cascadeは架空検査の
挙動であり、有料契約の法定保存期間を確定したものではない。本候補をM8全完としない。

契約添付consumerは`consumeCommercialAttachment`で親snapshotと添付暗号文を同revisionで
取得し、既存workerへ独立contextと両revisionを渡す。保存callbackは必要bytesを処理中に
コピーし、返却後に保持しない。成功・保存失敗・取消しの全経路でworkerの解放を行う。
このcallback接続は一括archive形式や全client UIの提供完了を意味しない。
consumerの一括走査は既存30回/分制限を変更しない。429となったGETのみ61秒待機して
最大1回再送し、配送済み保存callbackは再実行しない。待機中も取消し可能とする。
保存callbackが失敗した場合は呼出元が部分出力を未完了として扱い、完成を示さない。
保存callbackは取消signalを受け取り、取消時の書込み停止と部分出力の破棄を担う。
consumerは平文を即解放するがcallbackの終端までは完了を返さず、書込みの排出を待つ。
workerの5分idle期限は延長しない。`createCommercialExportProgress`の同snapshot記録を
保持して通常の鍵再解除後に再開でき、完了済みcallbackは再送しない。revision/epochや
契約/Boxを変えた記録の再利用は409で拒否し、資格・鍵・所属を復活させない。

#### 一括consumerの実行所有と保存確定
同一progressの実行は1件に限定し、GET待機・復号・保存callback・取消し後の排出まで
所有を保持する。並行再開は409。成功callbackの戻りを保存確定とし、その記録を取消し
検査より先に更新する。失敗・結果不明の保存を自動再送して最大1回を偽装しない。
保存先はcontext（item/attachment ID・version）とsnapshotで上書き/冪等に確定し、
成功した書込みを例外として報告しない。callback自身が保持した平文コピーや開始済み
外部I/Oをconsumerから強制停止することはできないため、両callbackにAbortSignalを渡し、
保存先が停止または確定結果を返すまでPromiseを終端しない。停止不能なら実行は未終端の
まま所有を保持し、別実行による二重保存を許さない。添付元bufferは取消し直後に消去する。
worker idleで中断しても権限・鍵を復活させず、通常再解除後に同snapshotの成功記録から再開する。
取消しは`signal.reason`（通常`AbortError`）で伝播し、snapshot不一致・並行再開の409と
区別する。fetch中の取消しも同じ理由へ正規化する。callbackが取消しを確定する場合は
成功returnせず同取消理由をrejectし、未保存分を成功checkpointへ含めない。

#### 出力先への保存と読み返し
`createVerifiedExportSink`は呼出元が選択済みのdirectory handleを使い、項目は安定ID/versionの
JSON、添付はitem/attachment ID/versionのbinaryと元ファイル名metadataへ保存する。
入力名をpathに使わない。同名既存出力は全bytes一致の場合だけ成功として再利用し、
違う内容は上書きせず拒否する。write/close後に同handleから全bytesを読み返してから成功を返す。
取消し・close失敗は成功にせず、writer abortとconsumerの排出契約を保つ。選択UI・権限取得の
画面操作はこのmoduleに含めず、実browser OPFSの受入と利用者選択directoryの受入を区別する。
