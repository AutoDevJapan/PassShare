#!/usr/bin/env node
/**
 * Local Web E2E orchestration (Issue #206).
 *
 * Installs workspace deps, builds connect-js, and runs Playwright auth-crud E2E.
 * Backend + frontend dev servers are started by playwright.config.ts webServer.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @param {string} cmd @param {string[]} args @param {string} [cwd] */
function run(cmd, args, cwd = root) {
  console.log(`\n> ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, CI: "true" },
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function main() {
  run("cargo", ["build", "--manifest-path", "backend/native/Cargo.toml", "--release", "--locked", "--bin", "passshare-mutations"]);
  process.env.PASSSHARE_MUTATIONS_BIN = join(root, "backend", "native", "target", "release",
    process.platform === "win32" ? "passshare-mutations.exe" : "passshare-mutations");
  run("pnpm", ["install", "--frozen-lockfile"]);
  run("pnpm", ["--dir", "backend", "install", "--frozen-lockfile"]);
  run("pnpm", ["--dir", "packages/connect-js", "install", "--frozen-lockfile"]);
  run("pnpm", ["--dir", "packages/connect-js", "run", "build"]);
  run("pnpm", ["--dir", "frontend", "install", "--frozen-lockfile"]);

  const chromiumMarker = join(
    root,
    "node_modules",
    "playwright-core",
    ".local-browsers",
  );
  if (!existsSync(chromiumMarker)) {
    run("pnpm", ["exec", "playwright", "install", "chromium", "--with-deps"]);
  }

  run("pnpm", ["exec", "playwright", "test", "--project=chromium"]);
  console.log("\nLocal Web E2E passed.");
}

main();
