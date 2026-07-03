/**
 * Shared password generator.
 *
 * Single source of truth for the "generate password" buttons across the web
 * frontend and mobile app. Both previously had inline generators that used
 * `byte % alphabet.length` (modulo bias — some characters are more likely than
 * others) and guaranteed no character-class coverage, so a generated password
 * could legitimately contain e.g. no digits (#324).
 *
 * This implementation:
 *   - draws randomness from the platform CSPRNG (`crypto.getRandomValues`)
 *   - uses rejection sampling to avoid modulo bias
 *   - guarantees at least one lower, upper, digit and symbol
 *   - clamps the requested length to [MIN_LENGTH, MAX_LENGTH]
 */

const LOWER = "abcdefghijkmnopqrstuvwxyz"; // no l (visually ambiguous)
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I, O
const DIGITS = "23456789"; // no 0, 1
const SYMBOLS = "!@#$%^&*";
const ALL = LOWER + UPPER + DIGITS + SYMBOLS;

export const MIN_LENGTH = 12;
export const MAX_LENGTH = 64;
export const DEFAULT_LENGTH = 20;

const UINT32_RANGE = 0x1_0000_0000;

/** Uniform random integer in [0, max) via rejection sampling (no modulo bias). */
function randomIndex(max: number): number {
  // Largest multiple of `max` that fits in a uint32; values at or above it are
  // rejected so the remaining range divides evenly.
  const limit = Math.floor(UINT32_RANGE / max) * max;
  const buf = new Uint32Array(1);
  let value: number;
  do {
    crypto.getRandomValues(buf);
    value = buf[0];
  } while (value >= limit);
  return value % max;
}

function pick(set: string): string {
  return set[randomIndex(set.length)];
}

/** Fisher-Yates shuffle using the unbiased randomIndex. */
function shuffle(chars: string[]): void {
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
}

export function generatePassword(length: number = DEFAULT_LENGTH): string {
  const target = Math.min(
    Math.max(Math.floor(length) || DEFAULT_LENGTH, MIN_LENGTH),
    MAX_LENGTH,
  );

  // Seed one of each class so coverage is guaranteed, then fill the rest.
  const chars: string[] = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < target) {
    chars.push(pick(ALL));
  }
  shuffle(chars);
  return chars.join("");
}
