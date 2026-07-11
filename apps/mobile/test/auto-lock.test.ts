import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

// In-memory localStorage shim (see app-lock.test.ts) so the settings helpers can
// run outside a WebView. Installed before importing the module under test.
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
}

const storage = new MemoryStorage();
(globalThis as { localStorage?: unknown }).localStorage = storage;
// window is optional for the controller; stub a minimal one for the settings
// event dispatch path.
const dispatched: string[] = [];
(globalThis as { window?: unknown }).window = {
  dispatchEvent: (event: { type: string }) => {
    dispatched.push(event.type);
    return true;
  },
};
(globalThis as { CustomEvent?: unknown }).CustomEvent = class {
  type: string;
  detail: unknown;
  constructor(type: string, init?: { detail?: unknown }) {
    this.type = type;
    this.detail = init?.detail;
  }
};

const {
  AUTO_LOCK_CHANGED_EVENT,
  AutoLockController,
  DEFAULT_IDLE_TIMEOUT_MS,
  getAutoLockIdleMs,
  normalizeIdleTimeoutMs,
  setAutoLockIdleMs,
} = await import("../src/lib/auto-lock.ts");

/** Deterministic clock + timer queue so lifecycle logic is testable without wall time. */
class FakeClock {
  private t = 0;
  private seq = 1;
  private timers = new Map<number, { at: number; cb: () => void }>();

  now = (): number => this.t;

  setTimer = (cb: () => void, ms: number): number => {
    const id = this.seq++;
    this.timers.set(id, { at: this.t + ms, cb });
    return id as unknown as number;
  };

  clearTimer = (handle: number): void => {
    this.timers.delete(handle);
  };

  /** Advance time, firing any timers whose deadline is reached, in order. */
  advance(ms: number): void {
    const target = this.t + ms;
    // Fire timers up to `target`, honoring re-scheduling during callbacks.
    // Loop until no due timer remains before/at target.
    for (;;) {
      let next: { id: number; at: number; cb: () => void } | null = null;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && (next === null || timer.at < next.at)) {
          next = { id, at: timer.at, cb: timer.cb };
        }
      }
      if (!next) {
        break;
      }
      this.timers.delete(next.id);
      this.t = next.at;
      next.cb();
    }
    this.t = target;
  }

  deps() {
    return { now: this.now, setTimer: this.setTimer, clearTimer: this.clearTimer };
  }
}

beforeEach(() => {
  storage.clear();
  dispatched.length = 0;
});

test("idle timeout fires the lock after the configured inactivity window", () => {
  const clock = new FakeClock();
  let locks = 0;
  const controller = new AutoLockController(
    { idleTimeoutMs: 120_000, backgroundGraceMs: 0 },
    () => {
      locks += 1;
    },
    clock.deps(),
  );
  controller.start();

  clock.advance(119_000);
  assert.equal(locks, 0);
  clock.advance(2_000);
  assert.equal(locks, 1);
});

test("activity restarts the idle countdown", () => {
  const clock = new FakeClock();
  let locks = 0;
  const controller = new AutoLockController(
    { idleTimeoutMs: 60_000, backgroundGraceMs: 0 },
    () => {
      locks += 1;
    },
    clock.deps(),
  );
  controller.start();

  clock.advance(50_000);
  controller.notifyActivity();
  clock.advance(50_000); // 100s total, but only 50s since activity
  assert.equal(locks, 0);
  clock.advance(11_000);
  assert.equal(locks, 1);
});

test("backgrounding locks immediately with a zero grace", () => {
  const clock = new FakeClock();
  let locks = 0;
  const controller = new AutoLockController(
    { idleTimeoutMs: 120_000, backgroundGraceMs: 0 },
    () => {
      locks += 1;
    },
    clock.deps(),
  );
  controller.start();

  controller.notifyVisibility(true);
  clock.advance(1);
  assert.equal(locks, 1);
});

test("returning to foreground before the grace elapses cancels the background lock", () => {
  const clock = new FakeClock();
  let locks = 0;
  const controller = new AutoLockController(
    { idleTimeoutMs: 120_000, backgroundGraceMs: 30_000 },
    () => {
      locks += 1;
    },
    clock.deps(),
  );
  controller.start();

  controller.notifyVisibility(true);
  clock.advance(10_000);
  controller.notifyVisibility(false); // came back within the grace
  clock.advance(25_000);
  assert.equal(locks, 0, "background lock should have been cancelled");
  // Idle countdown resumed on return: still under 120s of inactivity.
  clock.advance(100_000);
  assert.equal(locks, 1);
});

test("the lock callback fires at most once", () => {
  const clock = new FakeClock();
  let locks = 0;
  const controller = new AutoLockController(
    { idleTimeoutMs: 10_000, backgroundGraceMs: 0 },
    () => {
      locks += 1;
    },
    clock.deps(),
  );
  controller.start();

  clock.advance(11_000);
  controller.notifyActivity();
  controller.notifyVisibility(true);
  clock.advance(60_000);
  assert.equal(locks, 1);
});

test("an idle timeout of zero disables the idle trigger", () => {
  const clock = new FakeClock();
  let locks = 0;
  const controller = new AutoLockController(
    { idleTimeoutMs: 0, backgroundGraceMs: 0 },
    () => {
      locks += 1;
    },
    clock.deps(),
  );
  controller.start();

  clock.advance(10 * 60_000);
  assert.equal(locks, 0);
  // Background trigger still works.
  controller.notifyVisibility(true);
  clock.advance(1);
  assert.equal(locks, 1);
});

test("stop() cancels a pending idle lock", () => {
  const clock = new FakeClock();
  let locks = 0;
  const controller = new AutoLockController(
    { idleTimeoutMs: 60_000, backgroundGraceMs: 0 },
    () => {
      locks += 1;
    },
    clock.deps(),
  );
  controller.start();
  clock.advance(30_000);
  controller.stop();
  clock.advance(60_000);
  assert.equal(locks, 0);
});

test("normalizeIdleTimeoutMs clamps unknown values to the default", () => {
  assert.equal(normalizeIdleTimeoutMs(60_000), 60_000);
  assert.equal(normalizeIdleTimeoutMs("300000"), 300_000);
  assert.equal(normalizeIdleTimeoutMs(999), DEFAULT_IDLE_TIMEOUT_MS);
  assert.equal(normalizeIdleTimeoutMs(null), DEFAULT_IDLE_TIMEOUT_MS);
  assert.equal(normalizeIdleTimeoutMs("nope"), DEFAULT_IDLE_TIMEOUT_MS);
});

test("idle timeout persists and round-trips, notifying the session", () => {
  assert.equal(getAutoLockIdleMs(), DEFAULT_IDLE_TIMEOUT_MS);
  setAutoLockIdleMs(300_000);
  assert.equal(getAutoLockIdleMs(), 300_000);
  assert.ok(dispatched.includes(AUTO_LOCK_CHANGED_EVENT));
  // An out-of-range write is normalized, not stored verbatim.
  setAutoLockIdleMs(42);
  assert.equal(getAutoLockIdleMs(), DEFAULT_IDLE_TIMEOUT_MS);
});
