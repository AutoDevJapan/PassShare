const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
const SYMBOLS = "!@#$%^&*()-_=+[]{}";

export function generatePassword(length = 20): string {
  const safeLength = Math.min(Math.max(length, 12), 64);
  const all = LOWER + UPPER + DIGITS + SYMBOLS;
  const required = [
    LOWER[randomIndex(LOWER.length)],
    UPPER[randomIndex(UPPER.length)],
    DIGITS[randomIndex(DIGITS.length)],
    SYMBOLS[randomIndex(SYMBOLS.length)],
  ];
  const rest = Array.from({ length: safeLength - required.length }, () =>
    all[randomIndex(all.length)],
  );
  const chars = [...required, ...rest];
  shuffle(chars);
  return chars.join("");
}

function randomIndex(max: number): number {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return array[0] % max;
}

function shuffle<T>(items: T[]): void {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
}
