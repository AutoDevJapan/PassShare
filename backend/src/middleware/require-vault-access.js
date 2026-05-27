import { sendConnectError } from "./connect-auth.js";

/** @type {import('express').RequestHandler} */
export function requireVaultAccess(req, res, next) {
  const auth = req.connectAuth;
  if (!auth) {
    sendConnectError(res, 401, "PS011: Invalid or missing Connect bearer token");
    return;
  }

  if (auth.legacy) {
    next();
    return;
  }

  const vaultId = req.params.vaultUuid;
  if (!vaultId) {
    next();
    return;
  }

  if (!auth.vaultIds.includes(vaultId)) {
    sendConnectError(res, 403, "PS016: Access denied to password box");
    return;
  }

  next();
}
