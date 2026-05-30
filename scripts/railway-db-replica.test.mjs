import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPublicSchemaWipeSql,
  parsePostgresUser,
} from "./railway-db-replica.mjs";

test("parsePostgresUser decodes credentials from connection URL", () => {
  assert.equal(
    parsePostgresUser("postgresql://app%40user:secret@host:5432/passshare_dev"),
    "app@user",
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
