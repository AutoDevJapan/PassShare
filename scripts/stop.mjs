import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const args = new Set(process.argv.slice(2));
const backendOnly = args.has("--backend-only");
const frontendOnly = args.has("--frontend-only");
const removeVolumes = args.has("--volumes");

const stopBackend = !frontendOnly;
const stopFrontend = !backendOnly;

const ROOT = process.cwd();
const RUN_DIR = path.join(ROOT, ".run");
const FRONTEND_PID_FILE = path.join(RUN_DIR, "frontend.pid");

function run(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, cmdArgs, { stdio: "inherit", shell: false, ...opts });
    p.on("exit", () => resolve());
    p.on("error", () => resolve());
  });
}

async function killTree(pid) {
  if (!pid || Number.isNaN(pid)) return;

  if (process.platform === "win32") {
    await run("cmd", ["/c", `taskkill /PID ${pid} /T /F`], { stdio: "ignore" });
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {}
}

function readPidFile() {
  if (!existsSync(FRONTEND_PID_FILE)) return null;
  try {
    const s = readFileSync(FRONTEND_PID_FILE, "utf8").trim();
    const pid = Number(s);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function cleanupPidFile() {
  try {
    rmSync(FRONTEND_PID_FILE, { force: true });
  } catch {}
}

if (!existsSync(path.join(ROOT, "docker-compose.yml"))) {
  console.error("[ERROR] プロジェクトルートで実行してください（docker-compose.yml が見つかりません）");
  process.exit(1);
}

if (stopFrontend) {
  const pid = readPidFile();
  if (!pid) {
    console.log("[INFO] Frontend PID file not found; skip frontend stop.");
  } else {
    console.log(`[INFO] Stopping frontend (PID=${pid})...`);
    await killTree(pid);
    cleanupPidFile();
    console.log("[OK] Frontend stop requested.");
  }
}

if (stopBackend) {
  console.log("[INFO] Stopping docker compose...");
  await run("docker", ["compose", "down", ...(removeVolumes ? ["-v"] : [])], { cwd: ROOT });
  console.log("[OK] Docker compose down requested.");
}


