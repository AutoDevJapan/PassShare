# CLI の暗号化モード

originalToDo1163 / M4 の CLI 接続部分です。製品全体・全クライアント・M4 の完了は示しません。
実装は `crates/op-cli/src/encrypted.rs`。既存 Core と Rust Connect SDK を使用します。

## 対応する操作

`op --encrypted` を明示した場合だけ、現在有効なセッションを使います。
`item list/get/create/edit/delete`、`read`、限定された `vault list`、`item retry` が対象です。
共有受信者は `--recipient --secret-stdin` を併用し、後述の有限な読取だけを行います。
コマンドの `vault` / `--vault` は op 互換の綴りであり、指す対象はパスワードボックスです。
暗号化モードの指定がない場合は、従来の Connect API の操作を維持します。

暗号化モードの `--vault` と項目の位置引数は、それぞれ26文字のボックスID・項目IDを要求します。
名前・タイトルからの検索は提供しません。`read` も `op://<box-id>/<item-id>/<field>` です。
`vault list` は `--password-box <box-id>` または `PASSSHARE_PASSWORD_BOX` で指定した1件の
IDと鍵世代だけを表示します。セッションAPIによるアカウント全体のボックス発見機能は未提供です。
`item list` は現在のメタデータから項目IDと保存版だけを表示し、タイトルや秘密値を表示しません。
平文を標準出力へ表示するのは、利用者が明示する `item get` と `read` です。

## 入力と通信の境界

接続先は `--passshare-host` または `PASSSHARE_HOST` です。
セッションは `PASSSHARE_SESSION_TOKEN`、暗号化パスワードは `PASSSHARE_ENCRYPTION_PASSWORD` から
明示的に渡せます。操作本文は `PASSSHARE_INPUT_JSON` から渡せます。この本文には認証情報を入れません。
より推奨する入力は `--secret-stdin` です。パイプから単一のJSONを読み、次の最上位キーだけを受け付けます。

| キー | 内容 |
|---|---|
| `sessionToken` | ログインで取得した現在のセッションBearer。Connectトークンではない |
| `encryptionPassword` | 所有者バンドルを展開する暗号化パスワード。ログインパスワードとは別 |
| `item` | 作成時の全項目JSON。`title`、対応する大文字の`category`、`fields`配列が必要 |
| `selectedFields` | 編集するフィールド名・IDと文字列値のオブジェクト。`title`も選択可 |
| `preparedWrite` | 明示的な再送時に渡す、準備済みの不透明な要求 |
| `sharedReceive` | `--recipient` の独立した信頼入力。所有者の操作では拒否 |

標準入力を選んだ場合、環境変数の認証情報は補充しません。端末からの直接入力は、入力値が表示されるため拒否します。
入力JSONは2MiBまで、認証情報の文字列は各16KiBまでです。Coreの平文上限1MiBがBase64の暗号文に
なる際の増加も、再送用入力として収まる上限にしています。ファイルから認証情報を読み取る機能はありません。
暗号化モードでは作成・編集の秘密値やタイトルをコマンド引数に入れられません。作成のcategoryもJSONに含めます。
秘密値は履歴に残るシェルのリテラルで作らず、利用者側の秘密管理ツールからパイプまたは環境変数で渡してください。
環境変数の機密性は利用者の実行環境に依存し、安全な永続保管をこのCLIが提供するものではありません。

`OP_CONNECT_HOST` / `OP_CONNECT_TOKEN` はこのモードで使いません。Connectトークンを自動取得・転用しません。
暗号文の送受信は `EncryptedSessionClient`、版付きメタデータの取得は `SharingRotationClient` を使います。
SDKにまだ公開されていない `/api/auth/me` だけは、CLI内のGET専用処理で取得します。
最初にSDKで接続先とトークンを検査し、このGETにも接続10秒・要求30秒、proxy不使用、redirect非追従、
16KiBの応答上限を適用します。HTTPはリテラルのloopbackだけです。TLS検証を無効にせず、curl等への代替経路はありません。

## 期待条件と損失のない編集

1. `/api/auth/me` の現在利用者IDを確認します。
2. ボックス状態と所有者用の共有メタデータを取得し、所有者ID・鍵世代を照合します。
3. メタデータの所有者バンドル版に対して、取得したバンドル版を照合します。
4. この独立した期待条件をSDKとCoreに渡し、固定のArgon2id設定で鍵を導出してバンドルを展開します。
5. 同じ変更番号で一覧・項目を取得し、項目ID・保存版・鍵世代を確認してCoreで復号します。

現在利用者IDの取得元は `/api/auth/me` の `user.id` です。サーバーの
`backend/src/auth/router.js` は、現在のセッションで利用者を検索し、`toPublicUser` で
`users.id` を公開応答へ写します。このUUIDは利用者の識別子で、認証用Bearerやパスワードではありません。
CLIは `SubjectReply { user: SubjectIdentity { id: Uuid } }` だけをデシリアライズし、
メールアドレス・作成日時・未知のプロフィール属性を持つJSON全体をコピーして保持しません。
所有するID文字列は `Zeroizing<String>` で解放時に消去し、正規表記かつnilでないUUIDだけを保持します。
必須の `user`・`id` の欠落、型違い、重複は拒否します。
内部では公開の利用者を指す `live_subject`・`subject_id` を使い、金融口座を連想する名前を避けます。
所有者の期待条件にはこの型付きIDを渡し、共有メタデータとの照合時だけ公開文字列へ変換します。

公開の保存先IDは、利用者が指定したボックスIDを検証した `ConnectId` です。
`Session.box_route` に保持し、`box_id()` はこの保存先を読みます。
所有者の暗号処理に必要な `OwnerKeyContext.password_box_id` には、同じ検証済みIDの複製を渡します。
取得元は独立したコマンド入力であり、鍵やバンドルから保存先を抽出しません。
通信とCoreの `passwordBoxId`・`ownerAccountId` の契約は維持します。

2026-10-10の既存SARIFでは4件が残り、`live_account` の返すIDからセッション全体、
SDKの接続先URL、公開メタデータへ解析が広がる経路と、所有者の期待条件から保存先IDを読む経路を示しました。
[CodeQLの判定実装](https://github.com/github/codeql/blob/main/rust/ql/lib/codeql/rust/security/SensitiveData.qll)
は関数・変数・フィールド名から機密性を推定します。UUIDへの変換だけで解析が止まるとは扱いません。
今回の型と保持先の分離は上記の取得元に基づく設計修正です。出力方法・通信契約・検査条件を変えず、
クエリの抑制や解析を止めるためだけの型は加えません。新しいSARIFの結果は親担当が別途確認します。

期待する所有者・保存先・鍵世代・バンドル版を、暗号化バンドルや利用者のファイルから採りません。
共有相手の公開鍵をサーバーの返答だけで信用する処理もありません。
APIは要求ごとにセッション・所属・所有者・世代・項目版を再確認します。
読み取り中にメタデータが変われば、変更番号付きAPIで競合として拒否されます。

作成は、渡された全JSONを保持して新しいID・保存版1・ボックス参照を追加します。
利用者が作成JSONにID・版・ボックス参照を指定することは拒否します。
編集は取得した全JSON上で選択した値と保存版だけを変更します。選択しないフィールド、
sections、urls、tags、favorite、未知の項目・フィールド属性を保持します。
タイトルは `item.title`、フィールドIDの明示指定は `field:<id>` です。読み取り・参照・編集で同じ
指定を使います。通常の `title` は、IDやラベルがtitleのフィールドと衝突する場合、変更前に拒否します。
`password` / `username` は目的で検索し、他はラベルまたはフィールドIDで検索します。
存在しない選択、複数に一致する選択、同じフィールドを二重に選択する入力を拒否します。
生JSONの同名キーは、エスケープ解決後・全階層で変換前に拒否します。最後の値で置き換えません。
暗号化パスワードはWASMと同じNFC正規化と、形式1固定のArgon2id（64MiB/3/4）を使います。
正規化後の容量を先に確保し、所有する秘密値と任意JSONのキーを解放前に消去します。
暗号化はCoreのみで行い、通信にはSDKの期待保存版による比較更新を使います。

## 準備と明示的な再送

作成・編集・削除で `--prepare-only` を付けると、書き込まずに不透明な準備済み要求を標準出力へ返します。
このJSONには接続先・所有者・ボックス・世代・バンドル版・項目ID・期待版と暗号文だけを含めます。
利用者がこれを保持し、`preparedWrite` に入れて `op --encrypted item retry --vault <box-id>` に渡せます。
再送時も新しい認証状態とメタデータを取得します。準備済み要求は期待条件の供給元にはしません。
保存先・所有者・世代・バンドル版が変わった要求を拒否し、PUTはCoreによる復号検証も通してから送信します。
再送でIDやnonceを生成し直しません。作成・更新の完全一致の再送と削除記録の再送は、正式APIの契約に従います。
古い更新、異なる暗号文、削除済みIDへの再作成は409になります。

通常の作成・編集・削除も準備と送信を各1回行います。自動再送はありません。
通信失敗後に通常の作成をもう一度実行すると、新しい項目を作る操作になります。
応答が失われる可能性を扱う場合は、最初に `--prepare-only` で同じ要求を保持してください。
準備済み要求の保存や秘密情報の永続保管をCLIが自動で行うことはありません。

401は再ログイン、403は現在の所有者権限、409は項目版・鍵世代・メタデータの競合を示します。
サーバーのエラー本文、入力JSON、認証情報、秘密のフィールド値を診断へ出しません。

## 検査と未対応範囲

`cargo nextest run --locked -p op-cli -p passshare-connect` で検査します。
CLIモジュールの選択編集・入力エラー検査に加え、`src/encrypted_cli_tests.rs` の有限なloopback HTTPサーバーに
実際の `op` コマンドを接続し、実SDKとCoreで作成・取得・編集・削除・完全一致の再送を確認します。
401・403・409、所有者・バンドル版・世代・保存先の不一致、暗号文改変、全JSON保持、
秘密値の引数拒否、旧Connect設定の無視、診断の伏せ字も対象です。
検査用パスワードとsaltはCoreの乱数生成で独立に作り、バンドルには実際のsaltをBase64で保存します。
同じパスワードを検査サーバーと実コマンドに渡し、認証情報を失敗時の検査出力にも表示しません。
NFC検査はランダムな接尾部を持つパスワードで、合成済み・分解済みの両表記が復号できることを確認します。
利用者IDの不正値・非正規表記・nilの拒否と、公開メタデータの標準出力形式も検査します。
型付き応答では、未知のプロフィール属性を無視しつつ、必須属性の欠落・型違い・重複・末尾の不正JSONを拒否することも検査します。
正式Node/PostgreSQLと配布物の統合受入、全workspace検査は親担当の実行範囲です。

2026-10-10、利用者IDの型付き応答と公開保存先IDの分離後に、CLIの13検査（単体5件・実コマンド8件）と
SDKの43検査が `--locked` のnextestで成功しました。両クレートの全対象を確認する
`cargo clippy --locked -p op-cli -p passshare-connect --all-targets -- -D warnings` と
CLIの書式検査も成功しました。CodeQLの再解析・別モデルレビュー・CIの完了確認は親担当の範囲です。

CLI manifestはworkspaceの `uuid` を直接参照し、検査用にはworkspaceの `base64` を参照します。
今回の追加修正は `encrypted.rs` と関連検査・この仕様書だけです。
manifest・rootのCargo.lock・SDK/Core・他クライアント・出力用素材は変更していません。

所有者の既存操作と、次の受信者の読取だけが対象です。鍵更新の操作、受信者による書込み、
認証情報の安全な永続保管、オフライン操作、ログイン自体、移行・復旧、添付の変更操作、
全ボックスの発見は未提供です。他クライアントの実装状況をこの文書から推定しません。

## 共有受信者の有限読取

`--encrypted --recipient --secret-stdin` は `item list/get`、`read`、`attachment get` だけに対応します。
所有者の操作を自動的に受信者へ切り替えません。`vault list`、create/edit/delete/retry、
`--prepare-only` は受信者モードで通信前に拒否します。受信者の秘密入力はパイプだけです。
環境変数から信頼値や認証情報を補充せず、Connectへの自動切替も行いません。

最上位の入力キーは `sessionToken`、`encryptionPassword`、`sharedReceive` だけです。
`encryptionPassword` は自身のidentityバンドルを開く暗号化パスワードです。
次は形の説明であり、秘密値をシェルのリテラルへ記載する例ではありません。

```json
{
  "sessionToken": "<current-session>",
  "encryptionPassword": "<identity-encryption-password>",
  "sharedReceive": {
    "sender": {"accountId":"<sender-uuid>","identityVersion":1,"publicKey":"<verified-base64>","keyId":"<verified-fingerprint>"},
    "recipient": {"accountId":"<self-uuid>","identityVersion":1,"publicKey":"<held-base64>","keyId":"<held-fingerprint>"},
    "context": {
      "passwordBoxId":"<box-id>","senderAccountId":"<sender-uuid>","recipientAccountId":"<self-uuid>","keyEpoch":1,
      "senderIdentityVersion":1,"recipientIdentityVersion":1,"senderKeyId":"<verified-fingerprint>","recipientKeyId":"<held-fingerprint>"
    },
    "identityBundleVersion":1,
    "itemContext":{"passwordBoxId":"<box-id>","itemId":"<item-id>","itemVersion":3,"keyEpoch":1},
    "attachmentContext":{"passwordBoxId":"<box-id>","itemId":"<item-id>","attachmentId":"<attachment-id>","attachmentVersion":1,"keyEpoch":1}
  }
}
```

一覧では `itemContext` と `attachmentContext` を省略します。項目のget/readでは `itemContext` だけを付けます。
添付getでは両方が必須です。context・公開identity・世代・版は独立して保持し、送り手と自身の公開identityを
別手段で照合した後に供給します。CLIは信頼の自動承認、サーバーからのpin採用・更新を提供しません。
一覧の公開項目版を表示することと、暗号文自身から期待する版を採ることは区別します。

これらの制御JSONは未知・欠落・同名キー（エスケープの別表記を含む）・null・配列によるオブジェクト代用を拒否します。
整数は1〜9,007,199,254,740,991、UUIDは小文字の正規表記かつnil以外です。
公開identityはCoreのcanonical Base64と指紋・座標の検査も通します。
版・世代・ルート・sender/recipientの全対応関係を、最初のHTTP前に検査します。
全項目DTO内の未知属性やnullは従来どおり保持します。制御形式の拒否と、損失のない本文の保持を混同しません。

1. SDKの接続検査後、正式sessionの `/api/auth/me` を自身のidentityと照合します。
2. ボックスの現在世代を独立した期待世代と照合します。
3. `get_account_identity` で自身のバンドルを取得し、保持した公開identity・指紋・バンドル版と完全一致を要求します。
4. 形式1固定KDFとNFCで鍵を導出し、Core `AccountIdentity::unwrap` で自身の秘密identityを復元します。
5. SDK `get_self_grant(SharedKeyExpectation)` とCoreのHPKE Auth `unwrap_for_recipient` で共有鍵を開きます。

受信者を所有者用sharing-snapshotや所有者バンドルへ通しません。返信から期待世代やpinを更新しません。
一覧は正式 `list` のページをID順に検査し、全ページ成功後にID・版だけを表示します。
get/readは `get_attachment_state` → 同状態版の `get_attachment_snapshot` を各1回使い、
独立した `ItemContext` に対してCoreで全項目JSONを認証します。明示した全項目または選択欄だけを標準出力へ返します。

添付getは同じ状態版の全項目をCoreで認証し、順序を保った `attachments` 配列を検査します。
各参照の形は `{attachmentId,attachmentVersion,keyEpoch}` だけです。全参照のID重複・無効ID・
世代不一致・不正整数を拒否し、指定した添付の版を独立した `AttachmentContext` と照合します。
一致後にSDK `get_attachment` を1回だけ呼び、Coreで名前と全bytesを認証します。
公開状態はCASの入力だけであり、暗号認証や鍵の信頼の根拠ではありません。

`--out <path>` は利用者が明示した保存先です。認証した名前をパスへ解釈せず、親フォルダも作りません。
認証の成功後に `create_new` で新規作成し、既存ファイル・symlinkの上書きを拒否します。
Unixでは新規ファイルを0600で作り、全bytesを書き込み・同期します。空ファイルも0 bytesのまま保持します。
書込み失敗は失敗終了し、新規ファイルに一部だけ残る可能性を固定診断で伝えます。
保存に成功しても標準出力は空です。`--print-name` を明示した場合だけ元の名前をJSON文字列で返し、
Unicode・NUL・空の名前も損失なく扱います。鍵・本文・認証情報は、この明示した出力以外に保存しません。
所有する秘密入力・NFCパスワードはZeroizingまたは再帰消去guard、鍵と添付の名前/bytesはCoreの消去付き型で保持します。

設定不備、暗号認証失敗、401・403・409、未確認、除名、旧grant、世代・identityの不一致は失敗のままです。
HTTPの自動再送はありません。受信者による鍵更新・再共有・移行・復旧・変更操作はこのCLIでは未対応です。

## 受信者の正式受入

CLI専用のloopback検査は実 `op` と実SDK/Coreで行います。正式Node/PGを模擬した成功とは数えません。
`tools/encrypted-storage-acceptance/src/cli_recipient.rs` は、既存補助処理を使う独立した明示実行の検査です。
既存main・SQL輸送・local_postgres・添付受入の処理を変更せず、共有受入モジュールへ検査の登録だけを加えています。

```text
PASSSHARE_CLI_PG_MANIFEST=<absolute-owned-fixture-manifest>
PASSSHARE_CLI_NATIVE=<absolute-formal-native-binary>
PASSSHARE_CLI_BINARY=<absolute-op-binary>
PASSSHARE_CLI_OUTPUT_DIR=<absolute-directory-created-by-safe-delete>
cargo test --locked --manifest-path tools/encrypted-storage-acceptance/Cargo.toml sharing_rotation::cli_recipient::formal_cli_recipient -- --ignored --exact --nocapture
```

正式Node・所有情報を照合したPGの専用DB・実opで、全JSON/field/配列順、名前、全bytes、空ファイル、
明示保存先、上書き拒否を確認します。実要求を転送するtapで、状態→同revision項目→添付が各1回のSDK要求であることを照合します。
未確認と旧grantの拒否は専用DB内の明示した合成条件です。除名は正式な所有者の鍵更新APIを使い、
全項目・全添付を新鍵へ包み直した後、旧sessionと新ログインの受信者を拒否することを確認します。
全CLI要求の前後で全保存行・xminの不変を照合し、所有したNodeと専用DBだけを回収します。
添付出力とビルド生成物の回収は呼出担当がsafe-deleteの所有記録に従って行います。
親のPG・画面用DBは停止・変更しません。全workspace・配布image・CI・別モデルレビューは親担当の工程です。

2026-10-11の最終ソースで、関連nextestは82件成功・省略0（CLI18件、SDK64件）でした。
CLI/SDKと受入ツールのall-targets Clippy `-D warnings`、変更Rustファイルの整形検査も成功しました。
正式Node・PG・実opの明示受入は1件成功・省略0、24回のCLI実行で実SDKのGETを77回観測しました。
この77回にはCLI内のauth/meを含めません。正常添付2件の各要求は、状態→同revision項目→添付が各1回でした。
512 bytesの任意値と0 bytes、NUL/Unicode/空の名前、全JSON/field/配列順、上書き拒否を照合しました。
未確認・旧grant・実APIによる除名後の旧/新sessionでは、項目と添付の両方を拒否し、ダウンロード先を作りませんでした。
成功・拒否の全CLI実行で保存行とxminが不変でした。

受入コードの初回失敗は、Cookieログイン応答からBearer用のrefreshTokenを読もうとした取り違えでした。
正式なmobileログイン応答を使う検査へ修正しました。次の失敗は、現在世代のgrantがない場合の正式404を
受入側が403と期待した誤りでした。正式契約に合わせ、世代2に対して旧世代1のgrantが残る明示した合成条件も検査しました。
どちらもCLI/APIの権限を緩めていません。失敗時と最終成功時の専用DBは全て回収しました。
親担当が調べている過去のpsql終了2は、この成功を根拠に修復済みとは扱いません。

片付け後に、今回作った4つの専用DBが全て不在であることをPGのcatalogで確認しました。
親PGはPID68512・port50196・元の起動日時のままです。C1と他担当のDB・作業フォルダには触れていません。
nextest・正式受入の成功ログと初回2つの失敗ログは、この子ジョブの記録フォルダへ保存しました。
一時生成物2,203,338,425 bytesはsafe-deleteの容量上限により「削除希望」へ退避済みです。
検査用pnpm依存6,541,350 bytesも同じDドライブの「削除希望」へ保持しました。
後者の計画拒否は279件のjunctionによるもので、全て今回の元node_modules内を指すことを確認しました。
リンク先を変更・削除せずフォルダ全体を移動し、理由を残して所有記録の元パス不在を記録しました。
どちらも削除成功とは報告しません。追加のToDo・Discord投稿・push・PR・merge・全workspace検査は行っていません。
