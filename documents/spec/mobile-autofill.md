# Mobile OS Autofill

> Issue [#83](https://github.com/AutoDevJapan/PassShare/issues/83) — **Phase 2 stub in v2.0 scaffold**

## Scope (future)

| Platform | Integration |
|----------|-------------|
| iOS | ASCredentialProviderViewController (Password AutoFill) |
| Android | AutofillService |

## v2.0 status

- Settings screen displays planned integration notice
- Native extension targets are **not** bundled in the initial `apps/mobile` scaffold
- Full implementation tracked for post–Epic #33 follow-up

## Acceptance (target)

```gherkin
Given PassShare mobile with saved login items
When the user fills a login form in Safari/Chrome
Then credentials are offered via OS autofill
```
