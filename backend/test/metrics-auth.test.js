import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { createRequireMetricsAuth } from "../src/config/metrics-auth.js";
import { createMemoryAuthStore } from "../src/auth/index.js";
import { createMemoryStore } from "../src/store/memory-store.js";
import { createApp } from "../src/app.js";
import express from "express";
import { maxHeaderSize } from "node:http";
import { connect } from "node:net";

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
  it("preserves separator and token content semantics", async () => {
    const token = "fixture token\tpart";
    const middleware = createRequireMetricsAuth("prd", { METRICS_TOKEN: token });
    for (const separator of [" ", "\t", "  \t ", "\r\n", "\u00a0", "\u2028", "\ufeff"]) {
      const result = await runMiddleware(middleware, { authorization: ` \t bEaReR${separator}${token} \n` });
      assert.equal(result.nextCalled, true, "whitespace separator should be accepted");
    }
    for (const header of ["Bearer", "Bearer   ", `Bearer${token}`, `Basic ${token}`,
      `Bearer ${token}\npart`, `Bearer ${token}\rpart`, `Bearer ${token}\u2028part`,
      `Bearer ${token}\u2029part`, `Bearer fixture  token\tpart`]) {
      const result = await runMiddleware(middleware, { authorization: header });
      assert.equal(result.statusCode, 404);
      assert.equal(result.nextCalled, false);
    }
  });

  it("rejects long malformed whitespace input in linear scans", { timeout: 5000 }, async () => {
    const middleware = createRequireMetricsAuth("prd", { METRICS_TOKEN: "fixture-token" });
    for (const header of [`Bearer ${" ".repeat(1_000_000)}x\ny`,
      `Bearer ${" ".repeat(1_000_000)}`, `Bearer ${"x".repeat(1_000_000)}\u2028y`]) {
      const result = await runMiddleware(middleware, { authorization: header });
      assert.equal(result.statusCode, 404);
      assert.equal(result.nextCalled, false);
    }
  });

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

it("Node rejects oversized and invalid-line Authorization before metrics middleware", async (t) => {
  let middlewareCalls = 0;
  const app = express();
  const auth = createRequireMetricsAuth("prd", { METRICS_TOKEN: "fixture-token" });
  app.get("/metrics", (req, res, next) => {
    middlewareCalls += 1;
    auth(req, res, next);
  }, (_req, res) => res.json({ status: "ok" }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));
  const port = server.address().port;
  const allowed = await fetch(`http://127.0.0.1:${port}/metrics`, { headers: { Authorization: "Bearer fixture-token" } });
  assert.equal(allowed.status, 200);
  await allowed.json();
  assert.equal(middlewareCalls, 1, "positive control must reach the middleware");

  async function rawRequest(header) {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port });
      let response = "";
      socket.setEncoding("latin1");
      socket.setTimeout(5000, () => socket.destroy(new Error("HTTP fixture timeout")));
      socket.on("error", reject);
      socket.on("data", (chunk) => { response += chunk; });
      socket.on("end", () => resolve(response));
      socket.on("connect", () => socket.end(`GET /metrics HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nAuthorization: ${header}\r\n\r\n`, "latin1"));
    });
  }
  assert.match(await rawRequest(`Bearer ${" ".repeat(maxHeaderSize)}x`), /^HTTP\/1\.1 431 /);
  assert.match(await rawRequest(`Bearer ${" ".repeat(2000)}x\ry`), /^HTTP\/1\.1 400 /);
  assert.equal(middlewareCalls, 1, "parser rejections must not reach token parsing");
});
