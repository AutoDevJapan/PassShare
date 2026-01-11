/**
 * PassShare - A gopass-compatible password manager for teams and individuals.
 *
 * © 2026 株式会社BM1314. All rights reserved.
 */

export { Gopass } from './gopass.js';
export { Secret } from './secret.js';
export { Config } from './config.js';
export { Store } from './store.js';

// Crypto backends
export { CryptoBackend } from './crypto/base.js';
export { GPGBackend } from './crypto/gpg.js';
export { AgeBackend } from './crypto/age.js';
export { PlainBackend } from './crypto/plain.js';

// Storage backends
export { StorageBackend } from './storage/base.js';
export { FSBackend } from './storage/fs.js';
export { GitFSBackend } from './storage/gitfs.js';

// Utilities
export { generatePassword, checkPasswordStrength } from './password.js';
export { copyToClipboard, clearClipboard } from './clipboard.js';
export { TOTP, HOTP, parseOtpUri } from './otp.js';

// Errors
export {
  PassShareError,
  NotFoundError,
  DecryptError,
  EncryptError,
  StorageError,
  ConfigError,
  NotInitializedError,
  GitError,
} from './errors.js';

// Version
export const VERSION = '1.0.0';
