#!/usr/bin/env node
/**
 * Staging / production smoke checks (Issue #106).
 *
 * Usage:
 *   STG_BACKEND_URL=https://... STG_OP_CONNECT_TOKEN=... node scripts/stg-smoke.mjs
 *
 * Defaults to staging backend URL from infrastructure SSOT.
 */
const BACKEND_URL =
  process.env.STG_BACKEND_URL ??
  "https://pass-share-backend-staging.up.railway.app";
const TOKEN = process.env.STG_OP_CONNECT_TOKEN ?? process.env.OP_CONNECT_TOKEN;

const checks = [];

async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, ok: true });
    console.log(`✓ ${name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    checks.push({ name, ok: false, error: message });
    console.error(`✗ ${name}: ${message}`);
  }
}

async function main() {
  console.log(`Smoke target: ${BACKEND_URL}`);

  await check("GET /health", async () => {
    const res = await fetch(`${BACKEND_URL}/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body.status !== "ok") throw new Error(JSON.stringify(body));
  });

  await check("GET /health/db", async () => {
    const res = await fetch(`${BACKEND_URL}/health/db`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body.status !== "ok") throw new Error(JSON.stringify(body));
  });

  if (TOKEN) {
    await check("GET /v1/vaults (Connect)", async () => {
      const res = await fetch(`${BACKEND_URL}/v1/vaults`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!Array.isArray(body)) throw new Error("Expected array");
    });
  } else {
    console.warn("Skipping Connect API check — set STG_OP_CONNECT_TOKEN or OP_CONNECT_TOKEN");
  }

  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll smoke checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
