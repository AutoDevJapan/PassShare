import { timingSafeEqual } from "node:crypto";
import { generateToken } from "./tokens.js";
import { CSRF_COOKIE, CSRF_HEADER } from "./constants.js";
import { authHttpError } from "./errors.js";
import { isTokenAuthClient } from "./client.js";
import { parseBearerToken, parseCookies } from "./session.js";

/**
 * @param {import('express').Response} res
 * @param {string} appEnv
 * @returns {string}
 */
export function issueCsrfToken(res, appEnv) {
  const token = generateToken();
  setCsrfCookie(res, token, appEnv);
  return token;
}

/**
 * @param {import('express').Response} res
 * @param {string} token
 * @param {string} appEnv
 */
export function setCsrfCookie(res, token, appEnv) {
  const secure = appEnv === "prd" || appEnv === "stg";
  const parts = [
    `${CSRF_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "SameSite=Lax",
  ];
  if (secure) {
    parts.push("Secure");
  }
  res.append("Set-Cookie", parts.join("; "));
}

/** @param {import('express').Response} res @param {string} appEnv */
export function clearCsrfCookie(res, appEnv) {
  const secure = appEnv === "prd" || appEnv === "stg";
  const parts = [`${CSRF_COOKIE}=`, "Path=/", "Max-Age=0", "SameSite=Lax"];
  if (secure) {
    parts.push("Secure");
  }
  res.append("Set-Cookie", parts.join("; "));
}

/** @type {import('express').RequestHandler} */
export function requireCsrf(req, _res, next) {
  if (parseBearerToken(req) || isTokenAuthClient(req)) {
    next();
    return;
  }

  const cookies = parseCookies(req);
  const cookieToken = cookies[CSRF_COOKIE];
  const headerToken = req.headers[CSRF_HEADER];
  if (
    typeof cookieToken !== "string" ||
    typeof headerToken !== "string" ||
    !safeEqual(cookieToken, headerToken)
  ) {
    next(authHttpError(403, "PS027", "CSRF token validation failed"));
    return;
  }
  next();
}

/**
 * @param {string} a
 * @param {string} b
 */
function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
