# @passshare/core

A gopass-compatible password manager for teams and individuals.

**© 2026 株式会社BM1314. All rights reserved.**

## Features

- **gopass/pass compatible**: Works with existing password stores
- **GPG & Age encryption**: Choose your preferred encryption backend
- **Git integration**: Automatic version control and sync
- **Team sharing**: Multiple recipients for shared secrets
- **TypeScript first**: Full type safety and IntelliSense support

## Installation

```bash
npm install @passshare/core
# or
pnpm add @passshare/core
```

## Quick Start

```typescript
import { Gopass, Secret } from '@passshare/core';

// Initialize
const gopass = new Gopass();

// Get a secret
const secret = await gopass.get('email/gmail');
console.log(secret.password);
console.log(secret.get('username'));

// Create a new secret
const newSecret = new Secret(
  'super-secret',
  { username: 'user@example.com' }
);
await gopass.set('new/secret', newSecret);

// Generate a password
const password = await gopass.generate('another/secret', { length: 32 });
console.log(password);

// List secrets
const secrets = await gopass.list();
secrets.forEach(name => console.log(name));
```

## API

### Gopass

The main entry point for password management.

```typescript
const gopass = new Gopass(configPath?: string);

// Secret operations
await gopass.get(name: string): Promise<Secret>
await gopass.set(name: string, secret: Secret): Promise<void>
await gopass.delete(name: string): Promise<void>
await gopass.exists(name: string): Promise<boolean>
await gopass.list(prefix?: string): Promise<string[]>

// Password generation
await gopass.generate(name: string, options?: GenerateOptions): Promise<string>

// Sync
await gopass.sync(store?: string): Promise<void>

// Mount management
gopass.mounts: Map<string, string>
gopass.mount(alias: string, path: string): void
gopass.unmount(alias: string): void
```

### Secret

Represents a secret with password, key-value data, and notes.

```typescript
const secret = new Secret(
  password: string,
  data?: Record<string, string>,
  body?: string
);

secret.password: string
secret.get(key: string): string
secret.set(key: string, value: string): void
secret.keys(): string[]
secret.body: string
secret.otp(): string | null
```

### Password Generation

```typescript
import { generatePassword } from '@passshare/core';

// Random password
const password = generatePassword({ length: 24, symbols: true });

// XKCD-style password
const xkcdPassword = generatePassword({ xkcd: true, xkcdWords: 4 });
```

### OTP Support

```typescript
import { TOTP, parseOtpUri } from '@passshare/core';

// From secret
const secret = await gopass.get('2fa/github');
const code = secret.otp();

// Manual
const totp = new TOTP('BASE32SECRET');
const code = totp.generate();
```

## License

MIT License
