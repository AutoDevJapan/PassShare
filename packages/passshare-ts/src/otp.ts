/**
 * OTP (One-Time Password) utilities for PassShare.
 */

import * as crypto from 'crypto';

export class TOTP {
  public readonly secret: string;
  public readonly digits: number;
  public readonly period: number;
  public readonly algorithm: string;

  /**
   * Create a new TOTP instance.
   *
   * @param secret - Base32-encoded secret
   * @param digits - Number of digits (6 or 8)
   * @param period - Time step in seconds
   * @param algorithm - Hash algorithm (SHA1, SHA256, SHA512)
   */
  constructor(
    secret: string,
    digits: number = 6,
    period: number = 30,
    algorithm: string = 'SHA1'
  ) {
    this.secret = secret;
    this.digits = digits;
    this.period = period;
    this.algorithm = algorithm.toUpperCase();
  }

  private decodeSecret(): Buffer {
    // Base32 decode
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const secret = this.secret.toUpperCase().replace(/\s/g, '').replace(/=+$/, '');

    let bits = '';
    for (const char of secret) {
      const index = alphabet.indexOf(char);
      if (index === -1) continue;
      bits += index.toString(2).padStart(5, '0');
    }

    const bytes: number[] = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
      bytes.push(parseInt(bits.slice(i, i + 8), 2));
    }

    return Buffer.from(bytes);
  }

  private getHashAlgorithm(): string {
    switch (this.algorithm) {
      case 'SHA256':
        return 'sha256';
      case 'SHA512':
        return 'sha512';
      default:
        return 'sha1';
    }
  }

  /**
   * Generate current TOTP code.
   *
   * @param timestamp - Unix timestamp (uses current time if not specified)
   * @returns The OTP code
   */
  generate(timestamp?: number): string {
    const time = timestamp ?? Math.floor(Date.now() / 1000);
    const counter = Math.floor(time / this.period);
    return this.generateHotp(counter);
  }

  private generateHotp(counter: number): string {
    // Pack counter as 8-byte big-endian
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeBigUInt64BE(BigInt(counter));

    // Calculate HMAC
    const key = this.decodeSecret();
    const hmac = crypto.createHmac(this.getHashAlgorithm(), key);
    hmac.update(counterBuffer);
    const mac = hmac.digest();

    // Dynamic truncation
    const offset = mac[mac.length - 1] & 0x0f;
    const code =
      ((mac[offset] & 0x7f) << 24) |
      ((mac[offset + 1] & 0xff) << 16) |
      ((mac[offset + 2] & 0xff) << 8) |
      (mac[offset + 3] & 0xff);

    const otp = code % Math.pow(10, this.digits);
    return otp.toString().padStart(this.digits, '0');
  }

  /**
   * Verify a TOTP code.
   *
   * @param code - The code to verify
   * @param window - Number of periods to check before/after
   * @returns True if valid
   */
  verify(code: string, window: number = 1): boolean {
    const timestamp = Math.floor(Date.now() / 1000);

    for (let offset = -window; offset <= window; offset++) {
      const checkTime = timestamp + offset * this.period;
      if (this.generate(checkTime) === code) {
        return true;
      }
    }

    return false;
  }

  /** Get remaining seconds until code expires. */
  get remainingSeconds(): number {
    return this.period - (Math.floor(Date.now() / 1000) % this.period);
  }
}

export class HOTP {
  public readonly secret: string;
  public readonly digits: number;
  public counter: number;
  public readonly algorithm: string;

  private _totp: TOTP;

  /**
   * Create a new HOTP instance.
   *
   * @param secret - Base32-encoded secret
   * @param digits - Number of digits
   * @param counter - Initial counter
   * @param algorithm - Hash algorithm
   */
  constructor(
    secret: string,
    digits: number = 6,
    counter: number = 0,
    algorithm: string = 'SHA1'
  ) {
    this.secret = secret;
    this.digits = digits;
    this.counter = counter;
    this.algorithm = algorithm;
    this._totp = new TOTP(secret, digits, 1, algorithm);
  }

  /**
   * Generate current HOTP code.
   *
   * @returns The OTP code
   */
  generate(): string {
    return (this._totp as any).generateHotp(this.counter);
  }

  /**
   * Verify an HOTP code.
   *
   * @param code - The code to verify
   * @param window - Number of counters to check ahead
   * @returns True if valid
   */
  verify(code: string, window: number = 10): boolean {
    for (let offset = 0; offset < window; offset++) {
      const checkCounter = this.counter + offset;
      const tempTotp = new TOTP(this.secret, this.digits, 1, this.algorithm);
      if ((tempTotp as any).generateHotp(checkCounter) === code) {
        this.counter = checkCounter + 1;
        return true;
      }
    }

    return false;
  }
}

/**
 * Parse an OTP URI and return the appropriate OTP object.
 *
 * @param uri - The otpauth:// URI
 * @returns TOTP or HOTP object
 */
export function parseOtpUri(uri: string): TOTP | HOTP {
  const url = new URL(uri);

  if (url.protocol !== 'otpauth:') {
    throw new Error(`Invalid OTP URI scheme: ${url.protocol}`);
  }

  const otpType = url.hostname.toLowerCase();
  if (otpType !== 'totp' && otpType !== 'hotp') {
    throw new Error(`Invalid OTP type: ${otpType}`);
  }

  const params = url.searchParams;
  const secret = params.get('secret');
  if (!secret) {
    throw new Error('Missing secret in OTP URI');
  }

  const digits = parseInt(params.get('digits') ?? '6', 10);
  const algorithm = params.get('algorithm') ?? 'SHA1';

  if (otpType === 'totp') {
    const period = parseInt(params.get('period') ?? '30', 10);
    return new TOTP(secret, digits, period, algorithm);
  } else {
    const counter = parseInt(params.get('counter') ?? '0', 10);
    return new HOTP(secret, digits, counter, algorithm);
  }
}

/**
 * Generate an OTP URI.
 *
 * @param options - URI options
 * @returns The OTP URI
 */
export function generateOtpUri(options: {
  secret: string;
  issuer: string;
  account: string;
  type?: 'totp' | 'hotp';
  digits?: number;
  period?: number;
  algorithm?: string;
  counter?: number;
}): string {
  const {
    secret,
    issuer,
    account,
    type = 'totp',
    digits = 6,
    period = 30,
    algorithm = 'SHA1',
    counter = 0,
  } = options;

  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  let params = `secret=${secret}&issuer=${encodeURIComponent(issuer)}`;

  if (digits !== 6) {
    params += `&digits=${digits}`;
  }

  if (algorithm !== 'SHA1') {
    params += `&algorithm=${algorithm}`;
  }

  if (type === 'totp' && period !== 30) {
    params += `&period=${period}`;
  } else if (type === 'hotp') {
    params += `&counter=${counter}`;
  }

  return `otpauth://${type}/${label}?${params}`;
}
