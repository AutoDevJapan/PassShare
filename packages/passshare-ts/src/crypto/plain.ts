/**
 * Plain (no encryption) backend for PassShare.
 *
 * WARNING: This backend is for testing only. Do NOT use in production.
 */

import { BaseCryptoBackend } from './base.js';

export class PlainBackend extends BaseCryptoBackend {
  readonly name = 'plain';
  readonly ext = '.txt';
  readonly idFile = '.plain-id';

  /**
   * Create a new Plain backend.
   *
   * Emits a warning about the lack of security.
   */
  constructor() {
    super();
    console.warn('PlainBackend provides NO encryption. Do NOT use in production!');
  }

  async encrypt(plaintext: Buffer, _recipients: string[]): Promise<Buffer> {
    return plaintext;
  }

  async decrypt(ciphertext: Buffer): Promise<Buffer> {
    return ciphertext;
  }

  async recipientIds(_ciphertext: Buffer): Promise<string[]> {
    return [];
  }

  async listPublicKeys(): Promise<string[]> {
    return ['plain-test-key'];
  }

  async listPrivateKeys(): Promise<string[]> {
    return ['plain-test-key'];
  }

  async version(): Promise<string | null> {
    return '1.0.0';
  }
}
