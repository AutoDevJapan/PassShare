# PassShare

A gopass-compatible password manager for teams and individuals.

**© 2026 株式会社BM1314. All rights reserved.**

## Features

- **gopass/pass compatible**: Works with existing password stores
- **GPG & Age encryption**: Choose your preferred encryption backend
- **Git integration**: Automatic version control and sync
- **Team sharing**: Multiple recipients for shared secrets
- **CLI & API**: Use from command line or programmatically

## Installation

```bash
pip install passshare
```

## Quick Start

### Initialize a new store

```bash
passshare init 0xYOURGPGKEY
```

### Add a secret

```bash
passshare insert email/gmail
```

### Show a secret

```bash
passshare show email/gmail
```

### Generate a password

```bash
passshare generate website/example 24
```

### List all secrets

```bash
passshare list
```

## API Usage

```python
from passshare import Gopass, Secret

# Initialize
gopass = Gopass()

# Get a secret
secret = gopass.get("email/gmail")
print(secret.password)
print(secret.get("username"))

# Create a new secret
new_secret = Secret(
    password="super-secret",
    data={"username": "user@example.com"}
)
gopass.set("new/secret", new_secret)

# Generate a password
password = gopass.generate("another/secret", length=32)
```

## Commands

| Command | Description |
|---------|-------------|
| `show` | Show a secret |
| `insert` | Add a new secret |
| `edit` | Edit an existing secret |
| `delete/rm` | Delete a secret |
| `generate` | Generate a password |
| `list/ls` | List secrets |
| `find/search` | Find secrets by name |
| `grep` | Search secret contents |
| `copy/cp` | Copy a secret |
| `move/mv` | Move a secret |
| `sync` | Sync with remote |
| `init` | Initialize a new store |
| `config` | Manage configuration |
| `mounts` | Manage mount points |
| `recipients` | Manage recipients |
| `otp` | Generate OTP codes |
| `audit` | Audit password strength |
| `pwgen` | Generate standalone passwords |
| `history` | Show secret history |
| `completion` | Generate shell completion |

## Configuration

Configuration file: `~/.config/gopass/config`

```yaml
autoclip: true
cliptimeout: 45
autosync: true
path: ~/.local/share/gopass/stores/root
mounts:
  work: ~/.local/share/gopass/stores/work
```

## License

MIT License
