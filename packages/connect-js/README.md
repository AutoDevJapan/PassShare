# @passshare/connect

1Password Connect API compatible TypeScript client.

```typescript
import { ConnectClient } from "@passshare/connect";

const client = ConnectClient.fromEnv();
const item = await client.getItem(vaultId, itemId);
```

Environment: `OP_CONNECT_HOST`, `OP_CONNECT_TOKEN`.
