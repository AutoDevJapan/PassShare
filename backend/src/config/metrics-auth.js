import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time comparison of two strings that avoids leaking length via early
 * return. Returns false when either input is missing or the byte lengths differ.
 *
 * @param {string | undefined | null} a
 * @param {string | undefined | null} b
 * @returns {boolean}
 */
function timingSafeStringEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Extract a bearer token from the `Authorization` header, if present.
 *
 * @param {import('express').Request} req
 * @returns {string | null}
 */
function extractBearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== "string") {
    return null;
  }
  const trimmed = header.trim();
  if (trimmed.slice(0, 6).toLowerCase() !== "bearer") return null;
  let start = 6;
  // Match the former \s separator, greedily, without overlapping repetitions.
  while (start < trimmed.length && trimmed[start].trim() === "") start += 1;
  if (start === 6 || start === trimmed.length) return null;
  const token = trimmed.slice(start);
  // The former dot capture rejected line terminators inside the token.
  for (let i = 0; i < token.length; i += 1) {
    const code = token.charCodeAt(i);
    if (code === 10 || code === 13 || code === 0x2028 || code === 0x2029) return null;
  }
  return token;
}

/**
 * Build the middleware that guards the `/metrics` endpoint.
 *
 * `/metrics` exposes internal operational data (process RSS, uptime). Left
 * unauthenticated it leaks that data to anonymous callers, so this middleware
 * locks it down:
 *
 * - When `METRICS_TOKEN` is set, a request must present
 *   `Authorization: Bearer <METRICS_TOKEN>` (compared in constant time).
 *   Anything else is answered with 404 so the endpoint's existence stays hidden.
 * - When `METRICS_TOKEN` is not set, the endpoint is only reachable in the
 *   `local` environment (developer convenience). In every deployed environment
 *   it is disabled (404) so a missing token can never fail open.
 *
 * @param {string} appEnv
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {import('express').RequestHandler}
 */
export function createRequireMetricsAuth(appEnv, env = process.env) {
  const token = env.METRICS_TOKEN?.trim();

  return (req, res, next) => {
    if (token) {
      const provided = extractBearerToken(req);
      if (provided && timingSafeStringEqual(provided, token)) {
        next();
        return;
      }
      res.status(404).json({ status: "not_found" });
      return;
    }

    if (appEnv === "local") {
      next();
      return;
    }

    res.status(404).json({ status: "not_found" });
  };
}
