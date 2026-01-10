import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const args = new Set(process.argv.slice(2));
const skipInstall = args.has("--skip-install");

const ROOT = process.cwd();
const FRONTEND_DIR = path.join(ROOT, "electron");
const BACKEND_DIR = path.join(ROOT, "backend");
const AGENT_DIR = path.join(ROOT, "runner");

/**
 * @param {string} msg
 */
function fail(msg) {
  console.error(`[ERROR] ${msg}`);
  process.exit(1);
}

/**
 * @param {string} title
 */
function step(title) {
  console.log("");
  console.log(`== ${title} ==`);
}

/**
 * @param {string} cmd
 * @param {string[]} cmdArgs
 * @param {{ cwd?: string, allowedExitCodes?: number[] }} [opts]
 * @returns {Promise<void>}
 */
function run(cmd, cmdArgs, opts = {}) {
  const { allowedExitCodes = [0], ...spawnOpts } = opts;
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, cmdArgs, { stdio: "inherit", shell: true, ...spawnOpts });
    p.on("error", reject);
    p.on("exit", (code) => {
      if (allowedExitCodes.includes(code)) resolve();
      else reject(new Error(`${cmd} ${cmdArgs.join(" ")} exited with ${code}`));
    });
  });
}

/**
 * @param {string} name
 */
async function requireCommand(name) {
  const isWindows = process.platform === "win32";
  const checkCmd = isWindows ? "where" : "which";
  try {
    await run(checkCmd, [name], { stdio: "ignore" });
  } catch {
    fail(`Required command not found: ${name}`);
  }
}

// --- prechecks ---
if (!existsSync(path.join(ROOT, "docker-compose.yml"))) {
  fail("プロジェクトルートで実行してください（docker-compose.yml が見つかりません）");
}

if (!existsSync(path.join(FRONTEND_DIR, "package.json"))) {
  fail(`Frontend directory not found: ${FRONTEND_DIR}`);
}

if (!existsSync(path.join(BACKEND_DIR, "pyproject.toml"))) {
  fail(`Backend directory not found: ${BACKEND_DIR}`);
}

if (!existsSync(path.join(AGENT_DIR, "pyproject.toml"))) {
  fail(`Agent directory not found: ${AGENT_DIR}`);
}

// --- check required commands ---
step("Check required commands");
await requireCommand("pnpm");
await requireCommand("python");
await requireCommand("uv");
console.log("All required commands found.");

// --- SSOT validation ---
const ssotValidator = path.join(ROOT, "scripts", "ssot", "validate_ssot.py");
step("SSOT: validate (documents/spec)");
if (existsSync(ssotValidator)) {
  await run("python", [ssotValidator]);
} else {
  console.warn("WARNING: SSOT validator not found: scripts/ssot/validate_ssot.py (skipped)");
}

// --- Frontend ---
if (!skipInstall) {
  step("Frontend: install (pnpm)");
  await run("pnpm", ["-C", FRONTEND_DIR, "install", "--frozen-lockfile"]);
} else {
  console.log("");
  console.log("--skip-install: skipping pnpm install.");
}

step("Frontend: format check");
await run("pnpm", ["-C", FRONTEND_DIR, "format:check"]);

step("Frontend: lint");
await run("pnpm", ["-C", FRONTEND_DIR, "lint"]);

step("Frontend: typecheck");
await run("pnpm", ["-C", FRONTEND_DIR, "check-types"]);

step("Frontend: build");
await run("pnpm", ["-C", FRONTEND_DIR, "build"]);

// --- Backend ---
if (!skipInstall) {
  step("Backend: install (uv)");
  await run("uv", ["sync", "--all-groups"], { cwd: BACKEND_DIR });
} else {
  console.log("");
  console.log("--skip-install: skipping uv sync (backend).");
}

step("Backend: ruff check");
await run("uv", ["run", "ruff", "check", "."], { cwd: BACKEND_DIR });

step("Backend: pytest (API smoke)");
// TODO: テスト追加後は allowedExitCodes: [0, 5] を削除し、allowedExitCodes: [0] のみにすること
// exit code 5 = no tests collected（テスト未整備の暫定措置）
await run("uv", ["run", "pytest", "-q"], { cwd: BACKEND_DIR, allowedExitCodes: [0, 5] });

// --- Agent ---
if (!skipInstall) {
  step("Agent: install (uv)");
  await run("uv", ["sync", "--all-groups"], { cwd: AGENT_DIR });
} else {
  console.log("");
  console.log("--skip-install: skipping uv sync (agent).");
}

step("Agent: ruff check");
await run("uv", ["run", "ruff", "check", "."], { cwd: AGENT_DIR });

console.log("");
console.log("Quality gate finished.");

