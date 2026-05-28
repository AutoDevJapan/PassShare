# 開発者向け SDK ドキュメント

> Issue [#116](https://github.com/AutoDevJapan/PassShare/issues/116)  
> 最終更新: 2026-05-28

## OpenAPI SSOT

| 成果物 | パス |
|--------|------|
| OpenAPI 3 | [connect-api.yaml](../spec/openapi/connect-api.yaml) |
| 互換仕様 | [1password-connect-compatibility.md](../spec/1password-connect-compatibility.md) |
| 型生成 | `pnpm --dir backend run generate:types` → `packages/connect-js/src/generated/connect-api.ts` |

## 環境変数（全 SDK 共通）

| 変数 | 説明 |
|------|------|
| `OP_CONNECT_HOST` | Backend URL（例: `https://pass-share-backend-staging.up.railway.app/v1`） |
| `OP_CONNECT_TOKEN` | Connect API Bearer トークン |

Web 認証後は `/auth/connect-token` で per-user トークンを取得します。

## TypeScript — `@passshare/connect`

パス: `packages/connect-js/`  
README: [packages/connect-js/README.md](../../packages/connect-js/README.md)

```typescript
import { ConnectClient } from "@passshare/connect";

const client = new ConnectClient({
  host: process.env.OP_CONNECT_HOST!,
  token: process.env.OP_CONNECT_TOKEN!,
});

const vaults = await client.listVaults();
const item = await client.getItem(vaultId, itemId);
await client.import1pux(vaultId, base64Payload);
```

## Python — `passshare-connect`

パス: `packages/connect-python/`  
README: [packages/connect-python/README.md](../../packages/connect-python/README.md)

## Go — `passshare-connect`

パス: `packages/connect-go/`  
README: [packages/connect-go/README.md](../../packages/connect-go/README.md)

## Rust — `passshare-connect`

パス: `crates/passshare-connect/`  
Cargo: `passshare-connect`

```rust
use passshare_connect::ConnectClient;

let client = ConnectClient::from_env()?;
let vaults = client.list_vaults().await?;
```

## op CLI

```powershell
cargo build -p op-cli --release
# OP_CONNECT_HOST / OP_CONNECT_TOKEN を設定して op item list ...
```

## CI

- Connect 型 drift: `quality-gate.yml` → job `connect-types`
- connect-js tests: `pnpm --dir packages/connect-js test`

## 関連

- [connect-api-gap-analysis.md](../spec/connect-api-gap-analysis.md)
- [ADR 003](../adr/003-multi-client-architecture.md)
