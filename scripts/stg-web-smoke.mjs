#!/usr/bin/env node
/**
 * Staging / preview Web UI smoke (Issue #207).
 *
 * Usage:
 *   STG_WEB_URL=https://pass-share-frontend-....vercel.app node scripts/stg-web-smoke.mjs
 *
 * Optional:
 *   STG_BACKEND_URL — preflight GET /health (defaults to infrastructure stg backend)
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_URL = process.env.STG_WEB_URL ?? process.env.PLAYWRIGHT_BASE_URL;
const BACKEND_URL =
  process.env.STG_BACKEND_URL ??
  "https://pass-share-backend-staging.up.railway.app";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function preflight() {
  console.log(`Backend preflight: ${BACKEND_URL}/health`);
  const res = await fetch(`${BACKEND_URL}/health`);
  if (!res.ok) {
    throw new Error(`Backend health failed: HTTP ${res.status}`);
  }
  const body = await res.json();
  if (body.status !== "ok") {
    throw new Error(`Unexpected health body: ${JSON.stringify(body)}`);
  }
  console.log("✓ Backend health OK");
}

function main() {
  if (!WEB_URL) {
    console.error("STG_WEB_URL (or PLAYWRIGHT_BASE_URL) is required");
    process.exit(1);
  }

  console.log(`Web smoke target: ${WEB_URL}`);

  preflight()
    .then(() => {
      const result = spawnSync(
        "pnpm",
        ["exec", "playwright", "test", "-c", "playwright.staging.config.ts"],
        {
          cwd: root,
          stdio: "inherit",
          shell: process.platform === "win32",
          env: {
            ...process.env,
            CI: "true",
            STG_WEB_URL: WEB_URL,
            PLAYWRIGHT_BASE_URL: WEB_URL,
          },
        },
      );
      process.exit(result.status ?? 1);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}

main();
