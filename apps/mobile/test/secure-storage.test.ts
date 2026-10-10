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
  clearAuthSession,
  isSecureStorageAvailable,
  loadAuthSession,
  saveAuthSession,
} = await import("../src/lib/secure-storage.ts");

const SESSION = {
  refreshToken: "super-secret-refresh-token",
  connectAccessToken: "connect-access-token-value",
  connectExpiresAt: "2999-01-01T00:00:00.000Z",
};

const REASON = "Unlock PassShare";

/** Minimal fake of the biometry plugin that counts unlock (getData) prompts. */
function makeFakeApi() {
  const backing = new Map<string, string>();
  let getDataCalls = 0;
  const api = {
    async setData({ name, data }: { name: string; data: string }) {
      backing.set(name, data);
    },
    async getData({ name }: { name: string }) {
      getDataCalls += 1;
      return { data: backing.get(name) ?? null };
    },
    async removeData({ name }: { name: string }) {
      backing.delete(name);
    },
  };
  return { api, backing, getDataCalls: () => getDataCalls };
}

test("saving after legacy cleanup retains the Android domain key needed to reopen", async () => {
  const records = new Map<string, string>();
  let domainKeyPresent = false;
  const api = {
    async setData({ name, data }: { name: string; data: string }) {
      domainKeyPresent = true;
      records.set(name, data);
    },
    async getData({ name }: { name: string }) {
      if (!domainKeyPresent) throw new Error("No key pair found");
      return { data: records.get(name) ?? null };
    },
    async removeData({ name }: { name: string }) {
      records.delete(name);
      // The real Android plugin deletes the domain alias for every remove,
      // including a legacy name that does not have any stored data.
      domainKeyPresent = false;
    },
  };
  __setBiometryApiForTests(api as never);
  await saveAuthSession(SESSION);
  assert.deepEqual(await loadAuthSession(REASON), SESSION);
  await clearAuthSession();
  assert.equal(records.size, 0);
  assert.equal(domainKeyPresent, false);
});

beforeEach(() => {
  storage.clear();
});

afterEach(() => {
  __resetBiometryApiForTests();
});

test("without a secure backend, secrets stay in memory and never touch localStorage", async () => {
  __setBiometryApiForTests(null);
  assert.equal(await isSecureStorageAvailable(), false);

  await saveAuthSession(SESSION);

  // The value is usable for the current session...
  assert.deepEqual(await loadAuthSession(REASON), SESSION);
  // ...but nothing was persisted to localStorage (no plaintext at rest).
  assert.equal(storage.size, 0);
});

test("saving a secret purges any legacy plaintext copy left in localStorage", async () => {
  __setBiometryApiForTests(null);
  // Simulate values written at rest by the pre-blob localStorage fallback.
  storage.setItem("com.passshare.mobile:refresh-token", "leaked-plaintext");
  storage.setItem("com.passshare.mobile:connect-access-token", "leaked-connect");

  await saveAuthSession(SESSION);

  assert.equal(storage.getItem("com.passshare.mobile:refresh-token"), null);
  assert.equal(storage.getItem("com.passshare.mobile:connect-access-token"), null);
  assert.equal(storage.size, 0);
});

test("reading the stored session needs a single biometric prompt", async () => {
  const { api, getDataCalls } = makeFakeApi();
  __setBiometryApiForTests(api as never);

  await saveAuthSession(SESSION);
  const loaded = await loadAuthSession(REASON);

  assert.deepEqual(loaded, SESSION);
  // The whole session is one blob, so exactly one unlock prompt occurs.
  assert.equal(getDataCalls(), 1);
});

test("saving the session purges secrets left under the pre-blob keys", async () => {
  const { api, backing } = makeFakeApi();
  __setBiometryApiForTests(api as never);
  backing.set("refresh-token", "stale-refresh");
  backing.set("connect-access-token", "stale-connect");
  backing.set("connect-expires-at", "stale-expiry");

  await saveAuthSession(SESSION);

  assert.equal(backing.has("refresh-token"), false);
  assert.equal(backing.has("connect-access-token"), false);
  assert.equal(backing.has("connect-expires-at"), false);
  assert.equal(backing.get("auth-session"), JSON.stringify(SESSION));
});

test("a corrupt or legacy payload is treated as no session", async () => {
  const { api, backing } = makeFakeApi();
  __setBiometryApiForTests(api as never);
  backing.set("auth-session", "{not valid json");

  assert.equal(await loadAuthSession(REASON), null);
});

test("clearAuthSession removes the in-memory session secrets", async () => {
  __setBiometryApiForTests(null);
  await saveAuthSession(SESSION);
  await clearAuthSession();
  assert.equal(await loadAuthSession(REASON), null);
});

test("logout removes an OS write that was already in flight", async () => {
  const { api, backing } = makeFakeApi();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const setData = api.setData;
  api.setData = async (input) => {
    entered.resolve();
    await release.promise;
    await setData(input);
  };
  __setBiometryApiForTests(api as never);
  let current = true;
  const writing = saveAuthSession(SESSION, () => current);
  const refused = assert.rejects(writing, /Session changed/);
  await entered.promise;
  current = false;
  const removing = clearAuthSession();
  release.resolve();
  await refused;
  await removing;
  assert.equal(backing.has("auth-session"), false);
  assert.equal(await loadAuthSession(REASON), null);
});

test("cleanup of a stale OS write cannot remove a newer account", async () => {
  const { api, backing } = makeFakeApi();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const setData = api.setData;
  let first = true;
  api.setData = async (input) => {
    if (first) { first = false; entered.resolve(); await release.promise; }
    await setData(input);
  };
  __setBiometryApiForTests(api as never);
  let current = true;
  const old = saveAuthSession(SESSION, () => current);
  const refused = assert.rejects(old, /Session changed/);
  await entered.promise;
  current = false;
  const next = { ...SESSION, refreshToken: "synthetic-next-account" };
  const writing = saveAuthSession(next);
  release.resolve();
  await refused;
  await writing;
  await clearAuthSession(() => false);
  assert.equal(backing.get("auth-session"), JSON.stringify(next));
  assert.deepEqual(await loadAuthSession(REASON), next);
});
