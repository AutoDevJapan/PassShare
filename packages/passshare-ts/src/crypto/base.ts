/**
 * Base crypto backend interface.
 */

export interface CryptoBackend {
  /** Get the backend name. */
  readonly name: string;

  /** Get the file extension (e.g., '.gpg'). */
  readonly ext: string;

  /** Get the ID file name (e.g., '.gpg-id'). */
  readonly idFile: string;

  /**
   * Encrypt plaintext for the given recipients.
   *
   * @param plaintext - The data to encrypt
   * @param recipients - List of recipient key IDs
   * @returns The encrypted data
   */
  encrypt(plaintext: Buffer, recipients: string[]): Promise<Buffer>;

  /**
   * Decrypt ciphertext.
   *
   * @param ciphertext - The encrypted data
   * @returns The decrypted data
   */
  decrypt(ciphertext: Buffer): Promise<Buffer>;

  /**
   * Get recipient IDs from ciphertext.
   *
   * @param ciphertext - The encrypted data
   * @returns List of recipient key IDs
   */
  recipientIds(ciphertext: Buffer): Promise<string[]>;

  /**
   * List available public keys.
   *
   * @returns List of public key IDs
   */
  listPublicKeys(): Promise<string[]>;

  /**
   * List available private keys.
   *
   * @returns List of private key IDs
   */
  listPrivateKeys(): Promise<string[]>;

  /**
   * Get the backend version.
   *
   * @returns Version string or null
   */
  version(): Promise<string | null>;
}

/**
 * Abstract base implementation of CryptoBackend.
 */
export abstract class BaseCryptoBackend implements CryptoBackend {
  abstract readonly name: string;
  abstract readonly ext: string;
  abstract readonly idFile: string;

  abstract encrypt(plaintext: Buffer, recipients: string[]): Promise<Buffer>;
  abstract decrypt(ciphertext: Buffer): Promise<Buffer>;
  abstract recipientIds(ciphertext: Buffer): Promise<string[]>;
  abstract listPublicKeys(): Promise<string[]>;
  abstract listPrivateKeys(): Promise<string[]>;

  async version(): Promise<string | null> {
    return null;
  }

  /**
   * Find public keys matching search terms.
   *
   * @param search - Search terms
   * @returns List of matching key IDs
   */
  async findPublicKeys(search: string[]): Promise<string[]> {
    const allKeys = await this.listPublicKeys();
    if (!search.length) {
      return allKeys;
    }
    return allKeys.filter((k) =>
      search.some((s) => k.toLowerCase().includes(s.toLowerCase()))
    );
  }

  /**
   * Find private keys matching search terms.
   *
   * @param search - Search terms
   * @returns List of matching key IDs
   */
  async findPrivateKeys(search: string[]): Promise<string[]> {
    const allKeys = await this.listPrivateKeys();
    if (!search.length) {
      return allKeys;
    }
    return allKeys.filter((k) =>
      search.some((s) => k.toLowerCase().includes(s.toLowerCase()))
    );
  }
}
