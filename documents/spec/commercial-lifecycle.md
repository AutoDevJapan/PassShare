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

増席は、同じ入力で得た `quote` を `acceptedQuote` にそのまま渡すまで決定扱いにしない。`acceptedQuote` が欠けている場合は `requires-explicit-acceptance`、内容が変わっている場合は `409 PS015` を返す。

#### `seat-decrease`

減席は現在の支払済み期間へは反映せず、次回更新日からの決定案を返す。現在期間の自己都合返金は0円として返す。

#### `cancel`

解約は支払済み期間の終わりまで利用を残す決定案を返す。違約金は0円、自己都合の日割り返金は0円。実際の解約保存は行わない。

#### `post-end-export`

契約終了日から30日以内の書き出し案を返す。ただし、これは本人確認、所属、所有者、鍵の権限を復活させるものではない。現在の本人確認・所属・書き出しスコープがあるという呼び出し側の検証済み主張が必要。

## actor 主張

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

`sessionValid: false` は `401 PS024`、削除済みアカウントは `403 PS061`、未確認本人は `403 PS062` で拒否する。請求操作で `billingAdministrator` が真でない場合は `403 PS063`、終了後書き出しで現在の所属または書き出しスコープがない場合は `403 PS064`。

## 数学ポリシー

- 金額は税込の最終支払額で、整数 JPY のみ扱う。
- すべての数量と金額は `u64` の安全整数範囲内で検査し、乗算・加算・差分は checked arithmetic で計算する。
- 小数、負数、文字列数値、未知値、必須値不足は拒否する。
- 月次更新は契約開始日の元の日を anchor day とし、存在しない月だけその月の最終日に丸める。丸められた日を次月の anchor にしない。
- 残期間見積は `additionalMonthlyJpy * numeratorRemainingDays / denominatorPeriodDays` を正確な分子・分母で返す。
- 丸め円額は `roundingPolicy` の明示がある場合だけ `proposedRoundedJpy` に分けて返す。丸めなしは `null`。
- 日付は calendar date のみで、タイムゾーン、時刻、日末表現はこの部品では選ばない。

## 未完の本番アダプタ・検収チェックリスト

- 支払いプロバイダ連携を実装する。今回の native 部品は外部 HTTP や決済を呼ばない。
- 契約、見積受諾、増席、減席、解約の DB 永続化を実装する。
- 解約後の実データ書き出し許可、認可、監査ログ、期限切れ処理を DB 側で実装する。
- 終了後30日の書き出し猶予が、本人確認・所属・所有者・鍵アクセスの復活にならないことを API で検査する。
- 単独所有データ削除、共同データの所有者移管、削除保留、復元不能化を実装し、契約表示と同期する。
- 重複請求や当方不具合による未提供期間の返金処理を別アダプタで実装する。
- 購入前表示、規約、特定商取引法表記、問い合わせ導線、法務レビューを完了する。
- M8-D または原22条件の完了は、この文書と native unit test だけでは主張しない。
