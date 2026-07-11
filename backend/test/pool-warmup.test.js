import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { createMemoryAuthStore } from "../src/auth/index.js";
import { createApp } from "../src/app.js";
import { createMemoryStore } from "../src/store/memory-store.js";

/**
 * Startup DB pool warm-up (#368): the first request after a Railway cold-start
 * must be served without paying connection-establishment latency, and a
 * transient warm-up failure must never prevent the app from booting.
 */
describe("DB pool warm-up on startup (#368)", () => {
  /** @type {import('http').Server | null} */
  let server = null;

  /** @param {import('express').Express} app */
  async function listen(app) {
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return `http://127.0.0.1:${port}`;
  }

  afterEach(async () => {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      server = null;
    }
  });

  it("boots without a pool (no warm-up) and serves liveness", async () => {
    const { app } = await createApp({
      store: createMemoryStore(),
      authStore: createMemoryAuthStore(),
      pool: null,
    });
    const baseUrl = await listen(app);
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
  });

  it("warms the pool with a single SELECT 1 when the DB is healthy", async () => {
    let queries = 0;
    const pool = {
      async query() {
        queries += 1;
        return { rows: [{ ok: 1 }] };
      },
    };
    const { app } = await createApp({
      store: createMemoryStore(),
      authStore: createMemoryAuthStore(),
      pool,
    });
    const baseUrl = await listen(app);
    assert.equal(queries, 1, "warm-up should issue exactly one probe query");
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
  });

  it("retries a transient warm-up failure, then succeeds", async () => {
    let attempts = 0;
    const pool = {
      async query() {
        attempts += 1;
        if (attempts < 2) {
          throw new Error("connection refused (cold start)");
        }
        return { rows: [{ ok: 1 }] };
      },
    };
    const { app } = await createApp({
      store: createMemoryStore(),
      authStore: createMemoryAuthStore(),
      pool,
    });
    const baseUrl = await listen(app);
    assert.equal(attempts, 2, "warm-up should retry the transient failure once");
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
  });

  it("is non-fatal when warm-up never succeeds; app still boots", async () => {
    let attempts = 0;
    const pool = {
      async query() {
        attempts += 1;
        throw new Error("db unreachable");
      },
    };
    const { app } = await createApp({
      store: createMemoryStore(),
      authStore: createMemoryAuthStore(),
      pool,
    });
    const baseUrl = await listen(app);
    assert.ok(attempts >= 3, "warm-up should exhaust its retry attempts");
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
  });
});
