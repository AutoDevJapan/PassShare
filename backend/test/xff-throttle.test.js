import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { CSRF_COOKIE } from "../src/auth/constants.js";
import { LOGIN_IP_MAX_REQUESTS } from "../src/auth/rate-limit-constants.js";
import { resolveTrustProxyHops } from "../src/config/trust-proxy.js";
import { createMemoryAuthStore } from "../src/auth/index.js";
import { createMemoryStore } from "../src/store/memory-store.js";
import { createApp } from "../src/app.js";

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

/**
 * Attempt a login while spoofing the client IP via X-Forwarded-For.
 * @param {string} baseUrl
 * @param {string} email
 * @param {string} spoofedIp
 */
async function spoofedLogin(baseUrl, email, spoofedIp) {
  const { csrfToken, cookie } = await fetchCsrf(baseUrl);
  return fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
      Cookie: cookie,
      "X-Forwarded-For": spoofedIp,
    },
    body: JSON.stringify({ email, password: "wrong-password" }),
  });
}

describe("resolveTrustProxyHops", () => {
  it("trusts no hops for local (ignores forwarded headers)", () => {
    assert.equal(resolveTrustProxyHops("local", {}), 0);
  });

  it("trusts one Railway edge hop for deployed environments", () => {
    for (const appEnv of ["dev", "preview", "stg", "prd"]) {
      assert.equal(resolveTrustProxyHops(appEnv, {}), 1);
    }
  });

  it("honours a valid TRUST_PROXY_HOPS override", () => {
    assert.equal(resolveTrustProxyHops("prd", { TRUST_PROXY_HOPS: "2" }), 2);
    assert.equal(resolveTrustProxyHops("local", { TRUST_PROXY_HOPS: "3" }), 3);
  });

  it("falls back to the default for a blank TRUST_PROXY_HOPS override", () => {
    assert.equal(resolveTrustProxyHops("prd", { TRUST_PROXY_HOPS: "   " }), 1);
    assert.equal(resolveTrustProxyHops("local", { TRUST_PROXY_HOPS: "" }), 0);
  });

  it("rejects an invalid TRUST_PROXY_HOPS override", () => {
    assert.throws(() => resolveTrustProxyHops("prd", { TRUST_PROXY_HOPS: "-1" }));
    assert.throws(() => resolveTrustProxyHops("prd", { TRUST_PROXY_HOPS: "nope" }));
  });
});

describe("Per-IP login throttle vs spoofed X-Forwarded-For", () => {
  /** @type {import('http').Server} */
  let server;
  /** @type {string} */
  let baseUrl;

  before(async () => {
    const store = createMemoryStore();
    const authStore = createMemoryAuthStore();
    // Default APP_ENV is "local" => trust proxy 0 => forwarded headers ignored.
    const { app } = await createApp({ store, authStore, pool: null });
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("does not let a rotating spoofed X-Forwarded-For bypass the per-IP limit", async () => {
    // Password-spray from a single host: each request uses a distinct email
    // (so per-email lockout never triggers) and a distinct spoofed source IP.
    // All requests share the same real socket address, so the per-IP throttle
    // must still fire once the window limit is exceeded.
    for (let i = 0; i < LOGIN_IP_MAX_REQUESTS; i += 1) {
      const res = await spoofedLogin(baseUrl, `spray-${i}@example.com`, `1.2.3.${i}`);
      assert.equal(res.status, 401, `attempt ${i} should be rejected as bad credentials`);
    }

    const blocked = await spoofedLogin(baseUrl, "spray-final@example.com", "9.9.9.9");
    assert.equal(blocked.status, 429, "per-IP throttle must fire despite spoofed XFF");
    const body = await blocked.json();
    assert.equal(body.error, "PS029");
    assert.ok(blocked.headers.get("retry-after"));
  });
});
