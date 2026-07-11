import express from "express";
import { createAuthRouter } from "./auth/router.js";
import { createAuthStore } from "./auth/index.js";
import { resolveDbSslConfig } from "./config/db-ssl.js";
import { createRequireMetricsAuth } from "./config/metrics-auth.js";
import { resolveTrustProxyHops } from "./config/trust-proxy.js";
import { createConnectRouter } from "./connect/router.js";
import { applyDevSeed, isDevSeedEnvironment } from "./db/dev-seed.js";
import { connectErrorHandler } from "./middleware/connect-errors.js";
import { createRequireConnectAuth } from "./middleware/require-connect-auth.js";
import { requireVaultAccess } from "./middleware/require-vault-access.js";
import { createSecurityHeadersMiddleware } from "./middleware/security-headers.js";
import { createWebCorsMiddleware } from "./middleware/web-cors.js";
import { createStore, normalizeDatabaseUrl, Pool } from "./store/index.js";

// Best-effort DB pool warm-up: open the first connection during startup so the
// first real request after a Railway cold-start (idle wake / fresh deploy) does
// not pay connection-establishment latency — or fail — while the pool lazily
// connects. Non-fatal by design; readiness is still enforced by /health/db. (#368)
const POOL_WARMUP_MAX_ATTEMPTS = 3;
const POOL_WARMUP_RETRY_DELAY_MS = 200;

/**
 * @param {import('pg').Pool | null | undefined} pool
 */
async function warmUpPool(pool) {
  if (!pool) {
    return;
  }
  for (let attempt = 1; attempt <= POOL_WARMUP_MAX_ATTEMPTS; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (error) {
      if (attempt >= POOL_WARMUP_MAX_ATTEMPTS) {
        // Do not block startup on a transient DB hiccup; the app still boots and
        // serves liveness while the pool keeps retrying on demand.
        console.warn(
          "[startup] DB pool warm-up did not complete; continuing:",
          error instanceof Error ? error.message : error,
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POOL_WARMUP_RETRY_DELAY_MS));
    }
  }
}

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

  // Derive req.ip from a fixed number of trusted proxy hops so the per-IP login
  // throttle cannot be bypassed with a spoofed X-Forwarded-For header (#316).
  app.set("trust proxy", resolveTrustProxyHops(appEnv));
  const databaseUrl = normalizeDatabaseUrl(process.env.DATABASE_URL);
  const pool =
    options.pool ??
    (databaseUrl
      ? new Pool({
          connectionString: databaseUrl,
          ssl: resolveDbSslConfig(databaseUrl),
        })
      : null);

  // Warm the connection early so the first post-cold-start request is served by
  // an already-established connection rather than a cold one.
  await warmUpPool(pool);

  const connectStore = options.store ?? (await createStore(pool));
  const authStore = options.authStore ?? (await createAuthStore(pool));

  const ownsStores = !options.store && !options.authStore;
  if (ownsStores && isDevSeedEnvironment(appEnv)) {
    await applyDevSeed({ pool, authStore, connectStore });
  }

  app.use(createSecurityHeadersMiddleware(appEnv));
  app.use(createWebCorsMiddleware(appEnv));

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
      // Do not leak internal DB error detail to unauthenticated callers; log it.
      console.error("[health/db] database check failed:", error);
      res.status(503).json({
        status: "error",
        environment: appEnv,
        database: "unreachable",
      });
    }
  });

  app.get("/metrics", createRequireMetricsAuth(appEnv), async (_req, res) => {
    const metrics = {
      service: "pass-share-backend",
      environment: appEnv,
      uptimeSeconds: Math.floor(process.uptime()),
      memoryRssBytes: process.memoryUsage().rss,
      timestamp: new Date().toISOString(),
      database: pool ? "configured" : "not_configured",
    };

    if (pool) {
      try {
        const result = await pool.query("SELECT 1 AS ok");
        metrics.database = result.rows[0]?.ok === 1 ? "connected" : "degraded";
      } catch {
        metrics.database = "unreachable";
      }
    }

    res.json(metrics);
  });

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
