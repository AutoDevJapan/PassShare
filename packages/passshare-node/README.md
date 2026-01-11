# passshare

A gopass-compatible password manager CLI for teams and individuals.

**© 2026 株式会社BM1314. All rights reserved.**

## Installation

```bash
npm install -g passshare
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
# or just
passshare email/gmail
```

### Generate a password

```bash
passshare generate website/example 24
```

### List all secrets

```bash
passshare list
# or
passshare ls
```

## Commands

| Command | Description |
|---------|-------------|
| `show` | Show a secret |
| `insert` | Add a new secret |
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

## Options

### Global Options

- `-V, --version` - Show version
- `-h, --help` - Show help

### Show Options

- `-c, --clip` - Copy to clipboard
- `-o, --password` - Show password only
- `-r, --revision <rev>` - Show specific revision

### Generate Options

- `-c, --clip` - Copy to clipboard
- `-f, --force` - Overwrite existing
- `-n, --no-symbols` - No symbols
- `-x, --xkcd` - XKCD-style password

## License

MIT License
