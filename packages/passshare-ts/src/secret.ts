/**
 * Secret model for PassShare.
 *
 * A secret consists of:
 * 1. Password (first line)
 * 2. Key-value data (YAML-like section between ---)
 * 3. Body (freeform notes after second ---)
 */

import { TOTP, parseOtpUri } from './otp.js';

export class Secret {
  private _password: string;
  private _data: Map<string, string>;
  private _body: string;

  /**
   * Create a new Secret.
   *
   * @param password - The password (first line)
   * @param data - Key-value pairs
   * @param body - Freeform notes
   */
  constructor(
    password: string = '',
    data?: Map<string, string> | Record<string, string>,
    body: string = ''
  ) {
    this._password = password;
    this._body = body;

    if (data instanceof Map) {
      this._data = new Map(data);
    } else if (data) {
      this._data = new Map(Object.entries(data));
    } else {
      this._data = new Map();
    }
  }

  /** Get the password (first line). */
  get password(): string {
    return this._password;
  }

  /** Set the password. */
  set password(value: string) {
    this._password = value;
  }

  /**
   * Get a value by key.
   *
   * @param key - The key to look up
   * @param defaultValue - Default if not found
   * @returns The value or default
   */
  get(key: string, defaultValue: string = ''): string {
    return this._data.get(key) ?? defaultValue;
  }

  /**
   * Set a key-value pair.
   *
   * @param key - The key
   * @param value - The value
   */
  set(key: string, value: string): void {
    this._data.set(key, value);
  }

  /**
   * Delete a key-value pair.
   *
   * @param key - The key to delete
   * @returns True if deleted
   */
  delete(key: string): boolean {
    return this._data.delete(key);
  }

  /** Get all keys. */
  keys(): string[] {
    return Array.from(this._data.keys());
  }

  /** Get all data as a plain object. */
  get data(): Record<string, string> {
    return Object.fromEntries(this._data);
  }

  /** Get the freeform notes. */
  get body(): string {
    return this._body;
  }

  /** Set the freeform notes. */
  set body(value: string) {
    this._body = value;
  }

  /** Get the OTP URI if present. */
  get otpUri(): string | null {
    for (const value of this._data.values()) {
      if (value.startsWith('otpauth://')) {
        return value;
      }
    }
    return null;
  }

  /**
   * Generate current OTP code.
   *
   * @returns The OTP code or null if no OTP configured
   */
  otp(): string | null {
    const uri = this.otpUri;
    if (!uri) {
      return null;
    }

    try {
      const totp = parseOtpUri(uri);
      if (totp instanceof TOTP) {
        return totp.generate();
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Serialize the secret to a Buffer.
   *
   * @returns UTF-8 encoded buffer
   */
  toBuffer(): Buffer {
    return Buffer.from(this.toString(), 'utf-8');
  }

  /**
   * Deserialize a secret from a Buffer.
   *
   * @param data - UTF-8 encoded buffer
   * @returns A Secret instance
   */
  static fromBuffer(data: Buffer): Secret {
    return Secret.parse(data.toString('utf-8'));
  }

  /**
   * Parse secret content into a Secret object.
   *
   * @param content - The raw secret content
   * @returns A Secret instance
   */
  static parse(content: string): Secret {
    if (!content) {
      return new Secret();
    }

    const lines = content.split('\n');
    const password = lines[0] ?? '';

    const data = new Map<string, string>();
    let body = '';
    let inData = false;
    let inBody = false;
    const bodyLines: string[] = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];

      if (line === '---') {
        if (!inData && !inBody) {
          inData = true;
        } else if (inData) {
          inData = false;
          inBody = true;
        }
        continue;
      }

      if (inBody) {
        bodyLines.push(line);
      } else if (inData) {
        // Check for otpauth URI first (before key:value matching)
        if (line.startsWith('otpauth://')) {
          data.set('otp', line);
        } else {
          // Parse key: value
          const match = line.match(/^([^:]+):\s*(.*)$/);
          if (match) {
            const key = match[1].trim();
            const value = match[2].trim();
            data.set(key, value);
          }
        }
      } else {
        // Check for otpauth URI first
        if (line.startsWith('otpauth://')) {
          data.set('otp', line);
        } else {
          // Lines between password and first ---
          const match = line.match(/^([^:]+):\s*(.*)$/);
          if (match) {
            const key = match[1].trim();
            const value = match[2].trim();
            data.set(key, value);
          }
        }
      }
    }

    body = bodyLines.join('\n');

    return new Secret(password, data, body);
  }

  /**
   * Convert to string format.
   *
   * @returns The secret in standard format
   */
  toString(): string {
    const lines: string[] = [this._password];

    if (this._data.size > 0) {
      lines.push('---');
      for (const [key, value] of this._data) {
        lines.push(`${key}: ${value}`);
      }
    }

    if (this._body) {
      if (this._data.size === 0) {
        lines.push('---');
      }
      lines.push('---');
      lines.push(this._body);
    }

    return lines.join('\n');
  }

  /**
   * Check equality with another Secret.
   *
   * @param other - The other secret
   * @returns True if equal
   */
  equals(other: Secret): boolean {
    if (this._password !== other._password) return false;
    if (this._body !== other._body) return false;
    if (this._data.size !== other._data.size) return false;

    for (const [key, value] of this._data) {
      if (other._data.get(key) !== value) return false;
    }

    return true;
  }
}
