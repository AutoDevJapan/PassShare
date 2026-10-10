# CodeQLの解析とAndroidビルド

`.github/workflows/codeql.yml` は6言語をそれぞれ解析します。
すべてのPR、mainへのpush、手動実行、週1回（日曜日03:17 UTC）で起動します。
matrixの1言語が失敗しても、ほかの言語の解析を続けます。
クエリを指定せずCodeQLの標準クエリを使い、解析対象を減らす除外設定や失敗を許容する設定は加えません。

| 言語 | build-mode | ビルド手順 |
| --- | --- | --- |
| actions | none | ソースから解析 |
| go | manual | `packages/connect-go` で `go build ./...` |
| java-kotlin | manual | 正式Tauri Androidプロジェクトからdebug APKをビルド |
| javascript-typescript | none | ソースから解析 |
| python | none | 既存ソースから解析 |
| rust | none | CodeQLがRustソースをビルドなしで解析 |

## 修正の根拠

Android PR702のマージ後ソース `c22b0cd8fcfdb4b5872d0428a9309c78fca6a7c8` に対する
CodeQL実行38085258302のjava-kotlinジョブ114310335971は、CodeQL2.27.2で終了コード32となりました。
注記は `none` ではJava/Kotlinを1件も処理できず、明示的なビルドが必要だと示しています。
Kotlinは `autobuild` または `manual`、Goもこの2方式、Rustは `none` を使う必要があります。
根拠は [GitHubのビルド方式の説明](https://docs.github.com/en/code-security/reference/code-scanning/codeql/build-options-for-compiled-languages) です。

## Androidの実行順序

SDKの設定アクションには `packages: platform-tools` を明示します。
アクションの標準値にある旧 `tools` は配布されておらず、実CIで取得が終了コード1となりました。
command-line toolsはアクション自身が導入し、後続で固定platform/build-tools/NDKを導入します。
SDK利用条件は通常どおり確認しますが、その長い本文をCIログへ複製しません。

1. Ubuntu24.04でJDK21、SDK36、build-tools36.0.0、NDK30.0.14904198を導入します。
   Rustの `x86_64-linux-android` target、Cargo版Tauri CLI2.11.4を導入します。
   Connect JS SDKとモバイルの依存を `pnpm --frozen-lockfile` で導入し、両方をビルドします。
2. CodeQLを `java-kotlin` / `manual` で初期化します。
3. `apps/mobile` で `cargo tauri android init --ci --skip-targets-install` を実行します。
   初期化が生成するCargo呼出しの `BuildTask.kt` を残し、ほかの追跡済みAndroidファイルをHEADから戻します。
   追跡しないTauriの接続設定も残します。Kotlin2.2.21、AGP8.11.0、Gradle8.14.3の設定を保ちます。
4. 同じディレクトリで `cargo tauri android build --debug --target x86_64 --apk --ci` を実行します。
   CodeQL初期化前のKotlinコンパイルや、APK・Gradle成果物のキャッシュ再利用は行いません。
   APKが生成されたことを確認してから解析します。ビルドや抽出に失敗した場合はジョブを失敗させます。

Tauri2.11.4の [初期化処理](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-cli/src/mobile/init.rs) は、
起動したCLIに合わせてGradleの呼出しを生成します。
[Androidプロジェクト生成処理](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-cli/src/mobile/android/project.rs) は
既存ファイルを保持しますが、`BuildTask.kt` は必ず書き換えます。このファイルを復元対象から外すのはそのためです。
[Androidビルド処理](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-cli/src/mobile/android/build.rs) は
最初のRustビルドでプラグインを初期化してからGradleでAPKを作ります。
npm版CLIだけの導入では、Cargoを呼ぶ既存の手順を満たせません。

## 親担当が行うGitHub設定の切替と検証

独自ワークフローとGitHubのDefault setupは併用できません。
切替は、親担当がこの差分を確認できる状態にした後に実施します。
修正担当はリポジトリ設定を変更せず、push・PR作成・マージも行いません。

1. 現在のDefault setup設定（6言語、標準クエリ、remote脅威モデル、週次実行）を記録します。
2. Default setupを無効化し、このワークフローをAdvanced setupとして統合します。
   解析をGitHub-hosted runnerで実行し、言語・標準クエリ・remote脅威モデル・週次頻度を維持します。
   `threat-models` を指定しない場合はremoteの解析が使われます。
3. 対象コミットのPRまたはmain pushでCIを起動します。統合後は手動実行でも確認できます。
4. 6言語すべてのジョブが成功し、java-kotlinログに実際のKotlinコンパイルと抽出があり、
   CodeQLのアップロードが成功したことを確認します。
   失敗やpendingを残したまま、CodeQL修復の完了とは報告しません。
5. `gh pr checks` と `gh run view` で対象SHA・実行ID・結果を記録します。
   [Default setupの設定](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/manage-your-configuration/edit-default-setup)
   と [Advanced setupへの切替・Default setupの無効化](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/configure-code-scanning/configuring-advanced-setup-for-code-scanning) を参照してください。

Windowsでの正式debug APKビルド・仮想端末受入は親担当が確認済みです。
この修正で確認済みなのはYAML・静的検査までです。
Linux上のCodeQL実行成功は、CIで確認後に別の証拠として記録します。
Linuxでのビルド・抽出・6言語のアップロード成功は、親担当がCIで確認するまで未検証です。
debug APKは検査用であり、正式署名、配布、物理端末受入、販売開始を証明しません。
