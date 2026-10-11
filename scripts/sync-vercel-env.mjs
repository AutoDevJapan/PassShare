#!/usr/bin/env node
/** Sync the existing PassShare production environment only. */
import { execFileSync } from 'node:child_process';

const API_BASE = 'https://api.vercel.com/v10/projects';
const ENV_VALUES = {
  VITE_APP_ENV: 'prd',
  VITE_API_BASE_URL: '/backend/prd',
};

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Usage: node scripts/sync-vercel-env.mjs --baseline\nProduction only, clean main source, explicit VERCEL_PROJECT_ID and VERCEL_ORG_ID required.');
    return;
  }
  if (args.length !== 1 || args[0] !== '--baseline') {
    throw new Error('Only --baseline (production) is supported; branch, Preview and Development synchronization are retired.');
  }
  const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
  if (
    (process.env.GITHUB_ACTIONS === 'true'
      ? process.env.GITHUB_REF !== 'refs/heads/main' || process.env.GITHUB_SHA !== execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
      : branch !== 'main') ||
    execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()
  ) {
    throw new Error('Production synchronization requires clean source on main (CI must match GITHUB_SHA).');
  }
  const token = process.env.VERCEL_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const teamId = process.env.VERCEL_ORG_ID;
  if (projectId !== 'prj_itSKGa2HAEj3UNHnsCdPQEF5nziE' || teamId !== 'team_Hh2mAEEcMesxsuaVTP5DMxui') {
    throw new Error('The existing production VERCEL_PROJECT_ID and explicit VERCEL_ORG_ID are required.');
  }
  if (!token) throw new Error('VERCEL_TOKEN is required');
  const scope = new URLSearchParams({ teamId });
  const projectResponse = await fetch(`https://api.vercel.com/v9/projects/${projectId}?${scope}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!projectResponse.ok) throw new Error(`Production project verification failed: HTTP ${projectResponse.status}`);
  const project = await projectResponse.json();
  if (project.accountId !== teamId || project.link?.org !== 'AutoDevJapan' || project.link?.repo !== 'PassShare' || project.link?.repoId !== 1131498455) {
    throw new Error('Production project owner or GitHub source differs from the reconciled PassShare IDs.');
  }
  const params = new URLSearchParams({ upsert: 'true', teamId });
  for (const [key, value] of Object.entries(ENV_VALUES)) {
    const response = await fetch(`${API_BASE}/${projectId}/env?${params}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value, type: 'encrypted', target: ['production'] }),
    });
    if (!response.ok) throw new Error(`Production env sync failed for ${key}: HTTP ${response.status}`);
    console.log(`OK production ${key}`);
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
