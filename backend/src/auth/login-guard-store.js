import {
  LOGIN_IP_WINDOW_MS,
  LOGIN_LOCKOUT_MS,
  MAX_LOGIN_FAILURES,
} from "./rate-limit-constants.js";

// An unlocked email entry whose last activity is older than this is forgotten,
// so the tracking structure cannot grow without bound from one-off failed
// attempts. Aligned with the lockout window: after this much inactivity the
// accumulated failure count would no longer matter for a lockout decision.
const EMAIL_IDLE_TTL_MS = LOGIN_LOCKOUT_MS;

// How often (at most) a full sweep of expired state runs. The sweep is
// opportunistic — triggered by write operations — so no background timer is
// required and the store leaves no dangling handles in tests.
const SWEEP_INTERVAL_MS = LOGIN_IP_WINDOW_MS;

/**
 * Shared state backing for the login throttle / lockout guard.
 *
 * The guard (`login-guard.js`) owns the HTTP policy (which errors to throw and
 * the `Retry-After` it advertises); the store owns *where* the failure counters
 * and per-IP request timestamps live and how they expire. A `pg` store shares
 * that state across every backend instance and survives restarts; the `memory`
 * store keeps it process-local for local/test runs with no external dependency.
 *
 * @typedef {object} LoginGuardStore
 * @property {(email: string) => Promise<{ lockedUntil: number | null } | null>} getEmailLock
 *   Current active lockout record for an email, or `null` when none is tracked
 *   (or its window has expired). `lockedUntil` is an epoch-ms timestamp.
 * @property {(email: string) => Promise<{ failures: number, lockedUntil: number | null }>} recordEmailFailure
 *   Atomically increment the failure counter within the lockout window and
 *   apply the lockout once `MAX_LOGIN_FAILURES` is reached.
 * @property {(email: string) => Promise<void>} clearEmailFailures
 * @property {(ip: string) => Promise<{ count: number, oldestTimestamp: number | null }>} getIpWindow
 *   Number of requests from an IP currently inside the window, plus the oldest
 *   such timestamp (epoch ms) so the guard can compute `Retry-After`.
 * @property {(ip: string) => Promise<void>} recordIpRequest
 * @property {() => Promise<{ trackedEmails: number, trackedIps: number }>} stats
 */

/**
 * Select the login-guard store implementation.
 *
 * Mirrors the `memory-*` / `pg-*` auth-store selection: a Postgres pool means a
 * shared, restart-durable store; no pool means the in-memory fallback. The
 * `LOGIN_GUARD_STORE` environment variable (`pg` | `memory`) can override the
 * default — e.g. to force the in-memory store even when a pool is configured.
 *
 * @param {import('pg').Pool | null | undefined} pool
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ now?: () => number }} [options]
 * @returns {LoginGuardStore}
 */
export function createLoginGuardStore(pool, env = process.env, options = {}) {
  const mode = normalizeMode(env.LOGIN_GUARD_STORE, pool);
  if (mode === "pg") {
    if (!pool) {
      throw new Error("LOGIN_GUARD_STORE=pg requires a database connection (DATABASE_URL)");
    }
    return createPgLoginGuardStore(pool, options);
  }
  return createMemoryLoginGuardStore(options);
}

/**
 * @param {string | undefined} raw
 * @param {import('pg').Pool | null | undefined} pool
 * @returns {"pg" | "memory"}
 */
function normalizeMode(raw, pool) {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "pg" || value === "memory") {
    return value;
  }
  return pool ? "pg" : "memory";
}

/**
 * In-memory, process-local store. Bounds growth via opportunistic idle/TTL
 * eviction so a single instance cannot leak memory from unbounded distinct
 * emails or IPs. State is NOT shared across instances and resets on restart.
 *
 * @param {{ now?: () => number }} [options]
 * @returns {LoginGuardStore}
 */
export function createMemoryLoginGuardStore(options = {}) {
  const now = options.now ?? Date.now;

  /** @type {Map<string, { failures: number, lockedUntil: number | null, lastSeenAt: number }>} */
  const byEmail = new Map();
  /** @type {Map<string, number[]>} */
  const byIp = new Map();
  let lastSweepAt = now();

  return {
    async getEmailLock(email) {
      const entry = byEmail.get(email);
      if (!entry) {
        return null;
      }
      entry.lastSeenAt = now();
      if (entry.lockedUntil !== null && now() >= entry.lockedUntil) {
        byEmail.delete(email);
        return null;
      }
      return { lockedUntil: entry.lockedUntil };
    },

    async recordEmailFailure(email) {
      const entry = byEmail.get(email) ?? { failures: 0, lockedUntil: null, lastSeenAt: now() };
      entry.failures += 1;
      entry.lastSeenAt = now();
      if (entry.failures >= MAX_LOGIN_FAILURES) {
        entry.lockedUntil = now() + LOGIN_LOCKOUT_MS;
      }
      byEmail.set(email, entry);
      maybeSweep();
      return { failures: entry.failures, lockedUntil: entry.lockedUntil };
    },

    async clearEmailFailures(email) {
      byEmail.delete(email);
    },

    async getIpWindow(ip) {
      const timestamps = pruneIpWindow(ip);
      return {
        count: timestamps.length,
        oldestTimestamp: timestamps.length > 0 ? timestamps[0] : null,
      };
    },

    async recordIpRequest(ip) {
      const timestamps = pruneIpWindow(ip);
      timestamps.push(now());
      byIp.set(ip, timestamps);
    },

    async stats() {
      return { trackedEmails: byEmail.size, trackedIps: byIp.size };
    },
  };

  /** @param {string} ip */
  function pruneIpWindow(ip) {
    const current = now();
    const timestamps = (byIp.get(ip) ?? []).filter((ts) => current - ts < LOGIN_IP_WINDOW_MS);
    if (timestamps.length === 0) {
      byIp.delete(ip);
      return [];
    }
    byIp.set(ip, timestamps);
    return timestamps;
  }

  function maybeSweep() {
    const current = now();
    if (current - lastSweepAt < SWEEP_INTERVAL_MS) {
      return;
    }
    lastSweepAt = current;
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
 * Postgres-backed store. Login failure counters and per-IP request timestamps
 * are shared across every backend instance and survive restarts; expiry is
 * enforced by `expires_at` filtering plus opportunistic cleanup of stale rows.
 *
 * Requires the `login_failures` / `login_ip_requests` tables from
 * `db/auth-schema.js` (created by the auth store migration).
 *
 * @param {import('pg').Pool} pool
 * @param {{ now?: () => number }} [options]
 * @returns {LoginGuardStore}
 */
export function createPgLoginGuardStore(pool, options = {}) {
  const now = options.now ?? Date.now;
  let lastSweepAt = now();

  return {
    async getEmailLock(email) {
      const nowMs = now();
      const result = await pool.query(
        `SELECT locked_until
           FROM login_failures
          WHERE email = $1 AND expires_at > $2::timestamptz`,
        [email, iso(nowMs)],
      );
      const row = result.rows[0];
      if (!row) {
        return null;
      }
      const lockedUntil = row.locked_until ? new Date(row.locked_until).getTime() : null;
      if (lockedUntil !== null && nowMs >= lockedUntil) {
        return { lockedUntil: null };
      }
      return { lockedUntil };
    },

    async recordEmailFailure(email) {
      const nowMs = now();
      const nowIso = iso(nowMs);
      const expiresIso = iso(nowMs + LOGIN_LOCKOUT_MS);
      // Single atomic upsert: reset the counter when the previous window has
      // lapsed, otherwise increment, and (re)apply the lockout timestamp once
      // the threshold is reached. Correct even under concurrent writers.
      const result = await pool.query(
        `INSERT INTO login_failures (email, failures, locked_until, expires_at, updated_at)
         VALUES ($1, 1,
                 CASE WHEN 1 >= $2 THEN $4::timestamptz ELSE NULL END,
                 $4::timestamptz, $3::timestamptz)
         ON CONFLICT (email) DO UPDATE SET
           failures = (CASE WHEN login_failures.expires_at <= $3::timestamptz
                            THEN 0 ELSE login_failures.failures END) + 1,
           locked_until = CASE
             WHEN ((CASE WHEN login_failures.expires_at <= $3::timestamptz
                         THEN 0 ELSE login_failures.failures END) + 1) >= $2
             THEN $4::timestamptz ELSE NULL END,
           expires_at = $4::timestamptz,
           updated_at = $3::timestamptz
         RETURNING failures, locked_until`,
        [email, MAX_LOGIN_FAILURES, nowIso, expiresIso],
      );
      await maybeSweep(nowMs);
      const row = result.rows[0];
      return {
        failures: row.failures,
        lockedUntil: row.locked_until ? new Date(row.locked_until).getTime() : null,
      };
    },

    async clearEmailFailures(email) {
      await pool.query("DELETE FROM login_failures WHERE email = $1", [email]);
    },

    async getIpWindow(ip) {
      const nowMs = now();
      const windowStartIso = iso(nowMs - LOGIN_IP_WINDOW_MS);
      const result = await pool.query(
        `SELECT COUNT(*)::int AS count, MIN(requested_at) AS oldest
           FROM login_ip_requests
          WHERE ip = $1 AND requested_at > $2::timestamptz`,
        [ip, windowStartIso],
      );
      const row = result.rows[0];
      return {
        count: row?.count ?? 0,
        oldestTimestamp: row?.oldest ? new Date(row.oldest).getTime() : null,
      };
    },

    async recordIpRequest(ip) {
      const nowMs = now();
      await pool.query(
        `INSERT INTO login_ip_requests (ip, requested_at, expires_at)
         VALUES ($1, $2::timestamptz, $3::timestamptz)`,
        [ip, iso(nowMs), iso(nowMs + LOGIN_IP_WINDOW_MS)],
      );
      await maybeSweep(nowMs);
    },

    async stats() {
      const nowIso = iso(now());
      const result = await pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM login_failures WHERE expires_at > $1::timestamptz) AS emails,
           (SELECT COUNT(DISTINCT ip)::int FROM login_ip_requests WHERE expires_at > $1::timestamptz) AS ips`,
        [nowIso],
      );
      const row = result.rows[0];
      return { trackedEmails: row?.emails ?? 0, trackedIps: row?.ips ?? 0 };
    },
  };

  /** Delete expired rows at most once per sweep interval to bound table growth. */
  async function maybeSweep(nowMs) {
    if (nowMs - lastSweepAt < SWEEP_INTERVAL_MS) {
      return;
    }
    lastSweepAt = nowMs;
    const nowIso = iso(nowMs);
    await pool.query("DELETE FROM login_failures WHERE expires_at <= $1::timestamptz", [nowIso]);
    await pool.query("DELETE FROM login_ip_requests WHERE expires_at <= $1::timestamptz", [nowIso]);
  }
}

/** @param {number} ms */
function iso(ms) {
  return new Date(ms).toISOString();
}
