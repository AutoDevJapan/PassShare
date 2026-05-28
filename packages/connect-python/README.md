# passshare-connect (Python)

1Password Connect API compatible Python client for PassShare.

SSOT: [developer-sdk.md](../../documents/guides/developer-sdk.md)

## Install

```bash
pip install -e packages/connect-python
```

## Quick start

```python
import os
from passshare_connect import ConnectClient

client = ConnectClient(
    host=os.environ["OP_CONNECT_HOST"],
    token=os.environ["OP_CONNECT_TOKEN"],
)
# or: ConnectClient.from_env()

vaults = client.list_vaults()
items = client.list_items(vaults[0]["id"])
item = client.get_item(vaults[0]["id"], items[0]["id"])
```

## Environment

| Variable | Description |
|----------|-------------|
| `OP_CONNECT_HOST` | Backend URL |
| `OP_CONNECT_TOKEN` | Bearer token |

## Test

```bash
cd packages/connect-python && python -m pytest
```
