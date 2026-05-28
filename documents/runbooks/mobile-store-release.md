# Mobile Store Release Runbook

> Issue [#85](https://github.com/AutoDevJapan/PassShare/issues/85) / Epic [#33](https://github.com/AutoDevJapan/PassShare/issues/33)

## Prerequisites

- Apple Developer Program + Google Play Console accounts
- App icons and screenshots (`apps/mobile/src-tauri/icons/`)
- Privacy policy URL (Epic [#37](https://github.com/AutoDevJapan/PassShare/issues/37) / [#113](https://github.com/AutoDevJapan/PassShare/issues/113))

## Local build

```powershell
cd apps/mobile
pnpm install
pnpm --dir ../../packages/connect-js run build
pnpm run build
cargo tauri android build   # requires Android SDK
cargo tauri ios build       # requires macOS + Xcode
```

Set `VITE_API_BASE_URL` to production API before release builds.

## App Store Connect

1. Create app record `com.passshare.mobile`
2. Upload `.ipa` from Tauri iOS bundle
3. Complete privacy questionnaire (no master password leaves device)
4. Submit for review

## Google Play

1. Create app in Play Console
2. Upload `.aab` from Tauri Android bundle
3. Complete Data safety form
4. Submit to internal testing → production

## CI

`mobile-build.yml` runs smoke tests on every PR. Signed store uploads are manual until release signing secrets are configured.

## Review notes template

- PassShare is a password manager; account password is separate from item secrets
- Biometric unlock protects the local app session
- Connect API traffic uses HTTPS + Bearer tokens scoped per user
