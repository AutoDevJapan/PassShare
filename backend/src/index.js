import express from "express";
import pg from "pg";

const { Pool } = pg;

const app = express();
const port = Number(process.env.PORT ?? 8080);
const appEnv = process.env.APP_ENV ?? "local";

function normalizeDatabaseUrl(rawUrl) {
  if (!rawUrl) {
    return null;
  }
  return rawUrl.startsWith("postgres://")
    ? rawUrl.replace("postgres://", "postgresql://")
    : rawUrl;
}

const databaseUrl = normalizeDatabaseUrl(process.env.DATABASE_URL);
const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: databaseUrl.includes("railway.app")
        ? { rejectUnauthorized: false }
        : undefined,
    })
  : null;

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "pass-share-backend",
    environment: appEnv,
  });
});

app.get("/health/db", async (_req, res) => {
  if (!pool) {
    res.status(503).json({
      status: "error",
      environment: appEnv,
      database: "not_configured",
    });
    return;
  }

  try {
    const result = await pool.query("SELECT 1 AS ok");
    res.json({
      status: "ok",
      environment: appEnv,
      database: "connected",
      result: result.rows[0]?.ok ?? null,
    });
  } catch (error) {
    res.status(503).json({
      status: "error",
      environment: appEnv,
      database: "unreachable",
      message: error instanceof Error ? error.message : "unknown error",
    });
  }
});

app.listen(port, () => {
  console.log(`pass-share-backend listening on ${port} (${appEnv})`);
});
