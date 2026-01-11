/**
 * Base storage backend interface.
 */

export interface StorageBackend {
  /** Get the backend name. */
  readonly name: string;

  /** Get the store path. */
  readonly path: string;

  /**
   * Initialize a new store.
   *
   * @param storePath - The store path
   */
  init(storePath: string): Promise<void>;

  /**
   * Check if the store is initialized.
   *
   * @returns True if initialized
   */
  initialized(): Promise<boolean>;

  /**
   * Get a secret's content.
   *
   * @param name - The secret name/path
   * @returns The encrypted content
   */
  get(name: string): Promise<Buffer>;

  /**
   * Set a secret's content.
   *
   * @param name - The secret name/path
   * @param value - The encrypted content
   */
  set(name: string, value: Buffer): Promise<void>;

  /**
   * Delete a secret.
   *
   * @param name - The secret name/path
   */
  delete(name: string): Promise<void>;

  /**
   * Check if a secret exists.
   *
   * @param name - The secret name/path
   * @returns True if exists
   */
  exists(name: string): Promise<boolean>;

  /**
   * List secrets.
   *
   * @param prefix - Optional prefix to filter by
   * @returns List of secret names
   */
  list(prefix?: string): Promise<string[]>;

  /**
   * Check if a path is a directory.
   *
   * @param name - The path to check
   * @returns True if directory
   */
  isDir(name: string): Promise<boolean>;

  /**
   * Remove empty directories.
   *
   * @param prefix - The prefix to prune under
   */
  prune(prefix: string): Promise<void>;

  /**
   * Get the backend version.
   *
   * @returns Version string or null
   */
  version(): Promise<string | null>;
}
