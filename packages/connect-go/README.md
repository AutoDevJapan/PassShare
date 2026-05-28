# passshare-connect (Go)

1Password Connect API compatible Go client for PassShare.

SSOT: [developer-sdk.md](../../documents/guides/developer-sdk.md)

## Usage

```go
package main

import (
    "fmt"
    "log"

    connect "github.com/autodevjapan/passshare/packages/connect-go"
)

func main() {
    client, err := connect.FromEnv()
    if err != nil {
        log.Fatal(err)
    }

    vaults, err := client.ListVaults()
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("vaults: %d\n", len(vaults))
}
```

## Environment

| Variable | Description |
|----------|-------------|
| `OP_CONNECT_HOST` | Backend URL |
| `OP_CONNECT_TOKEN` | Bearer token |

## Test

```bash
cd packages/connect-go && go test ./...
```
