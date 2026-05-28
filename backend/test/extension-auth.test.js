import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { CLIENT_HEADER, EXTENSION_CLIENT_VALUE } from "../src/auth/client.js";
import { createMemoryAuthStore } from "../src/auth/index.js";
import { createMemoryStore } from "../src/store/memory-store.js";
import { createApp } from "../src/app.js";

const EMAIL = "extension@example.com";
const PASSWORD = "password123";

describe("Extension Auth API", () => {
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

  it("returns refresh and connect tokens on extension signup/login", async () => {
    const headers = {
      "Content-Type": "application/json",
      [CLIENT_HEADER]: EXTENSION_CLIENT_VALUE,
    };

    const signupRes = await fetch(`${baseUrl}/api/auth/signup`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    assert.equal(signupRes.status, 201);
    const signupBody = await signupRes.json();
    assert.equal(signupBody.user.email, EMAIL);
    assert.ok(signupBody.refreshToken);
    assert.ok(signupBody.connectAccessToken);

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    assert.equal(loginRes.status, 200);
    const loginBody = await loginRes.json();
    assert.ok(loginBody.refreshToken);
    assert.ok(loginBody.connectAccessToken);
  });

  it("authenticates /me with Bearer refresh token without CSRF", async () => {
    const headers = {
      "Content-Type": "application/json",
      [CLIENT_HEADER]: EXTENSION_CLIENT_VALUE,
    };

    const signupRes = await fetch(`${baseUrl}/api/auth/signup`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email: "ext-me@example.com", password: PASSWORD }),
    });
    const { refreshToken } = await signupRes.json();

    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: {
        Authorization: `Bearer ${refreshToken}`,
        [CLIENT_HEADER]: EXTENSION_CLIENT_VALUE,
      },
    });
    assert.equal(meRes.status, 200);
    const meBody = await meRes.json();
    assert.equal(meBody.user.email, "ext-me@example.com");
  });
});
