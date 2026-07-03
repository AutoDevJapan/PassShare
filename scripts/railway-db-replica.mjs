#!/usr/bin/env node
/**
 * Refresh target Postgres from source (pg_dump → pg_restore) or snapshot source only.
 * SSOT: documents/spec/infrastructure.md — deploy pipeline DB replica branches.
 *
 * Usage:
 *   node scripts/railway-db-replica.mjs refresh --source prd --target dev|stg
 *   node scripts/railway-db-replica.mjs snapshot --source prd
 *
 * Env: RAILWAY_API_TOKEN, RAILWAY_PROJECT_ID
 * Optional: RAILWAY_DATABASE_PUBLIC_URL_PRD|DEV|STG (CI override)
 */

import { spawnSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const API_URL = "https://backboard.railway.com/graphql/v2";

const ENV_IDS = {
  prd: process.env.RAILWAY_PRODUCTION_ENV_ID ?? "c1a3cdfc-9aa3-420d-b101-e6497714ccb9",
  stg: process.env.RAILWAY_STAGING_ENV_ID ?? "c807d209-0624-4e13-aff6-61332cd0bb29",
  dev: process.env.RAILWAY_DEVELOPMENT_ENV_ID ?? "0951c467-6bc3-418f-af75-a96e810f4946",
};

/** Postgres plugin service IDs — SSOT: documents/spec/infrastructure.md */
const POSTGRES_SERVICE_IDS = {
  prd: process.env.RAILWAY_POSTGRES_PRD_SERVICE_ID ?? "1509c487-cf03-4c50-8c9d-8781d53ee19a",
  stg: process.env.RAILWAY_POSTGRES_STG_SERVICE_ID ?? "7234bbc3-c482-4009-9c88-03063521ffd1",
  dev: process.env.RAILWAY_POSTGRES_DEV_SERVICE_ID ?? "43bc8dc5-c9c9-4fa3-9b7e-fd9079fd5c0a",
};

const POSTGRES_PORT = 5432;

function normalizeTcpHost(domain) {
  return domain.replace(/\.$/, "");
}

function buildPostgresUrl(user, password, database, host, port) {
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

function pickDirectCiDatabaseUrl(variables, logicalEnv) {
  const overrideKey = `RAILWAY_DATABASE_PUBLIC_URL_${logicalEnv.toUpperCase()}`;
  const override = process.env[overrideKey];
  if (override) {
    return override;
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

async function createTcpProxy(environmentId, serviceId, applicationPort) {
  const mutation = `
    mutation TcpProxyCreate($input: TCPProxyCreateInput!) {
      tcpProxyCreate(input: $input) {
        id
        domain
        proxyPort
        applicationPort
      }
    }
  `;

  const data = await railwayQuery(mutation, {
    input: { applicationPort, environmentId, serviceId },
  });

  return data?.tcpProxyCreate;
}

async function ensureTcpProxy(environmentId, serviceId, logicalEnv) {
  const existing = await listTcpProxies(environmentId, serviceId);
  const postgresProxy =
    existing.find((proxy) => proxy.applicationPort === POSTGRES_PORT) ?? existing[0];

  if (postgresProxy) {
    return postgresProxy;
  }

  console.log(
    `No TCP proxy on postgres-${logicalEnv}; creating proxy for port ${POSTGRES_PORT}...`,
  );
  return createTcpProxy(environmentId, serviceId, POSTGRES_PORT);
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
  const environmentId = ENV_IDS[logicalEnv];
  if (!environmentId) {
    throw new Error(`Unknown logical environment: ${logicalEnv}`);
  }

  const postgresServiceId = POSTGRES_SERVICE_IDS[logicalEnv];
  if (!postgresServiceId) {
    throw new Error(`No postgres service ID mapped for ${logicalEnv}`);
  }

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
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}`);
  }
}

/** @param {string} connectionUrl */
export function parsePostgresUser(connectionUrl) {
  const url = new URL(connectionUrl);
  return decodeURIComponent(url.username);
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

/** @param {string} targetUrl */
function wipeTargetDatabase(targetUrl) {
  const dbUser = parsePostgresUser(targetUrl);
  const wipeSql = buildPublicSchemaWipeSql(dbUser);

  console.log(`Wiping public schema on target before restore (user: ${dbUser})...`);
  runCommand("psql", [targetUrl, "-v", "ON_ERROR_STOP=1", "-c", wipeSql]);
}

async function refreshTargetFromSource(sourceEnv, targetEnv) {
  const label = branchLabel();
  console.log(`DB replica branch: ${label}`);
  console.log(`Refreshing ${targetEnv} from ${sourceEnv}...`);

  const sourceUrl = await getDatabaseUrl(sourceEnv);
  const targetUrl = await getDatabaseUrl(targetEnv);
  const dumpPath = join(tmpdir(), `passshare-${label}.dump`);

  try {
    runCommand("pg_dump", [
      "--format=custom",
      "--no-owner",
      "--no-acl",
      "--file",
      dumpPath,
      sourceUrl,
    ]);

    wipeTargetDatabase(targetUrl);

    runCommand("pg_restore", [
      "--exit-on-error",
      "--no-owner",
      "--no-acl",
      "--single-transaction",
      "--dbname",
      targetUrl,
      dumpPath,
    ]);

    console.log(`Replica refresh complete: ${sourceEnv} → ${targetEnv} (${label})`);
  } finally {
    try {
      unlinkSync(dumpPath);
    } catch {
      // ignore cleanup errors
    }
  }
}

async function snapshotSource(sourceEnv) {
  const label = branchLabel();
  const dumpPath = join(process.cwd(), `passshare-snapshot-${label}.dump`);
  console.log(`DB snapshot branch: ${label}`);
  console.log(`Snapshotting ${sourceEnv}...`);

  const sourceUrl = await getDatabaseUrl(sourceEnv);

  runCommand("pg_dump", [
    "--format=custom",
    "--no-owner",
    "--no-acl",
    "--file",
    dumpPath,
    sourceUrl,
  ]);

  console.log(`Snapshot written: ${dumpPath}`);
  console.log(`Snapshot branch label: ${label}`);
}

function printHelp() {
  console.log(`Usage:
  node scripts/railway-db-replica.mjs refresh --source prd --target dev|stg
  node scripts/railway-db-replica.mjs snapshot --source prd

Environment:
  RAILWAY_API_TOKEN, RAILWAY_PROJECT_ID
  RAILWAY_PRODUCTION_ENV_ID, RAILWAY_STAGING_ENV_ID, RAILWAY_DEVELOPMENT_ENV_ID
  RAILWAY_DATABASE_PUBLIC_URL_PRD|DEV|STG (optional CI override)
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
    if (!options.target) {
      throw new Error("refresh requires --target dev|stg");
    }
    if (!["dev", "stg"].includes(options.target)) {
      throw new Error("--target must be dev or stg");
    }
    if (options.source !== "prd") {
      throw new Error("refresh currently supports --source prd only");
    }
    await refreshTargetFromSource(options.source, options.target);
    return;
  }

  if (mode === "snapshot") {
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
