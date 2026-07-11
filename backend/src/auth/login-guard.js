import { LOGIN_IP_MAX_REQUESTS, LOGIN_IP_WINDOW_MS } from "./rate-limit-constants.js";
import { authHttpError } from "./errors.js";
import { createMemoryLoginGuardStore } from "./login-guard-store.js";

/**
 * @typedef {object} LoginGuard
 * @property {(email: string) => Promise<void>} assertNotLocked
 * @property {(email: string) => Promise<void>} recordFailure
 * @property {(email: string) => Promise<void>} clearFailures
 * @property {(ip: string) => Promise<void>} assertIpAllowed
 * @property {(ip: string) => Promise<void>} recordIpRequest
 * @property {() => Promise<{ trackedEmails: number, trackedIps: number }>} stats
 */

/**
 * Login throttle / lockout guard.
 *
 * The guard owns the HTTP policy — which error to raise and the `Retry-After`
 * it advertises — and delegates *where* the failure counters and per-IP request
 * timestamps live to an injected {@link import('./login-guard-store.js').LoginGuardStore}.
 * With the Postgres store the lockout and throttle state is shared across every
 * backend instance and survives restarts (#378); the default in-memory store
 * keeps it process-local for local/test runs with no external dependency.
 *
 * @param {{ store?: import('./login-guard-store.js').LoginGuardStore, now?: () => number }} [options]
 * @returns {LoginGuard}
 */
export function createLoginGuard(options = {}) {
  const now = options.now ?? Date.now;
  const store = options.store ?? createMemoryLoginGuardStore({ now: options.now });

  return {
    async assertNotLocked(email) {
      const lock = await store.getEmailLock(email);
      if (!lock || lock.lockedUntil === null) {
        return;
      }
      if (now() < lock.lockedUntil) {
        const retryAfterSec = Math.ceil((lock.lockedUntil - now()) / 1000);
        const error = authHttpError(
          429,
          "PS028",
          "Too many failed login attempts. Try again later.",
        );
        error.retryAfterSec = Math.max(retryAfterSec, 1);
        throw error;
      }
    },

    async recordFailure(email) {
      await store.recordEmailFailure(email);
    },

    async clearFailures(email) {
      await store.clearEmailFailures(email);
    },

    async assertIpAllowed(ip) {
      const { count, oldestTimestamp } = await store.getIpWindow(ip);
      if (count >= LOGIN_IP_MAX_REQUESTS && oldestTimestamp !== null) {
        const retryAfterSec = Math.ceil((oldestTimestamp + LOGIN_IP_WINDOW_MS - now()) / 1000);
        const error = authHttpError(429, "PS029", "Too many requests. Try again later.");
        error.retryAfterSec = Math.max(retryAfterSec, 1);
        throw error;
      }
    },

    async recordIpRequest(ip) {
      await store.recordIpRequest(ip);
    },

    async stats() {
      return store.stats();
    },
  };
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
