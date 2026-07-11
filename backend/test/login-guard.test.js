import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLoginGuard } from "../src/auth/login-guard.js";
import { LOGIN_LOCKOUT_MS, MAX_LOGIN_FAILURES } from "../src/auth/rate-limit-constants.js";

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
  it("locks after MAX_LOGIN_FAILURES and throws PS028 while locked", () => {
    const clock = fakeClock();
    const guard = createLoginGuard({ now: clock.now });

    for (let i = 0; i < MAX_LOGIN_FAILURES; i += 1) {
      guard.recordFailure("user@example.com");
    }

    assert.throws(
      () => guard.assertNotLocked("user@example.com"),
      (err) => err.status === 429 && err.code === "PS028",
    );

    // After the lockout window the entry unlocks.
    clock.advance(LOGIN_LOCKOUT_MS + 1);
    assert.doesNotThrow(() => guard.assertNotLocked("user@example.com"));
  });

  it("clearFailures removes the tracked entry", () => {
    const guard = createLoginGuard();
    guard.recordFailure("user@example.com");
    assert.equal(guard.stats().trackedEmails, 1);
    guard.clearFailures("user@example.com");
    assert.equal(guard.stats().trackedEmails, 0);
  });
});

describe("createLoginGuard byEmail memory bounding", () => {
  it("evicts idle unlocked entries during an opportunistic sweep", () => {
    const clock = fakeClock();
    const guard = createLoginGuard({ now: clock.now });

    guard.recordFailure("idle@example.com");
    assert.equal(guard.stats().trackedEmails, 1);

    // Advance past both the idle TTL and the sweep interval, then trigger a write
    // that runs the sweep. The idle entry must be forgotten.
    clock.advance(16 * MINUTE);
    guard.recordFailure("fresh@example.com");

    const stats = guard.stats();
    assert.equal(stats.trackedEmails, 1, "only the fresh entry should remain");
  });

  it("evicts entries whose lockout has expired", () => {
    const clock = fakeClock();
    const guard = createLoginGuard({ now: clock.now });

    for (let i = 0; i < MAX_LOGIN_FAILURES; i += 1) {
      guard.recordFailure("locked@example.com");
    }
    assert.equal(guard.stats().trackedEmails, 1);

    clock.advance(16 * MINUTE);
    guard.recordFailure("trigger@example.com");

    // The expired lock entry is swept; only the triggering entry remains.
    assert.equal(guard.stats().trackedEmails, 1);
  });

  it("retains entries that stay active", () => {
    const clock = fakeClock();
    const guard = createLoginGuard({ now: clock.now });

    guard.recordFailure("active@example.com");
    clock.advance(16 * MINUTE);
    // Re-activate before the sweep sees it as idle.
    guard.recordFailure("active@example.com");

    assert.equal(guard.stats().trackedEmails, 1);
    assert.doesNotThrow(() => guard.assertNotLocked("active@example.com"));
  });
});
