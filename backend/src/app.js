import express from "express";
import { createConnectRouter } from "./connect/router.js";
import { connectErrorHandler } from "./middleware/connect-errors.js";
import { requireConnectAuth } from "./middleware/require-connect-auth.js";
import { createStore, normalizeDatabaseUrl, Pool } from "./store/index.js";

/**
 * @param {{ pool?: import('pg').Pool | null, store?: import('./store/memory-store.js').ConnectStore }} [options]
 */
export async function createApp(options = {}) {
  const app = express();
  const appEnv = process.env.APP_ENV ?? "local";
  const databaseUrl = normalizeDatabaseUrl(process.env.DATABASE_URL);
  const pool =
    options.pool ??
    (databaseUrl
      ? new Pool({
          connectionString: databaseUrl,
          ssl: databaseUrl.includes("railway.app")
            ? { rejectUnauthorized: false }
            : undefined,
        })
      : null);

  const connectStore = options.store ?? (await createStore(pool));

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "pass-share-backend",
      environment: appEnv,
      connectApi: "ready",
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

  app.use(
    express.json({
      limit: "2mb",
      type: ["application/json", "application/json-patch+json"],
    }),
  );
  app.use("/v1", requireConnectAuth, createConnectRouter(connectStore));
  app.use(connectErrorHandler);

  return { app, store: connectStore, pool };
}
