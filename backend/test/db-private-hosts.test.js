import assert from "node:assert/strict";
import { it } from "node:test";
import pg from "pg";
import { resolveDbPoolConfig } from "../src/config/db-ssl.js";
import { createApp } from "../src/app.js";
import { createMemoryStore } from "../src/store/memory-store.js";
import { createMemoryAuthStore } from "../src/auth/index.js";

const privateEnv = { DATABASE_TRUSTED_PRIVATE_HOSTS: "postgres, passshare1163-encrypted-fixture" };
function consumed(url, env) {
  const pool = new pg.Pool(resolveDbPoolConfig(url, env));
  return new pool.Client(pool.options).connectionParameters;
}

it("requires an operator declaration for a private Docker hostname", () => {
  for (const hostname of ["postgres", "passshare1163-encrypted-fixture"]) {
    const url = `postgresql://fixture:fixture@${hostname}/fixture`;
    assert.deepEqual(consumed(url, {}).ssl, { rejectUnauthorized: true });
    assert.deepEqual(consumed(url, { APP_ENV: "test" }).ssl, { rejectUnauthorized: true });
    const params = consumed(url, privateEnv);
    assert.equal(params.host, hostname);
    assert.equal(params.ssl, false);
    assert.equal(params.sslnegotiation, "postgres");
  }
});

it("declares exact canonical DNS names that are also consumed by pg", () => {
  const params = consumed("postgresql://fixture:fixture@POSTGRES/fixture?application_name=fixture", {
    DATABASE_TRUSTED_PRIVATE_HOSTS: " POSTGRES ",
  });
  assert.equal(params.host, "postgres");
  assert.equal(params.ssl, false);
  assert.equal(params.application_name, "fixture");
});

it("rejects wildcard, URL, credential, query, port and malformed declarations", () => {
  for (const hosts of ["*", "*.example", "postgres,", ",postgres", "postgres:5432", "fixture@postgres",
    "postgres/fixture", "postgres?ssl=0", "postgres#fixture", "%70ostgres", "postgres..example",
    "https://postgres", "-postgres", "postgres-", "post_gres", "postgres.", "a".repeat(64),
    `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}`]) {
    assert.throws(() => resolveDbPoolConfig("postgresql://fixture:fixture@postgres/fixture", {
      DATABASE_TRUSTED_PRIVATE_HOSTS: hosts,
    }), { message: "Invalid trusted private database hosts configuration" });
  }
});

it("never trusts suffixes, passwords, paths or URL query declarations", () => {
  for (const url of [
    "postgresql://fixture:fixture@postgres.evil.example/fixture?sslmode=disable",
    "postgresql://fixture:fixture@evil-postgres/fixture?ssl=no-verify",
    "postgresql://fixture:postgres@external.example/fixture",
    "postgresql://fixture:fixture@external.example/postgres",
    "postgresql://fixture:fixture@external.example/fixture?private_host=postgres&sslmode=disable",
    "postgresql://fixture:fixture@external.example/fixture?DATABASE_TRUSTED_PRIVATE_HOSTS=external.example",
    "postgresql://postgres@external.example/fixture?note=postgres&sslmode=no-verify",
    "postgresql://fixture:fixture@host.proxy.rlwy.net/fixture?sslmode=disable",
  ]) {
    assert.deepEqual(consumed(url, privateEnv).ssl, { rejectUnauthorized: true });
  }
  for (const url of ["postgresql://fixture:fixture@postgres/fixture?host=external.example",
    "postgresql://fixture:fixture@postgres/fixture?%68ost=external.example",
    "postgresql://fixture:fixture@external.example/fixture?host=postgres"]) {
    assert.throws(() => resolveDbPoolConfig(url, privateEnv), { message: "Invalid database URL configuration" });
  }
});

it("prioritizes pinned CA and explicit TLS requests over a private declaration", () => {
  for (const query of ["", "?sslmode=disable", "?sslmode=no-verify", "?sslnegotiation=direct",
    "?sslrootcert=fixture-missing&sslcert=fixture-missing&sslkey=fixture-missing"]) {
    const params = consumed(`postgresql://fixture:fixture@postgres/fixture${query}`, {
      ...privateEnv, DATABASE_CA_CERT: "fixture-ca", DATABASE_SSL_ALLOW_INSECURE: "true",
    });
    assert.equal(params.host, "postgres");
    assert.deepEqual(params.ssl, { ca: "fixture-ca", rejectUnauthorized: true });
  }
  for (const query of ["?sslmode=require", "?sslmode=verify-full", "?sslmode=no-verify",
    "?sslnegotiation=direct", "?ssl=1", "?sslrootcert=fixture-missing"]) {
    assert.deepEqual(consumed(`postgresql://fixture:fixture@postgres/fixture${query}`, privateEnv).ssl,
      { rejectUnauthorized: true });
  }
});

it("retains private and public policy despite pg TLS environment hints", (t) => {
  const keys = ["PGSSLMODE", "PGSSLNEGOTIATION"];
  const saved = keys.map((key) => process.env[key]);
  t.after(() => keys.forEach((key, i) => {
    if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i];
  }));
  process.env.PGSSLMODE = "no-verify";
  process.env.PGSSLNEGOTIATION = "direct";
  const internal = consumed("postgresql://fixture:fixture@postgres/fixture", {
    ...privateEnv, PGSSLNEGOTIATION: "direct",
  });
  assert.equal(internal.ssl, false);
  assert.equal(internal.sslnegotiation, "postgres");
  assert.deepEqual(consumed("postgresql://fixture:fixture@external.example/fixture", privateEnv).ssl,
    { rejectUnauthorized: true });
});

it("uses pg last-value semantics for repeated TLS query options", () => {
  for (const query of ["ssl=0&ssl=1", "sslmode=disable&sslmode=require",
    "sslnegotiation=postgres&sslnegotiation=direct", "sslrootcert=&sslrootcert=fixture-missing",
    "sslcert=&sslcert=fixture-missing", "sslkey=&sslkey=fixture-missing"]) {
    const params = consumed(`postgresql://fixture:fixture@postgres/fixture?${query}`, privateEnv);
    assert.equal(params.host, "postgres");
    assert.deepEqual(params.ssl, { rejectUnauthorized: true });
    assert.equal(params.sslnegotiation, query.includes("sslnegotiation") ? "direct" : "postgres");
  }
  for (const query of ["ssl=1&ssl=0", "sslmode=require&sslmode=disable",
    "sslnegotiation=direct&sslnegotiation=postgres", "sslrootcert=fixture-missing&sslrootcert="]) {
    const params = consumed(`postgresql://fixture:fixture@postgres/fixture?${query}`, privateEnv);
    assert.equal(params.ssl, false);
    assert.equal(params.sslnegotiation, "postgres");
  }
});

it("does not extend an exact private declaration to a terminal-dot authority", () => {
  const env = { DATABASE_TRUSTED_PRIVATE_HOSTS: "postgres,127.0.0.2" };
  assert.equal(consumed("postgresql://fixture:fixture@postgres/fixture", env).ssl, false);
  for (const [authority, expectedHost] of [["postgres.", "postgres."], ["postgres%2e", "postgres."],
    ["postgres.evil.example", "postgres.evil.example"], ["127.0.0.2.", "127.0.0.2."]]) {
    const params = consumed(`postgresql://fixture:fixture@${authority}/fixture`, env);
    assert.equal(params.host, expectedHost);
    assert.deepEqual(params.ssl, { rejectUnauthorized: true });
  }
});

it("wires the private declaration into the app-created Pool", async (t) => {
  const keys = ["DATABASE_URL", "DATABASE_TRUSTED_PRIVATE_HOSTS", "DATABASE_CA_CERT",
    "PASSSHARE_MUTATIONS_BIN", "PASSSHARE_ENCRYPTED_STORAGE"];
  const saved = keys.map((key) => process.env[key]);
  t.after(() => keys.forEach((key, i) => {
    if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i];
  }));
  process.env.DATABASE_URL = "postgresql://fixture:fixture@postgres/fixture";
  process.env.DATABASE_TRUSTED_PRIVATE_HOSTS = "postgres";
  delete process.env.DATABASE_CA_CERT;
  delete process.env.PASSSHARE_MUTATIONS_BIN;
  delete process.env.PASSSHARE_ENCRYPTED_STORAGE;
  const observations = [];
  t.mock.method(pg.Pool.prototype, "query", function () {
    observations.push(new this.Client(this.options).connectionParameters);
    return Promise.resolve({ rows: [{ ok: 1 }] });
  });
  const { pool } = await createApp({ store: createMemoryStore(), authStore: createMemoryAuthStore() });
  try {
    assert.equal(observations.length, 1, "startup must consume the app-created Pool options");
    assert.equal(observations[0].host, "postgres");
    assert.equal(observations[0].ssl, false);
    assert.equal(observations[0].sslnegotiation, "postgres");
  } finally {
    await pool.end();
  }
});
