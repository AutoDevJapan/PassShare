import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createApp } from "../src/app.js";

const { Pool } = pg;

const TOKEN = "test-connect-token";
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://passshare:passshare@localhost:5432/passshare";

describe("Connect API (PostgreSQL integration)", { skip: !process.env.DATABASE_URL }, () => {
  /** @type {import('pg').Pool} */
  let pool;
  /** @type {import('http').Server} */
  let server;
  /** @type {string} */
  let baseUrl;
  /** @type {string} */
  let vaultId;

  before(async () => {
    process.env.OP_CONNECT_TOKEN = TOKEN;
    pool = new Pool({ connectionString: DATABASE_URL });

    const { app } = await createApp({ pool });
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;

    const vaultRes = await fetch(`${baseUrl}/v1/vaults`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const vaults = await vaultRes.json();
    vaultId = vaults[0].id;
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await pool.end();
    delete process.env.OP_CONNECT_TOKEN;
  });

  it("lists vaults from PostgreSQL", async () => {
    const res = await fetch(`${baseUrl}/v1/vaults`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.length >= 1);
    assert.equal(body[0].id, vaultId);
  });

  it("creates and reads an item through PostgreSQL", async () => {
    const createRes = await fetch(`${baseUrl}/v1/vaults/${vaultId}/items`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        category: "LOGIN",
        title: "Docker E2E Login",
        fields: [
          { id: "username", type: "STRING", purpose: "USERNAME", label: "username", value: "user@example.com" },
          { id: "password", type: "CONCEALED", purpose: "PASSWORD", label: "password", value: "secret123" },
        ],
      }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.ok(created.id);

    const getRes = await fetch(`${baseUrl}/v1/vaults/${vaultId}/items/${created.id}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(getRes.status, 200);
    const item = await getRes.json();
    assert.equal(item.title, "Docker E2E Login");
  });

  it("reports database health", async () => {
    const res = await fetch(`${baseUrl}/health/db`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
  });
});
