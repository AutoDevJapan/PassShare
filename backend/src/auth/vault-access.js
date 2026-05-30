import { authHttpError } from "./errors.js";

/** @typedef {'owner' | 'member'} VaultRole */

/**
 * @param {import('./index.js').AuthStore} authStore
 * @param {string} userId
 * @param {string} vaultId
 */
export async function requireVaultMembership(authStore, userId, vaultId) {
  const membership = await authStore.getVaultMembership(userId, vaultId);
  if (!membership) {
    throw authHttpError(403, "PS031", "Password box access denied");
  }
  return membership;
}

/**
 * @param {import('./index.js').AuthStore} authStore
 * @param {string} userId
 * @param {string} vaultId
 */
export async function requireVaultOwner(authStore, userId, vaultId) {
  const membership = await requireVaultMembership(authStore, userId, vaultId);
  if (membership.role !== "owner") {
    throw authHttpError(403, "PS032", "Password box owner access required");
  }
  return membership;
}

/** @param {unknown} role */
export function parseInviteRole(role) {
  const value = typeof role === "string" ? role.trim() : "member";
  if (value !== "member") {
    throw authHttpError(400, "PS033", "Invitation role must be member");
  }
  return value;
}

/** @param {unknown} role */
export function parseMemberRole(role) {
  const value = typeof role === "string" ? role.trim() : "";
  if (value !== "member") {
    throw authHttpError(400, "PS034", "Member role must be member");
  }
  return value;
}
