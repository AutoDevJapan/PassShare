/**
 * Types for Seed scanning and credential extraction.
 */

/**
 * A detected credential from a seed file.
 */
export interface DetectedCredential {
  /** Source file path */
  file: string;
  /** Line number where detected (if available) */
  line?: number;
  /** The field name (e.g., 'email', 'password') */
  field: string;
  /** The detected value */
  value: string;
  /** Context (e.g., parent object key, array index) */
  context?: string;
}

/**
 * A grouped set of credentials that belong together.
 * For example, email + password from the same user object.
 */
export interface CredentialGroup {
  /** Source file path */
  file: string;
  /** Suggested name for this credential (e.g., 'users/alice') */
  name: string;
  /** Email or username */
  email?: string;
  /** Password */
  password?: string;
  /** Additional fields (token, api_key, etc.) */
  extras: Record<string, string>;
}

/**
 * Result of scanning a directory.
 */
export interface ScanResult {
  /** Project/vault name */
  projectName: string;
  /** Root directory that was scanned */
  rootDir: string;
  /** All detected credential groups */
  credentials: CredentialGroup[];
  /** Files that were scanned */
  scannedFiles: string[];
  /** Files that were skipped (e.g., binary, too large) */
  skippedFiles: string[];
  /** Errors encountered during scanning */
  errors: Array<{ file: string; error: string }>;
}

/**
 * Options for scanning.
 */
export interface ScanOptions {
  /** Custom fields to detect (in addition to defaults) */
  customFields?: string[];
  /** Maximum file size to scan (bytes, default 1MB) */
  maxFileSize?: number;
  /** Patterns to ignore (glob patterns) */
  ignorePatterns?: string[];
  /** Whether to include node_modules, .git, etc. */
  includeHidden?: boolean;
}

/**
 * Default fields to detect.
 */
export const DEFAULT_CREDENTIAL_FIELDS = [
  // Email
  'email',
  'mail',
  'e-mail',
  'user_email',
  'useremail',
  // Password
  'password',
  'pass',
  'passwd',
  'pwd',
  'user_password',
  'userpassword',
  // Username
  'username',
  'user',
  'login',
  'user_name',
  'userid',
  'user_id',
  // Tokens and secrets
  'token',
  'api_key',
  'apikey',
  'api-key',
  'secret',
  'secret_key',
  'secretkey',
  'credential',
  'access_token',
  'accesstoken',
  'refresh_token',
  'auth_token',
  'bearer_token',
  // Database
  'db_password',
  'database_password',
  'mysql_password',
  'postgres_password',
  'redis_password',
];

/**
 * Default ignore patterns.
 */
export const DEFAULT_IGNORE_PATTERNS = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.tox',
  '.venv',
  'venv',
  '.env.example',
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.lock',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
];
