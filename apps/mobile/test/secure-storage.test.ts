import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

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
  get size(): number {
    return this.store.size;
  }
}

const storage = new MemoryStorage();
(globalThis as { localStorage?: unknown }).localStorage = storage;

const {
  __resetBiometryApiForTests,
  __setBiometryApiForTests,
  clearAllSecureAuth,
  isSecureStorageAvailable,
  loadRefreshToken,
  saveRefreshToken,
} = await import("../src/lib/secure-storage.ts");

beforeEach(() => {
  storage.clear();
});

afterEach(() => {
  __resetBiometryApiForTests();
});

test("without a secure backend, secrets stay in memory and never touch localStorage", async () => {
  __setBiometryApiForTests(null);
  assert.equal(await isSecureStorageAvailable(), false);

  await saveRefreshToken("super-secret-refresh-token");

  // The value is usable for the current session...
  assert.equal(await loadRefreshToken(), "super-secret-refresh-token");
  // ...but nothing was persisted to localStorage (no plaintext at rest).
  assert.equal(storage.size, 0);
});

test("saving a secret purges any legacy plaintext copy left in localStorage", async () => {
  __setBiometryApiForTests(null);
  // Simulate a value written at rest by the old localStorage fallback.
  storage.setItem("com.passshare.mobile:refresh-token", "leaked-plaintext");

  await saveRefreshToken("fresh-token");

  assert.equal(storage.getItem("com.passshare.mobile:refresh-token"), null);
  assert.equal(storage.size, 0);
});

test("a real secure backend is used and no fallback storage is written", async () => {
  const backing = new Map<string, string>();
  const fakeApi = {
    async setData({ name, data }: { name: string; data: string }) {
      backing.set(name, data);
    },
    async getData({ name }: { name: string }) {
      return { data: backing.get(name) ?? null };
    },
    async removeData({ name }: { name: string }) {
      backing.delete(name);
    },
  };
  __setBiometryApiForTests(fakeApi as never);

  assert.equal(await isSecureStorageAvailable(), true);
  await saveRefreshToken("keychain-token");
  assert.equal(await loadRefreshToken(), "keychain-token");
  assert.equal(backing.get("refresh-token"), "keychain-token");
  assert.equal(storage.size, 0);
});

test("clearAllSecureAuth removes the in-memory session secrets", async () => {
  __setBiometryApiForTests(null);
  await saveRefreshToken("to-be-cleared");
  await clearAllSecureAuth();
  assert.equal(await loadRefreshToken(), null);
});
