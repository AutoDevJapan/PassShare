#!/usr/bin/env node
/**
 * Refresh target Postgres from source (pg_dump → pg_restore) or snapshot source only.
 * SSOT: documents/spec/infrastructure.md — deploy pipeline DB replica branches.
 *
 * Usage:
 *   node scripts/railway-db-replica.mjs refresh --source prd --target dev|stg
 *   node scripts/railway-db-replica.mjs snapshot --source prd
 *
 * Env: RAILWAY_API_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_SERVICE_ID (backend)
 */

import { spawnSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API_URL = "https://backboard.railway.com/graphql/v2";

const ENV_IDS = {
  prd: process.env.RAILWAY_PRODUCTION_ENV_ID ?? "c1a3cdfc-9aa3-420d-b101-e6497714ccb9",
  stg: process.env.RAILWAY_STAGING_ENV_ID ?? "c807d209-0624-4e13-aff6-61332cd0bb29",
  dev: process.env.RAILWAY_DEVELOPMENT_ENV_ID ?? "0951c467-6bc3-418f-af75-a96e810f4946",
};

const BACKEND_SERVICE_ID =
  process.env.RAILWAY_SERVICE_ID ?? "29539998-d8d9-4e41-82a5-f71ca223f96c";

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

async function getDatabaseUrl(logicalEnv) {
  const environmentId = ENV_IDS[logicalEnv];
  if (!environmentId) {
    throw new Error(`Unknown logical environment: ${logicalEnv}`);
  }

  const query = `
    query Variables($projectId: String!, $environmentId: String!, $serviceId: String!) {
      variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
    }
  `;

  const data = await railwayQuery(query, {
    projectId: process.env.RAILWAY_PROJECT_ID,
    environmentId,
    serviceId: BACKEND_SERVICE_ID,
  });

  const databaseUrl = data?.variables?.DATABASE_URL;
  if (!databaseUrl || typeof databaseUrl !== "string") {
    throw new Error(
      `DATABASE_URL not resolved for ${logicalEnv} (env ${environmentId})`,
    );
  }

  if (databaseUrl.includes("${{")) {
    throw new Error(
      `DATABASE_URL for ${logicalEnv} is unresolved reference: ${databaseUrl}`,
    );
  }

  return databaseUrl;
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

    runCommand("pg_restore", [
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-acl",
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
  console.log(`::set-output name=dump_path::${dumpPath}`);
}

function printHelp() {
  console.log(`Usage:
  node scripts/railway-db-replica.mjs refresh --source prd --target dev|stg
  node scripts/railway-db-replica.mjs snapshot --source prd

Environment:
  RAILWAY_API_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_SERVICE_ID
  RAILWAY_PRODUCTION_ENV_ID, RAILWAY_STAGING_ENV_ID, RAILWAY_DEVELOPMENT_ENV_ID
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

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
