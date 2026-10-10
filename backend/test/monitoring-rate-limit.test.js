import assert from "node:assert/strict";
import { it } from "node:test";
import { createApp } from "../src/app.js";
import { createMemoryAuthStore } from "../src/auth/index.js";
import { createMemoryStore } from "../src/store/memory-store.js";

async function startMonitoringApp(t, appEnv = "local") {
  const keys = ["APP_ENV", "METRICS_TOKEN", "TRUST_PROXY_HOPS",
    "PASSSHARE_MUTATIONS_BIN", "PASSSHARE_ENCRYPTED_STORAGE"];
  const saved = keys.map((key) => process.env[key]);
  t.after(() => keys.forEach((key, i) => {
    if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i];
  }));
  process.env.APP_ENV = appEnv;
  process.env.METRICS_TOKEN = "monitoring-fixture-token";
  delete process.env.TRUST_PROXY_HOPS;
  delete process.env.PASSSHARE_MUTATIONS_BIN;
  delete process.env.PASSSHARE_ENCRYPTED_STORAGE;
  let queries = 0;
  const pool = { async query(sql) {
    queries += 1;
    return { rows: [{ ok: sql === "SELECT 1 AS ok" ? 1 : null }] };
  } };
  const { app } = await createApp({ pool, store: createMemoryStore(), authStore: createMemoryAuthStore() });
  // Keep startup warm-up separate from the route query count.
  queries = 0;
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { app, queryCount: () => queries, request: (path, headers = {}) => fetch(`${baseUrl}${path}`, { headers }) };
}

const metricsHeaders = { Authorization: "Bearer monitoring-fixture-token" };

for (const path of ["/health/db", "/metrics"]) {
  it(`${path} allows monitoring then rejects a burst before any Pool query`, async (t) => {
    const ctx = await startMonitoringApp(t);
    const headers = path === "/metrics" ? metricsHeaders : {};
    for (let i = 0; i < 60; i += 1) {
      const res = await ctx.request(path, headers);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.database, "connected");
    }
    assert.equal(ctx.queryCount(), 60, "allowed requests must actually query the Pool");
    const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => ctx.request(path,
      { ...headers, "X-Forwarded-For": `198.51.100.${i + 1}` })));
    for (const res of burst) {
      assert.equal(res.status, 429);
      assert.ok(Number(res.headers.get("Retry-After")) > 0);
      assert.equal(res.headers.get("RateLimit-Limit"), "60");
      assert.deepEqual(await res.json(), { status: "rate_limited" });
    }
    assert.equal(ctx.queryCount(), 60, "429 responses must not reach the Pool");
    const live = await ctx.request("/health");
    assert.equal(live.status, 200);
    assert.equal((await live.json()).status, "ok");
    assert.equal(ctx.queryCount(), 60, "liveness must stay cheap");
    const other = await ctx.request(path === "/metrics" ? "/health/db" : "/metrics", metricsHeaders);
    assert.equal(other.status, 200, "endpoints must have independent monitoring budgets");
    await other.json();
    assert.equal(ctx.queryCount(), 61);
  });
}

it("metrics authentication precedes the limiter and does not consume the monitoring budget", async (t) => {
  const ctx = await startMonitoringApp(t, "prd");
  const ip = { "X-Forwarded-For": "198.51.100.10" };
  for (let i = 0; i < 65; i += 1) {
    const res = await ctx.request("/metrics", { ...ip, Authorization: "Bearer invalid-fixture-token" });
    assert.equal(res.status, 404);
    await res.json();
  }
  assert.equal(ctx.queryCount(), 0);
  const allowed = await ctx.request("/metrics", { ...ip, ...metricsHeaders });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).database, "connected");
  assert.equal(ctx.queryCount(), 1);
});

it("deployed monitoring uses trusted proxy hops instead of spoofed leftmost addresses", async (t) => {
  const ctx = await startMonitoringApp(t, "prd");
  assert.equal(ctx.app.get("trust proxy"), 1);
  for (let i = 0; i < 60; i += 1) {
    const res = await ctx.request("/health/db", { "X-Forwarded-For": `203.0.113.${i + 1}, 198.51.100.10` });
    assert.equal(res.status, 200);
    await res.json();
  }
  assert.equal(ctx.queryCount(), 60);
  const denied = await ctx.request("/health/db", { "X-Forwarded-For": "203.0.113.200, 198.51.100.10" });
  assert.equal(denied.status, 429);
  await denied.json();
  assert.equal(ctx.queryCount(), 60);
  const otherIp = await ctx.request("/health/db", { "X-Forwarded-For": "203.0.113.200, 198.51.100.11" });
  assert.equal(otherIp.status, 200);
  await otherIp.json();
  assert.equal(ctx.queryCount(), 61);
});
