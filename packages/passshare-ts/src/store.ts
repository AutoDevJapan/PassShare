/**
 * Store management for PassShare.
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as nodePath from 'path';
import { CryptoBackend } from './crypto/base.js';
import { GPGBackend } from './crypto/gpg.js';
import { AgeBackend } from './crypto/age.js';
import { StorageBackend } from './storage/base.js';
import { FSBackend } from './storage/fs.js';
import { GitFSBackend } from './storage/gitfs.js';
import { Secret } from './secret.js';
import { NotFoundError, NotInitializedError, StorageError } from './errors.js';

export class Store {
  private _path: string;
  private _crypto: CryptoBackend;
  private _storage: StorageBackend;
  private _recipients: string[] = [];

  /**
   * Create a new Store.
   *
   * @param path - The store path
   * @param crypto - The crypto backend (auto-detected if not specified)
   * @param storage - The storage backend (auto-detected if not specified)
   */
  constructor(
    path: string,
    crypto?: CryptoBackend,
    storage?: StorageBackend
  ) {
    this._path = path;
    this._crypto = crypto ?? this.detectCrypto();
    this._storage = storage ?? this.detectStorage();
    this.loadRecipients();
  }

  private detectCrypto(): CryptoBackend {
    const ageRecipients = nodePath.join(this._path, '.age-recipients');
    if (fs.existsSync(ageRecipients)) {
      return new AgeBackend();
    }
    return new GPGBackend();
  }

  private detectStorage(): StorageBackend {
    const gitDir = nodePath.join(this._path, '.git');
    const ext = this._crypto.ext;

    if (fs.existsSync(gitDir)) {
      return new GitFSBackend(this._path, ext);
    }
    return new FSBackend(this._path, ext);
  }

  private loadRecipients(): void {
    const idFile = nodePath.join(this._path, this._crypto.idFile);

    if (!fs.existsSync(idFile)) {
      return;
    }

    try {
      const content = fs.readFileSync(idFile, 'utf-8');
      this._recipients = content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));
    } catch {
      // Ignore errors
    }
  }

  private async saveRecipients(): Promise<void> {
    const idFile = nodePath.join(this._path, this._crypto.idFile);
    const content = this._recipients.join('\n') + '\n';
    await fsPromises.writeFile(idFile, content, 'utf-8');
  }

  /** Get the store path. */
  get path(): string {
    return this._path;
  }

  /** Get the crypto backend. */
  get crypto(): CryptoBackend {
    return this._crypto;
  }

  /** Get the storage backend. */
  get storage(): StorageBackend {
    return this._storage;
  }

  /** Get the recipients. */
  get recipients(): string[] {
    return [...this._recipients];
  }

  /**
   * Check if the store is initialized.
   *
   * @returns True if ready to use
   */
  async initialized(): Promise<boolean> {
    if (!(await this._storage.initialized())) {
      return false;
    }

    const idFile = nodePath.join(this._path, this._crypto.idFile);
    return fs.existsSync(idFile);
  }

  /**
   * Initialize the store.
   *
   * @param recipients - Initial recipient key IDs
   * @param storageType - Storage backend type ('gitfs' or 'fs')
   */
  async init(recipients: string[], storageType: string = 'gitfs'): Promise<void> {
    if (!recipients.length) {
      throw new StorageError('At least one recipient is required');
    }

    const ext = this._crypto.ext;

    if (storageType === 'gitfs') {
      this._storage = new GitFSBackend(this._path, ext);
    } else {
      this._storage = new FSBackend(this._path, ext);
    }

    await this._storage.init(this._path);

    this._recipients = recipients;
    await this.saveRecipients();

    if (this._storage instanceof GitFSBackend) {
      await this._storage.add([this._crypto.idFile]);
      await this._storage.commit('Initialize password store');
    }
  }

  /**
   * Get a secret.
   *
   * @param name - The secret name/path
   * @returns The decrypted secret
   */
  async get(name: string): Promise<Secret> {
    if (!(await this.initialized())) {
      throw new NotInitializedError(this._path);
    }

    const ciphertext = await this._storage.get(name);
    const plaintext = await this._crypto.decrypt(ciphertext);
    return Secret.fromBuffer(plaintext);
  }

  /**
   * Set a secret.
   *
   * @param name - The secret name/path
   * @param secret - The secret to save
   */
  async set(name: string, secret: Secret): Promise<void> {
    if (!(await this.initialized())) {
      throw new NotInitializedError(this._path);
    }

    const plaintext = secret.toBuffer();
    const ciphertext = await this._crypto.encrypt(plaintext, this._recipients);
    await this._storage.set(name, ciphertext);
  }

  /**
   * Delete a secret.
   *
   * @param name - The secret name/path
   */
  async delete(name: string): Promise<void> {
    if (!(await this.initialized())) {
      throw new NotInitializedError(this._path);
    }

    await this._storage.delete(name);
  }

  /**
   * Check if a secret exists.
   *
   * @param name - The secret name/path
   * @returns True if exists
   */
  async exists(name: string): Promise<boolean> {
    if (!(await this.initialized())) {
      return false;
    }

    return this._storage.exists(name);
  }

  /**
   * List secrets.
   *
   * @param prefix - Optional prefix to filter by
   * @returns List of secret names
   */
  async list(prefix: string = ''): Promise<string[]> {
    if (!(await this.initialized())) {
      return [];
    }

    return this._storage.list(prefix);
  }

  /**
   * Check if a path is a directory.
   *
   * @param name - The path to check
   * @returns True if directory
   */
  async isDir(name: string): Promise<boolean> {
    if (!(await this.initialized())) {
      return false;
    }

    return this._storage.isDir(name);
  }

  /**
   * Copy a secret.
   *
   * @param fromName - Source path
   * @param toName - Destination path
   * @param force - Overwrite if exists
   */
  async copy(fromName: string, toName: string, force: boolean = false): Promise<void> {
    if (!(await this.exists(fromName))) {
      throw new NotFoundError(fromName);
    }

    if ((await this.exists(toName)) && !force) {
      throw new StorageError(`Destination already exists: ${toName}`);
    }

    const secret = await this.get(fromName);
    await this.set(toName, secret);
  }

  /**
   * Move a secret.
   *
   * @param fromName - Source path
   * @param toName - Destination path
   * @param force - Overwrite if exists
   */
  async move(fromName: string, toName: string, force: boolean = false): Promise<void> {
    await this.copy(fromName, toName, force);
    await this.delete(fromName);
  }

  /**
   * Add a recipient and re-encrypt all secrets.
   *
   * @param keyId - The recipient key ID
   */
  async addRecipient(keyId: string): Promise<void> {
    if (this._recipients.includes(keyId)) {
      return;
    }

    this._recipients.push(keyId);
    await this.saveRecipients();
    await this.reencryptAll();
  }

  /**
   * Remove a recipient and re-encrypt all secrets.
   *
   * @param keyId - The recipient key ID
   */
  async removeRecipient(keyId: string): Promise<void> {
    const index = this._recipients.indexOf(keyId);
    if (index === -1) {
      return;
    }

    this._recipients.splice(index, 1);
    await this.saveRecipients();
    await this.reencryptAll();
  }

  private async reencryptAll(): Promise<void> {
    for (const name of await this.list()) {
      try {
        const secret = await this.get(name);
        await this.set(name, secret);
      } catch {
        // Skip secrets that can't be re-encrypted
      }
    }
  }

  /** Sync with remote (for git-backed stores). */
  async sync(): Promise<void> {
    if (this._storage instanceof GitFSBackend) {
      await this._storage.sync();
    }
  }

  /**
   * Get history for a secret.
   *
   * @param name - The secret name
   * @param count - Number of entries
   * @returns List of history entries
   */
  async history(name: string, count: number = 10): Promise<Array<{ hash: string; message: string; date: string; author: string }>> {
    if (this._storage instanceof GitFSBackend) {
      return this._storage.history(name, count);
    }
    return [];
  }

  /**
   * Get a specific revision of a secret.
   *
   * @param name - The secret name
   * @param revision - The revision (commit hash)
   * @returns The secret at that revision
   */
  async showRevision(name: string, revision: string): Promise<Secret> {
    if (!(this._storage instanceof GitFSBackend)) {
      throw new StorageError('History not available for non-git stores');
    }

    const ciphertext = await this._storage.showRevision(name, revision);
    const plaintext = await this._crypto.decrypt(ciphertext);
    return Secret.fromBuffer(plaintext);
  }
}
