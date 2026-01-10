import { spawn } from "node:child_process";
import { mkdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";

const args = new Set(process.argv.slice(2));
const backendOnly = args.has("--backend-only");
const frontendOnly = args.has("--frontend-only");

const startBackend = !frontendOnly;
const startFrontend = !backendOnly;

const ROOT = process.cwd();
const RUN_DIR = path.join(ROOT, ".run");
const FRONTEND_PID_FILE = path.join(RUN_DIR, "frontend.pid");
const FRONTEND_DIR = path.join(ROOT, "electron");

function fail(msg) {
  console.error(`[ERROR] ${msg}`);
  process.exit(1);
}

function run(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, cmdArgs, { stdio: "inherit", shell: false, ...opts });
    p.on("error", reject);
    p.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with ${code}`));
    });
  });
}

async function waitForHealth(url, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function killTree(pid) {
  if (!pid || Number.isNaN(pid)) return;

  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const p = spawn("cmd", ["/c", `taskkill /PID ${pid} /T /F`], { stdio: "ignore", shell: false });
      p.on("exit", () => resolve());
      p.on("error", () => resolve());
    });
    return;
  }

  // On POSIX, kill process group (requires child to be spawned with detached: true)
  try {
    process.kill(-pid, "SIGTERM");
  } catch {}
}

function cleanupPidFile() {
  try {
    rmSync(FRONTEND_PID_FILE, { force: true });
  } catch {}
}

// --- prechecks ---
if (!existsSync(path.join(ROOT, "docker-compose.yml"))) {
  fail("プロジェクトルートで実行してください（docker-compose.yml が見つかりません）");
}

if (!existsSync(path.join(ROOT, ".env"))) {
  fail(
    ".env が見つかりません。ルート直下の env.example をコピーして .env を作成し、管理者から共有された API キー（OPENAI_API_KEY / ANTHROPIC_API_KEY）を両方設定してください。"
  );
}

mkdirSync(RUN_DIR, { recursive: true });

let frontendProc = null;

process.on("SIGINT", async () => {
  if (frontendProc?.pid) await killTree(frontendProc.pid);
  cleanupPidFile();
  process.exit(130);
});
process.on("SIGTERM", async () => {
  if (frontendProc?.pid) await killTree(frontendProc.pid);
  cleanupPidFile();
  process.exit(143);
});

// --- start backend ---
if (startBackend) {
  console.log("[INFO] Starting backend (mysql, api) via docker compose...");
  await run("docker", ["compose", "up", "-d", "mysql", "api"], { cwd: ROOT });

  console.log("[INFO] Waiting for backend health (http://localhost:8000/health)...");
  const ok = await waitForHealth("http://localhost:8000/health", 30_000);
  if (!ok) {
    console.warn("[WARN] Backend health check timed out. Check logs: docker compose logs api");
  } else {
    console.log("[OK] Backend is healthy.");
  }
}

// --- start frontend ---
if (startFrontend) {
  console.log("[INFO] Starting frontend (pnpm dev)...");

  // detached: true -> make a new process group so we can kill the whole tree on POSIX with -pid
  // On Windows, pnpm is typically a .cmd (batch). spawn() with shell:false may fail (ENOENT/EINVAL).
  // Use cmd.exe /c to reliably run pnpm on Windows.
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec || "cmd.exe";
    frontendProc = spawn(comspec, ["/d", "/s", "/c", "pnpm", "dev"], {
      cwd: FRONTEND_DIR,
      stdio: "inherit",
      shell: false,
      detached: false
    });
  } else {
    frontendProc = spawn("pnpm", ["dev"], {
      cwd: FRONTEND_DIR,
      stdio: "inherit",
      shell: false,
      detached: true
    });
  }

  frontendProc.on("error", (err) => {
    console.error(`[ERROR] Failed to start frontend: ${err?.message || err}`);
    cleanupPidFile();
    process.exit(1);
  });

  if (frontendProc.pid) {
    writeFileSync(FRONTEND_PID_FILE, String(frontendProc.pid), "utf8");
  }
  console.log(`[INFO] Frontend PID saved: ${FRONTEND_PID_FILE} (PID=${frontendProc.pid})`);

  const code = await new Promise((resolve) => frontendProc.on("exit", (c) => resolve(c ?? 0)));
  cleanupPidFile();
  process.exit(code);
}

process.exit(0);


