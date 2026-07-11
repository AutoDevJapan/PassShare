import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CSRF_COOKIE } from "../src/auth/constants.js";
import { LOGIN_IP_MAX_REQUESTS } from "../src/auth/rate-limit-constants.js";
import { createMemoryAuthStore } from "../src/auth/index.js";
import { createMemoryStore } from "../src/store/memory-store.js";
import { createApp } from "../src/app.js";

const PASSWORD = "password123";

async function startServer() {
  const store = createMemoryStore();
  const authStore = createMemoryAuthStore();
  // Default APP_ENV "local" => trust proxy 0 => every request keys off the same
  // loopback IP, so signup/login/token-refresh share one per-IP window.
  const { app } = await createApp({ store, authStore, pool: null });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

/** @param {import('http').Server} server */
async function stopServer(server) {
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/** @param {string} baseUrl */
async function fetchCsrf(baseUrl) {
  const res = await fetch(`${baseUrl}/api/auth/csrf`);
  assert.equal(res.status, 200);
  const body = await res.json();
  return {
    csrfToken: body.csrfToken,
    cookie: `${CSRF_COOKIE}=${encodeURIComponent(body.csrfToken)}`,
  };
}

/** @param {string} baseUrl @param {string} email */
async function signup(baseUrl, email) {
  const { csrfToken, cookie } = await fetchCsrf(baseUrl);
  return fetch(`${baseUrl}/api/auth/signup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
      Cookie: cookie,
    },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
}

/**
 * Cheap way to consume a per-IP window slot: a login for an unknown user is
 * rejected as bad credentials WITHOUT running the expensive Argon2 verify.
 * @param {string} baseUrl @param {string} email
 */
async function fillWithFailedLogin(baseUrl, email) {
  const { csrfToken, cookie } = await fetchCsrf(baseUrl);
  return fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
      Cookie: cookie,
    },
    body: JSON.stringify({ email, password: "wrong-password" }),
  });
}

describe("Signup per-IP throttle (#393)", () => {
  it("allows a signup while under the per-IP limit", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const res = await signup(baseUrl, "new-user@example.com");
      assert.equal(res.status, 201);
    } finally {
      await stopServer(server);
    }
  });

  it("rejects signup with 429 once the per-IP window is exhausted (before Argon2)", async () => {
    const { server, baseUrl } = await startServer();
    try {
      // Saturate the shared per-IP window with unique-email failed logins, none
      // of which run Argon2, so reaching the limit is fast.
      for (let i = 0; i < LOGIN_IP_MAX_REQUESTS; i += 1) {
        const res = await fillWithFailedLogin(baseUrl, `filler-${i}@example.com`);
        assert.equal(res.status, 401, `filler ${i} should be bad credentials, not throttled yet`);
      }

      const blocked = await signup(baseUrl, "flood@example.com");
      assert.equal(blocked.status, 429, "signup must be throttled once the per-IP window is full");
      const body = await blocked.json();
      assert.equal(body.error, "PS029");
      assert.ok(blocked.headers.get("retry-after"));
    } finally {
      await stopServer(server);
    }
  });

  it("rejects token/refresh with 429 once the per-IP window is exhausted", async () => {
    const { server, baseUrl } = await startServer();
    try {
      for (let i = 0; i < LOGIN_IP_MAX_REQUESTS; i += 1) {
        const res = await fillWithFailedLogin(baseUrl, `refresh-filler-${i}@example.com`);
        assert.equal(res.status, 401);
      }

      // No CSRF is required on token/refresh; the throttle must fire before the
      // refresh token is even looked up.
      const blocked = await fetch(`${baseUrl}/api/auth/token/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: "does-not-matter" }),
      });
      assert.equal(blocked.status, 429);
      const body = await blocked.json();
      assert.equal(body.error, "PS029");
      assert.ok(blocked.headers.get("retry-after"));
    } finally {
      await stopServer(server);
    }
  });
});
