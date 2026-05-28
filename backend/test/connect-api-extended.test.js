import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { createMemoryStore } from "../src/store/memory-store.js";
import { createApp } from "../src/app.js";

const TOKEN = "test-connect-token";
const VAULT_ID = "abcdefghijklmnopqrstuvwxyz";

describe("Connect API extended (#58)", () => {
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

  const authHeaders = {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
  };

  it("returns health and metrics", async () => {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.status, "ok");

    const metrics = await fetch(`${baseUrl}/metrics`);
    assert.equal(metrics.status, 200);
    const metricsBody = await metrics.json();
    assert.equal(metricsBody.service, "pass-share-backend");
  });

  it("returns PS012 for unknown vault", async () => {
    const unknownVault = "zzzzzzzzzzzzzzzzzzzzzzzzzz";
    const res = await fetch(`${baseUrl}/v1/vaults/${unknownVault}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.match(body.message, /PS012/);
  });

  it("gets vault details", async () => {
    const res = await fetch(`${baseUrl}/v1/vaults/${VAULT_ID}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, VAULT_ID);
    assert.equal(body.name, "Work");
  });

  it("replaces item with PUT", async () => {
    const createRes = await fetch(`${baseUrl}/v1/vaults/${VAULT_ID}/items`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        title: "Replace Me",
        category: "LOGIN",
        fields: [],
      }),
    });
    const created = await createRes.json();

    const putRes = await fetch(
      `${baseUrl}/v1/vaults/${VAULT_ID}/items/${created.id}`,
      {
        method: "PUT",
        headers: authHeaders,
        body: JSON.stringify({
          title: "Replaced",
          category: "SECURE_NOTE",
          fields: [{ label: "notes", type: "STRING", value: "hello" }],
        }),
      },
    );
    assert.equal(putRes.status, 200);
    const replaced = await putRes.json();
    assert.equal(replaced.title, "Replaced");
    assert.equal(replaced.category, "SECURE_NOTE");
  });

  it("returns PS015 for invalid PATCH content type", async () => {
    const createRes = await fetch(`${baseUrl}/v1/vaults/${VAULT_ID}/items`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "Patch Me", category: "LOGIN", fields: [] }),
    });
    const created = await createRes.json();

    const patchRes = await fetch(
      `${baseUrl}/v1/vaults/${VAULT_ID}/items/${created.id}`,
      {
        method: "PATCH",
        headers: authHeaders,
        body: JSON.stringify([{ op: "replace", path: "/title", value: "Nope" }]),
      },
    );
    assert.equal(patchRes.status, 415);
    const body = await patchRes.json();
    assert.match(body.message, /PS015/);
  });

  it("returns PS013 for invalid JSON Patch", async () => {
    const createRes = await fetch(`${baseUrl}/v1/vaults/${VAULT_ID}/items`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "Bad Patch", category: "LOGIN", fields: [] }),
    });
    const created = await createRes.json();

    const patchRes = await fetch(
      `${baseUrl}/v1/vaults/${VAULT_ID}/items/${created.id}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json-patch+json",
        },
        body: JSON.stringify([{ op: "replace", path: "/missing", value: "x" }]),
      },
    );
    assert.equal(patchRes.status, 400);
    const body = await patchRes.json();
    assert.match(body.message, /PS013/);
  });

  it("creates, reads, and deletes files", async () => {
    const createRes = await fetch(`${baseUrl}/v1/vaults/${VAULT_ID}/items`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "With File", category: "LOGIN", fields: [] }),
    });
    const item = await createRes.json();

    const fileRes = await fetch(
      `${baseUrl}/v1/vaults/${VAULT_ID}/items/${item.id}/files`,
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          name: "secret.txt",
          contentBase64: Buffer.from("hello").toString("base64"),
        }),
      },
    );
    assert.equal(fileRes.status, 201);
    const file = await fileRes.json();
    assert.match(file.id, /^[a-z0-9]{26}$/);

    const metaRes = await fetch(
      `${baseUrl}/v1/vaults/${VAULT_ID}/items/${item.id}/files/${file.id}`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    assert.equal(metaRes.status, 200);

    const contentRes = await fetch(
      `${baseUrl}/v1/vaults/${VAULT_ID}/items/${item.id}/files/${file.id}/content`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    assert.equal(contentRes.status, 200);
    const content = Buffer.from(await contentRes.arrayBuffer());
    assert.equal(content.toString("utf8"), "hello");

    const deleteRes = await fetch(
      `${baseUrl}/v1/vaults/${VAULT_ID}/items/${item.id}/files/${file.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${TOKEN}` },
      },
    );
    assert.equal(deleteRes.status, 204);

    const missingRes = await fetch(
      `${baseUrl}/v1/vaults/${VAULT_ID}/items/${item.id}/files/${file.id}`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    assert.equal(missingRes.status, 404);
    const missingBody = await missingRes.json();
    assert.match(missingBody.message, /PS014/);
  });

  it("validates item categories (#53)", async () => {
    const creditRes = await fetch(`${baseUrl}/v1/vaults/${VAULT_ID}/items`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        title: "Card",
        category: "CREDIT_CARD",
        fields: [],
      }),
    });
    assert.equal(creditRes.status, 201);
    const credit = await creditRes.json();
    assert.equal(credit.category, "CREDIT_CARD");

    const badRes = await fetch(`${baseUrl}/v1/vaults/${VAULT_ID}/items`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        title: "Bad",
        category: "NOT_A_CATEGORY",
        fields: [],
      }),
    });
    assert.equal(badRes.status, 400);
    const badBody = await badRes.json();
    assert.match(badBody.message, /PS018/);
  });

  it("creates item with client-provided id for sync (#99)", async () => {
    const clientId = "abcdefghijklmnopqrstuvwxyz";
    const createRes = await fetch(`${baseUrl}/v1/vaults/${VAULT_ID}/items`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        id: clientId,
        title: "Synced Item",
        category: "LOGIN",
        fields: [{ label: "password", type: "CONCEALED", purpose: "PASSWORD", value: "secret" }],
      }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.equal(created.id, clientId);
  });

  it("imports valid 1PUX JSON and rejects invalid payload (#54)", async () => {
    const validPayload = {
      items: [
        {
          title: "Imported Login",
          category: "LOGIN",
          fields: [{ label: "password", type: "CONCEALED", value: "secret" }],
        },
      ],
    };
    const zipBuffer = Buffer.from(JSON.stringify(validPayload));
    const base64 = zipBuffer.toString("base64");

    const importRes = await fetch(
      `${baseUrl}/v1/vaults/${VAULT_ID}/imports/1pux`,
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ base64 }),
      },
    );
    assert.equal(importRes.status, 201);
    const imported = await importRes.json();
    assert.equal(imported.imported, 1);
    assert.equal(imported.items[0].title, "Imported Login");

    const badRes = await fetch(`${baseUrl}/v1/vaults/${VAULT_ID}/imports/1pux`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ base64: Buffer.from("not-json").toString("base64") }),
    });
    assert.equal(badRes.status, 400);
    const badBody = await badRes.json();
    assert.match(badBody.message, /PS017/);
  });
});
