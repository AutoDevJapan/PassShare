import express from "express";
import { createAuthRouter } from "./auth/router.js";
import { createAuthStore } from "./auth/index.js";
import { createConnectRouter } from "./connect/router.js";
import { connectErrorHandler } from "./middleware/connect-errors.js";
import { createRequireConnectAuth } from "./middleware/require-connect-auth.js";
import { requireVaultAccess } from "./middleware/require-vault-access.js";
import { createWebCorsMiddleware } from "./middleware/web-cors.js";
import { createStore, normalizeDatabaseUrl, Pool } from "./store/index.js";

/**
 * @param {{
 *   pool?: import('pg').Pool | null,
 *   store?: import('./store/memory-store.js').ConnectStore,
 *   authStore?: import('./auth/index.js').AuthStore,
 * }} [options]
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
  const authStore = options.authStore ?? (await createAuthStore(pool));

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

  app.use(createWebCorsMiddleware(appEnv));
  app.use(
    express.json({
      limit: "2mb",
      type: ["application/json", "application/json-patch+json"],
    }),
  );
  app.use("/api/auth", createAuthRouter({ authStore, connectStore, appEnv }));
  const requireConnectAuth = createRequireConnectAuth({ authStore, appEnv });
  app.use(
    "/v1",
    requireConnectAuth,
    createConnectRouter(connectStore, { requireVaultAccess }),
  );
  app.use(connectErrorHandler);

  return { app, store: connectStore, authStore, pool };
}
