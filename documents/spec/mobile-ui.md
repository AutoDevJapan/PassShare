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
5. **Settings** — biometrics status, logout, autofill/share stubs

## Shared components

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
