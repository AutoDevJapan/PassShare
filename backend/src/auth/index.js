import { createMemoryAuthStore } from "./memory-auth-store.js";
import { createPgAuthStore } from "./pg-auth-store.js";

/**
 * @typedef {object} AuthStore
 * @property {() => Promise<void>} migrate
 * @property {(email: string) => Promise<object|null>} findUserByEmail
 * @property {(userId: string) => Promise<object|null>} findUserById
 * @property {(input: { email: string, passwordHash: string }) => Promise<object>} createUser
 * @property {(userId: string, vaultId: string, role?: string) => Promise<void>} addVaultMembership
 * @property {(userId: string) => Promise<string[]>} listVaultIdsForUser
 * @property {(userId: string, expectedPasswordHash: string) => Promise<{ sessionToken: string, sessionId: string, expiresAt: string }>} createSession
 * @property {(sessionToken: string) => Promise<object|null>} findSessionByToken
 * @property {(sessionId: string) => Promise<string>} refreshSession
 * @property {(sessionId: string) => Promise<void>} deleteSession
 * @property {(userId: string, label: string, sessionId: string) => Promise<{ accessToken: string, expiresAt: string, expiresIn: number, vaultIds: string[], tokenHash: string }>} createConnectToken
 * @property {(userId: string, sessionId: string, expectedHash: string, nextHash: string) => Promise<void>} changePassword
 * @property {(tokenHash: string) => Promise<object|null>} findConnectTokenByHash
 * @property {(userId: string) => Promise<void>} deleteConnectTokensForUser
 */

/**
 * @param {import('pg').Pool | null} pool
 * @returns {Promise<AuthStore>}
 */
export async function createAuthStore(pool) {
  if (!pool) {
    return createMemoryAuthStore();
  }
  const store = createPgAuthStore(pool);
  await store.migrate();
  return store;
}

export { createMemoryAuthStore, createPgAuthStore };
