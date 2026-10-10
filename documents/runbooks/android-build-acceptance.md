# Androidのビルドと端末受入

正式なTauriモバイルの生成プロジェクトを `apps/mobile/src-tauri/gen/android` に保持します。
OSごとの実体を検査するための設定であり、署名配布や販売開始の証明ではありません。

## ビルド

JDK、Android SDK、NDK、対象Rust targetを用意し、`JAVA_HOME`、`ANDROID_HOME`、`NDK_HOME` を設定します。
`apps/mobile` で固定依存を導入し、Connect JS SDKをビルドしてから実行します。

```text
cargo tauri android build --debug --target x86_64 --apk --ci
```

Cargoは共有ゲートを通し、worktree固有の生成先を使います。
実機のアーキテクチャがarm64なら対応するtargetを使います。
仮想端末の検査では、既存のADBサーバーとAVDに触らず、専用ADBポートと専用AVDを使います。

Kotlinプラグイン2.2.21、Android Gradle Plugin8.11.0、Gradle8.14.3を固定しています。
保管プラグインの依存が持つKotlin2.1のメタデータを、生成時の1.9.25では読めませんでした。
Kotlinをビルド内で実行し、別compiler daemonの接続失敗に依存しないようにしています。
実コンパイルエラーは引き続きビルドを失敗させます。
一次資料は [Kotlinの互換表](https://kotlinlang.org/docs/gradle-configure-project.html) と
[compiler実行方式](https://kotlinlang.org/docs/compiler-execution-strategy.html) です。

生成済みの設定・標準Activity・リソースとGradle wrapperを保存します。
SDK絶対パス、機械固有のTauri接続情報、APK、Rustライブラリ、秘密の署名鍵、build/cacheは保存しません。
APKはビルド終了後に検査専用場所へコピーし、コピー前後のSHA-256一致を確認してから導入します。

## 確認する操作

正式APIと専用の架空PostgreSQLを使います。架空の項目、アカウント、PINだけを投入します。
APIのURLは検査用ビルドの環境変数で指定し、本番URLや公開設定を変更しません。

1. ログイン・PIN・OSの安全な保管への保存後、項目を読めること。
2. OSのホーム画面へ移り、アプリへ戻った時に秘密と下書きが表示されず、再認証を要求すること。
3. OSの保管認証後にサーバー資格を更新し、同じ利用者の項目を読めること。
4. 300秒以上入力せず施錠されること。状態の読取りや通信で期限が延びないこと。
5. アプリのプロセスを停止・起動し、再認証前に秘密が表示されないこと。

画面、原結果、対象ソース、APKの指紋、実測時間を別に記録します。
仮想端末の指紋入力は仮想のOS認証であり、物理端末の認証を証明しません。
互換方式の項目で行った検査は、モバイルのクラウド本文暗号化を証明しません。
物理Android/iOS、クリップボード、署名・更新・削除、全販売条件は元の受入表に残します。

検査後は自分のアプリ・AVD・専用ADB・API・専用DBを終了し、保存した証拠を確認して一時資源を片付けます。
