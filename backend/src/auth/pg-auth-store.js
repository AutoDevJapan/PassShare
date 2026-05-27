import { randomUUID } from "node:crypto";
import { AUTH_SCHEMA_SQL } from "../db/auth-schema.js";
import { SESSION_TTL_MS, CONNECT_TOKEN_TTL_MS } from "./constants.js";
import { authHttpError } from "./errors.js";
import { generateToken, hashToken } from "./tokens.js";

/**
 * @param {import('pg').Pool} pool
 * @returns {import('./index.js').AuthStore}
 */
export function createPgAuthStore(pool) {
  return {
    async migrate() {
      await pool.query(AUTH_SCHEMA_SQL);
    },

    async findUserByEmail(email) {
      const result = await pool.query(
        "SELECT id, email, password_hash, created_at FROM users WHERE email = $1",
        [email],
      );
      return result.rows[0] ?? null;
    },

    async findUserById(userId) {
      const result = await pool.query(
        "SELECT id, email, password_hash, created_at FROM users WHERE id = $1",
        [userId],
      );
      return result.rows[0] ?? null;
    },

    async createUser({ email, passwordHash }) {
      const id = randomUUID();
      try {
        const result = await pool.query(
          `INSERT INTO users (id, email, password_hash)
           VALUES ($1, $2, $3)
           RETURNING id, email, password_hash, created_at`,
          [id, email, passwordHash],
        );
        return result.rows[0];
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "23505") {
          throw authHttpError(409, "PS023", "Email is already registered");
        }
        throw error;
      }
    },

    async addVaultMembership(userId, vaultId, role = "owner") {
      await pool.query(
        `INSERT INTO vault_memberships (user_id, vault_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, vault_id) DO NOTHING`,
        [userId, vaultId, role],
      );
    },

    async listVaultIdsForUser(userId) {
      const result = await pool.query(
        "SELECT vault_id FROM vault_memberships WHERE user_id = $1 ORDER BY created_at ASC",
        [userId],
      );
      return result.rows.map((row) => row.vault_id);
    },

    async createSession(userId) {
      const sessionToken = generateToken();
      const tokenHash = hashToken(sessionToken);
      const id = randomUUID();
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
      await pool.query(
        `INSERT INTO sessions (id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4::timestamptz)`,
        [id, userId, tokenHash, expiresAt.toISOString()],
      );
      return {
        sessionToken,
        sessionId: id,
        expiresAt: expiresAt.toISOString(),
      };
    },

    async findSessionByToken(sessionToken) {
      const tokenHash = hashToken(sessionToken);
      const result = await pool.query(
        `SELECT id, user_id, token_hash, expires_at
         FROM sessions
         WHERE token_hash = $1 AND expires_at > NOW()`,
        [tokenHash],
      );
      return result.rows[0] ?? null;
    },

    async refreshSession(sessionId) {
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
      const result = await pool.query(
        `UPDATE sessions SET expires_at = $2::timestamptz
         WHERE id = $1
         RETURNING expires_at`,
        [sessionId, expiresAt.toISOString()],
      );
      if (result.rowCount === 0) {
        throw authHttpError(401, "PS024", "Session is invalid or expired");
      }
      return result.rows[0].expires_at;
    },

    async deleteSession(sessionId) {
      await pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
    },

    async createConnectToken(userId, label = "session") {
      const vaultIds = await this.listVaultIdsForUser(userId);
      const accessToken = generateToken();
      const tokenHash = hashToken(accessToken);
      const id = randomUUID();
      const expiresAt = new Date(Date.now() + CONNECT_TOKEN_TTL_MS);
      await pool.query(
        `INSERT INTO connect_tokens (id, user_id, token_hash, vault_ids, expires_at, label)
         VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, $6)`,
        [id, userId, tokenHash, JSON.stringify(vaultIds), expiresAt.toISOString(), label],
      );
      return {
        accessToken,
        expiresAt: expiresAt.toISOString(),
        expiresIn: Math.floor(CONNECT_TOKEN_TTL_MS / 1000),
        vaultIds,
        tokenHash,
      };
    },

    async findConnectTokenByHash(tokenHash) {
      const result = await pool.query(
        `SELECT id, user_id, token_hash, vault_ids, expires_at, label
         FROM connect_tokens
         WHERE token_hash = $1 AND expires_at > NOW()`,
        [tokenHash],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        ...row,
        vault_ids: Array.isArray(row.vault_ids) ? row.vault_ids : JSON.parse(String(row.vault_ids)),
      };
    },
  };
}
