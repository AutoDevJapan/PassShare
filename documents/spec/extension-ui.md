# Extension UI Specification

Status: Implemented (Issue [#89](https://github.com/AutoDevJapan/PassShare/issues/89))

## Layout

| Surface | Size | Notes |
|---------|------|-------|
| Popup | **320px min width**, 360px default | Must not overflow horizontally |
| Nav buttons | 44px min tap target | Items / Settings |

## Screens

1. **Login** — email/password, signup toggle, i18n (ja/en)
2. **Items** — search, copy username/password, password generator
3. **Settings** — locale switch, logout, Native Messaging stub message

## Shared components

- `shared/ui/MatrixBackground`
- `shared/styles/*` design tokens
- `shared/i18n` keys prefixed with `extension.*`

## Acceptance criteria

```gherkin
Given the popup at 320px width
When the user opens Items after login
Then search and copy actions are visible without horizontal scroll

Given locale is switched to English
When the login screen renders
Then all labels use English extension.* keys
```
