#!/usr/bin/env node
/**
 * Sync PassShare Vercel environment variables via REST API.
 * Uses upsert=true to avoid duplicate keys; supports branch-scoped Preview vars.
 */

const API_BASE = 'https://api.vercel.com/v10/projects';

const ENV_VALUES = {
  production: {
    VITE_APP_ENV: 'prd',
    VITE_API_BASE_URL: 'https://pass-share-backend-production.up.railway.app',
  },
  development: {
    VITE_APP_ENV: 'dev',
    VITE_API_BASE_URL: 'https://pass-share-backend-development.up.railway.app',
  },
  previewDefault: {
    VITE_APP_ENV: 'preview',
    VITE_API_BASE_URL: 'https://pass-share-backend-development.up.railway.app',
  },
  stgBranch: {
    VITE_APP_ENV: 'stg',
    VITE_API_BASE_URL: 'https://pass-share-backend-staging.up.railway.app',
  },
};

function parseArgs(argv) {
  const args = {
    baseline: false,
    allPreviewDefaults: false,
    syncRemoteBranches: false,
    branch: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--baseline') {
      args.baseline = true;
    } else if (arg === '--all-preview-defaults') {
      args.allPreviewDefaults = true;
    } else if (arg === '--sync-remote-branches') {
      args.syncRemoteBranches = true;
    } else if (arg === '--branch') {
      args.branch = argv[i + 1];
      if (!args.branch) {
        throw new Error('--branch requires a branch name');
      }
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/sync-vercel-env.mjs [options]

Options:
  --baseline                 Upsert Production + Development env vars
  --all-preview-defaults     Upsert Preview vars for all branches (gitBranch=null)
  --branch <name>            Upsert Preview vars for a specific branch
  --sync-remote-branches     Upsert Preview vars for all remote Git branches

Environment:
  VERCEL_TOKEN               Required
  VERCEL_PROJECT_ID          Default: prj_itSKGa2HAEj3UNHnsCdPQEF5nziE
  VERCEL_TEAM_SLUG / VERCEL_ORG_ID
`);
}

function getConfig() {
  const token = process.env.VERCEL_TOKEN;
  if (!token) {
    throw new Error('VERCEL_TOKEN is required');
  }

  return {
    token,
    projectId:
      process.env.VERCEL_PROJECT_ID ?? 'prj_itSKGa2HAEj3UNHnsCdPQEF5nziE',
    teamSlug:
      process.env.VERCEL_TEAM_SLUG ??
      process.env.VERCEL_ORG_ID ??
      'masashi-matsumotos-projects-c5830f3d',
  };
}

function previewValuesForBranch(branch) {
  if (branch === 'main') {
    return null;
  }
  if (branch === 'stg') {
    return ENV_VALUES.stgBranch;
  }
  return ENV_VALUES.previewDefault;
}

async function upsertEnv({
  token,
  projectId,
  teamSlug,
  key,
  value,
  target,
  gitBranch,
}) {
  const params = new URLSearchParams({ upsert: 'true', slug: teamSlug });
  const body = {
    key,
    value,
    type: 'encrypted',
    target: [target],
  };

  if (gitBranch !== undefined) {
    body.gitBranch = gitBranch;
  }

  const response = await fetch(`${API_BASE}/${projectId}/env?${params}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Failed to upsert ${key} (${target}${
        gitBranch ? `:${gitBranch}` : gitBranch === null ? ':all-preview' : ''
      }): ${response.status} ${text}`,
    );
  }

  return response.json();
}

async function upsertTargetVars(config, target, values, gitBranch) {
  for (const [key, value] of Object.entries(values)) {
    await upsertEnv({
      ...config,
      key,
      value,
      target,
      gitBranch,
    });
    const scope =
      gitBranch === undefined
        ? target
        : gitBranch === null
          ? `${target} (all branches)`
          : `${target} (${gitBranch})`;
    console.log(`OK ${scope} ${key}`);
  }
}

async function listRemoteBranches() {
  const remoteUrl = process.env.GIT_REMOTE_URL ?? 'origin';
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  const { stdout } = await execFileAsync('git', [
    'ls-remote',
    '--heads',
    remoteUrl,
  ]);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split('\t')[1]?.replace(/^refs\/heads\//, ''))
    .filter(Boolean);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = getConfig();

  if (
    !args.baseline &&
    !args.allPreviewDefaults &&
    !args.branch &&
    !args.syncRemoteBranches
  ) {
    printHelp();
    throw new Error('No action specified');
  }

  if (args.baseline) {
    await upsertTargetVars(config, 'production', ENV_VALUES.production);
    await upsertTargetVars(config, 'development', ENV_VALUES.development);
  }

  if (args.allPreviewDefaults) {
    await upsertTargetVars(
      config,
      'preview',
      ENV_VALUES.previewDefault,
      null,
    );
  }

  if (args.branch) {
    const values = previewValuesForBranch(args.branch);
    if (!values) {
      console.log(`Skip preview env for production branch "${args.branch}"`);
    } else {
      await upsertTargetVars(config, 'preview', values, args.branch);
    }
  }

  if (args.syncRemoteBranches) {
    const branches = await listRemoteBranches();
    for (const branch of branches) {
      const values = previewValuesForBranch(branch);
      if (!values) {
        console.log(`Skip preview env for production branch "${branch}"`);
        continue;
      }
      await upsertTargetVars(config, 'preview', values, branch);
    }
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
