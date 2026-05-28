#!/usr/bin/env node
/**
 * Performance benchmark runner (Issue #109).
 * Writes bench-results.json for CI artifact upload and regression tracking.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createMemoryStore } from "../../backend/src/store/memory-store.js";
import { createApp } from "../../backend/src/app.js";

const results = {
  timestamp: new Date().toISOString(),
  kdf_ms: null,
  api_health_p95_ms: null,
  thresholds: {
    kdf_ms_max: 5000,
    api_health_p95_ms_max: 50,
  },
  passed: false,
};

function runKdfBench() {
  const output = spawnSync(
    "cargo",
    ["test", "-p", "passshare-core", "kdf_reference_timing", "--", "--nocapture"],
    { encoding: "utf8", shell: process.platform === "win32" },
  );
  if (output.status !== 0) {
    console.error(output.stdout);
    console.error(output.stderr);
    throw new Error("KDF benchmark test failed");
  }
  const match = output.stdout.match(/KDF_MS=(\d+)/);
  if (!match) {
    throw new Error("KDF_MS not found in cargo test output");
  }
  results.kdf_ms = Number.parseInt(match[1], 10);
}

async function runApiBench() {
  process.env.OP_CONNECT_TOKEN = "bench-token";
  const store = createMemoryStore();
  const now = new Date().toISOString();
  store.seedVault({
    id: "abcdefghijklmnopqrstuvwxyz",
    name: "Bench",
    description: "",
    type: "USER_CREATED",
    content_version: 1,
    attribute_version: 1,
    created_at: now,
    updated_at: now,
  });
  const { app } = await createApp({ store, pool: null });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  const samples = [];
  for (let i = 0; i < 100; i += 1) {
    const start = performance.now();
    const res = await fetch(`${baseUrl}/health`);
    if (!res.ok) {
      throw new Error(`Health check failed: ${res.status}`);
    }
    samples.push(performance.now() - start);
  }

  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  delete process.env.OP_CONNECT_TOKEN;

  samples.sort((a, b) => a - b);
  const index = Math.ceil(samples.length * 0.95) - 1;
  results.api_health_p95_ms = Math.round(samples[index] * 100) / 100;
}

function evaluate() {
  const kdfOk = results.kdf_ms <= results.thresholds.kdf_ms_max;
  const apiOk = results.api_health_p95_ms <= results.thresholds.api_health_p95_ms_max;
  results.passed = kdfOk && apiOk;
  if (!kdfOk) {
    console.error(`KDF ${results.kdf_ms}ms exceeds ${results.thresholds.kdf_ms_max}ms`);
  }
  if (!apiOk) {
    console.error(
      `API p95 ${results.api_health_p95_ms}ms exceeds ${results.thresholds.api_health_p95_ms_max}ms`,
    );
  }
}

async function main() {
  runKdfBench();
  await runApiBench();
  evaluate();
  writeFileSync("bench-results.json", `${JSON.stringify(results, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(results, null, 2));
  if (!results.passed) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
