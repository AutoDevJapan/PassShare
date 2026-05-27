import { randomUUID } from "node:crypto";
import { SESSION_TTL_MS, CONNECT_TOKEN_TTL_MS } from "./constants.js";
import { authHttpError } from "./errors.js";
import { generateToken, hashToken } from "./tokens.js";

/** @returns {import('./index.js').AuthStore} */
export function createMemoryAuthStore() {
  /** @type {Map<string, { id: string, email: string, password_hash: string, created_at: string }>} */
  const usersById = new Map();
  /** @type {Map<string, string>} */
  const userIdByEmail = new Map();
  /** @type {Map<string, { id: string, user_id: string, token_hash: string, expires_at: string }>} */
  const sessionsById = new Map();
  /** @type {Map<string, string>} */
  const sessionIdByTokenHash = new Map();
  /** @type {Array<{ user_id: string, vault_id: string, role: string }>} */
  const memberships = [];
  /** @type {Map<string, { id: string, user_id: string, token_hash: string, vault_ids: string[], expires_at: string, label: string }>} */
  const connectTokensById = new Map();
  /** @type {Map<string, string>} */
  const connectTokenIdByHash = new Map();

  function requireUser(userId) {
    const user = usersById.get(userId);
    if (!user) {
      throw authHttpError(404, "PS022", "User not found");
    }
    return user;
  }

  return {
    async migrate() {},

    async findUserByEmail(email) {
      const userId = userIdByEmail.get(email);
      return userId ? usersById.get(userId) ?? null : null;
    },

    async findUserById(userId) {
      return usersById.get(userId) ?? null;
    },

    async createUser({ email, passwordHash }) {
      if (userIdByEmail.has(email)) {
        throw authHttpError(409, "PS023", "Email is already registered");
      }
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const user = { id, email, password_hash: passwordHash, created_at: createdAt };
      usersById.set(id, user);
      userIdByEmail.set(email, id);
      return user;
    },

    async addVaultMembership(userId, vaultId, role = "owner") {
      requireUser(userId);
      memberships.push({ user_id: userId, vault_id: vaultId, role });
    },

    async listVaultIdsForUser(userId) {
      return memberships.filter((m) => m.user_id === userId).map((m) => m.vault_id);
    },

    async createSession(userId) {
      requireUser(userId);
      const sessionToken = generateToken();
      const tokenHash = hashToken(sessionToken);
      const id = randomUUID();
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
      const row = { id, user_id: userId, token_hash: tokenHash, expires_at: expiresAt };
      sessionsById.set(id, row);
      sessionIdByTokenHash.set(tokenHash, id);
      return { sessionToken, sessionId: id, expiresAt };
    },

    async findSessionByToken(sessionToken) {
      const tokenHash = hashToken(sessionToken);
      const sessionId = sessionIdByTokenHash.get(tokenHash);
      if (!sessionId) return null;
      const session = sessionsById.get(sessionId);
      if (!session) return null;
      if (new Date(session.expires_at).getTime() <= Date.now()) {
        await this.deleteSession(sessionId);
        return null;
      }
      return session;
    },

    async refreshSession(sessionId) {
      const session = sessionsById.get(sessionId);
      if (!session) {
        throw authHttpError(401, "PS024", "Session is invalid or expired");
      }
      session.expires_at = new Date(Date.now() + SESSION_TTL_MS).toISOString();
      return session.expires_at;
    },

    async deleteSession(sessionId) {
      const session = sessionsById.get(sessionId);
      if (!session) return;
      sessionsById.delete(sessionId);
      sessionIdByTokenHash.delete(session.token_hash);
    },

    async createConnectToken(userId, label = "session") {
      requireUser(userId);
      const vaultIds = await this.listVaultIdsForUser(userId);
      const accessToken = generateToken();
      const tokenHash = hashToken(accessToken);
      const id = randomUUID();
      const expiresAt = new Date(Date.now() + CONNECT_TOKEN_TTL_MS).toISOString();
      const row = {
        id,
        user_id: userId,
        token_hash: tokenHash,
        vault_ids: vaultIds,
        expires_at: expiresAt,
        label,
      };
      connectTokensById.set(id, row);
      connectTokenIdByHash.set(tokenHash, id);
      return {
        accessToken,
        expiresAt,
        expiresIn: Math.floor(CONNECT_TOKEN_TTL_MS / 1000),
        vaultIds,
        tokenHash,
      };
    },

    async findConnectTokenByHash(tokenHash) {
      const tokenId = connectTokenIdByHash.get(tokenHash);
      if (!tokenId) return null;
      const token = connectTokensById.get(tokenId);
      if (!token) return null;
      if (new Date(token.expires_at).getTime() <= Date.now()) {
        connectTokensById.delete(tokenId);
        connectTokenIdByHash.delete(tokenHash);
        return null;
      }
      return token;
    },
  };
}
