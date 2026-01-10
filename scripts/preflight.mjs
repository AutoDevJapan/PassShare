import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import net from "node:net";

// --- Argument parsing ---
const args = process.argv.slice(2);
const skipExternalTools = args.includes("--skip-external-tools");
const skipQualityGate = args.includes("--skip-quality-gate");
const skipInstall = args.includes("--skip-install");
const runIntegration = args.includes("--run-integration") || process.env.RUN_INTEGRATION === "1";
const noLog = args.includes("--no-log");
const autoStartDocker = args.includes("--auto-start-docker") || process.env.AUTO_START_DOCKER === "1";

// Parse --cleanup option (default: down-volumes)
let cleanup = "down-volumes";
const cleanupIdx = args.findIndex((a) => a === "--cleanup");
if (cleanupIdx !== -1 && args[cleanupIdx + 1]) {
  const val = args[cleanupIdx + 1];
  if (["none", "down", "down-volumes"].includes(val)) {
    cleanup = val;
  } else {
    console.error(`[ERROR] Invalid --cleanup value: ${val}. Use none|down|down-volumes`);
    process.exit(1);
  }
}

const ROOT = process.cwd();
const BACKEND_DIR = path.join(ROOT, "backend");
const LOG_DIR = path.join(ROOT, "logs");

// --- Logging ---
const timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15).replace(/(\d{8})(\d{6})/, "$1-$2");
const logFile = path.join(LOG_DIR, `preflight-${timestamp}.log`);
let logEnabled = !noLog;

function log(msg) {
  const line = `${msg}\n`;
  process.stdout.write(line);
  if (logEnabled) {
    appendFileSync(logFile, line);
  }
}

function initLog() {
  if (noLog) {
    console.log("Logging is disabled (--no-log).");
    return;
  }
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(logFile, `Preflight started: ${new Date().toISOString()}\n`);
  console.log(`Preflight log: ${logFile}`);
}

// --- Helpers ---
function fail(msg) {
  log(`[ERROR] ${msg}`);
  process.exit(1);
}

function step(title) {
  log("");
  log(`== ${title} ==`);
}

/**
 * @param {string} cmd
 * @param {string[]} cmdArgs
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<void>}
 */
function run(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, cmdArgs, {
      stdio: logEnabled ? ["inherit", "pipe", "pipe"] : "inherit",
      shell: true,
      ...opts
    });

    if (logEnabled && p.stdout) {
      p.stdout.on("data", (data) => {
        process.stdout.write(data);
        appendFileSync(logFile, data);
      });
    }
    if (logEnabled && p.stderr) {
      p.stderr.on("data", (data) => {
        process.stderr.write(data);
        appendFileSync(logFile, data);
      });
    }

    p.on("error", reject);
    p.on("exit", (code) => {
      if (code === 0) resolve();
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
    execSync(`${checkCmd} ${name}`, { stdio: "ignore" });
  } catch {
    fail(`Required command not found: ${name}`);
  }
}

/**
 * @param {string} name
 * @returns {string}
 */
function getVersion(name) {
  try {
    return execSync(`${name} --version`, { encoding: "utf8" }).trim().split("\n")[0];
  } catch {
    return "(unknown)";
  }
}

function isDockerDaemonReady() {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function findDockerDesktopExe() {
  const envPath = process.env.DOCKER_DESKTOP_EXE;
  if (envPath && existsSync(envPath)) return envPath;

  const candidates = [
    "C:\\\\Program Files\\\\Docker\\\\Docker\\\\Docker Desktop.exe",
    "C:\\\\Program Files (x86)\\\\Docker\\\\Docker\\\\Docker Desktop.exe"
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

async function ensureDockerDaemonReady() {
  if (isDockerDaemonReady()) return;

  const isWindows = process.platform === "win32";
  if (!isWindows || !autoStartDocker) {
    fail(
      "Docker デーモンが起動していません。Docker Desktop を起動してから再実行してください。"
        + "（Windowsなら opt-in で自動起動も可能: `pnpm preflight --auto-start-docker` または `AUTO_START_DOCKER=1 pnpm preflight`）"
    );
  }

  const exePath = findDockerDesktopExe();
  if (!exePath) {
    fail(
      "Docker デーモンが起動しておらず、Docker Desktop.exe の場所も特定できませんでした。"
        + " Docker Desktop を起動するか、環境変数 `DOCKER_DESKTOP_EXE` に exe のフルパスを設定してください。"
    );
  }

  step("Auto-start Docker Desktop (opt-in)");
  await run("powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `Start-Process -FilePath "${exePath}"`
  ]);

  step("Wait for Docker daemon");
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (isDockerDaemonReady()) {
      log("Docker daemon is ready.");
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  fail("Timed out waiting for Docker daemon to become ready (180s).");
}

/**
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(500);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, "127.0.0.1");
  });
}

/**
 * @returns {boolean}
 */
function isComposeRunning() {
  try {
    const names = execSync("docker ps --format {{.Names}}", { encoding: "utf8" });
    return names.includes("backend-mysql") || names.includes("backend-api");
  } catch {
    return false;
  }
}

/**
 * @param {string} containerName
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
async function waitDockerHealth(containerName, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = execSync(`docker inspect -f "{{.State.Health.Status}}" ${containerName}`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"]
      }).trim();
      if (status === "healthy") {
        log(`Container is healthy: ${containerName}`);
        return;
      }
      if (status === "unhealthy") {
        throw new Error(`Container became unhealthy: ${containerName}`);
      }
    } catch (e) {
      if (e.message?.includes("unhealthy")) throw e;
      // Container might not exist yet; keep waiting.
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`Timed out waiting for container health: ${containerName}`);
}

/**
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
async function waitHttpOk(url, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        log(`HTTP is ready: ${url} (status=${res.status})`);
        return;
      }
      lastError = `status=${res.status}`;
    } catch (e) {
      lastError = e.message || String(e);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`Timed out waiting for HTTP ready: ${url}. last_error=${lastError}`);
}

function showDockerComposeDebug() {
  log("");
  log("== Integration debug: docker compose ps / logs (mysql, api) ==");
  try {
    execSync("docker compose ps", { stdio: "inherit" });
  } catch {}
  try {
    execSync("docker compose logs --no-color --tail 200 mysql api", { stdio: "inherit" });
  } catch {}
}

async function composeCleanup() {
  if (cleanup === "none") {
    log("CLEANUP=none; keeping containers running.");
    return;
  }
  step(`Integration (opt-in): cleanup (docker compose ${cleanup === "down-volumes" ? "down -v" : "down"})`);
  const downArgs = cleanup === "down-volumes" ? ["compose", "down", "-v"] : ["compose", "down"];
  await run("docker", downArgs, { cwd: ROOT });
}

// --- Prechecks ---
if (!existsSync(path.join(ROOT, "docker-compose.yml"))) {
  fail("プロジェクトルートで実行してください（docker-compose.yml が見つかりません）");
}

// --- Main ---
initLog();

try {
  // 1. Check required commands
  step("Check required commands");
  for (const cmd of ["git", "python", "pnpm", "uv", "docker"]) {
    await requireCommand(cmd);
  }
  log("All required commands found.");

  // 2. Show versions
  step("Show versions");
  for (const cmd of ["git", "python", "pnpm", "uv", "docker"]) {
    log(`${cmd}: ${getVersion(cmd)}`);
  }

  // 2.5 Ensure docker daemon is available (mainly for integration / docker compose)
  await ensureDockerDaemonReady();

  // 3. Initialize git submodules
  step("Initialize git submodules (if any)");
  await run("git", ["submodule", "update", "--init", "--recursive"]);

  // 4. Quality gate
  if (!skipQualityGate) {
    step("Run quality gate");
    const qgArgs = ["scripts/quality-gate.mjs"];
    if (skipInstall) qgArgs.push("--skip-install");
    await run("node", qgArgs);
  } else {
    log("");
    log("--skip-quality-gate: skipping quality gate.");
  }

  // 5. External tools
  if (!skipExternalTools) {
    step("Run external tools commands");
    await run("python", ["scripts/run_external_tools.py"]);
  } else {
    log("");
    log("--skip-external-tools: skipping external tools.");
  }

  // 6. Integration (opt-in)
  if (runIntegration) {
    let integrationError = null;

    try {
      // 6a. Show DB target info
      step("Integration (opt-in): show DB target (host-side alembic)");
      const dbHost = process.env.DB_HOST || "localhost";
      const dbPort = process.env.DB_PORT || "3306";
      const dbUser = process.env.DB_USER || "rpa_user";
      const dbName = process.env.DB_NAME || "rpa_backend";
      const dbCharset = process.env.DB_CHARSET || "utf8mb4";
      log("Integration DB target (alembic / host-side):");
      log(`  DB_HOST=${dbHost}`);
      log(`  DB_PORT=${dbPort}`);
      log(`  DB_USER=${dbUser}`);
      log(`  DB_NAME=${dbName}`);
      log(`  DB_CHARSET=${dbCharset}`);

      // 6b. Pre-check port conflicts
      step("Integration (opt-in): pre-check port conflicts (3306/8000)");
      if (!isComposeRunning()) {
        for (const port of [3306, 8000]) {
          if (await isPortOpen(port)) {
            fail(`Port ${port} is already in use on localhost. Stop the service using it, or stop existing containers, then retry.`);
          }
        }
        log("Ports 3306/8000 look available.");
      } else {
        log("Compose containers seem to be running; skipping port conflict checks.");
      }

      // 6c. Docker compose up
      step("Integration (opt-in): docker compose up (mysql/api)");
      await run("docker", ["compose", "up", "-d"], { cwd: ROOT });
      await waitDockerHealth("backend-mysql", 180_000);
      await waitDockerHealth("backend-api", 180_000);
      await waitHttpOk("http://localhost:8000/health", 180_000);

      // 6d. Alembic upgrade
      step("Integration (opt-in): alembic upgrade head (backend)");
      await run("uv", ["run", "alembic", "upgrade", "head"], { cwd: BACKEND_DIR });

      // 6e. Pytest integration
      step("Integration (opt-in): pytest -m integration (backend)");
      await run("uv", ["run", "pytest", "-m", "integration", "-q"], {
        cwd: BACKEND_DIR,
        env: { ...process.env, RUN_INTEGRATION: "1" }
      });
    } catch (e) {
      integrationError = e;
      showDockerComposeDebug();
    } finally {
      await composeCleanup();
    }

    if (integrationError) {
      throw integrationError;
    }
  } else {
    log("");
    log("--run-integration not set; skipping integration (docker compose + migration + tests).");
    log("To run: pnpm preflight --run-integration");
    log("Cleanup options: --cleanup none | down | down-volumes");
  }

  log("");
  log("Preflight finished.");
  if (logEnabled) {
    log(`Preflight log saved: ${logFile}`);
  }
} catch (e) {
  log(`[FATAL] ${e.message || e}`);
  process.exit(1);
}

