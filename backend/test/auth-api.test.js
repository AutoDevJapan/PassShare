import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { CSRF_COOKIE } from "../src/auth/constants.js";
import { createMemoryAuthStore } from "../src/auth/index.js";
import { createMemoryStore } from "../src/store/memory-store.js";
import { createApp } from "../src/app.js";

const EMAIL = "user@example.com";
const PASSWORD = "password123";

/** @param {Headers} headers */
function getSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

/** @param {Headers} headers */
function sessionCookieFrom(headers) {
  const cookies = getSetCookies(headers);
  const session = cookies.find((entry) => entry.startsWith("passshare_session="));
  assert.ok(session, "expected passshare_session cookie");
  return session.split(";")[0];
}

/** @param {Headers} headers @param {string} name */
function cookieValueFrom(headers, name) {
  const cookies = getSetCookies(headers);
  const match = cookies.find((entry) => entry.startsWith(`${name}=`));
  if (!match) return null;
  return decodeURIComponent(match.slice(name.length + 1).split(";")[0]);
}

/** @param {string} baseUrl */
async function fetchCsrf(baseUrl) {
  const res = await fetch(`${baseUrl}/api/auth/csrf`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.csrfToken, cookieValueFrom(res.headers, CSRF_COOKIE));
  return body.csrfToken;
}

/**
 * @param {string} baseUrl
 * @param {string} path
 * @param {string} csrfToken
 * @param {string|null} cookieHeader
 * @param {object} payload
 */
async function authPost(baseUrl, path, csrfToken, cookieHeader, payload) {
  /** @type {Record<string, string>} */
  const headers = {
    "Content-Type": "application/json",
    "X-CSRF-Token": csrfToken,
    Cookie: [`${CSRF_COOKIE}=${encodeURIComponent(csrfToken)}`, cookieHeader]
      .filter(Boolean)
      .join("; "),
  };
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
}

describe("Auth API", () => {
  /** @type {import('http').Server} */
  let server;
  /** @type {string} */
  let baseUrl;

  before(async () => {
    process.env.OP_CONNECT_TOKEN = "test-connect-token";
    const store = createMemoryStore();
    const authStore = createMemoryAuthStore();
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
    delete process.env.OP_CONNECT_TOKEN;
  });

  it("signs up and issues a session cookie", async () => {
    const csrfToken = await fetchCsrf(baseUrl);
    const res = await authPost(baseUrl, "/api/auth/signup", csrfToken, null, {
      email: EMAIL,
      password: PASSWORD,
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.user.email, EMAIL);
    assert.ok(body.sessionExpiresAt);
    assert.match(sessionCookieFrom(res.headers), /^passshare_session=/);
  });

  it("logs in with valid credentials and issues a session", async () => {
    const csrfToken = await fetchCsrf(baseUrl);
    const res = await authPost(baseUrl, "/api/auth/login", csrfToken, null, {
      email: EMAIL,
      password: PASSWORD,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.user.email, EMAIL);
    assert.ok(sessionCookieFrom(res.headers));
  });

  it("returns 401 for invalid password", async () => {
    const csrfToken = await fetchCsrf(baseUrl);
    const res = await authPost(baseUrl, "/api/auth/login", csrfToken, null, {
      email: EMAIL,
      password: "wrong-password",
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "PS026");
  });

  it("returns current user for a valid session", async () => {
    const csrfToken = await fetchCsrf(baseUrl);
    const loginRes = await authPost(baseUrl, "/api/auth/login", csrfToken, null, {
      email: EMAIL,
      password: PASSWORD,
    });
    const cookie = sessionCookieFrom(loginRes.headers);
    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: cookie },
    });
    assert.equal(meRes.status, 200);
    const meBody = await meRes.json();
    assert.equal(meBody.user.email, EMAIL);
  });

  it("mints a connect token for an authenticated session", async () => {
    const csrfToken = await fetchCsrf(baseUrl);
    const loginRes = await authPost(baseUrl, "/api/auth/login", csrfToken, null, {
      email: EMAIL,
      password: PASSWORD,
    });
    const cookie = sessionCookieFrom(loginRes.headers);
    const tokenRes = await fetch(`${baseUrl}/api/auth/connect-token`, {
      headers: { Cookie: cookie },
    });
    assert.equal(tokenRes.status, 200);
    const tokenBody = await tokenRes.json();
    assert.ok(tokenBody.accessToken);
    assert.equal(typeof tokenBody.expiresIn, "number");
  });

  it("logs out and clears the session", async () => {
    const loginCsrf = await fetchCsrf(baseUrl);
    const loginRes = await authPost(baseUrl, "/api/auth/login", loginCsrf, null, {
      email: EMAIL,
      password: PASSWORD,
    });
    const cookie = sessionCookieFrom(loginRes.headers);
    const logoutCsrf = await fetchCsrf(baseUrl);
    const logoutRes = await authPost(baseUrl, "/api/auth/logout", logoutCsrf, cookie, {});
    assert.equal(logoutRes.status, 204);
    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: cookie },
    });
    assert.equal(meRes.status, 401);
  });
});
