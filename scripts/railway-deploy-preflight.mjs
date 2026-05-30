#!/usr/bin/env node
/**
 * Validate Railway deploy targets before `railway up` (Issue #208).
 *
 * Required env: RAILWAY_API_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_SERVICE_ID, RAILWAY_ENVIRONMENT_ID
 */
const API_URL = "https://backboard.railway.com/graphql/v2";

const token = process.env.RAILWAY_API_TOKEN ?? process.env.RAILWAY_TOKEN;
const projectId = process.env.RAILWAY_PROJECT_ID;
const serviceId = process.env.RAILWAY_SERVICE_ID;
const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;

function requireEnv(name, value) {
  if (!value) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
}

requireEnv("RAILWAY_API_TOKEN", token);
requireEnv("RAILWAY_PROJECT_ID", projectId);
requireEnv("RAILWAY_SERVICE_ID", serviceId);
requireEnv("RAILWAY_ENVIRONMENT_ID", environmentId);

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
