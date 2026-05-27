import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { createMemoryAuthStore } from "../src/auth/index.js";
import { createMemoryStore } from "../src/store/memory-store.js";
import { createApp } from "../src/app.js";

const PASSWORD = "password123";

/** @param {Headers} headers */
function sessionCookieFrom(headers) {
  const setCookie = headers.get("set-cookie");
  assert.ok(setCookie, "expected Set-Cookie header");
  return setCookie.split(";")[0];
}

/**
 * @param {string} baseUrl
 * @param {string} email
 */
async function signupWithConnectToken(baseUrl, email) {
  const signupRes = await fetch(`${baseUrl}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  assert.equal(signupRes.status, 201);
  const cookie = sessionCookieFrom(signupRes.headers);
  const tokenRes = await fetch(`${baseUrl}/api/auth/connect-token`, {
    headers: { Cookie: cookie },
  });
  assert.equal(tokenRes.status, 200);
  const tokenBody = await tokenRes.json();
  const vaultsRes = await fetch(`${baseUrl}/v1/vaults`, {
    headers: { Authorization: `Bearer ${tokenBody.accessToken}` },
  });
  assert.equal(vaultsRes.status, 200);
  const vaults = await vaultsRes.json();
  assert.equal(vaults.length, 1);
  return {
    accessToken: tokenBody.accessToken,
    vaultId: vaults[0].id,
  };
}

describe("Connect API multi-user authorization", () => {
  /** @type {import('http').Server} */
  let server;
  /** @type {string} */
  let baseUrl;

  before(async () => {
    process.env.APP_ENV = "local";
    delete process.env.OP_CONNECT_TOKEN;
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
    delete process.env.APP_ENV;
  });

  it("lists only vaults scoped to the connect token", async () => {
    const userA = await signupWithConnectToken(baseUrl, "a@example.com");
    await signupWithConnectToken(baseUrl, "b@example.com");

    const res = await fetch(`${baseUrl}/v1/vaults`, {
      headers: { Authorization: `Bearer ${userA.accessToken}` },
    });
    assert.equal(res.status, 200);
    const vaults = await res.json();
    assert.equal(vaults.length, 1);
    assert.equal(vaults[0].id, userA.vaultId);
  });

  it("denies access to another user's password box", async () => {
    const userA = await signupWithConnectToken(baseUrl, "alice@example.com");
    const userB = await signupWithConnectToken(baseUrl, "bob@example.com");

    const vaultRes = await fetch(`${baseUrl}/v1/vaults/${userB.vaultId}`, {
      headers: { Authorization: `Bearer ${userA.accessToken}` },
    });
    assert.equal(vaultRes.status, 403);

    const itemsRes = await fetch(`${baseUrl}/v1/vaults/${userB.vaultId}/items`, {
      headers: { Authorization: `Bearer ${userA.accessToken}` },
    });
    assert.equal(itemsRes.status, 403);

    const createRes = await fetch(`${baseUrl}/v1/vaults/${userB.vaultId}/items`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${userA.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: "Blocked",
        category: "LOGIN",
        fields: [],
      }),
    });
    assert.equal(createRes.status, 403);
  });

  it("allows scoped CRUD on the user's own password box", async () => {
    const user = await signupWithConnectToken(baseUrl, "owner@example.com");
    const createRes = await fetch(`${baseUrl}/v1/vaults/${user.vaultId}/items`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${user.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: "Owned Item",
        category: "LOGIN",
        fields: [{ label: "username", type: "STRING", purpose: "USERNAME", value: "dev" }],
      }),
    });
    assert.equal(createRes.status, 201);
    const item = await createRes.json();
    assert.equal(item.vault.id, user.vaultId);
  });
});

describe("Connect API legacy shared token (local/dev)", () => {
  /** @type {import('http').Server} */
  let server;
  /** @type {string} */
  let baseUrl;

  before(async () => {
    process.env.APP_ENV = "local";
    process.env.OP_CONNECT_TOKEN = "legacy-shared-token";
    const store = createMemoryStore();
    const authStore = createMemoryAuthStore();
    const now = new Date().toISOString();
    store.seedVault({
      id: "abcdefghijklmnopqrstuvwxyz",
      name: "Legacy Box",
      description: "",
      type: "USER_CREATED",
      content_version: 1,
      attribute_version: 1,
      created_at: now,
      updated_at: now,
    });
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
    delete process.env.APP_ENV;
  });

  it("accepts OP_CONNECT_TOKEN in local environment for CLI compatibility", async () => {
    const res = await fetch(`${baseUrl}/v1/vaults`, {
      headers: { Authorization: "Bearer legacy-shared-token" },
    });
    assert.equal(res.status, 200);
    const vaults = await res.json();
    assert.equal(vaults.length, 1);
    assert.equal(vaults[0].name, "Legacy Box");
  });
});
