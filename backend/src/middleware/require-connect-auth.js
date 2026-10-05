import { hashToken } from "../auth/tokens.js";
import { getBearerToken, resolveConnectToken, sendConnectError } from "./connect-auth.js";

/**
 * @typedef {object} ConnectAuthContext
 * @property {string|null} userId
 * @property {string[]|null} vaultIds
 * @property {boolean} legacy
 */

/**
 * @param {{ authStore: import('../auth/index.js').AuthStore, appEnv?: string }} deps
 */
export function createRequireConnectAuth({ authStore, appEnv = "local" }) {
  /** @type {import('express').RequestHandler} */
  return async function requireConnectAuth(req, res, next) {
    const token = getBearerToken(req);
    if (!token) {
      sendConnectError(res, 401, "PS011: Invalid or missing Connect bearer token");
      return;
    }

    const connectToken = await authStore.findConnectTokenByHash(hashToken(token));
    if (connectToken) {
      const currentVaultIds = await authStore.listVaultIdsForUser(connectToken.user_id);
      /** @type {ConnectAuthContext} */
      req.connectAuth = {
        userId: connectToken.user_id,
        vaultIds: connectToken.vault_ids.filter((id) => currentVaultIds.includes(id)),
        legacy: false,
      };
      next();
      return;
    }

    const legacyAllowed = appEnv === "local" || appEnv === "dev" || appEnv === "stg";
    const expected = resolveConnectToken();
    if (legacyAllowed && expected && token === expected) {
      /** @type {ConnectAuthContext} */
      req.connectAuth = {
        userId: null,
        vaultIds: null,
        legacy: true,
      };
      next();
      return;
    }

    sendConnectError(res, 401, "PS011: Invalid or missing Connect bearer token");
  };
}
