# アカウント鍵の保存API

実装中。親 ToDo 1163 / 1175 の M4 に渡す有限の実装であり、ビルド・受け入れ確認・別モデルのレビュー・CI は **NOT RUN**。公開や UI の変更を認可する文書ではない。

## 接続と実行前の条件

本ブランチの基点は `4a8b455`。親担当が `backend/src/encrypted/account-identity-router.js` に通信アダプターを置き、`backend/src/app.js` で既存の暗号化ルーターより先に接続しました。Connectの `/v1` には接続しません。

追加ルーターは既存の `PASSSHARE_ENCRYPTED_STORAGE` が `true` のときだけ対象ルートを作ります。無効ならルートは存在しません。対象パス内だけに認証と制限を適用します。スキーマは既存の暗号化ルーターの準備で一度だけ導入します。アダプターを単独で作る場合は既存の導入ロックを使います。DBがないアダプターは503を返し、既存アプリ全体もフラグ有効時にDBとnativeが無ければ起動を拒否します。実際の受入は未実行です。

PostgreSQL と native サービスが必要。既存のスキーマ導入ロック `4820124` を使い、既存のログイン制限ストアを注入する。新しい依存、Go サービス、暗号方式、production native の Core 依存は追加しない。料金・UI・公開方針は変更しない。

## 保存する公開 JSON

`PublicAccountIdentity` は既存 Core の次の形式だけを受け入れる。

```json
{"accountId":"11111111-1111-4111-8111-111111111111","identityVersion":1,"publicKey":"<canonical padded Base64 of 32 bytes>","keyId":"<lowercase SHA-256 hex of those 32 bytes>"}
```

暗号化した identity bundle は、次の形式だけを受け入れる。

```json
{"format":1,"salt":"<16 bytes Base64>","wrapped":{"format":1,"context":{"accountId":"11111111-1111-4111-8111-111111111111","identityVersion":1},"nonce":"<24 bytes Base64>","ciphertext":"<48 bytes Base64>"}}
```

すべてのオブジェクトを native Rust で手動検証し、未知のフィールド、秘密鍵、未暗号化の鍵、パスワード、平文、KDF 設定を受け入れない。版番号は JavaScript の安全な整数の範囲に限る。Node の JSON 解析・再符号化は `1.0` のような整数値を `1` に正規化する。native 単体は浮動小数の表現も拒否し、HTTP の拒否確認には小数部分がある値を使う。Base64 は標準アルファベット・必要なパディング・再符号化一致を要求する。公開キーは X25519 の標準座標表現（最上位ビットなし、`2^255-19` 未満）を要求する。低位数の点に対する DH 拒否は既存 Core HPKE の責任である。

body 内の accountId はすべて、セッションから確定した本人の正規化済み UUID と完全一致しなければならない。初期の identityVersion は 1 のみ。整った別の identityVersion への変更は 409。accountId の不一致や構造の不正は 400。

## 本人の GET / PUT

| 操作 | 要求 | 成功 |
| --- | --- | --- |
| `GET /api/encrypted/account-identity` | 本人の有効なログインセッション。body と query の指定なし | `{"bundleVersion":n,"identity":PublicAccountIdentity,"bundle":IdentityBundle}` |
| `PUT /api/encrypted/account-identity` | `{"expectedVersion":n,"identity":PublicAccountIdentity,"bundle":IdentityBundle}`。n > 0 は body 最上位に `currentPassword` を追加 | 保存した完全な `{bundleVersion,identity,bundle}`、200 |

本人の GET には他人を選択する機能がない。未作成は 404 / PS012。Connect トークンはログインセッションの代わりにならない。Cookie による PUT は CSRF を要求し、mobile / extension という自己申告では省略しない。

初期作成は expectedVersion=0 から保存版=1。保存版=1 の同一 identity と同一 bundle を expectedVersion=0 で再送した場合だけ、200 を返して何も書き換えない。行・xmin・時刻も変えない。異なる初期内容は 409 / PS015。初期作成には認証用フィールドを付けない。

expectedVersion > 0 の再保存では既存所有者キーと同じログインパスワードの再認証を行う。共有のログイン制限・失敗回数制限を使い、Node が検証したログインハッシュの SHA-256 スナップショットだけを SQL に渡す。実パスワードと Argon2 ハッシュは native に渡さず、bundle にも保存しない。SQL はユーザー行とセッション行をロックして現在のハッシュと照合する。

通常の更新は保存版が expectedVersion と一致する場合にだけ +1。公開記述全体は不変で、更新するのは bundle のみ。同じ鍵を、ログインパスワードと独立した別の暗号化パスワードで包み直せる。通常更新には初期作成の再送特例を適用しない。古い版は 409 / PS015、不正な再認証は 401 / PS026。DB 障害は内容を露出せず 503。拒否・競合・失敗では保存行を保つ。204 を返して成功したようには見せない。

## 共有相手の公開情報

`GET /api/encrypted/boxes/:boxId/member-identities/:accountId` は `{"identity":PublicAccountIdentity}` **だけ**を返す。相手の bundle、salt、nonce、ciphertext、email、保存版は返さない。

boxId は正規の26文字 ID、相手の accountId は小文字・非零の UUID。要求者と相手の両方が、現在同じパスワードボックスで確認済みの参加者であり、相手のアカウントが存在する必要がある。所有者は既存の規則で確認済みとなる。自称メールアドレスによる未確認の互換参加状態は権限にならない。確認済みでも、暗号化保存が有効でないパスワードボックスは 409 / PS055。未参加・未確認・削除された相手は 403 / PS016、公開情報が未作成なら 404 / PS012。

SQL はパスワードボックスの親行、ID 順のユーザー行、要求者のセッション、ID 順の参加行をロックする。待機後にセッションの期限と現在の参加状態を再確認し、過去の所有者・削除済み参加者の権限を復活させない。本人の GET / PUT は独立したユーザー行とセッション行だけをロックし、パスワードボックスのロックを後から取らない。identity 行は users の削除に連動して消え、別のユーザーの行には影響しない。

## クライアントが保持する信頼

サーバーが検証するのは公開形式、本人の文脈、公開キーと keyId のハッシュ一致、および保存の権限だけである。サーバーは鍵を持たず、AEAD や「暗号文中の秘密鍵が公開キーに対応すること」を検証できない。

クライアントは、独立して保持する account context と信頼済みの fingerprint を Core `AccountIdentity::unwrap` / WASM `CloudAccountIdentity::unlock` に渡し、復号後の公開情報の一致も確認する。サーバーから受け取った公開記述や、参加の確認完了だけを fingerprint の暗号学的な信頼の根拠にしない。

identity の鍵交換は、後で共有権限と epoch を同時に更新する仕組みが必要なため未対応。公開キー・keyId・identityVersion の任意の差し替えを成功させない。既存の秘密 identity と信頼済み fingerprint を保持する。identity の秘密鍵の復旧、共有鍵の配布、新しい復旧経路も実装していない。

## 親ジョブで実行する受け入れ確認

`tools/encrypted-storage-acceptance` の先頭に値を持たない `--account-identity` を付ける。後続は従来の native バイナリ指定または `--image <image>`。指定がなければ従来の確認内容を保つ。親の PR 681 の `--go-session` とは別の入口として統合する。

この入口は新しい DB / network で3人だけ登録し、既存 Host / Database / Core の補助処理を使う。実際の本体のルートが接続されていなければ、最初の PS012 確認で失敗する。未接続の 404 を成功とは数えない。

確認コードを実装した項目:

- Core が生成した identity を保存・取得し、元の master/context/fingerprint で unwrap。独立した暗号化パスワードへの包み直し、元の秘密 identity の保持。
- 認証・Connect 拒否・Cookie CSRF・未知フィールドの各階層・正しい下位形式を持つ座標不正・文脈不正の拒否。
- 初期の完全再送における xmin / 時刻を含む保存行の不変、異なる初期内容の拒否、公開情報の差し替え拒否。
- 誤ったログインパスワードの拒否、正しい再認証、古い版の拒否、異なる bundle を使う同時 CAS の成功1件・競合1件。
- 明示的な合成 AFTER UPDATE 障害でのロールバックと、本人の PUT・共有相手の GET の実際の SQL 待機を DB で観測してから合成セッション失効を確定させた際の 401 と保存行の不変。
- 実際の招待作成と、所有者が得た確認コードを使った accept API（この基点ではこれが確認処理）。未確認状態の SQL 作成は合成の拒否確認だけに使う。
- 公開情報だけの共有取得、第三者・未確認参加者・参加削除後の拒否、実際の所有権譲渡と参加削除。
- 実際の退会 API で B の行だけが消え、A の行が残ること。古い B のセッションの拒否、ホスト再起動後の保持、フラグ無効時の拒否。

平文の不在を調べる文字列は合成の sentinel だけを使う。秘密の seed の取得や DB への秘密の書き込みは行わない。SQL による障害注入とセッション削除は合成条件であり、API が起こしたこととは扱わない。既存の SQL 出力上限・期限・子プロセスの終了処理を使う。

実際のビルド、上記受け入れ確認、記憶領域だけのホストでの 503、別モデルによるレビューと CI は親ジョブが実行する。本実装ジョブではいずれも実行していない。
