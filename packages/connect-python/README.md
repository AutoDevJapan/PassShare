# passshare-connect (Python)

1Password Connect API compatible Python client.

```python
from passshare_connect import ConnectClient

client = ConnectClient.from_env()
item = client.get_item(vault_id, item_id)
```

Environment: `OP_CONNECT_HOST`, `OP_CONNECT_TOKEN`.
