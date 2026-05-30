#!/usr/bin/env node
/**
 * Apply deterministic dev seed to PostgreSQL (local / preview / dev).
 * Requires DATABASE_URL and APP_ENV in local|dev|preview.
 */
import pg from "pg";

import { AUTH_SCHEMA_SQL } from "../src/db/auth-schema.js";
import { applyDevSeed, isDevSeedEnvironment } from "../src/db/dev-seed.js";
import { SCHEMA_SQL } from "../src/db/schema.js";
import { normalizeDatabaseUrl, Pool } from "../src/store/index.js";

const appEnv = process.env.APP_ENV ?? "local";

if (!isDevSeedEnvironment(appEnv)) {
  console.error(`db:seed skipped — APP_ENV=${appEnv} is not a dev seed environment`);
  process.exit(1);
}

const databaseUrl = normalizeDatabaseUrl(process.env.DATABASE_URL);
if (!databaseUrl) {
  console.error("DATABASE_URL is required for db:seed");
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });

try {
  await pool.query(SCHEMA_SQL);
  await pool.query(AUTH_SCHEMA_SQL);
  await applyDevSeed({ pool });
  console.log(`Dev seed applied (${appEnv})`);
} finally {
  await pool.end();
}
