import { randomUUID } from "node:crypto";
import { SESSION_TTL_MS, CONNECT_TOKEN_TTL_MS, INVITATION_TTL_MS } from "./constants.js";
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
  /** @type {Array<{ user_id: string, vault_id: string, role: string, created_at?: string }>} */
  const memberships = [];
  /** @type {Array<{ id: string, vault_id: string, inviter_id: string, invitee_email: string, role: string, status: string, expires_at: string, created_at: string, responded_at?: string }>} */
  const invitations = [];
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
      const existing = memberships.find((m) => m.user_id === userId && m.vault_id === vaultId);
      if (!existing) {
        memberships.push({
          user_id: userId,
          vault_id: vaultId,
          role,
          created_at: new Date().toISOString(),
        });
      }
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

    async getVaultMembership(userId, vaultId) {
      return (
        memberships.find((m) => m.user_id === userId && m.vault_id === vaultId) ?? null
      );
    },

    async listVaultMembers(vaultId) {
      return memberships
        .filter((m) => m.vault_id === vaultId)
        .map((m) => {
          const user = usersById.get(m.user_id);
          return {
            user_id: m.user_id,
            role: m.role,
            created_at: m.created_at ?? new Date().toISOString(),
            email: user?.email ?? "",
          };
        });
    },

    async countVaultOwners(vaultId) {
      return memberships.filter((m) => m.vault_id === vaultId && m.role === "owner").length;
    },

    async updateVaultMemberRole(vaultId, targetUserId, role) {
      const membership = memberships.find(
        (m) => m.vault_id === vaultId && m.user_id === targetUserId,
      );
      if (!membership || membership.role === "owner") {
        throw authHttpError(404, "PS035", "Member not found or cannot change owner role");
      }
      membership.role = role;
    },

    async removeVaultMember(vaultId, targetUserId) {
      const index = memberships.findIndex(
        (m) => m.vault_id === vaultId && m.user_id === targetUserId,
      );
      if (index === -1) {
        throw authHttpError(404, "PS035", "Member not found");
      }
      if (memberships[index].role === "owner") {
        const owners = await this.countVaultOwners(vaultId);
        if (owners <= 1) {
          throw authHttpError(400, "PS036", "Cannot remove the last owner");
        }
      }
      memberships.splice(index, 1);
    },

    async createVaultInvitation({ vaultId, inviterId, inviteeEmail, role }) {
      requireUser(inviterId);
      const memberExists = memberships.some((m) => {
        if (m.vault_id !== vaultId) return false;
        const user = usersById.get(m.user_id);
        return user?.email === inviteeEmail;
      });
      if (memberExists) {
        throw authHttpError(409, "PS037", "User is already a member of this password box");
      }
      const duplicate = invitations.find(
        (inv) =>
          inv.vault_id === vaultId &&
          inv.invitee_email === inviteeEmail &&
          inv.status === "pending" &&
          new Date(inv.expires_at).getTime() > Date.now(),
      );
      if (duplicate) {
        throw authHttpError(409, "PS038", "A pending invitation already exists for this email");
      }

      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + INVITATION_TTL_MS).toISOString();
      const row = {
        id,
        vault_id: vaultId,
        inviter_id: inviterId,
        invitee_email: inviteeEmail,
        role,
        status: "pending",
        expires_at: expiresAt,
        created_at: createdAt,
      };
      invitations.push(row);
      return row;
    },

    async listVaultInvitations(vaultId) {
      return invitations.filter(
        (inv) =>
          inv.vault_id === vaultId &&
          inv.status === "pending" &&
          new Date(inv.expires_at).getTime() > Date.now(),
      );
    },

    async listUserPendingInvitations(inviteeEmail) {
      return invitations
        .filter(
          (inv) =>
            inv.invitee_email === inviteeEmail &&
            inv.status === "pending" &&
            new Date(inv.expires_at).getTime() > Date.now(),
        )
        .map((inv) => {
          const inviter = usersById.get(inv.inviter_id);
          return {
            ...inv,
            vault_name: inv.vault_id,
            inviter_email: inviter?.email ?? "",
          };
        });
    },

    async revokeVaultInvitation(vaultId, invitationId) {
      const invitation = invitations.find(
        (inv) => inv.id === invitationId && inv.vault_id === vaultId && inv.status === "pending",
      );
      if (!invitation) {
        throw authHttpError(404, "PS039", "Invitation not found");
      }
      invitation.status = "revoked";
      invitation.responded_at = new Date().toISOString();
    },

    async acceptVaultInvitation(invitationId, userId) {
      const user = requireUser(userId);
      const invitation = invitations.find((inv) => inv.id === invitationId);
      if (!invitation || invitation.status !== "pending") {
        throw authHttpError(404, "PS039", "Invitation not found");
      }
      if (new Date(invitation.expires_at).getTime() <= Date.now()) {
        throw authHttpError(410, "PS040", "Invitation has expired");
      }
      if (invitation.invitee_email !== user.email) {
        throw authHttpError(403, "PS041", "Invitation is for a different email address");
      }
      await this.addVaultMembership(userId, invitation.vault_id, invitation.role);
      invitation.status = "accepted";
      invitation.responded_at = new Date().toISOString();
      return { vaultId: invitation.vault_id, role: invitation.role };
    },

    async declineVaultInvitation(invitationId, userId) {
      const user = requireUser(userId);
      const invitation = invitations.find(
        (inv) => inv.id === invitationId && inv.invitee_email === user.email && inv.status === "pending",
      );
      if (!invitation) {
        throw authHttpError(404, "PS039", "Invitation not found");
      }
      invitation.status = "declined";
      invitation.responded_at = new Date().toISOString();
    },
  };
}
