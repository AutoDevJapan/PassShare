import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDistinctTarget,
  buildPublicSchemaWipeSql,
  parsePostgresHost,
  parsePostgresUser,
} from "./railway-db-replica.mjs";

test("parsePostgresUser decodes credentials from connection URL", () => {
  assert.equal(
    parsePostgresUser("postgresql://app%40user:secret@host:5432/passshare_dev"),
    "app@user",
  );
});

test("parsePostgresHost returns lowercased host:port", () => {
  assert.equal(
    parsePostgresHost("postgresql://u:p@Proxy.RAILWAY.app:54321/db"),
    "proxy.railway.app:54321",
  );
});

test("assertDistinctTarget passes when source and target hosts differ", () => {
  assert.doesNotThrow(() =>
    assertDistinctTarget(
      "postgresql://u:p@prd-host:5432/db",
      "postgresql://u:p@stg-host:5432/db",
      { sourceEnv: "prd", targetEnv: "stg" },
    ),
  );
});

test("assertDistinctTarget throws when target host matches source host", () => {
  assert.throws(
    () =>
      assertDistinctTarget(
        "postgresql://u:p@shared-host:5432/prd",
        "postgresql://u:p@shared-host:5432/stg",
        { sourceEnv: "prd", targetEnv: "stg" },
      ),
    /Refusing to wipe/,
  );
});

test("assertDistinctTarget is port-sensitive (same domain, different proxy port is distinct)", () => {
  assert.doesNotThrow(() =>
    assertDistinctTarget(
      "postgresql://u:p@proxy.railway.app:5001/db",
      "postgresql://u:p@proxy.railway.app:5002/db",
      { sourceEnv: "prd", targetEnv: "stg" },
    ),
  );
});

test("buildPublicSchemaWipeSql drops and recreates public schema with grants", () => {
  const sql = buildPublicSchemaWipeSql("postgres");
  assert.match(sql, /DROP SCHEMA IF EXISTS public CASCADE;/);
  assert.match(sql, /CREATE SCHEMA public;/);
  assert.match(sql, /GRANT ALL ON SCHEMA public TO public;/);
  assert.match(sql, /GRANT ALL ON SCHEMA public TO "postgres";/);
});

test("buildPublicSchemaWipeSql quotes user names with double quotes", () => {
  const sql = buildPublicSchemaWipeSql('app"user');
  assert.match(sql, /GRANT ALL ON SCHEMA public TO "app""user";/);
});
