# クライアント暗号化Workerの境界

共有ToDo #1163 / #1175 のM4の一部です。`cloud-wasm.md` のWASM境界を、専用Workerの中で
動かすためのメッセージ境界を定めます。画面・拡張・共有・鍵の更新・サーバー保存は含みません。
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
  任意フィールドの `null` は未指定と同じ扱いです。
- `owner`, `context`, `bundle`, `envelope`, `item`: 既存のWASM境界と同じJSON文字列です。
  `password` は暗号化パスワードで、NFC正規化・Argon2id（bundle形式1固定）も同じです。
- 返信: `version`, `requestId`, `generation`, `locked`, `ok`、失敗時は `error`、成功時の結果は
  `bundle` / `envelope` / `item` のいずれか。`requestId` と `generation` は要求を処理した
  後の値です。解析・返信生成に失敗した要求の `requestId` は `null` です。
  この返信では状態フィールドが省略される場合があり、呼出元は他のフィールドを信用せずWorkerを終了します。
- 返信にパスワード、生鍵、アカウントのトークン、入力の文言は含めません。エラーは
  `PS051`（不正）、`PS057`（施錠中）、`PS058`（世代が古い）、`PS059`（すでに開いている）の固定文字列です。

## 世代

世代は0から始まり、`generate` / `unlock` の成功と `lock` ごとに1ずつ増えます。

1. `wrap` / `encrypt` / `decrypt` / `generate` / `unlock` は `expectedGeneration` が現在の世代と
   違えば `PS058` で拒否します。施錠前の世代の操作・遅れて届いた要求は、施錠後に必ず拒否されます。
2. 形式が正しい `lock` は世代や要求番号の順序に関係なく成功し、鍵を消去して世代を進めます。
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
