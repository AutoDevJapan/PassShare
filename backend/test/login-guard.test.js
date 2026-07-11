import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLoginGuard } from "../src/auth/login-guard.js";
import {
  createLoginGuardStore,
  createMemoryLoginGuardStore,
} from "../src/auth/login-guard-store.js";
import {
  LOGIN_IP_MAX_REQUESTS,
  LOGIN_IP_WINDOW_MS,
  LOGIN_LOCKOUT_MS,
  MAX_LOGIN_FAILURES,
} from "../src/auth/rate-limit-constants.js";

const MINUTE = 60 * 1000;

/** A controllable clock for deterministic TTL/eviction tests. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
    },
  };
}

describe("createLoginGuard lockout behaviour", () => {
  it("locks after MAX_LOGIN_FAILURES and throws PS028 while locked", async () => {
    const clock = fakeClock();
    const guard = createLoginGuard({ now: clock.now });

    for (let i = 0; i < MAX_LOGIN_FAILURES; i += 1) {
      await guard.recordFailure("user@example.com");
    }

    await assert.rejects(
      () => guard.assertNotLocked("user@example.com"),
      (err) => err.status === 429 && err.code === "PS028",
    );

    // After the lockout window the entry unlocks.
    clock.advance(LOGIN_LOCKOUT_MS + 1);
    await assert.doesNotReject(() => guard.assertNotLocked("user@example.com"));
  });

  it("clearFailures removes the tracked entry", async () => {
    const guard = createLoginGuard();
    await guard.recordFailure("user@example.com");
    assert.equal((await guard.stats()).trackedEmails, 1);
    await guard.clearFailures("user@example.com");
    assert.equal((await guard.stats()).trackedEmails, 0);
  });

  it("throttles per IP after LOGIN_IP_MAX_REQUESTS and throws PS029", async () => {
    const clock = fakeClock();
    const guard = createLoginGuard({ now: clock.now });

    for (let i = 0; i < LOGIN_IP_MAX_REQUESTS; i += 1) {
      await assert.doesNotReject(() => guard.assertIpAllowed("1.2.3.4"));
      await guard.recordIpRequest("1.2.3.4");
    }

    await assert.rejects(
      () => guard.assertIpAllowed("1.2.3.4"),
      (err) => err.status === 429 && err.code === "PS029" && err.retryAfterSec >= 1,
    );

    // The window slides: past LOGIN_IP_WINDOW_MS the requests are forgotten.
    clock.advance(LOGIN_IP_WINDOW_MS + 1);
    await assert.doesNotReject(() => guard.assertIpAllowed("1.2.3.4"));
  });
});

describe("createLoginGuard byEmail memory bounding", () => {
  it("evicts idle unlocked entries during an opportunistic sweep", async () => {
    const clock = fakeClock();
    const guard = createLoginGuard({ now: clock.now });

    await guard.recordFailure("idle@example.com");
    assert.equal((await guard.stats()).trackedEmails, 1);

    // Advance past both the idle TTL and the sweep interval, then trigger a write
    // that runs the sweep. The idle entry must be forgotten.
    clock.advance(16 * MINUTE);
    await guard.recordFailure("fresh@example.com");

    assert.equal((await guard.stats()).trackedEmails, 1, "only the fresh entry should remain");
  });

  it("evicts entries whose lockout has expired", async () => {
    const clock = fakeClock();
    const guard = createLoginGuard({ now: clock.now });

    for (let i = 0; i < MAX_LOGIN_FAILURES; i += 1) {
      await guard.recordFailure("locked@example.com");
    }
    assert.equal((await guard.stats()).trackedEmails, 1);

    clock.advance(16 * MINUTE);
    await guard.recordFailure("trigger@example.com");

    // The expired lock entry is swept; only the triggering entry remains.
    assert.equal((await guard.stats()).trackedEmails, 1);
  });

  it("retains entries that stay active", async () => {
    const clock = fakeClock();
    const guard = createLoginGuard({ now: clock.now });

    await guard.recordFailure("active@example.com");
    clock.advance(16 * MINUTE);
    // Re-activate before the sweep sees it as idle.
    await guard.recordFailure("active@example.com");

    assert.equal((await guard.stats()).trackedEmails, 1);
    await assert.doesNotReject(() => guard.assertNotLocked("active@example.com"));
  });
});

describe("createLoginGuardStore selection", () => {
  it("defaults to the in-memory store when no pool is provided", () => {
    const store = createLoginGuardStore(null, {});
    assert.equal(typeof store.recordEmailFailure, "function");
  });

  it("honours LOGIN_GUARD_STORE=memory even when a pool is present", () => {
    // A truthy placeholder stands in for a pool; memory mode must not touch it.
    const store = createLoginGuardStore({}, { LOGIN_GUARD_STORE: "memory" });
    assert.equal(typeof store.getIpWindow, "function");
  });

  it("throws when LOGIN_GUARD_STORE=pg is requested without a pool", () => {
    assert.throws(() => createLoginGuardStore(null, { LOGIN_GUARD_STORE: "pg" }));
  });
});

describe("createMemoryLoginGuardStore", () => {
  it("shares a single store instance across two guards (multi-instance analogue)", async () => {
    const clock = fakeClock();
    const shared = createMemoryLoginGuardStore({ now: clock.now });
    const guardA = createLoginGuard({ store: shared, now: clock.now });
    const guardB = createLoginGuard({ store: shared, now: clock.now });

    // Failures recorded through one guard lock the account on the other.
    for (let i = 0; i < MAX_LOGIN_FAILURES; i += 1) {
      await guardA.recordFailure("shared@example.com");
    }

    await assert.rejects(
      () => guardB.assertNotLocked("shared@example.com"),
      (err) => err.code === "PS028",
    );
  });
});
