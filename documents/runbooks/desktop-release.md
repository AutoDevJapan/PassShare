# Desktop リリース Runbook

> Issue [#71](https://github.com/AutoDevJapan/PassShare/issues/71) / [#72](https://github.com/AutoDevJapan/PassShare/issues/72)

## M7-Aで使用する署名シークレット（GitHub Actions）

| Secret | 用途 |
|--------|------|
| `TAURI_SIGNING_PRIVATE_KEY` | 自動更新パッケージの署名（minisign 秘密鍵。Windowsの発行元署名とは別） |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 秘密鍵パスワード（任意） |

M7-AはAppleの証明書・秘密鍵をGitHubへ取り込まず、Apple IDやパスワードもworkflowへ渡さない。署名identity/teamは公開設定、証明書と公証資格は専用runnerの既存keychainを使う。以下の必要条件を参照する。

現在の `desktop-build.yml` はビルドとCI成果物保存を検証する。署名用シークレットをビルドへ渡す工程やWindowsの発行元署名は、このworkflowには接続していない。シークレット名が登録されているだけで署名済みとは判定せず、本番配布前に実成果物の署名を確認する。

Windowsの発行元署名は、別途Authenticode証明書と署名工程で確認する。自動更新用の署名だけでWindowsの発行元署名を済ませたとは扱わない。[Windows署名](https://v2.tauri.app/distribute/sign/windows/)と[自動更新](https://v2.tauri.app/plugin/updater/)の公式手順を分けて参照する。署名・公開に必要な支出や契約は、検証できる候補と必要な条件をそろえてオーナーが判断する。署名の秘密値をログや報告へ出さない。

## ローカルビルド

```powershell
cd apps/desktop
pnpm install
pnpm --dir ../../packages/connect-js run build
pnpm run build
cargo tauri build
```

## 自動更新

- `tauri.conf.json` の `plugins.updater.endpoints` が GitHub Releases `latest.json` を参照
- 本番公開時は `TAURI_SIGNING_PRIVATE_KEY` で updater 成果物に署名
- CI / ローカル検証では `tauri.conf.json` の `createUpdaterArtifacts: false`（未署名ビルド）
- 候補の更新署名は、下記の手動工程が実本体を作った後にTauri signerで行う。保存済みの公開鍵・版・URLは変えない
- smoke: アプリ起動 → 設定 → 更新確認（ネットワーク接続時）

## CI

`desktop-build.yml`:

- `smoke`: `cargo test -p passshare-desktop smoke_`
- `build`: macOS / Ubuntu / Windows で `tauri-action` 実行、インストーラ artifact アップロード

Cargoのworkspace全体の出力先を使うため、成果物はリポジトリ直下の `target/release/bundle/`、macOS arm64は `target/aarch64-apple-darwin/release/bundle/` に生成される。`apps/desktop/src-tauri/target/` を探すと生成に成功しても成果物を保存できない。成果物が0件ならCIを失敗させ、3OSの成果物を7日間保存する。

検証担当は、対象CIの実行番号とソースSHAを固定し、3OSの成果物が存在することと、取得したファイルのバイト数・SHA256を照合する。CIの成果物保存は一般公開や署名の証明ではない。対応OSでの署名・導入・起動・更新・削除を確認するまで、販売のM7を完了としない。

## M7-Aの手動署名候補工程（準備コード、実署名は未実施）

`.github/workflows/desktop-signed-candidate.yml` とGoの `tools/desktop-release-check/` を使う。親が差分をレビューしてmainへ統合した後、既存の署名環境が確認できたときだけ起動する。この有限実装では起動、鍵生成・取得、環境登録、支出、タグ、Release、公開を行わない。

### 起動できるソース

非公開の `AutoDevJapan/PassShare` の `refs/heads/main` で手動起動する。入力 `source_sha` は起動時mainの40桁SHAそのもの。workflow SHA、checkout SHAも同じでなければ失敗する。古いmainコミットを入力して動かす仕様ではない。mainが進んだ場合は、その時点のソースとworkflowを再レビューしてから起動する。fork、PR、別ブランチ、公開リポジトリには署名秘密を渡さない。

通常の `desktop-build.yml` は引き続き3OSの無署名インストーラを作る。新しいGo検査の回帰テストだけを通常CIへ接続し、署名秘密不足を通常CIの失敗理由にしない。両workflowのcontents権限はreadだけ。

### 既存環境の必要条件

| 対象 | 必要な既存環境・公開設定 | 実際に確認すること |
|---|---|---|
| 更新署名（全OS） | `TAURI_SIGNING_PRIVATE_KEY`、必要なら `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 現行公開鍵で実成果物の `.sig` を検証する。別鍵なら失敗 |
| Windows x64 | 専用runnerラベル `passshare-windows-signing`。発行元が対応するCSP/KSP等を構成済みの `CurrentUser/My` コード署名証明書、Windows SDK signtool、7-Zip | 秘密鍵利用可能、EKU、期限、オンラインchain、発行元subject、thumbprint。完成したNSISと内部アプリのAuthenticode、timestamp、版、内部アプリとビルド本体のバイト一致 |
| macOS arm64 | 専用runnerラベル `passshare-macos-signing`。有効なDeveloper ID Applicationと既存のnotarytool keychain profile、Xcode CLI tools | 署名identityとteam、公証提出成功、staple。更新archiveから展開した実appの版・identifier・codesignのApple chain/Developer ID/team・Gatekeeper・公証ticket |
| Linux x64 | 専用runnerラベル `passshare-linux-signing`、Ubuntu 22.04、既存CIと同じビルド依存、FUSE2 | AppImage全体の更新署名、同時生成debの版・architecture、deb内アプリとビルド本体の全バイト一致、AppImage内アプリとdeb内アプリのELFコード・静的データの一致。debは照合用で、無署名debを候補へ保存しない |

Windowsの公開設定は `DESKTOP_WINDOWS_CERT_THUMBPRINT`（40桁hex）、`DESKTOP_WINDOWS_PUBLISHER_SUBJECT`（証明書の実subject）、`DESKTOP_WINDOWS_TIMESTAMP_URL`（発行元が指定したHTTPS timestamp）。macOSは `DESKTOP_APPLE_SIGNING_IDENTITY`、`DESKTOP_APPLE_TEAM_ID`（10桁）、`DESKTOP_MACOS_NOTARY_PROFILE`（既存keychain profileの名前）。全OS環境の準備を確認するまで `DESKTOP_WINDOWS_SIGNING_READY`、`DESKTOP_MACOS_SIGNING_READY`、`DESKTOP_LINUX_SIGNING_READY` をtrueにしない。この実装は設定の登録を行わず、特定providerの秘密値も仮定しない。入口の一般runnerには秘密を渡さず、既存更新鍵の有無は各専用署名runnerのビルド工程で確認する。準備フラグがtrueでも実証明書・署名検査を省略しない。

署名runnerはこのリポジトリの信頼したmainだけで使う専用の使い捨てrunnerとし、fork/PRのジョブを受けない。checkoutと生成先は作業ごとに新しくする。runnerの資格とkeychainは管理対象の既存環境として扱い、候補ツールが取得・輸出・登録しない。作業終了時はrunnerとその作業用ファイルを破棄する。既存のWindows証明書をPFXへ輸出してGitHubへ取り込む手順は採用していない。

[TauriのWindows署名](https://v2.tauri.app/distribute/sign/windows/)は2023年6月より前のOV向け手順と現行の発行元対応を区別している。本工程のstore経由の署名が実発行元で使えるかは、その発行元の資料と実機で確認する。対応できない発行元には検証済みの専用adapterを追加して再レビューする。自由文字列のsignCommandを入力する工程へ置き換えない。現在のsignCommandは[公式のobject形式](https://v2.tauri.app/reference/config/#customsigncommandconfig)で、Go署名サブコマンドとファイルpathのargvを固定する。

macOSは[TauriのDeveloper ID手順](https://v2.tauri.app/distribute/sign/macos/)に従って既存keychainを使う。AppleのパスワードをCLI引数へ渡さないため、公証は[Appleのnotarytool/keychain profile手順](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)を別工程で呼ぶ。Tauriで作った署名appを公証・stapleした後、更新archiveを作り、Tauri signerへ秘密を環境変数で渡す。公証前の中間appは成果物に保存しない。

Linuxの[linuxdeploy実装](https://github.com/linuxdeploy/linuxdeploy/blob/master/src/core/appdir.cpp)はstripとRPATH変更を行うため、AppImage内アプリと元ELFの全ファイル一致は要求しない。実ELFのentry・architecture・全実行sectionと静的データ・初期化配列・build-idを照合し、loader用のdynamic/string tableやdebug配置を同一バイトとは主張しない。AppImage全体の真正性は独立固定した現行公開鍵の署名で確認する。このコード・データ照合は再現ビルドの証明ではない。

### 検査と保存

1. 秘密を渡す前にmain・workflow・入力SHA・非公開を検査する。ソースのDesktop package/Tauri/Cargo版と、独立固定した現行公開鍵を照合する。
2. 全OSの署名runner準備フラグが無ければ入口で失敗する。専用のOS runnerで既存更新秘密鍵と実署名環境を確認し、不足があれば失敗する。未署名候補へ切り替える工程はない。
3. ソース版のまま、公開されたOS署名設定だけで中間本体をビルドする。更新秘密鍵はfrontend/Cargo/OS署名/公証の子プロセスから外し、実本体を更新署名するTauri signerだけへ環境変数で渡す。Macは公証とstapleも先に行う。[更新署名](https://v2.tauri.app/plugin/updater/)を現行公開鍵で確認するまで候補ビルド成功とせず、中間ファイルをアップロードしない。追加設定はrunnerの一時領域だけ。署名工程の子プロセスのstdout/stderrは破棄し、秘密を含むログを別ファイルにも保存しない。
4. Goが実ファイルの署名を確認する。ファイル名や作成manifestの一致だけでは通さない。WindowsはOS信頼と発行元・timestamp、Macは展開済みの実appと公証、Linuxは署名されたAppImageと版付きpackageの実バイトを検査する。
5. 検査中・保存時の改ざんを再検査し、本体と `.sig` と `evidence.json` だけを新しい専用領域へ保存する。その領域だけを7日間のCI成果物へ保存する。署名・版・鍵・ソースのいずれかが違えば成功証拠は作らない。

証拠の `candidate_verified: true` は、そのOSの候補検査に限る。`published` と `install_update_uninstall_verified` は常にfalse。OS検査を動かしていない場合、そのOSの成功結果を作らない。JSONのsource SHAはGitHub実行の由来であり、再現ビルド証明や第三者の署名証明ではない。

取得する担当は、対象repository、workflowのpath、手動起動、main、固定SHA、run attempt、全3OSジョブのsuccessを先にGitHubの読み取り専用metadataで照合する。候補は一度だけ取得し、取得した本体のSHA256と証拠、現行公開鍵による署名、各OSの実検査を照合する。JSONだけを見て由来や成功を認めない。既存の古い公開setupを再取得して新候補の検査へ読み替えない。

### 未達と公開後の確認

親の監査では旧公開Windows setupはNotSigned/版1.1、更新URLの `latest.json` はHTTP404、署名secretはmetadata17件中0件だった。これらを新しい候補の成功へ読み替えない。Firefox配布の不一致もこのDesktop工程では解消しない。

本実装は版0.1.0と現行公開鍵を保持する。署名済み新候補、全3OSの実導入・起動・更新・削除、実更新manifest、実配布URLはまだ確認できていない。署名の候補検査だけでM7や原22全体を完了にしない。

公開の判断後は別工程で、実在するHTTPS manifestと対象URLから取得した実バイトを確認する。HTTP200だけでは不足し、manifestの全対象・版・公開署名、取得した本体の署名と版・SHA256を確認し、各OSで旧版から実更新する。未来の架空URLや生成したmanifestとの自己照合を有効な配布と数えない。このworkflowは `latest.json` を生成せず、公開URLを作る権限も持たない。

### Go回帰テスト（署名秘密不要）

PCではsafe-deleteで作った所有記録付き一時フォルダーを `TEST_SCRATCH` に指定してから実行する。CIではrunnerの一時領域を指定する。

```powershell
cd tools/desktop-release-check
# TEST_SCRATCH is a caller-owned safe-delete directory (PC) or runner temp (CI).
go test -mod=readonly ./...
go vet ./...
```

既存の公開署名vectorを使い、実minisign署名の成功、改ざん・unsigned・別公開鍵の拒否、版・checkout SHA・信頼できないrefの拒否を確認する。Windowsでは生成された未署名Goテスト実行ファイルを実Authenticode検査で拒否する。これらは製品の実署名成功ではない。macOS/Linuxのネイティブ署名候補検査は、対応OSで実行して初めて成功として記録する。
