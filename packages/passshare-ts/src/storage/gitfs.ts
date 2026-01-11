/**
 * Git + Filesystem storage backend.
 */

import { spawn } from 'child_process';
import * as fsPromises from 'fs/promises';
import * as nodePath from 'path';
import { FSBackend } from './fs.js';
import { GitError, NotFoundError, StorageError } from '../errors.js';

export class GitFSBackend extends FSBackend {
  override readonly name = 'gitfs';
  private _git: string;

  /**
   * Create a new GitFS backend.
   *
   * @param path - The store root path
   * @param extension - File extension for secrets
   * @param gitBinary - Path to git binary
   */
  constructor(path: string, extension: string = '.gpg', gitBinary?: string) {
    super(path, extension);
    this._git = gitBinary ?? 'git';
  }

  private runGit(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this._git, ['-C', this.path, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString('utf-8');
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString('utf-8');
      });

      proc.on('error', (err) => {
        reject(new GitError(`Git binary not found: ${this._git}`));
      });

      proc.on('close', (code) => {
        resolve({ stdout, stderr, code: code ?? 0 });
      });
    });
  }

  override async init(storePath: string): Promise<void> {
    await super.init(storePath);

    try {
      await this.runGit(['init']);

      // Create .gitattributes
      const extension = (this as any)._extension;
      const gitattributes = nodePath.join(storePath, '.gitattributes');
      await fsPromises.writeFile(gitattributes, `*${extension} diff=gpg\n`, 'utf-8');

      // Add and commit
      await this.runGit(['add', '.gitattributes']);
      await this.runGit(['commit', '-m', 'Initialize password store']);
    } catch (e) {
      if (e instanceof GitError) throw e;
      throw new StorageError(`Failed to initialize git: ${e}`, storePath);
    }
  }

  override async initialized(): Promise<boolean> {
    if (!(await super.initialized())) {
      return false;
    }

    const gitDir = nodePath.join(this.path, '.git');
    try {
      const stats = await fsPromises.stat(gitDir);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  override async set(name: string, value: Buffer): Promise<void> {
    const isNew = !(await this.exists(name));
    await super.set(name, value);

    try {
      const extension = (this as any)._extension;
      let normalized = name.trim().replace(/^\/+|\/+$/g, '');
      if (!normalized.endsWith(extension)) {
        normalized += extension;
      }

      await this.runGit(['add', normalized]);

      const action = isNew ? 'Add' : 'Edit';
      await this.runGit(['commit', '-m', `${action} secret for ${name}`]);
    } catch {
      // Don't fail if git operations fail
    }
  }

  override async delete(name: string): Promise<void> {
    const extension = (this as any)._extension;
    let normalized = name.trim().replace(/^\/+|\/+$/g, '');
    if (!normalized.endsWith(extension)) {
      normalized += extension;
    }

    try {
      await this.runGit(['rm', '-f', normalized]);
      await this.runGit(['commit', '-m', `Remove secret for ${name}`]);
    } catch {
      // Fall back to direct deletion
      await super.delete(name);
    }
  }

  async add(files: string[]): Promise<void> {
    if (!files.length) return;

    try {
      await this.runGit(['add', ...files]);
    } catch {
      // Ignore errors
    }
  }

  async commit(message: string): Promise<void> {
    await this.runGit(['commit', '-m', message]);
  }

  async push(remote: string = 'origin', branch: string = 'master'): Promise<void> {
    const result = await this.runGit(['push', remote, branch]);
    if (result.code !== 0) {
      throw new GitError(`Push failed: ${result.stderr}`, `push ${remote} ${branch}`);
    }
  }

  async pull(remote: string = 'origin', branch: string = 'master'): Promise<void> {
    const result = await this.runGit(['pull', '--rebase', remote, branch]);
    if (result.code !== 0) {
      throw new GitError(`Pull failed: ${result.stderr}`, `pull ${remote} ${branch}`);
    }
  }

  async sync(remote: string = 'origin', branch: string = 'master'): Promise<void> {
    await this.pull(remote, branch);
    await this.push(remote, branch);
  }

  async clone(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this._git, ['clone', url, destPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stderr = '';

      proc.stderr.on('data', (data) => {
        stderr += data.toString('utf-8');
      });

      proc.on('error', () => {
        reject(new GitError(`Git binary not found: ${this._git}`));
      });

      proc.on('close', (code) => {
        if (code === 0) {
          (this as any)._path = destPath;
          resolve();
        } else {
          reject(new GitError(`Clone failed: ${stderr}`, `clone ${url}`));
        }
      });
    });
  }

  async status(): Promise<string> {
    try {
      const result = await this.runGit(['status', '--porcelain']);
      return result.stdout;
    } catch {
      return '';
    }
  }

  async log(count: number = 10): Promise<Array<{ hash: string; message: string; date: string; author: string }>> {
    try {
      const result = await this.runGit(['log', `-${count}`, '--format=%H|%s|%ai|%an']);

      const commits: Array<{ hash: string; message: string; date: string; author: string }> = [];

      for (const line of result.stdout.trim().split('\n')) {
        const parts = line.split('|');
        if (parts.length === 4) {
          commits.push({
            hash: parts[0],
            message: parts[1],
            date: parts[2],
            author: parts[3],
          });
        }
      }

      return commits;
    } catch {
      return [];
    }
  }

  async history(name: string, count: number = 10): Promise<Array<{ hash: string; message: string; date: string; author: string }>> {
    const extension = (this as any)._extension;
    let normalized = name.trim().replace(/^\/+|\/+$/g, '');
    if (!normalized.endsWith(extension)) {
      normalized += extension;
    }

    try {
      const result = await this.runGit([
        'log',
        `-${count}`,
        '--format=%H|%s|%ai|%an',
        '--follow',
        '--',
        normalized,
      ]);

      const commits: Array<{ hash: string; message: string; date: string; author: string }> = [];

      for (const line of result.stdout.trim().split('\n')) {
        const parts = line.split('|');
        if (parts.length === 4) {
          commits.push({
            hash: parts[0],
            message: parts[1],
            date: parts[2],
            author: parts[3],
          });
        }
      }

      return commits;
    } catch {
      return [];
    }
  }

  async showRevision(name: string, revision: string): Promise<Buffer> {
    const extension = (this as any)._extension;
    let normalized = name.trim().replace(/^\/+|\/+$/g, '');
    if (!normalized.endsWith(extension)) {
      normalized += extension;
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(this._git, ['-C', this.path, 'show', `${revision}:${normalized}`], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const chunks: Buffer[] = [];

      proc.stdout.on('data', (data) => {
        chunks.push(data);
      });

      proc.on('error', () => {
        reject(new NotFoundError(`${name}@${revision}`));
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(Buffer.concat(chunks));
        } else {
          reject(new NotFoundError(`${name}@${revision}`));
        }
      });
    });
  }

  async addRemote(name: string, url: string): Promise<void> {
    await this.runGit(['remote', 'add', name, url]);
  }

  async removeRemote(name: string): Promise<void> {
    await this.runGit(['remote', 'remove', name]);
  }

  async listRemotes(): Promise<string[]> {
    try {
      const result = await this.runGit(['remote']);
      return result.stdout.trim().split('\n').filter((r) => r.trim());
    } catch {
      return [];
    }
  }

  override async version(): Promise<string | null> {
    try {
      const result = await this.runGit(['--version']);
      const match = result.stdout.match(/(\d+\.\d+\.\d+)/);
      if (match) {
        return match[1];
      }
    } catch {
      // Ignore errors
    }
    return null;
  }
}
