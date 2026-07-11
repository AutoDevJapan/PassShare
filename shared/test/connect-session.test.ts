import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bootstrapConnectSession,
  type ConnectSessionApi,
  type ConnectSessionStore,
  type StoredConnectSession,
} from "../lib/connect-session.ts";

type TestUser = { id: string };

const FUTURE = new Date(Date.now() + 60_000).toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();

type StoreCalls = {
  loads: number;
  clears: number;
  saved: StoredConnectSession[];
};

function makeStore(
  initial: StoredConnectSession | null,
): { store: ConnectSessionStore; calls: StoreCalls } {
  const calls: StoreCalls = { loads: 0, clears: 0, saved: [] };
  const store: ConnectSessionStore = {
    async load() {
      calls.loads += 1;
      return initial;
    },
    async save(session) {
      calls.saved.push(session);
    },
    async clear() {
      calls.clears += 1;
    },
  };
  return { store, calls };
}

describe("bootstrapConnectSession", () => {
  it("returns null and reads storage once when there is no refresh token", async () => {
    const { store, calls } = makeStore(null);
    const api: ConnectSessionApi<TestUser> = {
      fetchCurrentUser: async () => {
        throw new Error("should not be called");
      },
      refreshConnectToken: async () => {
        throw new Error("should not be called");
      },
    };

    const result = await bootstrapConnectSession(store, api);

    assert.equal(result, null);
    assert.equal(calls.loads, 1);
    assert.equal(calls.clears, 0);
  });

  it("clears storage and returns null when the user is no longer valid", async () => {
    const { store, calls } = makeStore({
      refreshToken: "refresh",
      connectAccessToken: "token",
      connectExpiresAt: FUTURE,
    });
    const api: ConnectSessionApi<TestUser> = {
      fetchCurrentUser: async () => null,
      refreshConnectToken: async () => {
        throw new Error("should not be called");
      },
    };

    const result = await bootstrapConnectSession(store, api);

    assert.equal(result, null);
    assert.equal(calls.clears, 1);
    assert.equal(calls.saved.length, 0);
  });

  it("reuses a still-usable Connect token without refreshing", async () => {
    const { store, calls } = makeStore({
      refreshToken: "refresh",
      connectAccessToken: "usable-token",
      connectExpiresAt: FUTURE,
    });
    let refreshCalls = 0;
    const api: ConnectSessionApi<TestUser> = {
      fetchCurrentUser: async () => ({ id: "u1" }),
      refreshConnectToken: async () => {
        refreshCalls += 1;
        return { connectAccessToken: "new-token", connectExpiresAt: FUTURE };
      },
    };

    const result = await bootstrapConnectSession(store, api);

    assert.deepEqual(result, { user: { id: "u1" }, accessToken: "usable-token" });
    assert.equal(refreshCalls, 0);
    assert.equal(calls.saved.length, 0);
  });

  it("refreshes and persists a new Connect token when the stored one is expired", async () => {
    const { store, calls } = makeStore({
      refreshToken: "refresh",
      connectAccessToken: "expired-token",
      connectExpiresAt: PAST,
    });
    const api: ConnectSessionApi<TestUser> = {
      fetchCurrentUser: async () => ({ id: "u1" }),
      refreshConnectToken: async (refreshToken) => {
        assert.equal(refreshToken, "refresh");
        return { connectAccessToken: "fresh-token", connectExpiresAt: FUTURE };
      },
    };

    const result = await bootstrapConnectSession(store, api);

    assert.deepEqual(result, { user: { id: "u1" }, accessToken: "fresh-token" });
    assert.equal(calls.saved.length, 1);
    assert.deepEqual(calls.saved[0], {
      refreshToken: "refresh",
      connectAccessToken: "fresh-token",
      connectExpiresAt: FUTURE,
    });
  });

  it("refreshes when the stored session has no Connect token", async () => {
    const { store, calls } = makeStore({
      refreshToken: "refresh",
      connectAccessToken: "",
      connectExpiresAt: "",
    });
    const api: ConnectSessionApi<TestUser> = {
      fetchCurrentUser: async () => ({ id: "u1" }),
      refreshConnectToken: async () => ({ connectAccessToken: "fresh-token", connectExpiresAt: FUTURE }),
    };

    const result = await bootstrapConnectSession(store, api);

    assert.deepEqual(result, { user: { id: "u1" }, accessToken: "fresh-token" });
    assert.equal(calls.saved.length, 1);
  });
});
