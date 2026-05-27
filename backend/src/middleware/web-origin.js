/**
 * Allowed browser origins for Web session cookies (CORS credentials).
 */

const DEFAULT_LOCAL_ORIGIN = "http://localhost:5173";
const DEFAULT_VERCEL_ORIGIN = "https://pass-share-frontend.vercel.app";

/**
 * @param {string} hostname
 */
function isVercelHostname(hostname) {
  return hostname === "pass-share-frontend.vercel.app" || hostname.endsWith(".vercel.app");
}

/**
 * @param {string | undefined | null} origin
 * @param {string} appEnv
 * @param {string | undefined} configuredOrigin
 */
export function isAllowedWebOrigin(origin, appEnv = "local", configuredOrigin) {
  if (!origin || typeof origin !== "string") {
    return false;
  }

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  if (appEnv === "local") {
    const allowed = configuredOrigin?.trim() || DEFAULT_LOCAL_ORIGIN;
    return origin === allowed;
  }

  if (parsed.protocol !== "https:") {
    return false;
  }

  if (configuredOrigin && origin === configuredOrigin.trim()) {
    return true;
  }

  if (appEnv === "prd" || appEnv === "stg" || appEnv === "preview" || appEnv === "dev") {
    return isVercelHostname(parsed.hostname);
  }

  return origin === (configuredOrigin?.trim() || DEFAULT_VERCEL_ORIGIN);
}

/**
 * @param {string} appEnv
 */
export function defaultWebOrigin(appEnv = "local") {
  if (appEnv === "local") {
    return process.env.WEB_ORIGIN?.trim() || DEFAULT_LOCAL_ORIGIN;
  }
  return process.env.WEB_ORIGIN?.trim() || DEFAULT_VERCEL_ORIGIN;
}
