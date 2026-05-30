import { randomUUID } from "node:crypto";
import { AUTH_SCHEMA_SQL } from "../db/auth-schema.js";
import { SESSION_TTL_MS, CONNECT_TOKEN_TTL_MS, INVITATION_TTL_MS } from "./constants.js";
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

    async getVaultMembership(userId, vaultId) {
      const result = await pool.query(
        `SELECT user_id, vault_id, role, created_at
         FROM vault_memberships
         WHERE user_id = $1 AND vault_id = $2`,
        [userId, vaultId],
      );
      return result.rows[0] ?? null;
    },

    async listVaultMembers(vaultId) {
      const result = await pool.query(
        `SELECT vm.user_id, vm.role, vm.created_at, u.email
         FROM vault_memberships vm
         JOIN users u ON u.id = vm.user_id
         WHERE vm.vault_id = $1
         ORDER BY vm.created_at ASC`,
        [vaultId],
      );
      return result.rows;
    },

    async countVaultOwners(vaultId) {
      const result = await pool.query(
        `SELECT COUNT(*)::int AS count
         FROM vault_memberships
         WHERE vault_id = $1 AND role = 'owner'`,
        [vaultId],
      );
      return result.rows[0]?.count ?? 0;
    },

    async updateVaultMemberRole(vaultId, targetUserId, role) {
      const result = await pool.query(
        `UPDATE vault_memberships SET role = $3
         WHERE vault_id = $1 AND user_id = $2 AND role <> 'owner'
         RETURNING user_id`,
        [vaultId, targetUserId, role],
      );
      if (result.rowCount === 0) {
        throw authHttpError(404, "PS035", "Member not found or cannot change owner role");
      }
    },

    async removeVaultMember(vaultId, targetUserId) {
      const membership = await this.getVaultMembership(targetUserId, vaultId);
      if (!membership) {
        throw authHttpError(404, "PS035", "Member not found");
      }
      if (membership.role === "owner") {
        const owners = await this.countVaultOwners(vaultId);
        if (owners <= 1) {
          throw authHttpError(400, "PS036", "Cannot remove the last owner");
        }
      }
      await pool.query(
        "DELETE FROM vault_memberships WHERE vault_id = $1 AND user_id = $2",
        [vaultId, targetUserId],
      );
    },

    async createVaultInvitation({ vaultId, inviterId, inviteeEmail, role }) {
      const existingMember = await pool.query(
        `SELECT 1 FROM vault_memberships vm
         JOIN users u ON u.id = vm.user_id
         WHERE vm.vault_id = $1 AND u.email = $2`,
        [vaultId, inviteeEmail],
      );
      if (existingMember.rowCount > 0) {
        throw authHttpError(409, "PS037", "User is already a member of this password box");
      }

      const id = randomUUID();
      const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
      try {
        await pool.query(
          `INSERT INTO vault_invitations (id, vault_id, inviter_id, invitee_email, role, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6::timestamptz)`,
          [id, vaultId, inviterId, inviteeEmail, role, expiresAt.toISOString()],
        );
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "23505") {
          throw authHttpError(409, "PS038", "A pending invitation already exists for this email");
        }
        throw error;
      }

      return {
        id,
        vault_id: vaultId,
        inviter_id: inviterId,
        invitee_email: inviteeEmail,
        role,
        status: "pending",
        expires_at: expiresAt.toISOString(),
      };
    },

    async listVaultInvitations(vaultId) {
      const result = await pool.query(
        `SELECT id, vault_id, inviter_id, invitee_email, role, status, expires_at, created_at
         FROM vault_invitations
         WHERE vault_id = $1 AND status = 'pending' AND expires_at > NOW()
         ORDER BY created_at DESC`,
        [vaultId],
      );
      return result.rows;
    },

    async listUserPendingInvitations(inviteeEmail) {
      const result = await pool.query(
        `SELECT vi.id, vi.vault_id, vi.inviter_id, vi.invitee_email, vi.role, vi.status,
                vi.expires_at, vi.created_at, cv.name AS vault_name, u.email AS inviter_email
         FROM vault_invitations vi
         JOIN connect_vaults cv ON cv.id = vi.vault_id
         JOIN users u ON u.id = vi.inviter_id
         WHERE vi.invitee_email = $1 AND vi.status = 'pending' AND vi.expires_at > NOW()
         ORDER BY vi.created_at DESC`,
        [inviteeEmail],
      );
      return result.rows;
    },

    async revokeVaultInvitation(vaultId, invitationId) {
      const result = await pool.query(
        `UPDATE vault_invitations
         SET status = 'revoked', responded_at = NOW()
         WHERE id = $1 AND vault_id = $2 AND status = 'pending'
         RETURNING id`,
        [invitationId, vaultId],
      );
      if (result.rowCount === 0) {
        throw authHttpError(404, "PS039", "Invitation not found");
      }
    },

    async acceptVaultInvitation(invitationId, userId) {
      const user = await this.findUserById(userId);
      if (!user) {
        throw authHttpError(404, "PS022", "User not found");
      }

      const invitationResult = await pool.query(
        `SELECT id, vault_id, invitee_email, role, status, expires_at
         FROM vault_invitations
         WHERE id = $1`,
        [invitationId],
      );
      const invitation = invitationResult.rows[0];
      if (!invitation || invitation.status !== "pending") {
        throw authHttpError(404, "PS039", "Invitation not found");
      }
      if (new Date(invitation.expires_at).getTime() <= Date.now()) {
        throw authHttpError(410, "PS040", "Invitation has expired");
      }
      if (invitation.invitee_email !== user.email) {
        throw authHttpError(403, "PS041", "Invitation is for a different email address");
      }

      await pool.query("BEGIN");
      try {
        await pool.query(
          `INSERT INTO vault_memberships (user_id, vault_id, role)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, vault_id) DO NOTHING`,
          [userId, invitation.vault_id, invitation.role],
        );
        await pool.query(
          `UPDATE vault_invitations
           SET status = 'accepted', responded_at = NOW()
           WHERE id = $1`,
          [invitationId],
        );
        await pool.query("COMMIT");
      } catch (error) {
        await pool.query("ROLLBACK");
        throw error;
      }

      return { vaultId: invitation.vault_id, role: invitation.role };
    },

    async declineVaultInvitation(invitationId, userId) {
      const user = await this.findUserById(userId);
      if (!user) {
        throw authHttpError(404, "PS022", "User not found");
      }

      const result = await pool.query(
        `UPDATE vault_invitations
         SET status = 'declined', responded_at = NOW()
         WHERE id = $1 AND invitee_email = $2 AND status = 'pending'
         RETURNING id`,
        [invitationId, user.email],
      );
      if (result.rowCount === 0) {
        throw authHttpError(404, "PS039", "Invitation not found");
      }
    },
  };
}
