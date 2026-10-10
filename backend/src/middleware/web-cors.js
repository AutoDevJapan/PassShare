import { isAllowedWebOrigin } from "./web-origin.js";
import { isTokenAuthClient } from "../auth/client.js";

// These are the fixed Tauri asset origins, not arbitrary localhost pages or
// opaque "null" origins. Native clients use explicit tokens, never Web cookies.
const NATIVE_TOKEN_ORIGINS = new Set([
  "http://tauri.localhost",
  "https://tauri.localhost",
  "tauri://localhost",
]);

function requestsTokenTransport(req) {
  if (isTokenAuthClient(req) || typeof req.headers.authorization === "string" && /^Bearer /i.test(req.headers.authorization)) return true;
  const requested = req.headers["access-control-request-headers"];
  return req.method === "OPTIONS" && typeof requested === "string" &&
    requested.toLowerCase().split(",").map((header) => header.trim())
      .some((header) => header === "x-passshare-client" || header === "authorization");
}

/**
 * CORS for Web session cookies (credentials).
 * @param {string} appEnv
 */
export function createWebCorsMiddleware(appEnv = "local") {
  const configuredOrigin = process.env.WEB_ORIGIN?.trim();
  const vercelTeamSlug = process.env.VERCEL_TEAM_SLUG?.trim();

  /** @type {import('express').RequestHandler} */
  return (req, res, next) => {
    const requestOrigin = req.headers.origin;
    if (NATIVE_TOKEN_ORIGINS.has(requestOrigin) && requestsTokenTransport(req)) {
      res.setHeader("Access-Control-Allow-Origin", requestOrigin);
      res.setHeader("Vary", "Origin");
      // Deliberately no Access-Control-Allow-Credentials: cookie requests must
      // still follow the existing Web origin and CSRF contracts.
    } else if (
      typeof requestOrigin === "string" &&
      isAllowedWebOrigin(requestOrigin, appEnv, configuredOrigin, vercelTeamSlug)
    ) {
      res.setHeader("Access-Control-Allow-Origin", requestOrigin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
    }
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-CSRF-Token, Idempotency-Key, X-Passshare-Client",
    );
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}
