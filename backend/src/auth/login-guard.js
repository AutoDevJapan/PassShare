import {
  LOGIN_IP_MAX_REQUESTS,
  LOGIN_IP_WINDOW_MS,
  LOGIN_LOCKOUT_MS,
  MAX_LOGIN_FAILURES,
} from "./rate-limit-constants.js";
import { authHttpError } from "./errors.js";

/**
 * @typedef {object} LoginGuard
 * @property {(email: string) => void} assertNotLocked
 * @property {(email: string) => void} recordFailure
 * @property {(email: string) => void} clearFailures
 * @property {(ip: string) => void} assertIpAllowed
 * @property {(ip: string) => void} recordIpRequest
 */

/** @returns {LoginGuard} */
export function createLoginGuard() {
  /** @type {Map<string, { failures: number, lockedUntil: number | null }>} */
  const byEmail = new Map();
  /** @type {Map<string, number[]>} */
  const byIp = new Map();

  return {
    assertNotLocked(email) {
      const entry = byEmail.get(email);
      if (!entry?.lockedUntil) {
        return;
      }
      if (Date.now() < entry.lockedUntil) {
        const retryAfterSec = Math.ceil((entry.lockedUntil - Date.now()) / 1000);
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
      const entry = byEmail.get(email) ?? { failures: 0, lockedUntil: null };
      entry.failures += 1;
      if (entry.failures >= MAX_LOGIN_FAILURES) {
        entry.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
      }
      byEmail.set(email, entry);
    },

    clearFailures(email) {
      byEmail.delete(email);
    },

    assertIpAllowed(ip) {
      pruneIpWindow(ip);
      const timestamps = byIp.get(ip) ?? [];
      if (timestamps.length >= LOGIN_IP_MAX_REQUESTS) {
        const retryAfterSec = Math.ceil(
          (timestamps[0] + LOGIN_IP_WINDOW_MS - Date.now()) / 1000,
        );
        const error = authHttpError(429, "PS029", "Too many requests. Try again later.");
        error.retryAfterSec = Math.max(retryAfterSec, 1);
        throw error;
      }
    },

    recordIpRequest(ip) {
      pruneIpWindow(ip);
      const timestamps = byIp.get(ip) ?? [];
      timestamps.push(Date.now());
      byIp.set(ip, timestamps);
    },
  };

  function pruneIpWindow(ip) {
    const now = Date.now();
    const timestamps = (byIp.get(ip) ?? []).filter((ts) => now - ts < LOGIN_IP_WINDOW_MS);
    if (timestamps.length === 0) {
      byIp.delete(ip);
      return;
    }
    byIp.set(ip, timestamps);
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
