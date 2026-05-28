# Mobile Share Sheet

> Issue [#84](https://github.com/AutoDevJapan/PassShare/issues/84) — **Phase 2 stub in v2.0 scaffold**

## Scope (future)

| Platform | Entry |
|----------|-------|
| iOS | Share Extension |
| Android | `ACTION_SEND` intent filter |

## v2.0 status

- Settings screen documents planned share-sheet flow
- No native share extension target in initial scaffold

## Acceptance (target)

```gherkin
Given text selected in another app
When the user shares to PassShare
Then a secure note or login draft is created
```
