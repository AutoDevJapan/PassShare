#!/usr/bin/env node
/**
 * Snapshot existing production Postgres only. Hosted replica refresh is retired.
 * SSOT: documents/spec/infrastructure.md — deploy pipeline DB replica branches.
 *
 * Usage:
 *   node scripts/railway-db-replica.mjs snapshot --source prd
 *
 * Env: RAILWAY_API_TOKEN, RAILWAY_PROJECT_ID
 *   Railway environment IDs (required — no hardcoded fallback):
 *     RAILWAY_PRODUCTION_ENV_ID
 *   Postgres plugin service IDs (required — no hardcoded fallback):
 *     RAILWAY_POSTGRES_PRD_SERVICE_ID (current PG18 service, not legacy PG16)
 * Connection overrides are retired; use the current service variables.
 *
 * SAFETY: environment/service IDs are resolved from env vars only. Hardcoded
 * UUID fallbacks were removed (#325) — a renamed/unset CI variable must fail
 * loudly rather than silently resolve to a stale ID and wipe the wrong Railway
 * environment (max blast-radius: wiping prd, or wiping dev/stg from the wrong
 * source). Refresh is now rejected before connection; the pure legacy identity
 * and SQL helpers remain available for their existing regression tests.
 */

import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const API_URL = "https://backboard.railway.com/graphql/v2";

/** Env var names for Railway environment IDs — SSOT: documents/spec/infrastructure.md */
const ENV_ID_VARS = {
  prd: "RAILWAY_PRODUCTION_ENV_ID",
};

/** Env var names for Postgres plugin service IDs — SSOT: documents/spec/infrastructure.md */
const POSTGRES_SERVICE_ID_VARS = {
  prd: "RAILWAY_POSTGRES_PRD_SERVICE_ID",
};

const POSTGRES_PORT = 5432;

/**
 * Read a required Railway identifier from the environment.
 * Throws instead of falling back to a hardcoded UUID (#325) so a
 * missing/renamed CI variable can never silently target the wrong environment.
 *
 * @param {string} varName
 * @param {string} description
 */
function requireRailwayId(varName, description) {
  const value = process.env[varName];
  if (!value) {
    throw new Error(
      `${varName} is required (${description}). Refusing to run with a hardcoded ` +
        "fallback that could target the wrong Railway environment (#325).",
    );
  }
  return value;
}

/** @param {string} logicalEnv */
function getEnvironmentId(logicalEnv) {
  const varName = ENV_ID_VARS[logicalEnv];
  if (!varName) {
    throw new Error(`Unknown logical environment: ${logicalEnv}`);
  }
  return requireRailwayId(varName, `Railway environment ID for ${logicalEnv}`);
}

/** @param {string} logicalEnv */
function getPostgresServiceId(logicalEnv) {
  const varName = POSTGRES_SERVICE_ID_VARS[logicalEnv];
  if (!varName) {
    throw new Error(`No postgres service ID mapped for ${logicalEnv}`);
  }
  return requireRailwayId(varName, `Railway Postgres service ID for ${logicalEnv}`);
}

function normalizeTcpHost(domain) {
  return domain.replace(/\.$/, "");
}

function buildPostgresUrl(user, password, database, host, port) {
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

function pickDirectCiDatabaseUrl(variables, logicalEnv) {
  if (process.env.RAILWAY_DATABASE_PUBLIC_URL_PRD) {
    throw new Error("Connection overrides are retired; resolve the current production service variables instead.");
  }

  const publicUrl = variables.DATABASE_PUBLIC_URL;
  if (typeof publicUrl === "string" && publicUrl.length > 0 && !publicUrl.includes("${{")) {
    return publicUrl;
  }

  const proxyDomain = variables.RAILWAY_TCP_PROXY_DOMAIN;
  const proxyPort = variables.RAILWAY_TCP_PROXY_PORT;
  if (proxyDomain && proxyPort) {
    const user = variables.POSTGRES_USER ?? variables.PGUSER;
    const password = variables.POSTGRES_PASSWORD ?? variables.PGPASSWORD;
    const database = variables.POSTGRES_DB ?? variables.PGDATABASE;
    if (user && password && database) {
      return buildPostgresUrl(
        user,
        password,
        database,
        normalizeTcpHost(proxyDomain),
        Number(proxyPort),
      );
    }
  }

  const databaseUrl = variables.DATABASE_URL;
  if (
    typeof databaseUrl === "string" &&
    databaseUrl.length > 0 &&
    !databaseUrl.includes("${{") &&
    !databaseUrl.includes(".railway.internal")
  ) {
    return databaseUrl;
  }

  return null;
}

function buildUrlFromTcpProxy(variables, tcpProxy) {
  const user = variables.POSTGRES_USER ?? variables.PGUSER;
  const password = variables.POSTGRES_PASSWORD ?? variables.PGPASSWORD;
  const database = variables.POSTGRES_DB ?? variables.PGDATABASE;

  if (!user || !password || !database) {
    throw new Error("Postgres credentials missing for TCP proxy URL construction");
  }

  return buildPostgresUrl(
    user,
    password,
    database,
    normalizeTcpHost(tcpProxy.domain),
    tcpProxy.proxyPort,
  );
}

async function listTcpProxies(environmentId, serviceId) {
  const query = `
    query TcpProxies($environmentId: String!, $serviceId: String!) {
      tcpProxies(environmentId: $environmentId, serviceId: $serviceId) {
        id
        domain
        proxyPort
        applicationPort
      }
    }
  `;

  const data = await railwayQuery(query, { environmentId, serviceId });
  return data?.tcpProxies ?? [];
}

async function ensureTcpProxy(environmentId, serviceId, logicalEnv) {
  const existing = await listTcpProxies(environmentId, serviceId);
  const postgresProxy =
    existing.find((proxy) => proxy.applicationPort === POSTGRES_PORT);

  if (postgresProxy) {
    return postgresProxy;
  }

  throw new Error(`No existing TCP proxy on postgres-${logicalEnv}; snapshot does not provision infrastructure.`);
}

async function getServiceVariables(environmentId, serviceId) {
  const query = `
    query Variables($projectId: String!, $environmentId: String!, $serviceId: String!) {
      variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
    }
  `;

  const data = await railwayQuery(query, {
    projectId: process.env.RAILWAY_PROJECT_ID,
    environmentId,
    serviceId,
  });

  return data?.variables ?? {};
}

async function getDatabaseUrl(logicalEnv) {
  const environmentId = getEnvironmentId(logicalEnv);
  const postgresServiceId = getPostgresServiceId(logicalEnv);

  const variables = await getServiceVariables(environmentId, postgresServiceId);
  const directUrl = pickDirectCiDatabaseUrl(variables, logicalEnv);
  if (directUrl) {
    return directUrl;
  }

  const tcpProxy = await ensureTcpProxy(environmentId, postgresServiceId, logicalEnv);
  return buildUrlFromTcpProxy(variables, tcpProxy);
}

function branchLabel() {
  const runId = process.env.GITHUB_RUN_ID ?? "local";
  const sha = (process.env.GITHUB_SHA ?? "manual").slice(0, 7);
  return `replica-${runId}-${sha}`;
}

async function railwayQuery(query, variables = {}) {
  const token = process.env.RAILWAY_API_TOKEN;
  if (!token) {
    throw new Error("RAILWAY_API_TOKEN is required");
  }

  const projectId = process.env.RAILWAY_PROJECT_ID;
  if (!projectId) {
    throw new Error("RAILWAY_PROJECT_ID is required");
  }

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = await response.json();
  if (!response.ok || payload.errors) {
    throw new Error(
      `Railway API error: ${JSON.stringify(payload.errors ?? payload)}`,
    );
  }

  return payload.data;
}

function runCommand(command, args, env = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });

  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${result.status}; connection arguments omitted.`);
  }
}

/** @param {string} connectionUrl */
export function parsePostgresUser(connectionUrl) {
  const url = new URL(connectionUrl);
  return decodeURIComponent(url.username);
}

/**
 * Host:port identity of a Postgres connection URL, used to prove the wipe
 * target is a different database from the source before any destructive DROP.
 *
 * @param {string} connectionUrl
 */
export function parsePostgresHost(connectionUrl) {
  const url = new URL(connectionUrl);
  return url.host.toLowerCase();
}

/**
 * Fail closed if the resolved target database is the same host as the source
 * (or the source is not clearly distinct). Guards the max-blast-radius bug
 * (#325): a stale/renamed env or service ID could resolve `--target dev|stg`
 * to prd's host and then DROP the source (prd) schema.
 *
 * @param {string} sourceUrl
 * @param {string} targetUrl
 * @param {{ sourceEnv: string, targetEnv: string }} labels
 */
export function assertDistinctTarget(sourceUrl, targetUrl, { sourceEnv, targetEnv }) {
  const sourceHost = parsePostgresHost(sourceUrl);
  const targetHost = parsePostgresHost(targetUrl);
  if (!targetHost) {
    throw new Error(`Resolved target host for ${targetEnv} is empty — aborting wipe`);
  }
  if (sourceHost === targetHost) {
    throw new Error(
      `Refusing to wipe: resolved target host for ${targetEnv} (${targetHost}) ` +
        `matches source ${sourceEnv} (${sourceHost}). A DROP here would destroy ` +
        "the source database. Check RAILWAY_*_ENV_ID / RAILWAY_POSTGRES_*_SERVICE_ID (#325).",
    );
  }
}

/**
 * SQL to reset the public schema before pg_restore.
 * pg_restore --clean fails when FK dependencies exist (e.g. vault_invitations).
 *
 * @param {string} dbUser
 */
export function buildPublicSchemaWipeSql(dbUser) {
  const quotedUser = `"${dbUser.replace(/"/g, '""')}"`;
  return [
    "DROP SCHEMA IF EXISTS public CASCADE;",
    "CREATE SCHEMA public;",
    "GRANT ALL ON SCHEMA public TO public;",
    `GRANT ALL ON SCHEMA public TO ${quotedUser};`,
  ].join("\n");
}

async function snapshotSource(sourceEnv) {
  if (
    sourceEnv !== "prd" ||
    process.env.RAILWAY_PROJECT_ID !== "82730a82-b4d4-47d0-b578-f951465465fc" ||
    getEnvironmentId(sourceEnv) !== "c1a3cdfc-9aa3-420d-b101-e6497714ccb9" ||
    getPostgresServiceId(sourceEnv) !== "4fdfda2d-ed50-4396-9797-25ea7720f720"
  ) {
    throw new Error("Snapshot requires the existing production environment and current PG18 service IDs.");
  }
  const label = branchLabel();
  const dumpPath = join(process.env.DB_SNAPSHOT_DIR ?? tmpdir(), `passshare-snapshot-${label}.dump`);
  console.log(`DB snapshot branch: ${label}`);
  console.log(`Snapshotting ${sourceEnv}...`);

  // Capture inside the existing PG18 service. No public DB proxy or connection
  // values are required in the runner. The helper revokes its temporary key.
  runCommand("go", ["-C", "tools/prd-snapshot-go", "run", ".", "--output", dumpPath]);

  console.log(`Snapshot written: ${dumpPath}`);
  console.log(`Snapshot branch label: ${label}`);
}

function printHelp() {
  console.log(`Usage:
  node scripts/railway-db-replica.mjs snapshot --source prd

Environment (all IDs required — no hardcoded fallback, #325):
  RAILWAY_API_TOKEN, RAILWAY_PROJECT_ID
  RAILWAY_PRODUCTION_ENV_ID, RAILWAY_POSTGRES_PRD_SERVICE_ID (current PG18)
  Connection overrides are rejected; existing current service variables are required.
  refresh is retired; snapshots never restore into dev/stg.
`);
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const options = { source: "prd", target: null };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--source") {
      options.source = rest[++i];
    } else if (arg === "--target") {
      options.target = rest[++i];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { mode, options };
}

async function main() {
  const { mode, options } = parseArgs(process.argv.slice(2));

  if (mode === "refresh") {
    throw new Error("Replica refresh is retired; only a prd snapshot is supported.");
  }

  if (mode === "snapshot") {
    if (options.source !== "prd" || options.target !== null) {
      throw new Error("Snapshot supports --source prd only, without --target.");
    }
    await snapshotSource(options.source);
    return;
  }

  printHelp();
  throw new Error(`Unknown mode: ${mode ?? "(none)"}`);
}

const isCliEntry =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isCliEntry) {
  main().catch((error) => {
    console.error(error.message ?? error);
    process.exit(1);
  });
}
