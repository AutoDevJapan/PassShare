// Run only against an owned, plaintext PostgreSQL 16 fixture. No production URLs.
import assert from "node:assert/strict";
import { it } from "node:test";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { resolveDbPoolConfig } from "../../src/config/db-ssl.js";
import { createApp } from "../../src/app.js";

const host = process.env.PASSSHARE_PRIVATE_DB_FIXTURE_HOST;
const port = Number(process.env.PASSSHARE_PRIVATE_DB_FIXTURE_PORT);
if (!["127.0.0.2", "postgres"].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("Explicit owned private PostgreSQL fixture host and port required");
}
const url = `postgresql://postgres@${host}:${port}/postgres`;
const declared = { DATABASE_TRUSTED_PRIVATE_HOSTS: host };
const baseline = process.env.PASSSHARE_PRIVATE_DB_BASELINE_MODULE
  ? await import(pathToFileURL(process.env.PASSSHARE_PRIVATE_DB_BASELINE_MODULE).href)
  : { resolveDbPoolConfig };
const probe = "SELECT 1 AS ok, host(inet_client_addr()) AS peer, host(inet_server_addr()) AS server, " +
  "(SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls, current_setting('server_version_num')::int AS version";

async function queryWith(config) {
  const pool = new pg.Pool({ ...config, connectionTimeoutMillis: 2000, query_timeout: 3000 });
  try {
    const params = new pool.Client(pool.options).connectionParameters;
    const result = await pool.query(probe);
    return { params, row: result.rows[0] };
  } finally {
    await pool.end();
  }
}

it("baseline verified TLS fails against the real private plaintext TCP fixture", async () => {
  const config = baseline.resolveDbPoolConfig(url, {});
  assert.deepEqual(config.ssl, { rejectUnauthorized: true });
  await assert.rejects(queryWith(config), { message: "The server does not support SSL connections" });
});

it("the operator-declared host connects to real PostgreSQL over private TCP", async () => {
  const { params, row } = await queryWith(resolveDbPoolConfig(url, declared));
  assert.equal(params.host, host, "pg must consume the exact declared authority hostname");
  assert.equal(params.ssl, false);
  assert.equal(row.ok, 1);
  assert.equal(row.tls, false);
  assert.ok(row.peer, "the connection must use TCP rather than a Unix socket");
  if (host === "127.0.0.2") assert.equal(row.server, host);
  assert.ok(row.version >= 160000 && row.version < 170000);
});

it("an unrelated declaration and test environment cannot disable verified TLS", async () => {
  const config = resolveDbPoolConfig(`${url}?sslmode=no-verify`, {
    APP_ENV: "test", DATABASE_TRUSTED_PRIVATE_HOSTS: "unrelated-fixture",
  });
  assert.deepEqual(config.ssl, { rejectUnauthorized: true });
  await assert.rejects(queryWith(config), { message: "The server does not support SSL connections" });
});

it("a pinned CA or explicit TLS request still refuses the plaintext fixture", async () => {
  for (const [query, env, ssl] of [
    ["?sslmode=disable&sslrootcert=fixture-missing", { ...declared, DATABASE_CA_CERT: "fixture-ca" },
      { ca: "fixture-ca", rejectUnauthorized: true }],
    ["?sslmode=verify-full", declared, { rejectUnauthorized: true }],
  ]) {
    const config = resolveDbPoolConfig(url + query, env);
    assert.deepEqual(config.ssl, ssl);
    await assert.rejects(queryWith(config), { message: "The server does not support SSL connections" });
  }
});

it("the real API initializes its owned DB and serves readiness with the declaration", async (t) => {
  const keys = ["DATABASE_URL", "DATABASE_TRUSTED_PRIVATE_HOSTS", "DATABASE_CA_CERT", "APP_ENV",
    "TRUST_PROXY_HOPS", "PASSSHARE_MUTATIONS_BIN", "PASSSHARE_ENCRYPTED_STORAGE"];
  const saved = keys.map((key) => process.env[key]);
  t.after(() => keys.forEach((key, i) => {
    if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i];
  }));
  process.env.DATABASE_URL = url;
  process.env.DATABASE_TRUSTED_PRIVATE_HOSTS = host;
  process.env.APP_ENV = "prd";
  process.env.TRUST_PROXY_HOPS = "0";
  delete process.env.DATABASE_CA_CERT;
  const native = process.env.PASSSHARE_PRIVATE_DB_NATIVE_BIN;
  if (!native) throw new Error("Owned fixture native prerequisite required for real API readiness");
  process.env.PASSSHARE_MUTATIONS_BIN = native;
  delete process.env.PASSSHARE_ENCRYPTED_STORAGE;
  const { app, pool } = await createApp();
  t.after(() => pool.end());
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/health/db`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.environment, "prd");
  assert.equal(body.database, "connected");
  assert.equal(body.result, 1);
});
