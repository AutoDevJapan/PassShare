/**
 * Password generation for PassShare.
 */

import * as crypto from 'crypto';

const LOWERCASE = 'abcdefghijklmnopqrstuvwxyz';
const UPPERCASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const SYMBOLS = '!@#$%^&*()-_=+[]{}|;:,.<>?';

// Word list for XKCD-style passwords
const WORD_LIST = [
  'correct', 'horse', 'battery', 'staple', 'apple', 'banana', 'cherry', 'dragon',
  'elephant', 'falcon', 'guitar', 'hammer', 'island', 'jungle', 'kingdom', 'lemon',
  'mountain', 'noble', 'ocean', 'piano', 'queen', 'river', 'sunset', 'tiger',
  'umbrella', 'valley', 'wizard', 'xenon', 'yellow', 'zebra', 'anchor', 'bridge',
  'castle', 'diamond', 'eagle', 'forest', 'garden', 'harbor', 'iceberg', 'jacket',
  'knight', 'lantern', 'marble', 'needle', 'orange', 'penguin', 'quartz', 'rocket',
  'silver', 'thunder', 'unicorn', 'violet', 'window', 'crystal', 'dolphin', 'empire',
  'fountain', 'glacier', 'horizon', 'ivory', 'jasmine', 'koala', 'lighthouse', 'meteor',
];

export interface GeneratePasswordOptions {
  /** Password length (characters or words for XKCD) */
  length?: number;
  /** Include symbols */
  symbols?: boolean;
  /** Exclude symbols (overrides symbols) */
  noSymbols?: boolean;
  /** Generate XKCD-style password */
  xkcd?: boolean;
  /** Separator for XKCD words */
  xkcdSeparator?: string;
  /** Number of words for XKCD */
  xkcdWords?: number;
}

/**
 * Generate a random password.
 *
 * @param options - Generation options
 * @returns The generated password
 */
export function generatePassword(options: GeneratePasswordOptions = {}): string {
  const {
    length = 24,
    symbols = true,
    noSymbols = false,
    xkcd = false,
    xkcdSeparator = '-',
    xkcdWords = 4,
  } = options;

  if (xkcd) {
    return generateXkcdPassword(xkcdWords, xkcdSeparator);
  }

  return generateRandomPassword(length, symbols && !noSymbols);
}

function generateRandomPassword(length: number, useSymbols: boolean): string {
  let charset = LOWERCASE + UPPERCASE + DIGITS;
  if (useSymbols) {
    charset += SYMBOLS;
  }

  const chars: string[] = [];

  if (length >= 4) {
    // Ensure at least one of each required type
    chars.push(secureRandomChoice(LOWERCASE));
    chars.push(secureRandomChoice(UPPERCASE));
    chars.push(secureRandomChoice(DIGITS));
    if (useSymbols) {
      chars.push(secureRandomChoice(SYMBOLS));
    }

    const remaining = length - chars.length;
    for (let i = 0; i < remaining; i++) {
      chars.push(secureRandomChoice(charset));
    }

    // Shuffle
    for (let i = chars.length - 1; i > 0; i--) {
      const j = secureRandomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
  } else {
    for (let i = 0; i < length; i++) {
      chars.push(secureRandomChoice(charset));
    }
  }

  return chars.join('');
}

function generateXkcdPassword(numWords: number, separator: string): string {
  const words: string[] = [];
  for (let i = 0; i < numWords; i++) {
    words.push(secureRandomChoice(WORD_LIST));
  }
  return words.join(separator);
}

function secureRandomChoice<T>(array: T[] | string): T {
  const index = secureRandomInt(array.length);
  return array[index] as T;
}

function secureRandomInt(max: number): number {
  const bytes = crypto.randomBytes(4);
  const value = bytes.readUInt32BE(0);
  return value % max;
}

export interface PasswordStrength {
  length: number;
  entropy: number;
  strength: 'weak' | 'fair' | 'good' | 'strong';
  hasLowercase: boolean;
  hasUppercase: boolean;
  hasDigits: boolean;
  hasSymbols: boolean;
}

/**
 * Check password strength.
 *
 * @param password - The password to check
 * @returns Strength analysis
 */
export function checkPasswordStrength(password: string): PasswordStrength {
  const hasLowercase = /[a-z]/.test(password);
  const hasUppercase = /[A-Z]/.test(password);
  const hasDigits = /[0-9]/.test(password);
  const hasSymbols = /[!@#$%^&*()\-_=+\[\]{}|;:,.<>?]/.test(password);

  let charsetSize = 0;
  if (hasLowercase) charsetSize += 26;
  if (hasUppercase) charsetSize += 26;
  if (hasDigits) charsetSize += 10;
  if (hasSymbols) charsetSize += SYMBOLS.length;

  const entropy = charsetSize > 0 ? password.length * Math.log2(charsetSize) : 0;

  let strength: 'weak' | 'fair' | 'good' | 'strong';
  if (entropy >= 80) {
    strength = 'strong';
  } else if (entropy >= 60) {
    strength = 'good';
  } else if (entropy >= 40) {
    strength = 'fair';
  } else {
    strength = 'weak';
  }

  return {
    length: password.length,
    entropy,
    strength,
    hasLowercase,
    hasUppercase,
    hasDigits,
    hasSymbols,
  };
}
