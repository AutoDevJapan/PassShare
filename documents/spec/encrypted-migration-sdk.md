# 既存クラウドの暗号化移行接続（Rust Connect SDK）

元ToDo1163の有限実装。Coreの `prepare_migration` と正式Nodeの移行APIを、既存の
`EncryptedSessionClient` のセッションbearer経路から利用する。契約は
`encrypted-migration-core.md` と `encrypted-migration-api.md`。Connectトークンは使わない。
cookie・CSRFのサーバー処理は変更しない。所有者限定、所属・招待の条件、認証失効、期限、
元状態の変更、409などの拒否はHTTP状態と安全なPSコードを保持して返す。

## 移行元の読取

- `migration_source` はパスワードボックスID、正の状態版、全件数、先世代1を返す。
- `migration_source_items` は状態版とカーソルを送り、ID順100件のページを検査する。
  100件の応答は最後のIDを次のカーソルとし、101件目は次のページで得る。
- `migration_source_item` は呼出元が独立して保持する元ItemContextを要求する。
  完全JSONを `MigrationItemPlaintext` に保持し、型付きItemへ変換しない。
  未知属性、配列順、null、u64最大値、1.0、項目版17を保つ。
  オブジェクトの属性順・空白・元ファイルの字句表記の保存を保証する契約ではない。
- `migration_source_file` は同じ状態版と独立した添付contextを要求する。
  実本文は名前と全bytesをCoreの `AttachmentPlaintext` に保持する。
  本文なしは `MigrationSourceFile::Missing`、実0byteは `Available` と区別する。
  本文のない添付は独立した保管元から実bytesを確保してからCoreへ渡す。

移行元の添付応答はID・項目ID・名前・長さ・可用性・本文であり、世代や添付版を返さない。
独立したcontextと完全JSONの参照をCoreで照合する。応答の公開情報から鍵の信頼条件を作らない。
呼出元は完全集合・全件数をsnapshotと照合する責任を持つ。並行変更は正式サーバーが拒否する。

JSONは再帰的な重複属性を拒否する。公開DTOは未知属性・別名・欠落とnullの曖昧さを拒否する。
経路上の整数は1〜9007199254740991、件数は0以上の安全な整数を使う。
完全JSONの未知属性にある大きな整数や浮動小数点を、経路の整数へ読み替えない。
公開contextの違い、Base64の非正規表記、長さと本文の不一致も拒否する。

## 準備済み要求と明示操作

`MigrationTransportPlan::new` はCoreの変更不能な `PreparedMigration` と、準備に使った
同じ鍵を包んだ所有者bundleから、正式APIのheader・item・file要求を作る。
Coreのoperationと全対応表を保ち、各HTTP本文を一度だけ直列化して保持する。
`core_replay_bytes` は元Coreのbytesをそのまま保持する。
header、item、fileの要求bytesも読取可能であり、同じplanの明示再送で変わらない。
planは私有鍵・root key・パスワード・完全JSON・平文名・平文本文を受け取らず、送らない。
鍵の生bytesを取り出す入口は追加しない。bundleと準備鍵の同一性は呼出元がCoreで確認する。

| SDK操作 | 正式API応答の検査 |
|---|---|
| `stage_migration_header/item/file` | 状態はpendingまたは同一計画のcommitted再送 |
| `staged_migration_item` | bindingとenvelopeが準備済み要求と完全一致 |
| `staged_migration_file` | envelopeが準備済み添付と完全一致 |
| `migration_status` | pending/committed/aborted、expired、header。headerは独立したplanと一致 |
| `cancel_migration` | aborted。本文を送らず、元データの削除をしない |
| `commit_migration` | committedと同じoperationId。本文を送らない |

読戻しの一致はHTTP契約の検査に限定する。確定の前に、所有者bundleをCoreで開いた鍵と
独立したexpectedを使い、全項目の外側JSONと元の完全JSON、添付名と全bytesを比較する。
SDKは暗号認証の成功をHTTP応答から推定しない。確定は呼出元の明示操作である。
自動確定、自動再送、prepareの再実行、nonceの再生成は実装しない。
固定版reqwest 0.12.28には低層の拒否を自動再送する動作があるため、既存セッション接続の
builderで `reqwest::retry::never()` を明示する。移行以外の暗号化セッション要求にも適用する。
HTTP/2の低層拒否を実際に起こす検査は実行していない。
応答喪失後は認証付きstatusを確認し、呼出元が同じplanの明示再送を決める。
commit失敗の応答だけでは巻き戻しを証明しない。元データは確定を確認するまで保持する。

## 平文の寿命と限界

所有する元JSONと添付は既存Coreの消去付き型を使う。HTTP本文の所有bufferと再帰JSON解析の
途中値は、このSDK内のDropで揮発書込とcompiler fenceを使って消去する。
解析失敗やfutureの取消しもこの所有範囲に含む。平文型にはDebug・Clone・serdeを付けない。
エラーは静的分類とHTTP状態・形式を検査したPSコードだけであり、本文やtokenを含めない。
reqwest/serde内部の一時コピー、呼出元が保持するコピー、強制終了時の消去を保証しない。
この有限変更はsrc内で完結し、新規依存やlock変更をしない。

## 受入の接続と実行記録

既存 `tools/encrypted-storage-acceptance/src/encrypted_migration.rs` の正式Node・所有PG・Core
fixtureをSDKの移行元読取、仮置き、仮置き読戻し、status、取消し、明示commit再送へ接続する。
独立した完全JSON・添付3件・元の全行とxmin保持、実Coreによる全文復号の検査を保つ。
本文なし1件の実bytesは合成保管元から供給する。旧受入の成功件数を新SDKの成功に流用しない。
`sdk_successful_requests` はこの実行中に成功したSDK要求だけを数える。
拒否と応答喪失、pending/committedのdump/restoreも既存fixtureの範囲を維持する。

```text
cargo nextest run --locked -p passshare-connect
cargo clippy --locked -p passshare-connect --all-targets -- -D warnings
cargo nextest run --locked --manifest-path tools/encrypted-storage-acceptance/Cargo.toml -p passshare-encrypted-storage-acceptance
cargo clippy --locked --manifest-path tools/encrypted-storage-acceptance/Cargo.toml --all-targets -- -D warnings
passshare-encrypted-storage-acceptance --local-postgres <owned-manifest> --encrypted-migration <current-production-native>
```

全workspace・doctest・CIは親の統合工程で一度実行する。画面からの鍵配布、各形式の解析、
全クライアント、実サービス、原22条件、オーナー承認、製品完成はこの実装の成功から宣言しない。
### 2026-10-11の有限実装記録

固定基点 `80582e530b93e66d9f58632cddf56ac20ee2e81a` の専用作業先で実装した。
新規SDK検査は10件。関連nextestを共有Cargoゲートで約689秒、Clippyを約105秒待ったが、
空きメモリの停止時実測は約3.3GiBと6.6GiBで、16GiBの開始条件を満たさなかった。
ゲートの子プロセス0件を確認して、この担当の待機だけを終了した。コンパイルと検査は
開始しておらず、新SDKのテスト成功数・実API受入成功数は0件。省略数は未計測である。
検証ツールの関連nextest/Clippy・新ソースの正式Node/PG受入も未実行で、親の統合工程に残す。
新規検査10件が根のworkspace集合に加わるため、旧259件の結果を新ソースへ流用しない。

変更したRustのrustfmtと差分の空白検査が成功した。WASMのCIが宣言する13対象は、
この固定基点から差分0である。既存40入力と3生成物の検証を再実行していない。
依存・lock・Core・server・既存UIは変更していない。共有PGの所有manifestを読んだが、
この担当の専用DB・API・Docker資源は作成していない。親のPGを停止していない。

GPT-5.5のChatGPT OAuthによる新SDK差分レビューはMust0件だった。
正式APIの拒否でPSコードまで検査する提案を取り込み、追加差分の再確認もMust0件。
最初のPowerShellラッパーでは指示が標準入力へ届かずレビューが開始しなかったため、
未実行の失敗記録を残してCLI本体から実行した。APIキーを使った呼出は行っていない。
検査用ソケットではWindowsの非ブロッキング継承を明示的に解除し、読み書きと全体の期限を
検査用スレッドに設定した。実行して成功した修正とは主張しない。
最後に固定版reqwestの配布ソースを読み、自動再送を明示的に無効化した。
この追加も既存セッション接続だけを使い、cookieや正式ルートを変更していない。
検査用ソケットと自動再送設定の各追加差分もGPT-5.5の確認でMust0件だった。

原ログ、ゲートの観測、各レビュー、元と最終のsource treeとcommit、未実行項目は
`D:/CC/Evidence/passshare-1163-migration-sdk-20261011-084532/` に保全する。
元ToDo1163を進行中のまま維持し、新ToDo・PR・push・merge・Discord送信を行わず親へ返す。
