import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createApp } from "../src/app.js";
import { CSRF_COOKIE } from "../src/auth/constants.js";
import { MAX_LOGIN_FAILURES } from "../src/auth/rate-limit-constants.js";

const { Pool } = pg;

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://passshare:passshare@localhost:5432/passshare";

// CSRF is a stateless double-submit token (cookie value must equal the header),
// so a self-consistent pair is accepted by any instance without a prior /csrf
// round-trip. That lets us exercise several independent instances uniformly.
const CSRF_TOKEN = "pg-login-guard-csrf";
const CSRF_COOKIE_HEADER = `${CSRF_COOKIE}=${CSRF_TOKEN}`;

// This suite shares a Postgres database with the other backend-e2e integration
// suites, which run concurrently (node's test runner parallelises files) and
// also perform logins from the loopback socket. To keep the per-IP throttle
// state isolated to THIS suite, we trust one proxy hop (TRUST_PROXY_HOPS=1) and
// send a unique X-Forwarded-For, so `req.ip` becomes our own dedicated bucket
// instead of the shared 127.0.0.1. That makes the email-lockout assertions
// deterministic regardless of what other suites do concurrently.
const CLIENT_IP = `198.51.100.${1 + Math.floor(Math.random() * 250)}`;

/** @param {import('express').Express} app */
async function listen(app) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

/** @param {string} baseUrl @param {string} path @param {object} body */
function post(baseUrl, path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": CSRF_TOKEN,
      Cookie: CSRF_COOKIE_HEADER,
      "X-Forwarded-For": CLIENT_IP,
    },
    body: JSON.stringify(body),
  });
}

describe("Login guard shared store (PostgreSQL integration)", { skip: !process.env.DATABASE_URL }, () => {
  /** @type {import('pg').Pool} */
  let pool;
  /** @type {Array<{ server: import('http').Server }>} */
  const instances = [];
  /** @type {string | undefined} */
  let previousTrustProxyHops;

  before(async () => {
    // Isolated to this file's worker process; restored in `after`.
    previousTrustProxyHops = process.env.TRUST_PROXY_HOPS;
    process.env.TRUST_PROXY_HOPS = "1";
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  after(async () => {
    for (const { server } of instances) {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
    await pool.end();
    if (previousTrustProxyHops === undefined) {
      delete process.env.TRUST_PROXY_HOPS;
    } else {
      process.env.TRUST_PROXY_HOPS = previousTrustProxyHops;
    }
  });

  /** Start a fresh backend instance bound to the shared Postgres pool. */
  async function startInstance() {
    const { app } = await createApp({ pool });
    const inst = await listen(app);
    instances.push(inst);
    return inst.baseUrl;
  }

  it("shares the lockout across instances and survives a restart", async () => {
    const email = `pg-lockout-${Date.now()}@example.com`;
    const password = "password12345";

    const instanceA = await startInstance();
    const instanceB = await startInstance();

    // Clear any leftover throttle state for THIS suite's dedicated IP/email so
    // a re-run against the same DB starts from a clean slate. Scoped by ip/email
    // so it never disrupts a concurrently-running suite.
    await pool.query("DELETE FROM login_ip_requests WHERE ip = $1", [CLIENT_IP]);
    await pool.query("DELETE FROM login_failures WHERE email = $1", [email]);

    const signup = await post(instanceA, "/api/auth/signup", { email, password });
    assert.equal(signup.status, 201);

    // Exhaust the failure budget entirely on instance A.
    for (let i = 0; i < MAX_LOGIN_FAILURES; i += 1) {
      const res = await post(instanceA, "/api/auth/login", { email, password: "wrong-password" });
      assert.equal(res.status, 401, `attempt ${i} should be rejected as bad credentials`);
    }

    // Instance B is a separate process that never saw a failure, yet the shared
    // Postgres state must lock it out too (multi-instance sharing).
    const lockedOnB = await post(instanceB, "/api/auth/login", { email, password });
    assert.equal(lockedOnB.status, 429, "lockout must be visible on a second instance");
    assert.equal((await lockedOnB.json()).error, "PS028");
    assert.ok(lockedOnB.headers.get("retry-after"));

    // Simulate a deploy/restart: a brand-new instance with no in-memory state
    // still observes the lockout because it lives in Postgres (restart durable).
    const instanceC = await startInstance();
    const lockedAfterRestart = await post(instanceC, "/api/auth/login", { email, password });
    assert.equal(lockedAfterRestart.status, 429, "lockout must survive a restart");
    assert.equal((await lockedAfterRestart.json()).error, "PS028");

    // Leave no state behind so repeated runs against the same DB start clean.
    await pool.query("DELETE FROM login_failures WHERE email = $1", [email]);
    await pool.query("DELETE FROM login_ip_requests WHERE ip = $1", [CLIENT_IP]);
  });
});
