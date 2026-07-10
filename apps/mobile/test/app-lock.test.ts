import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

// Minimal in-memory localStorage shim so the module under test can run outside a
// WebView. Installed before importing app-lock (which reads the global lazily).
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
  keys(): string[] {
    return [...this.store.keys()];
  }
}

const storage = new MemoryStorage();
(globalThis as { localStorage?: unknown }).localStorage = storage;

const {
  clearAppPin,
  getPinLockState,
  hasAppPin,
  setAppPin,
  verifyAppPin,
} = await import("../src/lib/app-lock.ts");

beforeEach(() => {
  storage.clear();
});

test("setAppPin rejects PINs shorter than 6 digits", async () => {
  await assert.rejects(() => setAppPin("1234"), /6-8 digits/);
  await assert.rejects(() => setAppPin("12345"), /6-8 digits/);
  await assert.rejects(() => setAppPin("123456789"), /6-8 digits/);
  await assert.rejects(() => setAppPin("12ab56"), /6-8 digits/);
});

test("stored record is a salted PBKDF2 record, not the raw PIN or a bare hash", async () => {
  await setAppPin("135790");
  const raw = storage.getItem("app-pin-hash");
  assert.ok(raw);
  const record = JSON.parse(raw as string);
  assert.equal(record.v, 2);
  assert.ok(record.iterations >= 100_000);
  assert.equal(typeof record.salt, "string");
  assert.equal(typeof record.hash, "string");
  // The plaintext PIN must not appear anywhere in the persisted record.
  assert.ok(!(raw as string).includes("135790"));
});

test("two identical PINs produce different hashes (per-device salt)", async () => {
  await setAppPin("246800");
  const first = JSON.parse(storage.getItem("app-pin-hash") as string);
  await setAppPin("246800");
  const second = JSON.parse(storage.getItem("app-pin-hash") as string);
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.hash, second.hash);
});

test("verifyAppPin accepts the correct PIN and rejects a wrong one", async () => {
  await setAppPin("246801");
  assert.deepEqual(await verifyAppPin("246801"), { status: "ok" });
  const wrong = await verifyAppPin("000000");
  assert.equal(wrong.status, "invalid");
});

test("a successful unlock clears the failure counter", async () => {
  await setAppPin("246802");
  await verifyAppPin("000000");
  await verifyAppPin("000000");
  const ok = await verifyAppPin("246802");
  assert.deepEqual(ok, { status: "ok" });
  // Counter reset: a subsequent wrong guess reports the full remaining budget.
  const wrong = await verifyAppPin("000000");
  assert.deepEqual(wrong, { status: "invalid", remainingAttempts: 4 });
});

test("repeated failures lock the account with exponential backoff", async () => {
  await setAppPin("246803");
  const now = 1_000_000;
  let last;
  for (let i = 0; i < 5; i += 1) {
    last = await verifyAppPin("000000", now);
  }
  assert.equal(last?.status, "locked");
  const firstLock = last as { status: "locked"; retryAtMs: number };
  assert.equal(firstLock.retryAtMs, now + 30_000);

  // While locked, even the correct PIN is refused.
  const duringLock = await verifyAppPin("246803", now + 1_000);
  assert.deepEqual(duringLock, { status: "locked", retryAtMs: firstLock.retryAtMs });

  // Next failure after the window escalates the backoff.
  const afterWindow = now + 30_001;
  const second = await verifyAppPin("000000", afterWindow);
  assert.equal(second.status, "locked");
  assert.equal((second as { retryAtMs: number }).retryAtMs, afterWindow + 60_000);
});

test("getPinLockState reflects an active lockout without consuming a try", async () => {
  await setAppPin("246804");
  const now = 2_000_000;
  for (let i = 0; i < 5; i += 1) {
    await verifyAppPin("000000", now);
  }
  assert.equal(getPinLockState(now + 1_000).locked, true);
  assert.equal(getPinLockState(now + 30_001).locked, false);
});

test("hasAppPin discards a legacy unsalted SHA-256 record and forces re-setup", async () => {
  // v1 shape: a bare 64-char hex digest with no salt/version wrapper.
  storage.setItem("app-pin-hash", "a".repeat(64));
  assert.equal(await hasAppPin(), false);
  assert.equal(storage.getItem("app-pin-hash"), null);
});

test("clearAppPin removes both the record and the lockout state", async () => {
  await setAppPin("246805");
  await verifyAppPin("000000");
  await clearAppPin();
  assert.equal(storage.getItem("app-pin-hash"), null);
  assert.equal(storage.getItem("app-pin-lockout"), null);
  assert.equal(await hasAppPin(), false);
});
