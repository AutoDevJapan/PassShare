import { isAllowedWebOrigin } from "./web-origin.js";

/**
 * CORS for Web session cookies (credentials).
 * @param {string} appEnv
 */
export function createWebCorsMiddleware(appEnv = "local") {
  const configuredOrigin = process.env.WEB_ORIGIN?.trim();

  /** @type {import('express').RequestHandler} */
  return (req, res, next) => {
    const requestOrigin = req.headers.origin;
    if (
      typeof requestOrigin === "string" &&
      isAllowedWebOrigin(requestOrigin, appEnv, configuredOrigin)
    ) {
      res.setHeader("Access-Control-Allow-Origin", requestOrigin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
    }
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-CSRF-Token",
    );
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}
