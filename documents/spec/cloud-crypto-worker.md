# クライアント暗号化Workerの境界

共有ToDo #1163 / #1175 のM4の一部です。`cloud-wasm.md` のWASM境界を、専用Workerの中で
動かすためのメッセージ境界を定めます。共有鍵の暗号操作を含みますが、画面・拡張・鍵の更新・サーバー保存への接続は含みません。
これだけで全クライアントの暗号化が完成したとは扱いません。

## 責務

- Rust（`packages/cloud-wasm/src/worker.rs`）: メッセージの形式、操作の世代、保存先・所有者・
  項目の期待値、サイズ上限、秘密の消去を強制します。Workerごとにパスワードボックスは1つです。
- JavaScript（`worker/boot.mjs`）: WASMを読み込み、Rustの `start_worker()` を呼ぶだけです。
  判断や方針は持ちません。HTTP・ファイル・ログ・独自サーバーはありません。
- 呼出元（画面側）: 画面とWorkerの寿命を決めます。生鍵を取得する方法はありません。

実際に動くのは `DedicatedWorkerGlobalScope` の中だけです。メインスレッドで読み込んでも
`start_worker()` は `PS060` で失敗し、リスナー登録も鍵生成もしません。2回目の呼出しも拒否します。
リスナー登録後、`ready` 返信（`requestId` が `null`、`ok` が `true`）を1回送ります。
呼出元は `ready` を受け取ってから最初の要求を送ります。

## メッセージ（version 1）

要求・返信とも、`postMessage` で渡す1つのJSON文字列です。未知のフィールド、型違い、
コマンドごとに過不足のあるフィールドは拒否します。

| command | 必須フィールド（`version`・`requestId` に加えて） |
|---|---|
| `status` | なし |
| `generate` | `expectedGeneration`, `owner` |
| `unlock` | `expectedGeneration`, `owner`, `bundle`, `password` |
| `wrap` | `expectedGeneration`, `password` |
| `encrypt` | `expectedGeneration`, `context`, `item` |
| `decrypt` | `expectedGeneration`, `context`, `envelope` |
| `lock` | なし |

- `requestId`: 1〜2^53−1の整数。`lock` 以外は前回の最大値より大きい値だけ受け付け、重複・再送を拒否します。
  形式が正しい `lock` は古い番号・再送でも受け付け、要求番号の最大値を下げません。
  全フィールドの明示的 `null` は拒否します。コマンドの必須フィールドの欠落も拒否します。
- `owner`, `context`, `bundle`, `envelope`, `item`: 既存のWASM境界と同じJSON文字列です。
  `password` は暗号化パスワードで、NFC正規化・Argon2id（bundle形式1固定）も同じです。
- 返信: `version`, `requestId`, `generation`, `locked`, `ok`、失敗時は `error`、成功時の結果は
  `bundle` / `envelope` / `item` のいずれか。`requestId` と `generation` は要求を処理した
  後の値です。解析・返信生成に失敗した要求の `requestId` は `null` です。
  この返信では状態フィールドが省略される場合があり、呼出元は他のフィールドを信用せずWorkerを終了します。
- 返信にパスワード、生鍵、アカウントのトークン、入力の文言は含めません。エラーは
  `PS051`（不正）、`PS057`（施錠中）、`PS058`（世代が古い）、`PS059`（すでに開いている）の固定文字列です。

## 世代

世代は0から始まり、ボックスまたはアカウント鍵を開く操作の成功と `lock` ごとに1ずつ増えます。

1. `wrap` / `encrypt` / `decrypt` / `generate` / `unlock` は `expectedGeneration` が現在の世代と
   違えば `PS058` で拒否します。施錠前の世代の操作・遅れて届いた要求は、施錠後に必ず拒否されます。
2. 形式が正しい `lock` は世代や要求番号の順序に関係なく成功し、ボックス鍵とアカウント鍵を両方消去して世代を進めます。
   すでに施錠中でも進めます。不正な形式への拒否を施錠の成功と扱わず、呼出元はWorkerを終了します。
3. 開いている間の `generate` / `unlock` は `PS059` です。別のボックスやアカウントへ切り替えるときは
   `lock` のあと、新しい期待所有者を渡して開き直します。失敗した `unlock` が開いている
   セッションを置き換えることはなく、施錠中の失敗も世代と状態を変えません。
4. 自動の再オープン・keepaliveはありません。

呼出元は返信の `requestId` / `generation` で、施錠や終了後に遅れて届いた返信を捨てます。
古い番号の `lock` も現在開いているセッションを施錠します。その返信番号は再利用されるので、
保留要求との照合には世代も使います。

## 上限

メッセージ全体は約6MiB（1MiBの平文を全文字エスケープした長さ）、項目本文は1MiB、封筒は1,500,000バイト、
`password` は1024バイト・8文字以上、コンテキスト類は既存の上限です。JSONの深さは
serde_jsonの上限（128）に従い、要求は平坦なので実質1段です。超えた入力は復号・暗号化の前に拒否します。

## 秘密の扱い

受信した文字列全体、解析した `password` / `item`、返す平文は、Rustの処理後に消去します。
`serde_json` が文字列のエスケープ解除中に一時コピーを作る可能性があり、メモリ全体の消去は
約束しません。通常の `lock` はRust側の鍵を消去します。**強制終了したWorkerの鍵が消去された
とは主張しません。** 終了後のメモリ回収はブラウザに依存し、JavaScript側の保証の範囲外です。
JavaScriptの入力・返却文字列と画面状態は呼出元が保持するため、別途消去が必要です。

## 呼出元が守ること

Argon2idは同期処理で、Workerのメッセージ処理は直列です。実行中の `unlock` / `wrap` の後ろに
`lock` が並ぶため、**施錠・背景移行のときに `lock` の返信を待ってはいけません**。呼出元は
即座に次を行います。

1. Workerへの `onmessage` を外し、保留中の要求をすべて拒否する。
2. 保持している状態（世代・平文）を捨てる。
3. Workerを `terminate()` する。

必要なら新しいWorkerを起動して、期待所有者から `unlock` し直します。
`onerror`、応答の期限超過、起動失敗で `ready` が届かない場合も同じ終了処理を行います。
panic・WASM trap・強制終了でメモリ内の鍵が消去されたとは扱いません。

## ビルドと受入

```text
cargo build --locked --release --target wasm32-unknown-unknown
wasm-bindgen target/wasm32-unknown-unknown/release/passshare_cloud_wasm.wasm --target web --out-dir pkg
cp worker/boot.mjs pkg/boot.mjs
new Worker(new URL('./boot.mjs', import.meta.url), { type: 'module' })
```

- ネイティブ: `src/worker.rs` のテストが、全JSONの往復、施錠後の古い世代の拒否、誤パスワード・
  別所有者・開いたままの置換拒否、生鍵や入力の反射がないこと、未知フィールド・型違い・
  再送・過大入力の拒否、固定の形式1ベクターを確認します。
- 実ブラウザ: `cargo run --locked --example worker_acceptance -- pkg` が表示するURLを
  Chromeで開くと、readyを含む13返信と6件の追加操作・負例をRustが検証します。
  追加操作は生成、古い番号の施錠とその再送、重複番号、未知フィールド、文字列以外の入力です。
  結果の送信先は実行ごとに変わる乱数パスで、検証成功後だけHTTP成功を返します。
  任意の第2引数は、検証前の返信を調査用に保存するファイルです。このファイルだけでは合格の証拠になりません。
  Rustの検証が全条件を通り、プロセスが終了コード0で終了した結果と併せて判定します。
  NodeやFake Workerは実ブラウザの証拠にしません。
  CIはビルドと配布用ファイル生成を確認します。ブラウザ受入は実際にChromeで実行して初めて結果になります。
  2026-10-09にオーナーのChromeで19返信の全条件が成功しました。releaseのWeb bindingsを使用し、
  `passshare_cloud_wasm_bg.wasm` のSHA-256は
  `8197da19e4065e1c8d047c9533845d5cd69da9491a78e76cb8eb7b9c4a6ef07e` です。再ビルドで値は変わり得ます。
  検査ページの実行をブラウザ操作とRustで照合した合成データの受入です。
  Argon2実行中の強制終了と、製品画面の背景移行は未検証です。
- 既存のWASM Node試験、`format1-vector.json`、`release_acceptance` は変更していません。

## 未完了

画面・拡張からの接続、Worker終了と施錠の実画面での検証、端末の鍵保管、サーバー保存、共有・
鍵の更新・復旧・移行を含むM4全体は未完了です。暗号化済みとして販売しません。

## ToDo 1163: Worker内の共有鍵操作

`WorkerSession` の私有状態に既存 `Session` と不透明な `CloudAccountIdentity` を各1つ保持する。
`shared.rs` のRust内部ヘルパーを直接使い、Coreと既存のWASMハンドルの形式・暗号を共用する。
秘密のgetter/export、独自暗号、サーバー認可は追加しない。

以下の要求はすべて `version:1`, `requestId`, `command`, `expectedGeneration` が必須。
表の追加フィールドもすべて必須で、JSONは文字列として渡す。未知フィールド・重複・null・
型違い・余分な既存フィールドも拒否する。非lockの失敗要求も、解析・version・番号順の
検査を通った時点で要求番号を消費する。全メッセージと項目返値の上限は従来のまま。

| command | 追加フィールド | 成功時の結果 |
|---|---|---|
| `identityGenerate` | `accountContext` | `publicIdentity` |
| `identityPublic` | なし | `publicIdentity` |
| `identityWrap` | `identitySecret` | `bundle` |
| `identityUnlock` | `accountContext`, `expectedKeyId`, `bundle`, `identitySecret` | `publicIdentity` |
| `sharedRecipientWrap` | `trustedRecipientPublic`, `sharedContext` | `envelope` |
| `sharedReceiveUnlock` | `trustedSenderPublic`, `sharedContext`, `envelope` | 結果フィールドなし |

`accountContext` は `{accountId, identityVersion}`、`publicIdentity` は
`{accountId, identityVersion, publicKey, keyId}`。生成時の公開指紋を最初に別保管する。
復元する文脈と `expectedKeyId` はその独立値を必ず渡す。同一account/versionの別鍵も拒否する。
`sharedContext` は [共有WASM仕様](shared-key-wasm.md) の8フィールドすべてが必須。
送信先・送信元の公開記述子は独立に信頼済みのものを渡し、期待文脈をbundle/envelopeから作らない。
サーバーが返した公開記述子の自己整合は信頼の証明ではない。
入力上限はアカウント文脈256、公開記述子512、共有文脈1024、identity bundle/共有envelope
2048、`identitySecret` 1024 UTF-8バイト。パスワード正規化・形式1のKDFは既存APIと同じ。

全返信に `identityLocked` を追加する。`locked` は従来どおりボックスが閉じていることを表す。
状態は両方閉じている、identityのみ、boxのみ、同一アカウントの両方、の4通り。
既存owner-first経路では、開いたボックスと同じaccountのidentityを後から追加できる。
identityが開いている場合のowner生成/復元/復旧は、期待所有者のaccountを照合する。
受信者として開くにはidentityが必要で、Coreが宛先account・版・指紋を照合する。
既存boxまたはidentityの置換は `PS059`。owner/recipient・account・boxを切り替えるには
`lock` 後に開き直す。すべての失敗は元の鍵と世代を保持し、鍵を自動復元しない。
受信者の `wrap` と `recoveryMaterial` は引き続き拒否する。共有操作は権限を付与しない。

identity生成/復元と受信box復元の成功も世代を1増やす。公開・封印・共有送信では増やさない。
非status/lockはすべて世代一致が必須。古い世代の生成/復元も施錠後に鍵を復活させない。
古い番号・再送の正しい `lock` も両方の鍵を破棄し、要求番号の最大値は下げない。
世代は2^53−1で飽和し、その値では全オープン操作を拒否する。上限のlockも消去に成功する。
要求番号を使い切った場合も、新Workerへ切り替える。lock後はstatus/lockを許すが、
最新世代の暗号操作・公開・封印はそれぞれ施錠エラー、古い世代は `PS058`。
明示的に最新世代でidentity/ownerを再オープンすることだけは上限未満なら許す。

新しい返信結果は公開記述子・封印bundle・共有暗号文だけ。従来の項目・復旧経路は同じ契約。
受信文字列、解析した `identitySecret`、KDFの文字列、返信bufferは処理後にzeroizeする。
鍵の破棄は既存不透明型/CoreのDropに委ねる。診断に入力・秘密・下位エラーを出さない。
JSの文字列・強制終了時の全メモリ消去は保証しない。背景移行の即時terminate契約も変わらない。

検査は `src/worker.rs` のNative状態・上限検査と、既存 `tests/wasm.rs` の
`exported_worker_create_edit_node_boundary` 内で実export `start_worker` を呼ぶNode検査へ追加する。
Node側はmessage surfaceだけのfixtureであり、実ブラウザ受入の証拠には数えない。
UI、正式API、配布WASM/assets/inputの全照合と全workspace検査は親担当が実施する。

2026-10-11: 独立manifest/lock/target・共有Cargoゲート・sccacheでNative 36件、doc（0例）、
Native全targetとwasm32 testsのClippyが成功。Nodeは既存WASM 4件（共有dispatcher検査を含む）、
共有API 5件、Core共有鍵 1件の計10件が成功。読み取り専用の別モデル確認は指摘0件。
世代上限は私有状態へ設定するNative検査で確認し、実WASMでは上限までの反復は省略した。
この子では全workspace、ブラウザ/画面、正式API、配布生成物更新、CI、pushは実施していない。
