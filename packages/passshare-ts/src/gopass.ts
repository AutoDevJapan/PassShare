/**
 * Gopass - Main API class for PassShare.
 */

import * as fs from 'fs';
import { Config } from './config.js';
import { GPGBackend } from './crypto/gpg.js';
import { AgeBackend } from './crypto/age.js';
import { Secret } from './secret.js';
import { Store } from './store.js';
import { generatePassword } from './password.js';
import { NotInitializedError, StorageError } from './errors.js';

export class Gopass {
  private _config: Config;
  private _rootStore: Store | null = null;
  private _mountStores: Map<string, Store> = new Map();

  /**
   * Create a new Gopass instance.
   *
   * @param configPath - Path to config file
   */
  constructor(configPath?: string) {
    this._config = new Config(configPath);
    this._config.load();
    this.initStores();
  }

  private initStores(): void {
    // Root store
    const rootPath = this._config.storePath;
    if (fs.existsSync(rootPath)) {
      this._rootStore = new Store(rootPath);
    }

    // Mounted stores
    for (const [alias, mountPath] of this._config.mounts) {
      if (fs.existsSync(mountPath)) {
        this._mountStores.set(alias, new Store(mountPath));
      }
    }
  }

  private resolveStore(name: string): { store: Store; relativeName: string } {
    const normalized = name.trim().replace(/^\/+|\/+$/g, '');

    // Check if name starts with a mount prefix
    for (const [alias, store] of this._mountStores) {
      if (normalized === alias || normalized.startsWith(`${alias}/`)) {
        const relativeName = normalized.slice(alias.length).replace(/^\/+/, '');
        return { store, relativeName: relativeName || '' };
      }
    }

    // Use root store
    if (!this._rootStore) {
      throw new NotInitializedError();
    }

    return { store: this._rootStore, relativeName: normalized };
  }

  /** Check if any store is initialized. */
  get initialized(): boolean {
    if (this._rootStore) {
      return true;
    }

    if (this._mountStores.size > 0) {
      return true;
    }

    return false;
  }

  /**
   * Initialize a new store.
   *
   * @param recipients - Recipient key IDs
   * @param path - Store path (uses default if not specified)
   * @param crypto - Crypto backend ('gpg' or 'age')
   * @param storage - Storage backend ('gitfs' or 'fs')
   */
  async init(
    recipients: string[],
    path?: string,
    crypto: string = 'gpg',
    storage: string = 'gitfs'
  ): Promise<void> {
    const storePath = path ?? this._config.storePath;

    // Create crypto backend
    const cryptoBackend = crypto === 'age' ? new AgeBackend() : new GPGBackend();

    // Create store
    const store = new Store(storePath, cryptoBackend);
    await store.init(recipients, storage);

    // Update config
    if (!path) {
      this._rootStore = store;
    } else {
      this._config.storePath = storePath;
      this._config.save();
    }
  }

  /**
   * Get a secret.
   *
   * @param name - The secret path
   * @returns The decrypted secret
   */
  async get(name: string): Promise<Secret> {
    const { store, relativeName } = this.resolveStore(name);
    return store.get(relativeName);
  }

  /**
   * Set a secret.
   *
   * @param name - The secret path
   * @param secret - The secret to save
   */
  async set(name: string, secret: Secret): Promise<void> {
    const { store, relativeName } = this.resolveStore(name);
    await store.set(relativeName, secret);
  }

  /**
   * Delete a secret.
   *
   * @param name - The secret path
   */
  async delete(name: string): Promise<void> {
    const { store, relativeName } = this.resolveStore(name);
    await store.delete(relativeName);
  }

  /**
   * Check if a secret exists.
   *
   * @param name - The secret path
   * @returns True if exists
   */
  async exists(name: string): Promise<boolean> {
    try {
      const { store, relativeName } = this.resolveStore(name);
      return store.exists(relativeName);
    } catch {
      return false;
    }
  }

  /**
   * List secrets.
   *
   * @param prefix - Optional prefix to filter by
   * @returns List of secret paths
   */
  async list(prefix: string = ''): Promise<string[]> {
    const secrets: string[] = [];
    const normalizedPrefix = prefix.trim().replace(/^\/+|\/+$/g, '');

    for (const [alias, store] of this._mountStores) {
      if (!normalizedPrefix || normalizedPrefix === alias || normalizedPrefix.startsWith(`${alias}/`)) {
        const mountPrefix = normalizedPrefix.startsWith(alias)
          ? normalizedPrefix.slice(alias.length).replace(/^\/+/, '')
          : '';
        for (const name of await store.list(mountPrefix)) {
          secrets.push(`${alias}/${name}`);
        }
      } else if (!normalizedPrefix) {
        for (const name of await store.list()) {
          secrets.push(`${alias}/${name}`);
        }
      }
    }

    // List from root store
    if (this._rootStore) {
      let shouldListRoot = true;
      for (const alias of this._mountStores.keys()) {
        if (normalizedPrefix === alias || normalizedPrefix.startsWith(`${alias}/`)) {
          shouldListRoot = false;
          break;
        }
      }

      if (shouldListRoot) {
        secrets.push(...(await this._rootStore.list(normalizedPrefix)));
      }
    }

    return secrets.sort();
  }

  /**
   * Find secrets by name pattern.
   *
   * @param pattern - The search pattern
   * @returns List of matching paths
   */
  async find(pattern: string): Promise<string[]> {
    const allSecrets = await this.list();
    const patternLower = pattern.toLowerCase();

    return allSecrets.filter((name) => {
      const nameLower = name.toLowerCase();
      return nameLower.includes(patternLower);
    });
  }

  /**
   * Search secret contents.
   *
   * @param pattern - The regex pattern
   * @returns List of [name, line] tuples
   */
  async grep(pattern: string): Promise<Array<[string, string]>> {
    const results: Array<[string, string]> = [];
    const regex = new RegExp(pattern, 'i');

    for (const name of await this.list()) {
      try {
        const secret = await this.get(name);
        const content = secret.toString();

        for (const line of content.split('\n')) {
          if (regex.test(line)) {
            results.push([name, line]);
          }
        }
      } catch {
        // Skip secrets that can't be read
      }
    }

    return results;
  }

  /**
   * Generate a password and save it.
   *
   * @param name - The secret path
   * @param options - Generation options
   * @returns The generated password
   */
  async generate(
    name: string,
    options: {
      length?: number;
      symbols?: boolean;
      xkcd?: boolean;
      force?: boolean;
    } = {}
  ): Promise<string> {
    const { length = 24, symbols = true, xkcd = false, force = false } = options;

    if ((await this.exists(name)) && !force) {
      throw new StorageError(`Secret already exists: ${name}`);
    }

    const password = generatePassword({ length, symbols, xkcd });

    // Try to preserve existing data if updating
    let secret: Secret;
    if ((await this.exists(name)) && force) {
      secret = await this.get(name);
      secret.password = password;
    } else {
      secret = new Secret(password);
    }

    await this.set(name, secret);
    return password;
  }

  /**
   * Copy a secret.
   *
   * @param fromName - Source path
   * @param toName - Destination path
   * @param force - Overwrite if exists
   */
  async copy(fromName: string, toName: string, force: boolean = false): Promise<void> {
    const secret = await this.get(fromName);
    if ((await this.exists(toName)) && !force) {
      throw new StorageError(`Destination already exists: ${toName}`);
    }
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
   * Sync with remote.
   *
   * @param store - Store name to sync (syncs all if not specified)
   */
  async sync(store?: string): Promise<void> {
    if (store) {
      if (this._mountStores.has(store)) {
        await this._mountStores.get(store)!.sync();
      } else if (this._rootStore && store === 'root') {
        await this._rootStore.sync();
      }
    } else {
      if (this._rootStore) {
        try {
          await this._rootStore.sync();
        } catch {
          // Ignore errors
        }
      }

      for (const mountStore of this._mountStores.values()) {
        try {
          await mountStore.sync();
        } catch {
          // Ignore errors
        }
      }
    }
  }

  /** Get mount points. */
  get mounts(): Map<string, string> {
    return this._config.mounts;
  }

  /**
   * Add a mount point.
   *
   * @param alias - The mount alias
   * @param path - The store path
   */
  mount(alias: string, path: string): void {
    this._config.addMount(alias, path);
    this._config.save();

    if (fs.existsSync(path)) {
      this._mountStores.set(alias, new Store(path));
    }
  }

  /**
   * Remove a mount point.
   *
   * @param alias - The mount alias
   */
  unmount(alias: string): void {
    this._config.removeMount(alias);
    this._config.save();
    this._mountStores.delete(alias);
  }

  /**
   * Get recipients for a store.
   *
   * @param store - Store name (uses root if not specified)
   * @returns List of recipient key IDs
   */
  recipients(store?: string): string[] {
    if (store && this._mountStores.has(store)) {
      return this._mountStores.get(store)!.recipients;
    }

    if (this._rootStore) {
      return this._rootStore.recipients;
    }

    return [];
  }

  /**
   * Add a recipient to a store.
   *
   * @param keyId - The recipient key ID
   * @param store - Store name
   */
  async addRecipient(keyId: string, store?: string): Promise<void> {
    if (store && this._mountStores.has(store)) {
      await this._mountStores.get(store)!.addRecipient(keyId);
    } else if (this._rootStore) {
      await this._rootStore.addRecipient(keyId);
    }
  }

  /**
   * Remove a recipient from a store.
   *
   * @param keyId - The recipient key ID
   * @param store - Store name
   */
  async removeRecipient(keyId: string, store?: string): Promise<void> {
    if (store && this._mountStores.has(store)) {
      await this._mountStores.get(store)!.removeRecipient(keyId);
    } else if (this._rootStore) {
      await this._rootStore.removeRecipient(keyId);
    }
  }

  /**
   * Get history for a secret.
   *
   * @param name - The secret path
   * @param count - Number of entries
   * @returns List of history entries
   */
  async history(name: string, count: number = 10): Promise<Array<{ hash: string; message: string; date: string; author: string }>> {
    const { store, relativeName } = this.resolveStore(name);
    return store.history(relativeName, count);
  }

  /**
   * Get a specific revision of a secret.
   *
   * @param name - The secret path
   * @param revision - The revision (commit hash)
   * @returns The secret at that revision
   */
  async showRevision(name: string, revision: string): Promise<Secret> {
    const { store, relativeName } = this.resolveStore(name);
    return store.showRevision(relativeName, revision);
  }

  /** Get the config object. */
  get config(): Config {
    return this._config;
  }
}
