# ADR 005: Mobile Platform Selection (Tauri Mobile vs Capacitor)

## Status

Accepted (2026-05-28) — Issue [#78](https://github.com/AutoDevJapan/PassShare/issues/78)

## Context

Epic [#33](https://github.com/AutoDevJapan/PassShare/issues/33) requires iOS / Android clients for App Store / Google Play submission. [ADR 003](./003-multi-client-architecture.md) pre-selected **Tauri v2 Mobile** as the first candidate with `shared/ui` + React and Connect API as the data layer.

We evaluated:

| Option | Pros | Cons |
|--------|------|------|
| **Tauri v2 Mobile** | Same Rust/Tauri stack as Desktop; reuse `tauri-plugin-biometry`; shared React UI; single monorepo | Mobile tooling newer; iOS build requires macOS |
| **Capacitor + React** | Mature store tooling; large ecosystem | Second native bridge; duplicate from Desktop Tauri; biometry via separate plugins |

## PoC Summary

| Criterion | Tauri Mobile | Capacitor |
|-----------|--------------|-----------|
| Shared UI (`shared/ui`, i18n) | ✅ Same Vite + React | ✅ Same |
| Biometric unlock (Issue [#82](https://github.com/AutoDevJapan/PassShare/issues/82)) | ✅ Existing `tauri-plugin-biometry` | ⚠️ Separate plugin per platform |
| Connect API client | ✅ `packages/connect-js` | ✅ |
| Desktop code reuse | ✅ `mobile_entry_point` pattern proven in `apps/desktop` | ❌ |
| CI smoke (Rust + TS) | ✅ `cargo test -p passshare-mobile` | Web-only unit tests |
| Store submission | ✅ via Xcode / Gradle (Tauri bundle) | ✅ |

**PoC result:** Tauri v2 Mobile meets all Must requirements with lowest duplication vs Desktop.

## Decision

Adopt **Tauri v2 Mobile** in `apps/mobile/`:

1. **UI:** React + `shared/ui` + `shared/i18n` (same as Desktop/Web patterns)
2. **Data:** Connect API only via `packages/connect-js` (no local `.pbox` in v2.0)
3. **Auth:** Mobile JSON flow per [ADR 004](./004-auth-authorization-model.md) — `refreshToken` + `connectAccessToken`, stored in OS Secure Storage ([#80](https://github.com/AutoDevJapan/PassShare/issues/80))
4. **Biometrics:** `tauri-plugin-biometry` for app unlock ([#82](https://github.com/AutoDevJapan/PassShare/issues/82))
5. **Autofill / Share:** Native extensions documented as Phase 2 stubs ([#83](https://github.com/AutoDevJapan/PassShare/issues/83), [#84](https://github.com/AutoDevJapan/PassShare/issues/84)); full Credential Provider / Autofill Service in follow-up Epic

## Consequences

### Positive

- Single Rust + React skill set across Desktop and Mobile
- Biometric plugin reuse from Epic [#29](https://github.com/AutoDevJapan/PassShare/issues/29)
- Consistent design system and i18n

### Negative

- iOS CI builds require macOS runners
- OS autofill requires additional native targets (documented, not blocking scaffold)

## References

- [ADR 003: Multi-client architecture](./003-multi-client-architecture.md)
- [ADR 004: Auth model](./004-auth-authorization-model.md)
- [mobile-ui.md](../spec/mobile-ui.md)
- Issue [#78](https://github.com/AutoDevJapan/PassShare/issues/78)–[#86](https://github.com/AutoDevJapan/PassShare/issues/86)
