import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { MOBILE_CLIENT_HEADER } from "../src/auth/client.js";
import { createMemoryAuthStore } from "../src/auth/index.js";
import { createMemoryStore } from "../src/store/memory-store.js";
import { createApp } from "../src/app.js";

const EMAIL = "mobile@example.com";
const PASSWORD = "password123";

describe("Mobile Auth API", () => {
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

  it("returns refresh and connect tokens on mobile login", async () => {
    const signupRes = await fetch(`${baseUrl}/api/auth/signup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [MOBILE_CLIENT_HEADER]: "mobile",
      },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    assert.equal(signupRes.status, 201);
    const signupBody = await signupRes.json();
    assert.equal(signupBody.user.email, EMAIL);
    assert.ok(signupBody.refreshToken);
    assert.ok(signupBody.connectAccessToken);
    assert.equal(typeof signupBody.connectExpiresIn, "number");

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [MOBILE_CLIENT_HEADER]: "mobile",
      },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    assert.equal(loginRes.status, 200);
    const loginBody = await loginRes.json();
    assert.ok(loginBody.refreshToken);
    assert.ok(loginBody.connectAccessToken);
  });

  it("returns current user with bearer refresh token", async () => {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [MOBILE_CLIENT_HEADER]: "mobile",
      },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const { refreshToken } = await loginRes.json();

    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${refreshToken}` },
    });
    assert.equal(meRes.status, 200);
    const meBody = await meRes.json();
    assert.equal(meBody.user.email, EMAIL);
  });

  it("refreshes connect access token with refreshToken body", async () => {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [MOBILE_CLIENT_HEADER]: "mobile",
      },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const { refreshToken } = await loginRes.json();

    const refreshRes = await fetch(`${baseUrl}/api/auth/token/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    assert.equal(refreshRes.status, 200);
    const refreshBody = await refreshRes.json();
    assert.ok(refreshBody.connectAccessToken);
    assert.equal(typeof refreshBody.connectExpiresIn, "number");
  });

  it("returns 401 for invalid refresh token", async () => {
    const refreshRes = await fetch(`${baseUrl}/api/auth/token/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: "invalid-token" }),
    });
    assert.equal(refreshRes.status, 401);
  });

  it("logs out with bearer token", async () => {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [MOBILE_CLIENT_HEADER]: "mobile",
      },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const { refreshToken } = await loginRes.json();

    const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${refreshToken}` },
    });
    assert.equal(logoutRes.status, 204);

    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${refreshToken}` },
    });
    assert.equal(meRes.status, 401);
  });
});
