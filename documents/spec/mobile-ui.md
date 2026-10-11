# Mobile UI Specification

> Issue [#81](https://github.com/AutoDevJapan/PassShare/issues/81) / Epic [#33](https://github.com/AutoDevJapan/PassShare/issues/33)

## Layout

| Breakpoint | Layout |
|------------|--------|
| ≤640px | Single column, bottom navigation, tap targets ≥44px |

## Screens

1. **Login** — email/password, signup toggle
2. **App lock** — biometric + PIN fallback ([#82](https://github.com/AutoDevJapan/PassShare/issues/82))
3. **Vault list** — password boxes from Connect API
4. **Items** — `shared/ui` `ItemForm` + `ConnectItemList` CRUD
5. **Settings** — biometrics status, secure-storage status, logout, autofill/share stubs

## Secret at rest ([#321](https://github.com/AutoDevJapan/PassShare/issues/321))

- **Secrets** (`refresh-token`, Connect access token) are stored only in the
  OS-backed secure store (`secure-storage.ts`). When no secure backend is
  available they are held in an in-memory session store and are **never** written
  to `localStorage`/disk in plaintext; Settings surfaces `isSecureStorageAvailable()`.
- **App-lock PIN** (`app-lock.ts`) is stretched with salted PBKDF2-SHA256
  (per-device random salt, high iteration count), requires 6–8 digits, and applies
  a failure counter with exponential lockout backoff. Legacy unsalted SHA-256
  records are discarded on read and force re-enrollment.

## Shared components

Encrypted item/attachment mode uses [the shared cross-client runtime](cross-client-encrypted-items-ui.md)
with the formal mobile session and native lock generation. Connect remains the compatibility transport;
it is never an encrypted-mode fallback. Native acceptance remains a separate parent integration check.

- `shared/ui/ItemForm`, `ConnectItemList`, `CategoryPicker`
- `shared/i18n` keys under `mobile.*`

## Acceptance

```gherkin
Given an authenticated mobile user
When they open a password box
Then they can create, edit, and delete items

Given a mobile viewport ≤640px
When the vault list renders
Then bottom navigation is visible
```
