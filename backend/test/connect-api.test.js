import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { createMemoryStore } from "../src/store/memory-store.js";
import { createApp } from "../src/app.js";

const TOKEN = "test-connect-token";
const VAULT_ID = "abcdefghijklmnopqrstuvwxyz";

describe("Connect API", () => {
  /** @type {import('http').Server} */
  let server;
  /** @type {string} */
  let baseUrl;
  /** @type {ReturnType<typeof createMemoryStore>} */
  let store;

  before(async () => {
    process.env.OP_CONNECT_TOKEN = TOKEN;
    store = createMemoryStore();
    const now = new Date().toISOString();
    store.seedVault({
      id: VAULT_ID,
      name: "Work",
      description: "",
      type: "USER_CREATED",
      content_version: 1,
      attribute_version: 1,
      created_at: now,
      updated_at: now,
    });
    const { app } = await createApp({ store, pool: null });
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

  it("rejects missing bearer token", async () => {
    const res = await fetch(`${baseUrl}/v1/vaults`);
    assert.equal(res.status, 401);
  });

  it("lists vaults in Connect shape", async () => {
    const res = await fetch(`${baseUrl}/v1/vaults`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].id, VAULT_ID);
    assert.equal(body[0].name, "Work");
    assert.equal(body[0].type, "USER_CREATED");
    assert.equal(typeof body[0].createdAt, "string");
  });

  it("creates, patches, and deletes items", async () => {
    const createRes = await fetch(`${baseUrl}/v1/vaults/${VAULT_ID}/items`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: "GitHub",
        category: "LOGIN",
        fields: [
          { label: "username", type: "STRING", purpose: "USERNAME", value: "dev" },
          { label: "password", type: "CONCEALED", purpose: "PASSWORD", value: "secret" },
        ],
      }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.match(created.id, /^[a-z0-9]{26}$/);
    assert.equal(created.title, "GitHub");
    assert.equal(created.vault.id, VAULT_ID);

    const listRes = await fetch(`${baseUrl}/v1/vaults/${VAULT_ID}/items`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const listed = await listRes.json();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].title, "GitHub");

    const patchRes = await fetch(
      `${baseUrl}/v1/vaults/${VAULT_ID}/items/${created.id}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json-patch+json",
        },
        body: JSON.stringify([
          { op: "replace", path: "/fields/1/value", value: "new-password" },
        ]),
      },
    );
    assert.equal(patchRes.status, 200);
    const patched = await patchRes.json();
    assert.equal(patched.fields[1].value, "new-password");

    const deleteRes = await fetch(
      `${baseUrl}/v1/vaults/${VAULT_ID}/items/${created.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${TOKEN}` },
      },
    );
    assert.equal(deleteRes.status, 204);
  });
});
