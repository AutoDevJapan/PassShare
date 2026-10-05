# Desktop リリース Runbook

> Issue [#71](https://github.com/AutoDevJapan/PassShare/issues/71) / [#72](https://github.com/AutoDevJapan/PassShare/issues/72)

## 署名シークレット（GitHub Actions）

| Secret | 用途 |
|--------|------|
| `TAURI_SIGNING_PRIVATE_KEY` | 自動更新パッケージの署名（minisign 秘密鍵。Windowsの発行元署名とは別） |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 秘密鍵パスワード（任意） |
| `APPLE_CERTIFICATE` | macOS 証明書（base64 `.p12`） |
| `APPLE_CERTIFICATE_PASSWORD` | 証明書パスワード |
| `APPLE_SIGNING_IDENTITY` | Developer ID Application |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | Notarization |

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
- リリース時は `createUpdaterArtifacts: true` にし、GitHub Secrets（下表）を release ワークフローに渡す
- smoke: アプリ起動 → 設定 → 更新確認（ネットワーク接続時）

## CI

`desktop-build.yml`:

- `smoke`: `cargo test -p passshare-desktop smoke_`
- `build`: macOS / Ubuntu / Windows で `tauri-action` 実行、インストーラ artifact アップロード

Cargoのworkspace全体の出力先を使うため、成果物はリポジトリ直下の `target/release/bundle/`、macOS arm64は `target/aarch64-apple-darwin/release/bundle/` に生成される。`apps/desktop/src-tauri/target/` を探すと生成に成功しても成果物を保存できない。成果物が0件ならCIを失敗させ、3OSの成果物を7日間保存する。

検証担当は、対象CIの実行番号とソースSHAを固定し、3OSの成果物が存在することと、取得したファイルのバイト数・SHA256を照合する。CIの成果物保存は一般公開や署名の証明ではない。対応OSでの署名・導入・起動・更新・削除を確認するまで、販売のM7を完了としない。
