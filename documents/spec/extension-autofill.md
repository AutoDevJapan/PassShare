# Extension Autofill Specification

Status: Implemented (Issue [#90](https://github.com/AutoDevJapan/PassShare/issues/90))

## Flow

1. Content script listens for `focusin` on `input[type=password]`
2. Service worker loads LOGIN items for current hostname via Connect API
3. Floating panel (max 320px) lists up to 5 matches
4. User selects entry → username/password fields filled via DOM events

## Hostname matching

- Normalize `www.` prefix
- Page hostname equals item URL hostname **or** page is subdomain of item host

## Save proposal (Issue [#91](https://github.com/AutoDevJapan/PassShare/issues/91))

On form `submit` with password field:

1. Show bottom banner "Save this login to PassShare?"
2. **Save** → `POST` Connect item in default password box
3. **Dismiss** → remove banner

## Security

- Content script does not read extension storage directly
- Secrets fetched per request from service worker
- No persistent secret cache in content script

## Acceptance criteria

```gherkin
Given a LOGIN item with URL https://example.com
When the user focuses a password field on https://app.example.com
Then autofill panel shows the matching item

Given a submitted login form
When the user clicks Save on the banner
Then a new LOGIN item is created in Connect API
```
