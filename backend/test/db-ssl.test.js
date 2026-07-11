import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveDbSslConfig } from "../src/config/db-ssl.js";

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
});
