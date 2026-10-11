#!/usr/bin/env node
/**
 * Validate Railway deploy targets before `railway up` (Issue #208).
 *
 * Required env: RAILWAY_API_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_SERVICE_ID, RAILWAY_ENVIRONMENT_ID
 */
import { execFileSync } from "node:child_process";

const API_URL = "https://backboard.railway.com/graphql/v2";

const token =
  process.env.RAILWAY_TOKEN ??
  process.env.RAILWAY_PROJECT_TOKEN ??
  process.env.RAILWAY_API_TOKEN;
const projectId = process.env.RAILWAY_PROJECT_ID;
const serviceId = process.env.RAILWAY_SERVICE_ID;
const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;

function requireEnv(name, value) {
  if (!value) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
}

// These are allowlisted existing production resources, not default IDs.
// Changing them requires reconciliation with the infrastructure SSOT.
requireEnv("DEPLOY_TARGET=prd", process.env.DEPLOY_TARGET === "prd");
requireEnv("RAILWAY_PROJECT_ID", projectId);
requireEnv("RAILWAY_SERVICE_ID", serviceId);
requireEnv("RAILWAY_ENVIRONMENT_ID", environmentId);
requireEnv("RAILWAY_PRODUCTION_ENV_ID", process.env.RAILWAY_PRODUCTION_ENV_ID);
if (
  projectId !== "82730a82-b4d4-47d0-b578-f951465465fc" ||
  serviceId !== "29539998-d8d9-4e41-82a5-f71ca223f96c" ||
  environmentId !== "c1a3cdfc-9aa3-420d-b101-e6497714ccb9" ||
  environmentId !== process.env.RAILWAY_PRODUCTION_ENV_ID
) {
  console.error("Only the existing PassShare production project/service/environment IDs are allowed.");
  process.exit(1);
}
const branch = execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
if (
  (process.env.GITHUB_ACTIONS === "true"
    ? process.env.GITHUB_REF !== "refs/heads/main" || process.env.GITHUB_SHA !== execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
    : branch !== "main") ||
  execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()
) {
  console.error("Production deploy requires clean source on main (CI must match GITHUB_SHA).");
  process.exit(1);
}
if (process.env.RAILWAY_HEALTH_URL !== "https://pass-share-backend-production.up.railway.app/health/db") {
  console.error("RAILWAY_HEALTH_URL must be the existing production /health/db URL.");
  process.exit(1);
}
if (process.argv.includes("--offline")) {
  console.log("Production target and main source guard OK (no provider access).");
  process.exit(0);
}
requireEnv("RAILWAY_TOKEN (or RAILWAY_API_TOKEN)", token);

/** @param {string} query @param {Record<string, unknown>} [variables] */
async function railwayQuery(query, variables = {}) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Railway API HTTP ${res.status}`);
  }
  const body = await res.json();
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join("; "));
  }
  return body.data;
}

async function main() {
  const query = `
    query DeployPreflight($projectId: String!) {
      project(id: $projectId) {
        id
        name
        services {
          edges {
            node {
              id
              name
            }
          }
        }
        environments {
          edges {
            node {
              id
              name
            }
          }
        }
      }
    }
  `;

  const data = await railwayQuery(query, { projectId });
  const project = data?.project;
  if (!project) {
    console.error(`Project not found: ${projectId}`);
    process.exit(1);
  }

  const services = project.services?.edges?.map((e) => e.node) ?? [];
  const service = services.find((s) => s.id === serviceId);
  if (!service) {
    console.error(
      `RAILWAY_SERVICE_ID ${serviceId} is not in project "${project.name}" (${projectId}).`,
    );
    console.error("Known services:", services.map((s) => `${s.name}=${s.id}`).join(", ") || "(none)");
    process.exit(1);
  }

  const environments = project.environments?.edges?.map((e) => e.node) ?? [];
  const environment = environments.find((e) => e.id === environmentId);
  if (!environment) {
    console.error(
      `RAILWAY_ENVIRONMENT_ID ${environmentId} is not in project "${project.name}".`,
    );
    console.error(
      "Known environments:",
      environments.map((e) => `${e.name}=${e.id}`).join(", ") || "(none)",
    );
    process.exit(1);
  }

  console.log(
    `Railway preflight OK: service="${service.name}" environment="${environment.name}"`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
