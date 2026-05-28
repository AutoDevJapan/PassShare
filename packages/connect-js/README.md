# @passshare/connect

1Password Connect API compatible TypeScript client for PassShare.

SSOT: [developer-sdk.md](../../documents/guides/developer-sdk.md) · OpenAPI: [connect-api.yaml](../../documents/spec/openapi/connect-api.yaml)

## Install

```bash
pnpm add @passshare/connect
# monorepo: file:../packages/connect-js
```

## Quick start

```typescript
import { ConnectClient } from "@passshare/connect";

const client = ConnectClient.fromEnv();
// or: new ConnectClient({ host: "https://...", token: "..." })

const vaults = await client.listVaults();
const items = await client.listItems(vaults[0].id);
const item = await client.getItem(vaults[0].id, items[0].id);
```

## CRUD example

```typescript
const created = await client.createItem(vaultId, {
  category: "LOGIN",
  title: "Example",
  fields: [
    { id: "username", type: "STRING", purpose: "USERNAME", label: "username", value: "user@example.com" },
    { id: "password", type: "CONCEALED", purpose: "PASSWORD", label: "password", value: "secret" },
  ],
});

await client.patchItem(vaultId, created.id, [
  { op: "replace", path: "/title", value: "Updated title" },
]);

await client.deleteItem(vaultId, created.id);
```

## 1PUX import

```typescript
const result = await client.import1pux(vaultId, base64Payload);
console.log(`Imported ${result.imported} items`);
```

## Environment

| Variable | Description |
|----------|-------------|
| `OP_CONNECT_HOST` | Backend base URL (with or without `/v1` suffix) |
| `OP_CONNECT_TOKEN` | Bearer token |

## Test

```bash
pnpm install && pnpm test
```

Types are generated from OpenAPI: `pnpm --dir backend run generate:types`
