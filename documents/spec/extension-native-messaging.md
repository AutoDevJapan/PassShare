# Extension Native Messaging Specification

Status: Stub (Issue [#96](https://github.com/AutoDevJapan/PassShare/issues/96))

## Goal

Optional path for Desktop users with local `.pbox` only — extension delegates unlock/fill to Tauri Desktop via Chrome Native Messaging host.

## v2.0 scope

- Host manifest template: `apps/desktop/native-host/com.passshare.desktop.json`
- Extension settings displays Phase 2 notice
- **Connect API remains primary** per [ADR 003](../adr/003-multi-client-architecture.md)

## Message envelope (draft)

```json
{
  "version": 1,
  "action": "list_items",
  "requestId": "uuid",
  "payload": {}
}
```

Responses must not include long-lived tokens in extension storage.

## Acceptance criteria (Phase 2)

```gherkin
Given Desktop is running with native host registered
When the extension requests items via Native Messaging
Then items are returned without writing master password to extension storage
```
