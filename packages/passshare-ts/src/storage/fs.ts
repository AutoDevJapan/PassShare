/**
 * Plain filesystem storage backend.
 */

import * as fsPromises from 'fs/promises';
import * as nodePath from 'path';
import { StorageBackend } from './base.js';
import { NotFoundError, StorageError } from '../errors.js';

export class FSBackend implements StorageBackend {
  readonly name: string = 'fs';
  private _path: string;
  private _extension: string;

  /**
   * Create a new FS backend.
   *
   * @param path - The store root path
   * @param extension - File extension for secrets
   */
  constructor(path: string, extension: string = '.gpg') {
    this._path = path;
    this._extension = extension;
  }

  get path(): string {
    return this._path;
  }

  async init(storePath: string): Promise<void> {
    try {
      await fsPromises.mkdir(storePath, { recursive: true, mode: 0o700 });
      this._path = storePath;
    } catch (e) {
      throw new StorageError(`Failed to initialize store: ${e}`, storePath);
    }
  }

  async initialized(): Promise<boolean> {
    try {
      const stats = await fsPromises.stat(this._path);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  private resolvePath(name: string): string {
    // Normalize the path
    let normalized = name.trim().replace(/^\/+|\/+$/g, '');
    normalized = normalized
      .split('/')
      .filter((p) => p && p !== '.' && p !== '..')
      .join('/');

    // Add extension if not present
    if (!normalized.endsWith(this._extension)) {
      normalized += this._extension;
    }

    return nodePath.join(this._path, normalized);
  }

  async get(name: string): Promise<Buffer> {
    const filePath = this.resolvePath(name);

    try {
      return await fsPromises.readFile(filePath);
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        throw new NotFoundError(name);
      }
      throw new StorageError(`Failed to read secret: ${e}`, filePath);
    }
  }

  async set(name: string, value: Buffer): Promise<void> {
    const filePath = this.resolvePath(name);

    try {
      // Create parent directories
      await fsPromises.mkdir(nodePath.dirname(filePath), { recursive: true, mode: 0o700 });

      // Write the file
      await fsPromises.writeFile(filePath, value, { mode: 0o600 });
    } catch (e) {
      throw new StorageError(`Failed to write secret: ${e}`, filePath);
    }
  }

  async delete(name: string): Promise<void> {
    const filePath = this.resolvePath(name);

    try {
      await fsPromises.unlink(filePath);
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        throw new NotFoundError(name);
      }
      throw new StorageError(`Failed to delete secret: ${e}`, filePath);
    }
  }

  async exists(name: string): Promise<boolean> {
    const filePath = this.resolvePath(name);

    try {
      const stats = await fsPromises.stat(filePath);
      return stats.isFile();
    } catch {
      return false;
    }
  }

  async list(prefix: string = ''): Promise<string[]> {
    const secrets: string[] = [];
    let searchPath = this._path;

    if (prefix) {
      searchPath = nodePath.join(this._path, prefix.trim().replace(/^\/+|\/+$/g, ''));
    }

    try {
      await this.listRecursive(searchPath, secrets);
    } catch {
      return [];
    }

    return secrets.sort();
  }

  private async listRecursive(dir: string, secrets: string[]): Promise<void> {
    try {
      const entries = await fsPromises.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = nodePath.join(dir, entry.name);

        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          await this.listRecursive(fullPath, secrets);
        } else if (entry.isFile() && entry.name.endsWith(this._extension)) {
          // Get relative path without extension
          let relPath = nodePath.relative(this._path, fullPath);
          relPath = relPath.replace(/\\/g, '/');
          if (relPath.endsWith(this._extension)) {
            relPath = relPath.slice(0, -this._extension.length);
          }
          secrets.push(relPath);
        }
      }
    } catch {
      // Ignore errors
    }
  }

  async isDir(name: string): Promise<boolean> {
    const dirPath = nodePath.join(this._path, name.trim().replace(/^\/+|\/+$/g, ''));

    try {
      const stats = await fsPromises.stat(dirPath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  async prune(prefix: string): Promise<void> {
    if (!prefix) return;

    const dirPath = nodePath.join(this._path, prefix.trim().replace(/^\/+|\/+$/g, ''));

    try {
      await this.pruneRecursive(dirPath);
    } catch {
      // Ignore errors
    }
  }

  private async pruneRecursive(dir: string): Promise<void> {
    if (dir === this._path) return;

    try {
      const entries = await fsPromises.readdir(dir);
      if (entries.length === 0) {
        await fsPromises.rmdir(dir);
        await this.pruneRecursive(nodePath.dirname(dir));
      }
    } catch {
      // Ignore errors
    }
  }

  async version(): Promise<string | null> {
    return '1.0.0';
  }
}
