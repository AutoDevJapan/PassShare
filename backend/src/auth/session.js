import { SESSION_COOKIE, SESSION_TTL_MS } from "./constants.js";
import { authHttpError } from "./errors.js";

/** @param {import('express').Request} req */
export function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header || typeof header !== "string") {
    return {};
  }
  /** @type {Record<string, string>} */
  const cookies = {};
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const name = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1);
    try { cookies[name] = decodeURIComponent(value); }
    catch { /* Malformed cookie values cannot authenticate a session. */ }
  }
  return cookies;
}

/**
 * @param {import('express').Response} res
 * @param {string} sessionToken
 * @param {string} appEnv
 */
export function setSessionCookie(res, sessionToken, appEnv) {
  const secure = appEnv === "prd" || appEnv === "stg";
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}`,
    "HttpOnly",
    "Path=/",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    "SameSite=Lax",
  ];
  if (secure) {
    parts.push("Secure");
  }
  res.setHeader("Set-Cookie", parts.join("; "));
}

/** @param {import('express').Response} res @param {string} appEnv */
export function clearSessionCookie(res, appEnv) {
  const secure = appEnv === "prd" || appEnv === "stg";
  const parts = [
    `${SESSION_COOKIE}=`,
    "HttpOnly",
    "Path=/",
    "Max-Age=0",
    "SameSite=Lax",
  ];
  if (secure) {
    parts.push("Secure");
  }
  res.setHeader("Set-Cookie", parts.join("; "));
}

/** @param {import('express').Request} req */
export function parseBearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return null;
  }
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

/**
 * @param {import('express').Request} req
 * @param {import('./index.js').AuthStore} authStore
 */
export async function resolveSessionAuth(req, authStore) {
  const bearerToken = parseBearerToken(req);
  if (req.headers.authorization !== undefined && !bearerToken) {
    throw authHttpError(401,"PS024","Session is invalid or expired");
  }
  if (bearerToken) {
    const session = await authStore.findSessionByToken(bearerToken);
    if (!session) {
      throw authHttpError(401, "PS024", "Session is invalid or expired");
    }
    return {
      userId: session.user_id,
      sessionId: session.id,
    };
  }

  const cookies = parseCookies(req);
  const sessionToken = cookies[SESSION_COOKIE];
  if (!sessionToken) {
    throw authHttpError(401, "PS025", "Session is required");
  }
  const session = await authStore.findSessionByToken(sessionToken);
  if (!session) {
    throw authHttpError(401, "PS024", "Session is invalid or expired");
  }
  return {
    userId: session.user_id,
    sessionId: session.id,
  };
}

/**
 * @param {import('./index.js').AuthStore} authStore
 * @returns {import('express').RequestHandler}
 */
export function requireSession(authStore) {
  return async (req, res, next) => {
    try {
      req.auth = await resolveSessionAuth(req, authStore);
      next();
    } catch (error) {
      next(error);
    }
  };
}
