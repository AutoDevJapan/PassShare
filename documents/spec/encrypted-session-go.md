# 暗号文セッションSDK（Go）の通信契約

Go SDK の暗号文通信層を追加しました。共有ToDo #1163 / #1175 の M4 の一部です。
既存の Connect 用 `Client` は変更していません。Go 1.22 の標準ライブラリだけを使います。
2026-10-10にWindowsのGo 1.27で通常・race・vetと、正式Node／配布イメージ＋PostgreSQLの相互運用検査が成功しました。候補CIと統合後mainは別途確認します。

契約の根拠は [Rust SDK](encrypted-session-client.md)、
[暗号文保存API](encrypted-storage-api.md)、[所有者キーAPI](owner-key-bundle-api.md) と
`crates/passshare-connect/src/encrypted_client.rs` です。

## 操作と認証

`NewEncryptedSessionClient(host, sessionBearer)` はセッションの Bearer を受け取り、
通信先と認証情報を非公開のフィールドに保持します。Connect トークンは使いません。
`String` と `GoString` は通信先も認証情報も伏せます。
認証ヘッダーは `Authorization: Bearer <sessionBearer>`、応答指定は `Accept: application/json` です。
JSON を送る場合だけ `Content-Type: application/json` を付けます。
Cookie、CSRF ヘッダー、クライアント種別のヘッダーは送りません。

以下はすべて先頭に `context.Context` を受け取ります。
パスは指定したベースURLのパス末尾に `/api/encrypted` を足したものです。

| メソッド | HTTP と相対パス | 本文 | 成功応答 |
|---|---|---|---|
| `State(boxID)` | GET `/boxes/:boxID` | なし | 200 `{mode,keyEpoch}` |
| `EnableEmptyBox(boxID)` | POST `/boxes/:boxID/enable` | `{keyEpoch:1}` | 200 `{mode:"encrypted",keyEpoch:1}` |
| `SetupEmptyBox(boxID,bundle)` | POST `/boxes/:boxID/setup` | `{bundle}` | 200 `{mode:"encrypted",keyEpoch:1,bundleVersion:1,bundle}` |
| `List(boxID,after)` | GET `/boxes/:boxID/items` | なし。任意の `?after=:itemID` | 200 `{items,nextCursor}` |
| `GetItem(boxID,itemID)` | GET `/boxes/:boxID/items/:itemID` | なし | 200 項目の全暗号文 |
| `PutItem(boxID,itemID,expectedVersion,envelope)` | PUT 同上 | `{expectedVersion,envelope}` | 200 送信した暗号文と完全一致 |
| `DeleteItem(boxID,itemID,expectedVersion,keyEpoch)` | DELETE 同上 | `{expectedVersion,keyEpoch}` | 204 本文0バイト |
| `GetOwnerKey(boxID,expectedOwnerCtx)` | GET `/boxes/:boxID/owner-key` | なし | 200 `{bundleVersion,bundle}` のみ |
| `PutOwnerKey(boxID,expectedVersion,bundle,currentLoginPassword)` | PUT 同上 | `{expectedVersion,bundle}`、置換時だけ `currentPassword` | 200 版が期待版+1、bundle が送信値と完全一致 |

`after` と `currentLoginPassword` は `*string` です。省略は nil で示します。
所有者bundleの初回保存ではパスワードを受け付けず、置換では空でない現在のログイン用
パスワードを要求します。暗号化パスワードではありません。再認証情報は bundle と別の引数で、
送信する本文以外に保持しません。SDK 内部からログを出しません。
Go の文字列やHTTP送信バッファの確実なゼロ化は保証していません。

初回設定は世代1の有効化と所有者bundle保存をサーバーの同一トランザクションで行うAPIです。
送るbundleの世代は1、返る世代と版も1、返るbundleは送信値との完全一致が必要です。
設定後は取得し直したbundleをCoreで展開して、鍵が使えることを確認します。

## 公開形式と応答の検査

`EncryptedItem` は `{format,context,nonce,ciphertext}`、context は
`{passwordBoxId,itemId,itemVersion,keyEpoch}` だけです。
`OwnerKeyBundle` は `{format,salt,wrapped}`、wrapped は同じ暗号文の形で、
context は `{passwordBoxId,ownerAccountId,keyEpoch}` だけです。
KDF の指定は受け付けません。format 1 の固定KDF（Core の Argon2id 64MiB / 3 / 4）を使うのは
呼出元のCoreです。このGo SDKには暗号処理がありません。

- ID は26桁の英小文字・数字です。所有者は小文字・ハイフン付きのcanonical UUIDで、nil UUIDは禁止です。
- 正の整数は1〜9007199254740991です。PUTの期待版だけは0〜9007199254740990を認めます。
  項目PUTの送信版は期待版+1です。DELETEの期待版と世代は正の整数です。
- nonce は24バイト、salt は16バイト、包んだ鍵の暗号文は48バイトです。
  項目暗号文は16〜1048592バイトです。標準のパディング付き Base64 を再エンコードで照合し、
  非canonical形式・改行・不正な末尾ビットを拒否します。デコード前に符号化後の長さを制限します。
- 引数をすべてHTTP送信前に検査します。未知フィールドや平文を渡す map 型の入口はありません。
- 応答は必須フィールド、未知フィールド、重複フィールド、大文字小文字を変えた名前、
  nullable 以外のnull、小数・指数形式の整数、範囲外数値、JSON後の余分な値を拒否します。
- 状態は `compatibility` と世代null、または `encrypted` と正の世代だけです。
- 一覧は最大100件で、IDが `after` より大きく、厳密な昇順で重複しないことを要求します。
  100件の場合だけカーソルを必須とし、最後のIDとの一致を要求します。
- 所有者GETは受信値の所有者・ボックス・世代を呼出元の期待文脈と照合します。
  PUTとsetupの応答は、受信した文脈だけでなく、送信した暗号文全体と照合します。

`GetItem` はURLのボックスと項目、版と世代の構造上の範囲を検査します。
取得APIの引数には期待版と世代がないため、その2値の信頼性を通信層だけでは保証できません。
呼出元は自分で保持する `ItemContext` を `ValidateContext` に渡してすべてのヘッダーを照合し、
**同じ独立した期待文脈**をCoreの `decrypt_item` に渡して認証・復号します。
受信したenvelopeから期待する版や世代を作ってはいけません。
所有者bundleも独立した期待文脈を使ってCoreの `unwrap_for_owner` で認証してから使います。
構造検査だけではAEADの正当性も鍵の正当性も確認できません。

呼出元は配列・添付メタデータ・任意payloadを含む項目の全DTOを暗号化します。
SDKはその暗号文をそのまま運び、必要と思われる一部のフィールドへ絞り込みません。
平文・生鍵・暗号化パスワードを受け取る通信APIはありません。

## 通信先・制限・エラー

HTTPS を要求し、HTTP はRustと同じリテラル `localhost`、`127.0.0.1`、`[::1]` だけです。
URL のユーザー情報・クエリ・フラグメント・制御文字・バックスラッシュ・パス区切りの符号化・
`.` / `..` の符号化を拒否します。二重符号化も拒否します。
任意のプロキシ用パス接頭辞を残し、そこへ固定のAPIパスを追加します。
環境のHTTPプロキシは使いません。TLS証明書の検証を維持します。

専用のHTTPクライアントを使い、CookieJarは設定しません。
接続とTLS接続の期限は10秒、要求全体は30秒です。contextによる取消も反映します。
同一通信先を含むすべてのリダイレクトを追いません。
接続を再利用せず、再送用の本文も設定せず、SDKは自動再試行を行いません。

成功応答は1.5MiB、エラー応答は64KiBまでで、宣言された長さを先に検査し、
読み取りも上限+1バイトで打ち切ってJSON処理より前に拒否します。
HTTPヘッダーにも64KiBの上限を設定し、圧縮応答の自動展開を無効にします。
DELETEはTransfer-Encodingと0以外のContent-Lengthを拒否し、公開された本文を0バイトに制限します。
`net/http` が未宣言の不正な204本文を公開しない場合、そのバイトはSDKから観測できません。
あらゆるwire上の不正な本文を検出できる保証とはしません。要求には接続を閉じる指定を付けます。
正式APIの本文0バイトは、親担当の実受入で生のHTTP応答も別に確認します。

200以外のJSON応答と204以外の削除応答は、他の2xxでもAPIエラーです。
`EncryptedSessionError` が保持するAPI情報はHTTPステータスと `error` フィールドの厳密な
`PSnnn` コードだけです。大きすぎる、壊れた、読み取れないエラー本文からコードは取り出しません。
URL・ネットワーク・JSONの元のエラー、サーバーのmessage、本文、入力値、認証情報は保持しません。

削除済みIDの再利用はサーバーの契約に従い、SDKに代替保存はありません。
一致した削除の明示再送では最初の期待版と世代を保持します。
項目PUTなどの完全一致再送を許すサーバー拡張が親ブランチで加わっても、SDKの自動再試行は無効のままです。
結果が不明な場合に新しい鍵・salt・暗号文を生成して再送する処理はありません。

## 確認結果とM4の残条件

`encrypted_client_test.go` の `httptest` は実際の要求のメソッド・パス・認証・本文、200と204、
送信前の拒否、応答構造、Base64、文脈不一致、一覧とカーソル、サイズ上限、余分なJSON、
不正な204の宣言、秘密値の非表示、リダイレクト先の呼出し0回と送信元の呼出し1回、
409で2件目の応答が未使用となることを検査するコードです。
fixtureの暗号文は合成値で、Core暗号文の正当性の証拠ではありません。
既存の互換SDKのテストは変更していません。

`go test ./...`、`go test -race ./...`、`go vet ./...` が成功しました。正常なJSONへ空白を足した過大応答を宣言長あり／なしで拒否し、成功・エラー本文双方について、不明な長さは上限+1バイトで停止することを検査しました。所有付きコピーで読み取り上限を外す変異試験は、目的の読取量アサーションで失敗しました。最初の変異試験はCドライブ容量不足でビルドが止まったため、証拠に数えず、Dドライブで実際の失敗を確認しました。

次の実行ファイルが、実際のCoreから生成した暗号文をGo SDKで保存・取得します。リポジトリのルートから、Nodeまたは配布イメージのどちらかを指定します。

```sh
tools/encrypted-storage-acceptance/target/debug/passshare-encrypted-storage-acceptance --go-session <コンパイル済みGoテスト> <正式native>
tools/encrypted-storage-acceptance/target/debug/passshare-encrypted-storage-acceptance --go-session <コンパイル済みGoテスト> --image <正式配布イメージ>
```

Windowsの実行ファイルには `.exe` を付けます。2026-10-10に両モードが成功しました。Rustが独立して保持する文脈と鍵で全DTOを復号して一致を確認し、所有者bundleも展開して同じ項目を復号します。配列・複数フィールド・添付メタデータ・未知payloadを検査しており、Goの合成fixtureだけの結果ではありません。

初回設定とPUTの一致再送、所有者キー置換時の誤パスワード拒否と正しい再認証、削除と一致再送、取得の404・ID再利用拒否、別の実登録アカウントの403と、検証DBでセッション削除をcommitした後の同じトークンの401も確認しました。最後の失効は検証DBの直接更新であり、ログアウトAPIや実サービス障害の検査ではありません。拒否後も生存項目・削除メタデータ・所有者bundleが変わらず、互換の平文行が無いことを確認しました。専用サーバー・DB・ネットワークは各実行後に回収しました。

検証用の資格情報は有限サイズの標準入力だけでGo子プロセスへ渡します。公開暗号文だけの結果を回収し、診断出力は破棄します。子の実行とI/Oには35秒の期限と終了・回収処理があり、検査の準備から全体の終了までを35秒で保証するものではありません。Go CIは最低対応版と現行版でrace・vet・整形を確認し、正式Nodeと配布イメージの相互運用も独立したCIへ接続しました。別モデルの確認は全指摘0件、候補CIと統合後mainは別途確認中です。RootのRustライブラリはPR677と同じソースで全127件・doc4クレート各0例の成功を保持します。

新しいrootソースの承認も、Goの通信層の合格も、M4全体の完了を意味しません。
全クライアントへの組込み、WASM接続、端末での鍵保管、共有鍵の確認・配布・失効・復旧、
鍵世代の更新、平文移行と故障時の原本保持、暗号化した添付、プラン上限、公開環境での受入が残ります。
