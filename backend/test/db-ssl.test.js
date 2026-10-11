import assert from "node:assert/strict";
import { describe, it } from "node:test";
import pg from "pg";
import { resolveDbSslConfig, resolveDbPoolConfig } from "../src/config/db-ssl.js";
import { createApp } from "../src/app.js";
import { createMemoryStore } from "../src/store/memory-store.js";
import { createMemoryAuthStore } from "../src/auth/index.js";

describe("resolveDbSslConfig", () => {
  it("returns undefined when no database URL is provided", () => {
    assert.equal(resolveDbSslConfig(null, {}), undefined);
    assert.equal(resolveDbSslConfig(undefined, {}), undefined);
    assert.equal(resolveDbSslConfig("", {}), undefined);
  });

  it("disables TLS for the Railway private network", () => {
    const url = "postgresql://user:pass@postgres.railway.internal:5432/railway";
    assert.equal(resolveDbSslConfig(url, {}), undefined);
    // A pinned CA does not override the private-network shortcut.
    assert.equal(resolveDbSslConfig(url, { DATABASE_CA_CERT: "-----BEGIN CERTIFICATE-----" }), undefined);
  });

  it("pins the provided CA and verifies the certificate", () => {
    const ca = "-----BEGIN CERTIFICATE-----\nMII...\n-----END CERTIFICATE-----";
    const result = resolveDbSslConfig(
      "postgresql://user:pass@host.rlwy.net:5432/railway",
      { DATABASE_CA_CERT: ca },
    );
    assert.deepEqual(result, { ca, rejectUnauthorized: true });
  });

  it("ignores a blank CA env value", () => {
    const result = resolveDbSslConfig(
      "postgresql://user:pass@host.railway.app:5432/railway",
      { DATABASE_CA_CERT: "   " },
    );
    assert.deepEqual(result, { rejectUnauthorized: true });
  });

  it("requires certificate verification for public/proxied hosts by default", () => {
    assert.deepEqual(
      resolveDbSslConfig("postgresql://u:p@containers.railway.app:5432/db", {}),
      { rejectUnauthorized: true },
    );
    assert.deepEqual(
      resolveDbSslConfig("postgresql://u:p@host.proxy.rlwy.net:5432/db", {}),
      { rejectUnauthorized: true },
    );
  });

  it("honours sslmode in the connection string", () => {
    for (const mode of ["require", "verify-ca", "verify-full"]) {
      assert.deepEqual(
        resolveDbSslConfig(`postgresql://u:p@db.example.com:5432/db?sslmode=${mode}`, {}),
        { rejectUnauthorized: true },
        `sslmode=${mode} should require verified TLS`,
      );
    }
  });

  it("allows verification to be disabled only via explicit opt-in", () => {
    const url = "postgresql://u:p@host.railway.app:5432/db";
    assert.deepEqual(
      resolveDbSslConfig(url, { DATABASE_SSL_ALLOW_INSECURE: "true" }),
      { rejectUnauthorized: false },
    );
    // Any value other than the exact string "true" keeps verification on.
    assert.deepEqual(
      resolveDbSslConfig(url, { DATABASE_SSL_ALLOW_INSECURE: "1" }),
      { rejectUnauthorized: true },
    );
  });

  it("returns undefined for a local database without TLS hints", () => {
    assert.equal(
      resolveDbSslConfig("postgresql://postgres:postgres@localhost:5432/passshare", {}),
      undefined,
    );
  });

  it("uses the actual hostname boundary rather than password, path or query text", () => {
    for (const url of [
      "postgresql://u:fake.railway.internal@external.example/db",
      "postgresql://u:p@external.example/db/.railway.internal",
      "postgresql://u:p@external.example/db?note=.railway.internal",
      "postgresql://u:p@postgres.railway.internal.evil.example/db",
      "postgresql://u:p@evil-railway.internal/db",
      "postgresql://u:p@railway.internal/db",
      "postgresql://u:p@railway.app.evil.example/db",
      "postgresql://u:p@evilrlwy.net/db",
      "postgresql://u:p@localhost.evil.example/db",
      "postgresql://u:p@10.0.0.1/db",
    ]) {
      assert.deepEqual(resolveDbSslConfig(url, {}), { rejectUnauthorized: true });
      assert.deepEqual(resolveDbSslConfig(url, { DATABASE_CA_CERT: "fixture-ca" }),
        { ca: "fixture-ca", rejectUnauthorized: true });
    }
    for (const hostname of ["POSTGRES.RAILWAY.INTERNAL", "postgres.railway.internal.",
      "nested.postgres.railway.internal"]) {
      assert.equal(resolveDbSslConfig(`postgresql://u:p@${hostname}/db`, {}), undefined);
    }
    for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
      assert.equal(resolveDbSslConfig(`postgresql://u:p@${hostname}/db`, {}), undefined);
      assert.deepEqual(resolveDbSslConfig(`postgresql://u:p@${hostname}/db?sslmode=require`, {}),
        { rejectUnauthorized: true });
    }
  });

  it("never lets an URL TLS opt-out weaken an external connection", () => {
    for (const query of ["", "?sslmode=disable", "?sslmode=no-verify", "?ssl=0", "?ssl=no-verify",
      "?sslmode=prefer&uselibpqcompat=true", "?sslmode=verify-ca&uselibpqcompat=true",
      "?sslmode=disable&sslmode=require"]) {
      assert.deepEqual(resolveDbSslConfig(`postgresql://u:p@external.example/db${query}`, {}),
        { rejectUnauthorized: true });
    }
  });

  it("rejects invalid URLs and query host overrides without revealing their input", () => {
    for (const url of ["not-a-url-with-fake-password", "https://u:fake-password@external.example/db",
      "postgresql://u:fake-password@/db", "postgresql://u:fake-password@localhost/db?host=external.example",
      "postgresql://u:fake-password@external.example/db?sslmode=require-extra"]) {
      for (const resolve of [resolveDbSslConfig, resolveDbPoolConfig]) {
        assert.throws(() => resolve(url, {}), { message: "Invalid database URL configuration" });
      }
    }
  });
});

describe("actual pg Pool configuration consumption", () => {
  it("retains the validated TLS policy after pg parses URL options", async () => {
    for (const [host, env, expected] of [
      ["external.example", {}, { rejectUnauthorized: true }],
      ["host.proxy.rlwy.net", { DATABASE_CA_CERT: "fixture-ca" }, { ca: "fixture-ca", rejectUnauthorized: true }],
      ["external.example", { DATABASE_SSL_ALLOW_INSECURE: "true" }, { rejectUnauthorized: false }],
      ["external.example", { DATABASE_CA_CERT: "fixture-ca", DATABASE_SSL_ALLOW_INSECURE: "true" },
        { ca: "fixture-ca", rejectUnauthorized: true }],
      ["postgres.railway.internal", { DATABASE_CA_CERT: "fixture-ca" }, false],
      ["localhost", {}, false],
    ]) {
      for (const [query, requestsLocalTls] of [["sslmode=disable", false], ["sslmode=no-verify", true],
        ["ssl=0", false], ["ssl=no-verify", true], ["sslmode=disable&sslmode=require", true],
        ["sslmode=require&sslmode=disable", false],
        ["sslnegotiation=direct", true],
        ["sslrootcert=fixture-does-not-exist&sslcert=fixture-does-not-exist&sslkey=fixture-does-not-exist", true],
        ["sslmode=require&uselibpqcompat=true", true]]) {
        const pool = new pg.Pool(resolveDbPoolConfig(`postgresql://u:p@${host}/db?${query}&application_name=fixture`, env));
        try {
          // Pool constructs its Client with these exact options on acquisition.
          const client = new pool.Client(pool.options);
          const localRequestedTls = host === "localhost" && requestsLocalTls;
          assert.deepEqual(client.connectionParameters.ssl, localRequestedTls ? { rejectUnauthorized: true } : expected);
          assert.equal(client.connectionParameters.host, host);
          assert.equal(client.connectionParameters.application_name, "fixture");
          assert.equal(client.connectionParameters.sslnegotiation,
            query === "sslnegotiation=direct" && client.connectionParameters.ssl ? "direct" : "postgres");
        } finally {
          await pool.end();
        }
      }
    }
  });

  it("keeps pg environment hints from weakening pinned or trusted configurations", async (t) => {
    const keys = ["PGSSLMODE", "PGSSLNEGOTIATION"];
    const saved = keys.map((key) => process.env[key]);
    t.after(() => keys.forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i];
    }));
    process.env.PGSSLMODE = "no-verify";
    process.env.PGSSLNEGOTIATION = "direct";
    for (const [host, env, expected] of [
      ["external.example", { DATABASE_CA_CERT: "fixture-ca", PGSSLNEGOTIATION: "direct" },
        { ca: "fixture-ca", rejectUnauthorized: true }],
      ["external.example", {}, { rejectUnauthorized: true }],
      ["postgres.railway.internal", {}, false],
      ["localhost", {}, false],
    ]) {
      const pool = new pg.Pool(resolveDbPoolConfig(`postgresql://u:p@${host}/db`, env));
      try {
        const client = new pool.Client(pool.options);
        assert.deepEqual(client.connectionParameters.ssl, expected);
        assert.equal(client.connectionParameters.sslnegotiation, env.PGSSLNEGOTIATION ?? "postgres");
      } finally {
        await pool.end();
      }
    }
  });

  it("wires the validated config into the Pool created by createApp", async (t) => {
    const keys = ["DATABASE_URL", "DATABASE_CA_CERT", "DATABASE_SSL_ALLOW_INSECURE",
      "PASSSHARE_MUTATIONS_BIN", "PASSSHARE_ENCRYPTED_STORAGE"];
    const saved = keys.map((key) => process.env[key]);
    t.after(() => keys.forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i];
    }));
    process.env.DATABASE_URL = "postgresql://u:fixture.railway.internal@external.example/db?sslmode=disable&sslrootcert=fixture-does-not-exist";
    process.env.DATABASE_CA_CERT = "fixture-ca";
    delete process.env.DATABASE_SSL_ALLOW_INSECURE;
    delete process.env.PASSSHARE_MUTATIONS_BIN;
    delete process.env.PASSSHARE_ENCRYPTED_STORAGE;
    const consumed = [];
    // Intercept only transport, keeping createApp, Pool and pg Client parsing real.
    t.mock.method(pg.Pool.prototype, "query", function () {
      consumed.push(new this.Client(this.options).connectionParameters);
      return Promise.resolve({ rows: [{ ok: 1 }] });
    });
    const { pool } = await createApp({ store: createMemoryStore(), authStore: createMemoryAuthStore() });
    try {
      assert.equal(consumed.length, 1, "startup must exercise the app-created Pool");
      assert.equal(consumed[0].host, "external.example");
      assert.deepEqual(consumed[0].ssl, { ca: "fixture-ca", rejectUnauthorized: true });
    } finally {
      await pool.end();
    }
  });
});
