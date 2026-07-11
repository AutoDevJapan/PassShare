import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { createRequireMetricsAuth } from "../src/config/metrics-auth.js";
import { createMemoryAuthStore } from "../src/auth/index.js";
import { createMemoryStore } from "../src/store/memory-store.js";
import { createApp } from "../src/app.js";

/**
 * Minimal Express req/res doubles to exercise the middleware in isolation.
 * @param {Record<string, string>} [headers]
 */
function runMiddleware(middleware, headers = {}) {
  return new Promise((resolve) => {
    const req = { headers };
    let nextCalled = false;
    const res = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        resolve({ nextCalled, statusCode: this.statusCode, body: this.body });
      },
    };
    middleware(req, res, () => {
      nextCalled = true;
      resolve({ nextCalled, statusCode: res.statusCode, body: res.body });
    });
  });
}

describe("createRequireMetricsAuth", () => {
  it("allows access in local when no token is configured", async () => {
    const result = await runMiddleware(createRequireMetricsAuth("local", {}));
    assert.equal(result.nextCalled, true);
  });

  it("disables the endpoint (404) in deployed envs when no token is configured", async () => {
    for (const appEnv of ["dev", "stg", "prd", "preview"]) {
      const result = await runMiddleware(createRequireMetricsAuth(appEnv, {}));
      assert.equal(result.nextCalled, false, `${appEnv} should not call next`);
      assert.equal(result.statusCode, 404);
      assert.deepEqual(result.body, { status: "not_found" });
    }
  });

  it("accepts the correct bearer token", async () => {
    const middleware = createRequireMetricsAuth("prd", { METRICS_TOKEN: "s3cret-token" });
    const result = await runMiddleware(middleware, { authorization: "Bearer s3cret-token" });
    assert.equal(result.nextCalled, true);
  });

  it("rejects a missing or wrong token with 404", async () => {
    const middleware = createRequireMetricsAuth("prd", { METRICS_TOKEN: "s3cret-token" });

    const missing = await runMiddleware(middleware, {});
    assert.equal(missing.nextCalled, false);
    assert.equal(missing.statusCode, 404);

    const wrong = await runMiddleware(middleware, { authorization: "Bearer nope" });
    assert.equal(wrong.nextCalled, false);
    assert.equal(wrong.statusCode, 404);

    // Length-mismatch must not throw from timingSafeEqual.
    const shorter = await runMiddleware(middleware, { authorization: "Bearer x" });
    assert.equal(shorter.statusCode, 404);
  });
});

describe("/metrics endpoint integration", () => {
  /** @type {import('http').Server} */
  let server;
  /** @type {string} */
  let baseUrl;

  before(async () => {
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
  });

  it("serves metrics in the local test environment", async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.service, "pass-share-backend");
  });
});
