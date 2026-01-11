/**
 * PassShare error classes.
 */

export class PassShareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PassShareError';
  }
}

export class NotFoundError extends PassShareError {
  public readonly secretName: string;

  constructor(name: string) {
    super(`Secret not found: ${name}`);
    this.name = 'NotFoundError';
    this.secretName = name;
  }
}

export class DecryptError extends PassShareError {
  constructor(message: string = 'Decryption failed') {
    super(message);
    this.name = 'DecryptError';
  }
}

export class EncryptError extends PassShareError {
  constructor(message: string = 'Encryption failed') {
    super(message);
    this.name = 'EncryptError';
  }
}

export class StorageError extends PassShareError {
  public readonly path?: string;

  constructor(message: string, path?: string) {
    super(message);
    this.name = 'StorageError';
    this.path = path;
  }
}

export class ConfigError extends PassShareError {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class NotInitializedError extends PassShareError {
  public readonly storePath?: string;

  constructor(storePath?: string) {
    const message = storePath
      ? `Store not initialized: ${storePath}`
      : 'Store not initialized';
    super(message);
    this.name = 'NotInitializedError';
    this.storePath = storePath;
  }
}

export class GitError extends PassShareError {
  public readonly command?: string;

  constructor(message: string, command?: string) {
    super(message);
    this.name = 'GitError';
    this.command = command;
  }
}

export class RecipientError extends PassShareError {
  public readonly keyId?: string;

  constructor(message: string, keyId?: string) {
    super(message);
    this.name = 'RecipientError';
    this.keyId = keyId;
  }
}
