import { getBearerToken, resolveConnectToken, sendConnectError } from "./connect-auth.js";

/** @type {import('express').RequestHandler} */
export function requireConnectAuth(req, res, next) {
  const expected = resolveConnectToken();
  if (!expected) {
    sendConnectError(res, 503, "PS008: Connect token is not configured on server");
    return;
  }
  const token = getBearerToken(req);
  if (!token || token !== expected) {
    sendConnectError(res, 401, "PS011: Invalid or missing Connect bearer token");
    return;
  }
  next();
}
