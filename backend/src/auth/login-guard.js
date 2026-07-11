import {
  LOGIN_IP_MAX_REQUESTS,
  LOGIN_IP_WINDOW_MS,
  LOGIN_LOCKOUT_MS,
  MAX_LOGIN_FAILURES,
} from "./rate-limit-constants.js";
import { authHttpError } from "./errors.js";

// An unlocked email entry whose last activity is older than this is forgotten,
// so the `byEmail` map cannot grow without bound from one-off failed attempts.
// Aligned with the lockout window: after this much inactivity the accumulated
// failure count would no longer matter for a lockout decision anyway.
const EMAIL_IDLE_TTL_MS = LOGIN_LOCKOUT_MS;

// How often (at most) a full sweep of the `byEmail` map runs. The sweep is
// opportunistic — triggered by write operations — so no background timer is
// required and the guard leaves no dangling handles in tests.
const EMAIL_SWEEP_INTERVAL_MS = LOGIN_IP_WINDOW_MS;

/**
 * @typedef {object} LoginGuard
 * @property {(email: string) => void} assertNotLocked
 * @property {(email: string) => void} recordFailure
 * @property {(email: string) => void} clearFailures
 * @property {(ip: string) => void} assertIpAllowed
 * @property {(ip: string) => void} recordIpRequest
 * @property {() => { trackedEmails: number, trackedIps: number }} stats
 */

/**
 * In-memory login throttle / lockout guard.
 *
 * NOTE: State is process-local. In a multi-instance deployment the lockout and
 * per-IP counters are not shared, and they reset on restart. A shared store
 * (Redis / DB) with TTL eviction is tracked separately for that hardening; this
 * implementation bounds memory growth via opportunistic idle eviction so a
 * single instance cannot leak memory from unbounded distinct emails.
 *
 * @param {{ now?: () => number }} [options] Injectable clock (defaults to `Date.now`).
 * @returns {LoginGuard}
 */
export function createLoginGuard(options = {}) {
  const now = options.now ?? Date.now;

  /** @type {Map<string, { failures: number, lockedUntil: number | null, lastSeenAt: number }>} */
  const byEmail = new Map();
  /** @type {Map<string, number[]>} */
  const byIp = new Map();
  let lastEmailSweepAt = now();

  return {
    assertNotLocked(email) {
      const entry = byEmail.get(email);
      if (!entry) {
        return;
      }
      entry.lastSeenAt = now();
      if (!entry.lockedUntil) {
        return;
      }
      if (now() < entry.lockedUntil) {
        const retryAfterSec = Math.ceil((entry.lockedUntil - now()) / 1000);
        const error = authHttpError(
          429,
          "PS028",
          "Too many failed login attempts. Try again later.",
        );
        error.retryAfterSec = retryAfterSec;
        throw error;
      }
      byEmail.delete(email);
    },

    recordFailure(email) {
      const entry = byEmail.get(email) ?? { failures: 0, lockedUntil: null, lastSeenAt: now() };
      entry.failures += 1;
      entry.lastSeenAt = now();
      if (entry.failures >= MAX_LOGIN_FAILURES) {
        entry.lockedUntil = now() + LOGIN_LOCKOUT_MS;
      }
      byEmail.set(email, entry);
      maybeSweepByEmail();
    },

    clearFailures(email) {
      byEmail.delete(email);
    },

    assertIpAllowed(ip) {
      pruneIpWindow(ip);
      const timestamps = byIp.get(ip) ?? [];
      if (timestamps.length >= LOGIN_IP_MAX_REQUESTS) {
        const retryAfterSec = Math.ceil(
          (timestamps[0] + LOGIN_IP_WINDOW_MS - now()) / 1000,
        );
        const error = authHttpError(429, "PS029", "Too many requests. Try again later.");
        error.retryAfterSec = Math.max(retryAfterSec, 1);
        throw error;
      }
    },

    recordIpRequest(ip) {
      pruneIpWindow(ip);
      const timestamps = byIp.get(ip) ?? [];
      timestamps.push(now());
      byIp.set(ip, timestamps);
    },

    stats() {
      return { trackedEmails: byEmail.size, trackedIps: byIp.size };
    },
  };

  function pruneIpWindow(ip) {
    const current = now();
    const timestamps = (byIp.get(ip) ?? []).filter((ts) => current - ts < LOGIN_IP_WINDOW_MS);
    if (timestamps.length === 0) {
      byIp.delete(ip);
      return;
    }
    byIp.set(ip, timestamps);
  }

  function maybeSweepByEmail() {
    const current = now();
    if (current - lastEmailSweepAt < EMAIL_SWEEP_INTERVAL_MS) {
      return;
    }
    lastEmailSweepAt = current;
    for (const [email, entry] of byEmail) {
      const lockExpired = entry.lockedUntil !== null && current >= entry.lockedUntil;
      const idleExpired =
        entry.lockedUntil === null && current - entry.lastSeenAt >= EMAIL_IDLE_TTL_MS;
      if (lockExpired || idleExpired) {
        byEmail.delete(email);
      }
    }
  }
}

/**
 * Resolve the throttling key for a request.
 *
 * Uses Express's `req.ip`, which honours the app's `trust proxy` setting and
 * walks the `X-Forwarded-For` chain from right to left past the configured
 * trusted hops. A raw, attacker-supplied `X-Forwarded-For` is therefore never
 * trusted, so per-IP throttling cannot be bypassed by rotating spoofed
 * forwarded addresses (#316). Falls back to the socket address when `req.ip`
 * is unavailable.
 *
 * @param {import('express').Request} req
 */
export function resolveClientIp(req) {
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}
