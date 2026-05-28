# Desktop リリース Runbook

> Issue [#71](https://github.com/AutoDevJapan/PassShare/issues/71) / [#72](https://github.com/AutoDevJapan/PassShare/issues/72)

## 署名シークレット（GitHub Actions）

| Secret | 用途 |
|--------|------|
| `TAURI_SIGNING_PRIVATE_KEY` | Updater + Windows 署名（minisign 秘密鍵） |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 秘密鍵パスワード（任意） |
| `APPLE_CERTIFICATE` | macOS 証明書（base64 `.p12`） |
| `APPLE_CERTIFICATE_PASSWORD` | 証明書パスワード |
| `APPLE_SIGNING_IDENTITY` | Developer ID Application |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | Notarization |

シークレット未設定時は **未署名ビルド** が生成される（CI は green）。本番配布前に必ず設定する。

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
- smoke: アプリ起動 → 設定 → 更新確認（ネットワーク接続時）

## CI

`desktop-build.yml`:

- `smoke`: `cargo test -p passshare-desktop smoke_`
- `build`: macOS / Ubuntu / Windows で `tauri-action` 実行、インストーラ artifact アップロード
