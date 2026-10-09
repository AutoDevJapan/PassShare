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

## Encrypted session transport (M4)

`NewEncryptedSessionClient(host, sessionBearer)` creates a separate client for
`/api/encrypted`. Supply the **session bearer**, not `OP_CONNECT_TOKEN` or a
Connect token. The legacy `Client` and its environment configuration are unchanged.
Go 1.22 and the standard library are sufficient; no dependencies were added.

```go
ctx := context.Background()
client, err := connect.NewEncryptedSessionClient(host, sessionBearer)
if err != nil {
    return err
}
// envelope and expectedContext must come from the caller's Rust Core/WASM
// integration. The complete item DTO is encrypted there, including arrays,
// attachment metadata and arbitrary payload; never project it into a subset.
stored, err := client.PutItem(ctx, boxID, itemID, expectedVersion, envelope)
if err != nil {
    return err
}
if err := stored.ValidateContext(expectedContext); err != nil {
    return err
}
// Authenticate/decrypt with Core using that SAME independent expectedContext.
```

All operations take `context.Context`: `State`, `EnableEmptyBox`, `SetupEmptyBox`,
`List`, `GetItem`, `PutItem`, `DeleteItem`, `GetOwnerKey`, `PutOwnerKey`.
`List` takes a nullable `*string` cursor. `PutOwnerKey` takes a nullable `*string`
login password: nil for creation, nonempty for replacement. It is separate from
the encrypted bundle and is never the encryption password. `SetupEmptyBox`
atomically enables an empty パスワードボックス and saves its initial owner bundle.

The client transports opaque ciphertext and public metadata only. It performs
no encryption, decryption, KDF, key storage or plaintext transport. `GetItem`
checks box/item and structural version/epoch bounds; the caller must separately
bind version/epoch using `ValidateContext` and authenticate with Core. Never build
the expected context from the returned envelope. `GetOwnerKey` requires an
independent expected owner context and accepts only `{bundleVersion,bundle}`.

HTTPS is required except literal localhost/127.0.0.1/[::1] HTTP. A proxy URL path
prefix is supported, but ambient proxies/cookies and all redirects are disabled.
Timeout is 30 seconds; no automatic retries, including conflicts and exact
server replay, are enabled. Responses are bounded to 1.5 MiB, errors to 64 KiB.
Only HTTP 200 JSON or DELETE's empty 204 succeeds. DELETE rejects observable
Transfer-Encoding, nonzero Content-Length and exposed body bytes. Go's
`net/http` may hide undeclared bytes after a 204; this is not a guarantee of
detecting every malformed wire body. Connections are not reused.

`EncryptedSessionError` exposes only `HTTPStatus()` and a strict `PSnnn` `Code()`
for API failures; other errors have fixed local messages. Client formatting is
redacted and retains no URL/network error text. Do not log request bodies or the
separate login-password argument. Go strings/HTTP buffers are not securely erased.

See [Go transport contract](../../documents/spec/encrypted-session-go.md).
The added `httptest` cases have **not been run in this implementation job**.
The parent must run `go test ./...`, `go test -race ./...`, `go vet ./...`, formal
Core/server interoperability, independent review and CI before merging.
Root source approval does not complete all client integration, shared keys,
recovery, migration, encrypted attachments or M4 as a whole.
