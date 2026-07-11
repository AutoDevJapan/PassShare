// Auto-lock controller (#408).
//
// A password manager must re-lock itself once the device leaves the user's
// control, not just on cold start. This module owns the framework-agnostic
// decision logic so it can be unit-tested with a fake clock, independently of
// the React wiring in `hooks/useAutoLock.ts`.
//
// Two triggers reset the app to its locked state:
//   1. Background transition — when the WebView is hidden (app switcher, screen
//      off, task switch) the app locks after `backgroundGraceMs` (default: 0,
//      i.e. immediately). A short grace can be configured to tolerate brief
//      excursions (e.g. an OS share sheet) without forcing a re-unlock.
//   2. Idle timeout — after `idleTimeoutMs` with no user interaction the app
//      locks. Any pointer/key/touch activity restarts the countdown.

const AUTO_LOCK_IDLE_KEY = "mobile-auto-lock-idle-ms";

/** Custom event fired when the persisted idle timeout changes, so a running
 *  session can pick up the new value without a reload. */
export const AUTO_LOCK_CHANGED_EVENT = "passshare:auto-lock-changed";

/** Lock immediately on background by default — the most secure choice. */
export const DEFAULT_BACKGROUND_GRACE_MS = 0;

/** Default idle timeout: 2 minutes of inactivity. */
export const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

/** User-selectable idle timeouts (ms). Order is the UI order. */
export const IDLE_TIMEOUT_OPTIONS_MS = [60_000, 120_000, 300_000] as const;

export type AutoLockConfig = {
  /** Lock after this long with no activity. `<= 0` disables the idle trigger. */
  idleTimeoutMs: number;
  /** Lock after this long in the background. `<= 0` locks immediately. */
  backgroundGraceMs: number;
};

type TimerHandle = ReturnType<typeof setTimeout>;

export type AutoLockDeps = {
  now: () => number;
  setTimer: (cb: () => void, ms: number) => TimerHandle;
  clearTimer: (handle: TimerHandle) => void;
};

const REAL_DEPS: AutoLockDeps = {
  now: () => Date.now(),
  setTimer: (cb, ms) => setTimeout(cb, ms),
  clearTimer: (handle) => clearTimeout(handle),
};

/**
 * Drives the re-lock decision from lifecycle and activity signals. The owner
 * calls `start()`, then forwards `notifyActivity()` / `notifyVisibility()`; the
 * controller invokes `onLock` exactly once when a trigger fires. After firing it
 * is inert until a fresh instance is created (matching a lock → re-unlock cycle).
 */
export class AutoLockController {
  private readonly config: AutoLockConfig;
  private readonly onLock: () => void;
  private readonly deps: AutoLockDeps;
  private idleTimer: TimerHandle | null = null;
  private backgroundTimer: TimerHandle | null = null;
  private fired = false;

  constructor(config: AutoLockConfig, onLock: () => void, deps: AutoLockDeps = REAL_DEPS) {
    this.config = config;
    this.onLock = onLock;
    this.deps = deps;
  }

  /** Begin watching. Starts the idle countdown from "now". */
  start(): void {
    if (this.fired) {
      return;
    }
    this.scheduleIdle();
  }

  /** Stop watching and release any pending timers. */
  stop(): void {
    this.clearIdle();
    this.clearBackground();
  }

  /** User interacted; restart the idle countdown. */
  notifyActivity(): void {
    if (this.fired) {
      return;
    }
    this.scheduleIdle();
  }

  /** Visibility changed; `hidden` true means the app was backgrounded. */
  notifyVisibility(hidden: boolean): void {
    if (this.fired) {
      return;
    }
    if (hidden) {
      // Backgrounded: the idle timer is meaningless (no foreground activity can
      // arrive), so swap it for the background grace timer.
      this.clearIdle();
      this.scheduleBackground();
    } else {
      // Returned to foreground before the grace elapsed: cancel the pending
      // background lock and treat the return as fresh activity.
      this.clearBackground();
      this.scheduleIdle();
    }
  }

  private scheduleIdle(): void {
    this.clearIdle();
    if (this.config.idleTimeoutMs <= 0) {
      return;
    }
    this.idleTimer = this.deps.setTimer(() => this.fire(), this.config.idleTimeoutMs);
  }

  private scheduleBackground(): void {
    this.clearBackground();
    const grace = Math.max(0, this.config.backgroundGraceMs);
    this.backgroundTimer = this.deps.setTimer(() => this.fire(), grace);
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) {
      this.deps.clearTimer(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private clearBackground(): void {
    if (this.backgroundTimer !== null) {
      this.deps.clearTimer(this.backgroundTimer);
      this.backgroundTimer = null;
    }
  }

  private fire(): void {
    if (this.fired) {
      return;
    }
    this.fired = true;
    this.stop();
    this.onLock();
  }
}

/** Clamp an arbitrary value to a supported idle-timeout option. */
export function normalizeIdleTimeoutMs(value: unknown): number {
  const ms = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(ms) && (IDLE_TIMEOUT_OPTIONS_MS as readonly number[]).includes(ms)) {
    return ms;
  }
  return DEFAULT_IDLE_TIMEOUT_MS;
}

/** Read the persisted idle timeout, falling back to the default. */
export function getAutoLockIdleMs(): number {
  try {
    return normalizeIdleTimeoutMs(localStorage.getItem(AUTO_LOCK_IDLE_KEY));
  } catch {
    return DEFAULT_IDLE_TIMEOUT_MS;
  }
}

/** Persist the idle timeout and notify any active session. */
export function setAutoLockIdleMs(ms: number): void {
  const normalized = normalizeIdleTimeoutMs(ms);
  try {
    localStorage.setItem(AUTO_LOCK_IDLE_KEY, String(normalized));
  } catch {
    // Best-effort: a non-persistable environment still gets the live update.
  }
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new CustomEvent(AUTO_LOCK_CHANGED_EVENT, { detail: normalized }));
  }
}
