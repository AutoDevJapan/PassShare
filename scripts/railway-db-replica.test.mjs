import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

// No provider credentials or live DB are passed to these CLI rejection tests.
function assertCliRejected(file, args, expected, env = {}) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(file, import.meta.url)), ...args], {
    encoding: "utf8",
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    timeout: 10000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, expected);
}

for (const target of ["dev", "stg", "preview"]) {
  test(`hosted replica refresh to ${target} is rejected before authentication`, () => {
    assertCliRejected("railway-db-replica.mjs", ["refresh", "--source", "prd", "--target", target], /Replica refresh is retired/);
  });
  test(`snapshot source ${target} is rejected before authentication`, () => {
    assertCliRejected("railway-db-replica.mjs", ["snapshot", "--source", target], /Snapshot supports --source prd only/);
  });
}

const productionDeployEnv = {
  DEPLOY_TARGET: "prd",
  RAILWAY_PROJECT_ID: "82730a82-b4d4-47d0-b578-f951465465fc",
  RAILWAY_SERVICE_ID: "29539998-d8d9-4e41-82a5-f71ca223f96c",
  RAILWAY_ENVIRONMENT_ID: "c1a3cdfc-9aa3-420d-b101-e6497714ccb9",
  RAILWAY_PRODUCTION_ENV_ID: "c1a3cdfc-9aa3-420d-b101-e6497714ccb9",
  RAILWAY_HEALTH_URL: "https://pass-share-backend-production.up.railway.app/health/db",
};

for (const [key, value] of [
  ["RAILWAY_PROJECT_ID", "another-project"],
  ["RAILWAY_SERVICE_ID", "another-service"],
  ["RAILWAY_ENVIRONMENT_ID", "c807d209-0624-4e13-aff6-61332cd0bb29"],
  ["RAILWAY_PRODUCTION_ENV_ID", "c807d209-0624-4e13-aff6-61332cd0bb29"],
]) {
  test(`manual deploy rejects a wrong ${key} before authentication`, () => {
    assertCliRejected("railway-deploy-preflight.mjs", ["--offline"], /existing PassShare production/, { ...productionDeployEnv, [key]: value });
  });
}

test("production IDs cannot deploy a non-main CI source", () => {
  assertCliRejected("railway-deploy-preflight.mjs", ["--offline"], /requires clean source on main/, {
    ...productionDeployEnv,
    GITHUB_ACTIONS: "true",
    GITHUB_REF: "refs/heads/feature/not-main",
  });
});

test("legacy production DB cannot be used for a snapshot", () => {
  assertCliRejected("railway-db-replica.mjs", ["snapshot", "--source", "prd"], /current PG18 service IDs/, {
    RAILWAY_PROJECT_ID: "82730a82-b4d4-47d0-b578-f951465465fc",
    RAILWAY_PRODUCTION_ENV_ID: "c1a3cdfc-9aa3-420d-b101-e6497714ccb9",
    RAILWAY_POSTGRES_PRD_SERVICE_ID: "1509c487-cf03-4c50-8c9d-8781d53ee19a",
  });
});

for (const args of [["--branch", "main"], ["--branch", "stg"], ["--all-preview-defaults"], ["--sync-remote-branches"], ["--baseline", "--all-preview-defaults"]]) {
  test(`old Vercel sync arguments ${args.join(" ")} are rejected before authentication`, () => {
    assertCliRejected("sync-vercel-env.mjs", args, /synchronization are retired/);
  });
}

for (const target of ["dev", "stg", "preview"]) {
  test(`manual Railway deploy target ${target} is rejected before authentication`, () => {
    assertCliRejected("railway-deploy-preflight.mjs", ["--offline"], /DEPLOY_TARGET=prd/, { DEPLOY_TARGET: target });
  });
}
