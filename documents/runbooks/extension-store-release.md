# Browser Extension Store Release Runbook

> Issues [#92](https://github.com/AutoDevJapan/PassShare/issues/92)–[#95](https://github.com/AutoDevJapan/PassShare/issues/95) / Epic [#34](https://github.com/AutoDevJapan/PassShare/issues/34)

## Prerequisites

- Privacy policy URL (Epic [#37](https://github.com/AutoDevJapan/PassShare/issues/37) / [#113](https://github.com/AutoDevJapan/PassShare/issues/113))
- Extension icons (`packages/extension/public/icons/`)
- Store developer accounts (Google, Microsoft, Mozilla, Apple)

## Build

```powershell
cd packages/extension
pnpm install
pnpm --dir ../connect-js run build
pnpm run build
```

Set `VITE_API_BASE_URL` to production API before release builds.

Output: `packages/extension/dist/` (load unpacked in Chrome for QA).

## Chrome Web Store ([#92](https://github.com/AutoDevJapan/PassShare/issues/92))

1. Zip contents of `dist/` (manifest at root)
2. Upload to Chrome Developer Dashboard
3. Declare permissions: `storage`, `activeTab`, host access
4. Submit for review

## Edge Add-ons ([#93](https://github.com/AutoDevJapan/PassShare/issues/93))

1. Reuse the same MV3 zip
2. Upload to Partner Center → Edge Add-ons
3. Note Connect API HTTPS usage in review notes

## Firefox AMO ([#94](https://github.com/AutoDevJapan/PassShare/issues/94))

1. Upload MV3 build to AMO
2. Provide source code archive (this repo path `packages/extension/`)
3. Document data collection: auth tokens in `storage.local` only

## Safari Web Extension ([#95](https://github.com/AutoDevJapan/PassShare/issues/95))

1. Requires macOS + Xcode
2. Convert with `safari-web-extension-converter` (Apple tooling)
3. Ship via Mac App Store with Desktop bundle or standalone wrapper

## CI

`extension-build.yml` runs unit tests + production build on every PR. Store uploads remain manual until publisher API keys are configured.

## Review notes template

- PassShare is a password manager; secrets sync via user-scoped Connect API tokens
- Autofill runs only after explicit user action on matched credentials
- No third-party analytics in extension build
