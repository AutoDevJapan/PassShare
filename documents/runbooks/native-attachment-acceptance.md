# Desktop添付の実操作受入（ToDo1163の有限範囲）

2026-10-12の子では正規Computer Useのネイティブ接続を取得できず、
**実Desktopの添付受入は未達**。型・配布ビルド・fixtureの成功を実操作の成功に数えない。
オーナーへの質問は不要で、親の1163へこの未達と証拠を統合する。

## 固定したソースと操作能力

- ソース: `2f57263558c8b483288d389d5f74223a4fc0b688`
- ブランチ: `feat/todo1163-native-attachment-acceptance`
- `scrub391.exe --guard-path`の結果: `client_resource=false`
- 正規`mcp__node_repl__js`から`@oai/sky`を直接importできた。
- `sky.list_apps()`は初回、再確認、kernel reset後の正規再初期化の3回とも失敗した。

返却されたエラーは次のとおり。

```text
Computer Use native pipe is unavailable: failed to connect native pipe: The system cannot find the file specified. (os error 2)
```

ウィンドウ選択・入力・画面取得は各0件。自作helper、別の画面取得経路、
SendInput、親のアプリ・API・DB・Chromeの操作は行っていない。
native pipeを用意するためのhelper独自起動も行っていない。

## 独立して実行できた検査

`git archive HEAD`で所有記録付きの隔離コピーを作り、4パッケージの依存を
`--frozen-lockfile --ignore-scripts`で用意した。Desktop入口・共有添付画面・
worker輸送・寿命処理・検査の計7ファイルは改行を正規化して元ソースと一致を確認した。

| 検査 | 実結果 | 証拠の範囲 |
|---|---|---|
| Desktop失焦関連5件と応答EOFの中断リスナー解除1件 | 6成功、失敗0 | 制御したReact/HTTP host。OS失焦の観測ではない |
| 添付の既存検査 | 25成功、失敗0 | 制御したrenderer/worker/API輸送。実暗号・PG・OSではない |
| Desktop `tsc --noEmit` | exit 0 | 型検査 |
| Desktop Vite build | exit 0 | 86モジュール。既存の配布WASM指紋・asset検証を含む |
| i18n check | exit 0 | 10言語、481キー、文書ja/en/ru |

Nodeが報告したskipは0。cross-client検査のうち今回の選択から外した29件は未実行。
Viteの500kB超chunk警告は残る。TauriのRust実行ファイルはビルド・起動していない。
Rust入力・生成WASM・manifest・アプリ実装は変更していない。
親の全workspace・正式API/SDK/CLIの検査は繰り返していない。

## 実Desktopで残る受入

| 操作 | 合格条件 | 今回 |
|---|---|---|
| ファイル選択と選択取消 | owned OS dialogと別アプリへの背景遷移を観測。ダイアログ後に追加が使える | 未実行 |
| 同名2件、取替と取消 | 別添付として保持し、取消で原本の名前・容量を戻す | 未実行 |
| 保存、再取得、ダウンロード | 日本語名、`00 ff`、空file、259bytesを全内容で照合 | 未実行 |
| 全文保持 | 未知属性、複数URL、順序、item17/file17を保存後再取得で照合 | 未実行 |
| 削除の失敗、409、応答喪失 | 原本保持、原下書き保持、同じ不透明payloadの明示再送、二重createなし | 未実行 |
| 背景、idle、logout、再開 | worker/session/key/draftを閉じ、遅着や再開で秘密が復活しない | 未実行 |
| 入力と表示 | file input/buffer消去、Blob URL解放、focus/a11y、320pxのja/en/ru | 未実行 |
| AndroidとMV3 popup/CSP | 正式transportで部分受入し、Desktopと区別して記録 | 未実行 |

## 正規操作で再開する最小手順

1. 正規Computer Useが提供するnative pipeのあるセッションで、スキルのguidance/api/confirmationsを読み、`@oai/sky`を初期化する。`list_apps()`の成功を先に確認する。
2. 固定ソースからDesktopを共有Cargoゲート・専用targetで用意する。所有記録付きの新しい検査環境だけを使い、既存のsynthetic fixture生成と正式認証APIを再利用する。親PGは目的・PID・port・開始時刻を照合し、専用DBだけを作る。
3. `list_apps()`または`list_windows()`が返した自作アプリのWindowを一意に選ぶ。observe→1操作→refreshを守り、ダイアログが別Windowなら返却された対象を選び直す。
4. 最初にファイル選択・選択取消・通常背景を比較する。実害を観測した場合だけ最小修復する。JSのskipBlurや暗号文から導いたpinで通常背景の消去を弱めない。OS所有関係を使う修復が必要なら、最小Rust/native接続とその実測を先に行う。
5. 上表の未達を順に確認し、独立context・状態版・正式transportを保持する。Rust入力を変更したら旧WASM/root結果を転用せず、親へ正式生成と最新全件の必要を返す。
6. 所有したアプリ・API・DB・tabを終了し、結果と残存資源を記録する。公開・課金・push・PR・mergeはこの子では実行しない。

## 証拠と後片付け

証拠は次の一意フォルダへ保存した。生の秘密やAPI/DBの応答本文は含めない。

```text
D:/CC/Evidence/passshare-1163-native-attachments-20261012/run-20261011T171327Z-015f78df/
```

`capability.json`、`results.json`、`build-results.json`、`cleanup.json`と各検査のログを保持する。
検査コピーの所有IDは`8db0884837ba258cb48b8a885f2119a5`。
safe-deleteの`plan`と指定された`quarantine --reason policy`は、両方とも
`LINK_OR_REPARSE_POINT`で拒否した。依存のreparse pointは179件、
ファイル3767件の名前ごとの容量合計は303,560,253bytes。
これはsafe-delete補助コマンドの拒否であり、自動承認レビューの拒否ではない。
別経路で削除・移動を再試行せず、次の所有フォルダを保持した。

```text
D:/CC/Work/passshare-native-attachment-acceptance-1163-20261012/codex-owned-8db0884837ba258cb48b8a885f2119a5/
```

独立DB・API・自作アプリ・Chrome tab・Docker資源の作成は各0件。
新ToDo・Discord送信・質問再送・親の1163/1175の状態や全体進捗変更は行っていない。
