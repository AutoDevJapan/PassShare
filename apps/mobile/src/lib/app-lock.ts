// App-lock PIN storage (#321 H9b).
//
// The PIN is stretched with a salted, high-iteration KDF (PBKDF2-SHA256) so a
// stored record cannot be reversed by precomputation, and repeated guesses are
// throttled by a failure counter with exponential lockout backoff. Legacy
// unsalted SHA-256 records (v1) are discarded on read and force a fresh setup.

const APP_PIN_KEY = "app-pin-hash";
const APP_PIN_LOCKOUT_KEY = "app-pin-lockout";

const RECORD_VERSION = 2;
const PBKDF2_ITERATIONS = 210_000;
const SALT_BYTES = 16;
const DERIVED_BITS = 256;

// Lockout policy: the user gets FREE_ATTEMPTS wrong tries; from that attempt on,
// each failure locks the app with exponential backoff capped at MAX_LOCKOUT_MS.
const FREE_ATTEMPTS = 5;
const BASE_LOCKOUT_MS = 30_000;
const MAX_LOCKOUT_MS = 15 * 60_000;

const PIN_PATTERN = /^\d{6,8}$/;

type PinRecord = {
  v: number;
  salt: string;
  iterations: number;
  hash: string;
};

type LockoutState = {
  failedAttempts: number;
  lockedUntil: number;
};

export type PinVerification =
  | { status: "ok" }
  | { status: "invalid"; remainingAttempts: number }
  | { status: "locked"; retryAtMs: number };

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function derivePinHash(
  pin: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    keyMaterial,
    DERIVED_BITS,
  );
  return toBase64(new Uint8Array(bits));
}

/** Constant-time string comparison to avoid leaking the match position. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function readPinRecord(): PinRecord | null {
  const raw = localStorage.getItem(APP_PIN_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PinRecord>;
    if (
      parsed.v === RECORD_VERSION &&
      typeof parsed.salt === "string" &&
      typeof parsed.hash === "string" &&
      typeof parsed.iterations === "number"
    ) {
      return parsed as PinRecord;
    }
  } catch {
    // Fall through: legacy or corrupt record.
  }
  return null;
}

function readLockout(): LockoutState {
  const raw = localStorage.getItem(APP_PIN_LOCKOUT_KEY);
  if (!raw) {
    return { failedAttempts: 0, lockedUntil: 0 };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockoutState>;
    return {
      failedAttempts:
        typeof parsed.failedAttempts === "number" ? parsed.failedAttempts : 0,
      lockedUntil: typeof parsed.lockedUntil === "number" ? parsed.lockedUntil : 0,
    };
  } catch {
    return { failedAttempts: 0, lockedUntil: 0 };
  }
}

function writeLockout(state: LockoutState): void {
  localStorage.setItem(APP_PIN_LOCKOUT_KEY, JSON.stringify(state));
}

function clearLockout(): void {
  localStorage.removeItem(APP_PIN_LOCKOUT_KEY);
}

export async function hasAppPin(): Promise<boolean> {
  const raw = localStorage.getItem(APP_PIN_KEY);
  if (!raw) {
    return false;
  }
  if (readPinRecord()) {
    return true;
  }
  // Legacy unsalted SHA-256 (v1) or corrupt record: discard so the user is
  // forced to re-enroll under the salted KDF.
  localStorage.removeItem(APP_PIN_KEY);
  clearLockout();
  return false;
}

export async function setAppPin(pin: string): Promise<void> {
  if (!PIN_PATTERN.test(pin)) {
    throw new Error("PIN must be 6-8 digits.");
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const record: PinRecord = {
    v: RECORD_VERSION,
    salt: toBase64(salt),
    iterations: PBKDF2_ITERATIONS,
    hash: await derivePinHash(pin, salt, PBKDF2_ITERATIONS),
  };
  localStorage.setItem(APP_PIN_KEY, JSON.stringify(record));
  clearLockout();
}

/** Current lockout status without consuming an attempt (for UI on mount). */
export function getPinLockState(now: number = Date.now()): {
  locked: boolean;
  retryAtMs: number;
} {
  const { lockedUntil } = readLockout();
  if (lockedUntil > now) {
    return { locked: true, retryAtMs: lockedUntil };
  }
  return { locked: false, retryAtMs: 0 };
}

export async function verifyAppPin(
  pin: string,
  now: number = Date.now(),
): Promise<PinVerification> {
  const lockout = readLockout();
  if (lockout.lockedUntil > now) {
    return { status: "locked", retryAtMs: lockout.lockedUntil };
  }

  const record = readPinRecord();
  if (!record) {
    return { status: "invalid", remainingAttempts: FREE_ATTEMPTS };
  }

  const candidate = await derivePinHash(pin, fromBase64(record.salt), record.iterations);
  if (timingSafeEqual(candidate, record.hash)) {
    clearLockout();
    return { status: "ok" };
  }

  const failedAttempts = lockout.failedAttempts + 1;
  if (failedAttempts >= FREE_ATTEMPTS) {
    const backoff = Math.min(
      BASE_LOCKOUT_MS * 2 ** (failedAttempts - FREE_ATTEMPTS),
      MAX_LOCKOUT_MS,
    );
    const lockedUntil = now + backoff;
    writeLockout({ failedAttempts, lockedUntil });
    return { status: "locked", retryAtMs: lockedUntil };
  }
  writeLockout({ failedAttempts, lockedUntil: 0 });
  return { status: "invalid", remainingAttempts: FREE_ATTEMPTS - failedAttempts };
}

export async function clearAppPin(): Promise<void> {
  localStorage.removeItem(APP_PIN_KEY);
  clearLockout();
}
