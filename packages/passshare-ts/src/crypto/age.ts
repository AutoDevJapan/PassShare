/**
 * Age crypto backend for PassShare.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BaseCryptoBackend } from './base.js';
import { DecryptError, EncryptError } from '../errors.js';

export class AgeBackend extends BaseCryptoBackend {
  readonly name = 'age';
  readonly ext = '.age';
  readonly idFile = '.age-recipients';

  private _age: string;
  private _identityFile: string;
  private _versionCache: string | null = null;

  /**
   * Create a new Age backend.
   *
   * @param ageBinary - Path to age binary
   * @param identityFile - Path to identity file
   */
  constructor(ageBinary?: string, identityFile?: string) {
    super();
    this._age = ageBinary ?? process.env['GOPASS_AGE_BINARY'] ?? 'age';
    this._identityFile = identityFile ?? this.defaultIdentityFile();
  }

  private defaultIdentityFile(): string {
    const envFile = process.env['AGE_KEY_FILE'];
    if (envFile) {
      return envFile;
    }

    if (process.platform === 'win32') {
      return path.join(os.homedir(), 'AppData', 'Local', 'age', 'key.txt');
    }
    return path.join(os.homedir(), '.config', 'age', 'key.txt');
  }

  private runAge(args: string[], input?: Buffer): Promise<{ stdout: Buffer; stderr: Buffer }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this._age, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      proc.stdout.on('data', (data) => stdout.push(data));
      proc.stderr.on('data', (data) => stderr.push(data));

      proc.on('error', () => {
        reject(new EncryptError(`Age binary not found: ${this._age}`));
      });

      proc.on('close', () => {
        resolve({
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        });
      });

      if (input) {
        proc.stdin.write(input);
      }
      proc.stdin.end();
    });
  }

  async encrypt(plaintext: Buffer, recipients: string[]): Promise<Buffer> {
    if (!recipients.length) {
      throw new EncryptError('No recipients specified');
    }

    const args = ['--encrypt', '--armor'];
    for (const recipient of recipients) {
      args.push('--recipient', recipient);
    }

    try {
      const result = await this.runAge(args, plaintext);
      return result.stdout;
    } catch (e) {
      if (e instanceof EncryptError) throw e;
      throw new EncryptError(`Encryption failed: ${e}`);
    }
  }

  async decrypt(ciphertext: Buffer): Promise<Buffer> {
    const args = ['--decrypt', '--identity', this._identityFile];

    try {
      const result = await this.runAge(args, ciphertext);
      if (result.stdout.length === 0 && result.stderr.length > 0) {
        throw new DecryptError(result.stderr.toString('utf-8'));
      }
      return result.stdout;
    } catch (e) {
      if (e instanceof DecryptError) throw e;
      throw new DecryptError(`Decryption failed: ${e}`);
    }
  }

  async recipientIds(_ciphertext: Buffer): Promise<string[]> {
    // Age doesn't expose recipient info from ciphertext
    return [];
  }

  async listPublicKeys(): Promise<string[]> {
    const keys: string[] = [];

    if (fs.existsSync(this._identityFile)) {
      try {
        const content = fs.readFileSync(this._identityFile, 'utf-8');
        for (const line of content.split('\n')) {
          if (line.startsWith('# public key:')) {
            const publicKey = line.split(':')[1]?.trim();
            if (publicKey) {
              keys.push(publicKey);
            }
          }
        }
      } catch {
        // Ignore errors
      }
    }

    return keys;
  }

  async listPrivateKeys(): Promise<string[]> {
    if (fs.existsSync(this._identityFile)) {
      return [this._identityFile];
    }
    return [];
  }

  async version(): Promise<string | null> {
    if (this._versionCache) {
      return this._versionCache;
    }

    try {
      const result = await this.runAge(['--version']);
      const output = result.stdout.toString('utf-8').trim();
      if (output) {
        const parts = output.split(/\s+/);
        this._versionCache = parts[parts.length - 1];
        return this._versionCache;
      }
    } catch {
      // Ignore errors
    }

    return null;
  }

  async generateKey(outputPath?: string): Promise<{ publicKey: string; privateKeyPath: string }> {
    const keygenBinary = this._age.replace('age', 'age-keygen');
    const outputFile = outputPath ?? this._identityFile;

    return new Promise((resolve, reject) => {
      const proc = spawn(keygenBinary, ['-o', outputFile], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stderr = '';

      proc.stderr.on('data', (data) => {
        stderr += data.toString('utf-8');
      });

      proc.on('error', () => {
        reject(new EncryptError('age-keygen binary not found'));
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new EncryptError(`Key generation failed: ${stderr}`));
          return;
        }

        // Extract public key from stderr
        for (const line of stderr.split('\n')) {
          if (line.startsWith('Public key:')) {
            const publicKey = line.split(':')[1]?.trim();
            if (publicKey) {
              resolve({ publicKey, privateKeyPath: outputFile });
              return;
            }
          }
        }

        reject(new EncryptError('Could not extract public key'));
      });
    });
  }
}
