import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { createMemoryAuthStore } from "../src/auth/index.js";
import { createMemoryStore } from "../src/store/memory-store.js";
import { createApp } from "../src/app.js";

const EMAIL = "user@example.com";
const PASSWORD = "password123";

/** @param {Headers} headers */
function sessionCookieFrom(headers) {
  const setCookie = headers.get("set-cookie");
  assert.ok(setCookie, "expected Set-Cookie header");
  return setCookie.split(";")[0];
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
    const res = await fetch(`${baseUrl}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.user.email, EMAIL);
    assert.ok(body.sessionExpiresAt);
    const cookie = sessionCookieFrom(res.headers);
    assert.match(cookie, /^passshare_session=/);
  });

  it("logs in with valid credentials and issues a session", async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.user.email, EMAIL);
    assert.ok(sessionCookieFrom(res.headers));
  });

  it("returns 401 for invalid password", async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: "wrong-password" }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "PS026");
  });

  it("returns current user for a valid session", async () => {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
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
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
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
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const cookie = sessionCookieFrom(loginRes.headers);
    const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    assert.equal(logoutRes.status, 204);
    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: cookie },
    });
    assert.equal(meRes.status, 401);
  });
});
