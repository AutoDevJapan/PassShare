/**
 * GPG crypto backend for PassShare.
 */

import { spawn } from 'child_process';
import { BaseCryptoBackend } from './base.js';
import { DecryptError, EncryptError } from '../errors.js';

export class GPGBackend extends BaseCryptoBackend {
  readonly name = 'gpg';
  readonly ext = '.gpg';
  readonly idFile = '.gpg-id';

  private _gpg: string;
  private _versionCache: string | null = null;

  /**
   * Create a new GPG backend.
   *
   * @param gpgBinary - Path to GPG binary
   */
  constructor(gpgBinary?: string) {
    super();
    this._gpg = gpgBinary ?? process.env['GOPASS_GPG_BINARY'] ?? 'gpg';
  }

  private runGpg(args: string[], input?: Buffer): Promise<{ stdout: Buffer; stderr: Buffer }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this._gpg, ['--batch', '--yes', '--quiet', ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      proc.stdout.on('data', (data) => stdout.push(data));
      proc.stderr.on('data', (data) => stderr.push(data));

      proc.on('error', (err) => {
        reject(new EncryptError(`GPG binary not found: ${this._gpg}`));
      });

      proc.on('close', (code) => {
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
      const result = await this.runGpg(args, plaintext);
      return result.stdout;
    } catch (e) {
      if (e instanceof EncryptError) throw e;
      throw new EncryptError(`Encryption failed: ${e}`);
    }
  }

  async decrypt(ciphertext: Buffer): Promise<Buffer> {
    const args = ['--decrypt'];

    try {
      const result = await this.runGpg(args, ciphertext);
      if (result.stdout.length === 0 && result.stderr.length > 0) {
        const stderrStr = result.stderr.toString('utf-8');
        if (stderrStr.includes('decryption failed')) {
          throw new DecryptError(stderrStr);
        }
      }
      return result.stdout;
    } catch (e) {
      if (e instanceof DecryptError) throw e;
      throw new DecryptError(`Decryption failed: ${e}`);
    }
  }

  async recipientIds(ciphertext: Buffer): Promise<string[]> {
    const args = ['--list-packets', '--list-only'];

    try {
      const result = await this.runGpg(args, ciphertext);
      const output = result.stdout.toString('utf-8') + result.stderr.toString('utf-8');

      const keyIds: string[] = [];
      const regex = /keyid\s+([A-F0-9]+)/gi;
      let match;
      while ((match = regex.exec(output)) !== null) {
        keyIds.push('0x' + match[1]);
      }

      return keyIds;
    } catch {
      return [];
    }
  }

  async listPublicKeys(): Promise<string[]> {
    const args = ['--list-keys', '--keyid-format', 'long', '--with-colons'];

    try {
      const result = await this.runGpg(args);
      return this.parseKeyList(result.stdout.toString('utf-8'));
    } catch {
      return [];
    }
  }

  async listPrivateKeys(): Promise<string[]> {
    const args = ['--list-secret-keys', '--keyid-format', 'long', '--with-colons'];

    try {
      const result = await this.runGpg(args);
      return this.parseKeyList(result.stdout.toString('utf-8'));
    } catch {
      return [];
    }
  }

  private parseKeyList(output: string): string[] {
    const keys: string[] = [];
    let currentKeyId = '';

    for (const line of output.split('\n')) {
      const fields = line.split(':');

      if (fields.length >= 5) {
        const recordType = fields[0];

        if (recordType === 'pub' || recordType === 'sec') {
          currentKeyId = fields[4] ? '0x' + fields[4] : '';
        } else if (recordType === 'uid' && currentKeyId) {
          const uid = fields[9] ?? '';
          if (uid) {
            keys.push(`${currentKeyId} - ${uid}`);
            currentKeyId = '';
          }
        }
      }
    }

    return keys;
  }

  async version(): Promise<string | null> {
    if (this._versionCache) {
      return this._versionCache;
    }

    try {
      const result = await this.runGpg(['--version']);
      const output = result.stdout.toString('utf-8');
      const match = output.match(/(\d+\.\d+\.\d+)/);
      if (match) {
        this._versionCache = match[1];
        return this._versionCache;
      }
    } catch {
      // Ignore errors
    }

    return null;
  }

  async importKey(keyData: Buffer): Promise<string> {
    const args = ['--import'];

    try {
      const result = await this.runGpg(args, keyData);
      const stderr = result.stderr.toString('utf-8');
      const match = stderr.match(/key\s+([A-F0-9]+):/i);
      if (match) {
        return '0x' + match[1];
      }
      return '';
    } catch (e) {
      throw new EncryptError(`Key import failed: ${e}`);
    }
  }

  async exportKey(keyId: string): Promise<Buffer> {
    const args = ['--export', '--armor', keyId];

    try {
      const result = await this.runGpg(args);
      return result.stdout;
    } catch (e) {
      throw new EncryptError(`Key export failed: ${e}`);
    }
  }
}
