# passshare-connect (Go)

1Password Connect API compatible Go client.

```go
client, err := connect.FromEnv()
item, err := client.GetItem(vaultID, itemID)
```

Environment: `OP_CONNECT_HOST`, `OP_CONNECT_TOKEN`.
