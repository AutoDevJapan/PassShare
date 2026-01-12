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

// HIBP (Have I Been Pwned)
export {
  checkPassword as hibpCheckPassword,
  checkPasswordsBatch as hibpCheckPasswordsBatch,
  checkEmail as hibpCheckEmail,
  formatPwnedCount,
  type HIBPCheckResult,
  type HIBPBatchResult,
} from './hibp.js';

// Seed scanning
export {
  SeedScanner,
  scanDirectory,
  CredentialExtractor,
  parseFile,
  getSupportedExtensions,
  type ScanResult,
  type ScanOptions,
  type CredentialGroup,
  type DetectedCredential,
  DEFAULT_CREDENTIAL_FIELDS,
  DEFAULT_IGNORE_PATTERNS,
} from './seed/index.js';

// Templates
export {
  TemplateManager,
  defaultTemplateManager,
  BUILTIN_TEMPLATES,
  LOGIN_TEMPLATE,
  CREDIT_CARD_TEMPLATE,
  BANK_ACCOUNT_TEMPLATE,
  SSH_KEY_TEMPLATE,
  API_TOKEN_TEMPLATE,
  DATABASE_TEMPLATE,
  PASSPORT_TEMPLATE,
  DRIVERS_LICENSE_TEMPLATE,
  SOFTWARE_LICENSE_TEMPLATE,
  WIFI_TEMPLATE,
  SECURE_NOTE_TEMPLATE,
  IDENTITY_TEMPLATE,
  SERVER_TEMPLATE,
  type Template,
  type TemplateField,
  type TemplateManagerOptions,
} from './templates/index.js';

// Import/Export
export {
  Importer,
  importPasswords,
  type ImportSource,
  type ImportResult,
  type ImportOptions,
} from './importer.js';

export {
  Exporter,
  exportPasswords,
  type ExportFormat,
  type ExportResult,
  type ExportOptions,
} from './exporter.js';

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
