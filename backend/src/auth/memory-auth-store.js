import { randomUUID } from "node:crypto";
import { SESSION_TTL_MS, CONNECT_TOKEN_TTL_MS, INVITATION_TTL_MS } from "./constants.js";
import { authHttpError } from "./errors.js";
import { generateToken, hashToken } from "./tokens.js";
import { nativeMutation } from "../lib/native-mutations.js";

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
      const user = userId ? usersById.get(userId) : null;
      return user ? { ...user } : null;
    },

    async findUserById(userId) {
      const user = usersById.get(userId);
      return user ? { ...user } : null;
    },

    async createUser({ email, passwordHash, id: requestedId }) {
      if (userIdByEmail.has(email)) {
        throw authHttpError(409, "PS023", "Email is already registered");
      }
      const id = requestedId ?? randomUUID();
      const createdAt = new Date().toISOString();
      const user = { id, email, password_hash: passwordHash, created_at: createdAt };
      usersById.set(id, user);
      userIdByEmail.set(email, id);
      return { ...user };
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
          confirmed_at: role === "owner" ? new Date().toISOString() : null,
        });
      }
    },

    async listVaultIdsForUser(userId) {
      return memberships.filter((m) => m.user_id === userId && (m.role === "owner" || m.confirmed_at)).map((m) => m.vault_id);
    },

    async createSession(userId, expectedPasswordHash) {
      const user = usersById.get(userId);
      if (!user || user.password_hash !== expectedPasswordHash) throw authHttpError(401, "PS024", "Session is invalid or expired");
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

    async createConnectToken(userId, label = "session", sessionId) {
      requireUser(userId);
      const vaultIds = await this.listVaultIdsForUser(userId);
      const session = sessionsById.get(sessionId);
      if (!session || session.user_id !== userId || new Date(session.expires_at).getTime() <= Date.now()) {
        throw authHttpError(401, "PS024", "Session is invalid or expired");
      }
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

    async deleteConnectTokensForUser(userId) {
      for (const [id, row] of connectTokensById) {
        if (row.user_id === userId) {
          connectTokensById.delete(id);
          connectTokenIdByHash.delete(row.token_hash);
        }
      }
    },

    async changePassword(userId, sessionId, expectedHash, nextHash) {
      const user = requireUser(userId);
      const session = sessionsById.get(sessionId);
      await nativeMutation({command: "account-password-change", currentHash: user.password_hash,
        verifiedHash: expectedHash, nextHash, sessionExists: !!session && session.user_id === userId && new Date(session.expires_at).getTime() > Date.now()});
      if (user.password_hash !== expectedHash || !sessionsById.has(sessionId) || new Date(session.expires_at).getTime() <= Date.now()) {
        throw authHttpError(401, "PS024", "Session is invalid or expired");
      }
      user.password_hash = nextHash;
      for (const [id, row] of sessionsById) {
        if (row.user_id === userId) { sessionsById.delete(id); sessionIdByTokenHash.delete(row.token_hash); }
      }
      for (const [id, row] of connectTokensById) {
        if (row.user_id === userId) { connectTokensById.delete(id); connectTokenIdByHash.delete(row.token_hash); }
      }
    },

    async setRecoveryKey(userId, sessionId, expectedHash, recoveryHash) {
      const user = usersById.get(userId);
      const session = sessionsById.get(sessionId);
      const snapshot = () => ({command:"account-recovery-issue", currentHash:user?.password_hash,
        verifiedHash:expectedHash,recoveryHash,sessionExists:usersById.get(userId) === user && !!session &&
          sessionsById.get(sessionId) === session && session.user_id === userId && new Date(session.expires_at).getTime() > Date.now()});
      await nativeMutation(snapshot());
      // Recheck after native IPC yields; a password change or logout may have
      // revoked this authenticated snapshot in the meantime.
      if (!usersById.has(userId) || user.password_hash !== expectedHash || !sessionsById.has(sessionId) ||
          new Date(session.expires_at).getTime() <= Date.now()) throw authHttpError(401,"PS026","Invalid recovery credentials");
      user.recovery_hash = recoveryHash;
    },

    async findRecoveryByEmail(email) {
      const user = usersById.get(userIdByEmail.get(email));
      return user ? {...user} : null;
    },

    async recoverPassword(userId, expectedHash, recoveryHash, nextHash) {
      const user = usersById.get(userId);
      await nativeMutation({command:"account-recovery-consume",currentHash:user?.password_hash,
        verifiedHash:expectedHash,recoveryHash,storedRecoveryHash:user?.recovery_hash,nextHash});
      if (!user || usersById.get(userId) !== user || user.password_hash !== expectedHash || user.recovery_hash !== recoveryHash) {
        throw authHttpError(401,"PS026","Invalid recovery credentials");
      }
      // No await between the one-time check, credential change and revocation.
      user.password_hash = nextHash;
      user.recovery_hash = null;
      for (const [id,row] of sessionsById) {
        if (row.user_id === userId) { sessionsById.delete(id); sessionIdByTokenHash.delete(row.token_hash); }
      }
      for (const [id,row] of connectTokensById) {
        if (row.user_id === userId) { connectTokensById.delete(id); connectTokenIdByHash.delete(row.token_hash); }
      }
    },

    createOwnedBox(userId, connectStore, vaultId, name) {
      requireUser(userId);
      // Both map writes execute in the same stack, with no yielding adapter.
      connectStore.createOwnedBox(vaultId,name);
      memberships.push({user_id:userId,vault_id:vaultId,role:"owner",created_at:new Date().toISOString(),confirmed_at:new Date().toISOString()});
    },

    async transferOwnership(userId, sessionId, expectedHash, vaultId, targetUserId) {
      const user=usersById.get(userId);
      const session=sessionsById.get(sessionId);
      const members=memberships.filter(m=>m.vault_id===vaultId).map(m=>({...m,identity_confirmed:m.role==="owner" || !!m.confirmed_at}));
      const snapshot=JSON.stringify(memberships);
      await nativeMutation({command:"account-owner-transfer",userId,targetUserId,currentHash:user?.password_hash,verifiedHash:expectedHash,sessionExists:!!session && session.user_id===userId && new Date(session.expires_at).getTime()>Date.now(),members});
      if (!user || usersById.get(userId)!==user || user.password_hash!==expectedHash || sessionsById.get(sessionId)!==session || new Date(session.expires_at).getTime()<=Date.now()) throw authHttpError(401,"PS024","Session is invalid or expired");
      if (JSON.stringify(memberships)!==snapshot) throw authHttpError(409,"PS047","Memberships changed; retry ownership transfer");
      memberships.find(m=>m.vault_id===vaultId && m.user_id===targetUserId).role="owner";
      const previous=memberships.find(m=>m.vault_id===vaultId && m.user_id===userId);
      previous.role="member";previous.confirmed_at=new Date().toISOString();
      for (const [id,row] of connectTokensById) {
        if (row.user_id===userId || row.user_id===targetUserId) {connectTokensById.delete(id);connectTokenIdByHash.delete(row.token_hash);}
      }
    },

    async retireAccount(userId, sessionId, expectedHash, confirmationEmail, connectStore) {
      const user=usersById.get(userId);
      const session=sessionsById.get(sessionId);
      const snapshot=JSON.stringify(memberships);
      const ids=memberships.filter(m=>m.user_id===userId).map(m=>m.vault_id);
      const boxes=ids.map(id=>({id,members:memberships.filter(m=>m.vault_id===id).map(m=>({...m}))}));
      const {privateBoxIds}=await nativeMutation({command:"account-retire",userId,currentHash:user?.password_hash,verifiedHash:expectedHash,sessionExists:!!session && session.user_id===userId && new Date(session.expires_at).getTime()>Date.now(),email:user?.email,confirmationEmail,boxes});
      if (!user || usersById.get(userId)!==user || user.password_hash!==expectedHash || sessionsById.get(sessionId)!==session || new Date(session.expires_at).getTime()<=Date.now()) throw authHttpError(401,"PS024","Session is invalid or expired");
      if (JSON.stringify(memberships)!==snapshot) throw authHttpError(409,"PS049","Memberships changed; review and retry deletion");
      // The map adapter's purge is synchronous: no request interleaves between
      // the final authorization check, private data removal and account removal.
      connectStore.purgePrivateBoxes(privateBoxIds);
      for (let i=memberships.length-1;i>=0;i--) {
        if (memberships[i].user_id===userId || privateBoxIds.includes(memberships[i].vault_id)) memberships.splice(i,1);
      }
      for (let i=invitations.length-1;i>=0;i--) {
        if (invitations[i].inviter_id===userId || invitations[i].invitee_email===user.email || privateBoxIds.includes(invitations[i].vault_id)) invitations.splice(i,1);
      }
      for (const [id,row] of sessionsById) {
        if (row.user_id===userId) {sessionsById.delete(id);sessionIdByTokenHash.delete(row.token_hash);}
      }
      for (const [id,row] of connectTokensById) {
        if (row.user_id===userId) {connectTokensById.delete(id);connectTokenIdByHash.delete(row.token_hash);}
      }
      userIdByEmail.delete(user.email);usersById.delete(userId);
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
        memberships.find((m) => m.user_id === userId && m.vault_id === vaultId && (m.role === "owner" || m.confirmed_at)) ?? null
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
            identity_confirmed: m.role === "owner" || !!m.confirmed_at,
          };
        });
    },

    async countVaultOwners(vaultId) {
      return memberships.filter((m) => m.vault_id === vaultId && m.role === "owner").length;
    },

    async listSoleOwnedSharedBoxes(userId, limit) {
      const boxes = [];
      const owned = memberships.filter((m) => m.user_id === userId && m.role === "owner").map((m) => m.vault_id).sort();
      for (const id of owned) {
        const members = memberships.filter((m) => m.vault_id === id);
        const others = members.filter((m) => m.user_id !== userId);
        if (!others.length || others.some((m) => m.role === "owner")) continue;
        boxes.push({ id, members: members.map((m) => ({ user_id: m.user_id, role: m.role,
          email: usersById.get(m.user_id)?.email ?? "", identity_confirmed: m.role === "owner" || !!m.confirmed_at })) });
        if (boxes.length >= limit) break;
      }
      return boxes;
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

    async removeVaultMember(vaultId, targetUserId, actorUserId) {
      if (!memberships.some((m) => m.vault_id === vaultId && m.user_id === actorUserId && m.role === "owner")) {
        throw authHttpError(403, "PS032", "Password box owner access required");
      }
      const index = memberships.findIndex(
        (m) => m.vault_id === vaultId && m.user_id === targetUserId,
      );
      if (index === -1) {
        throw authHttpError(404, "PS035", "Member not found");
      }
      if (memberships[index].role === "owner") {
        const owners = memberships.filter((m) => m.vault_id === vaultId && m.role === "owner").length;
        if (owners <= 1) {
          throw authHttpError(400, "PS036", "Cannot remove the last owner");
        }
      }
      memberships.splice(index, 1);
      await this.deleteConnectTokensForUser(targetUserId);
    },

    async createVaultInvitation({ vaultId, inviterId, inviteeEmail, role }) {
      requireUser(inviterId);
      for (const inv of invitations) {
        if (inv.vault_id === vaultId && inv.invitee_email === inviteeEmail && inv.status === "pending" && new Date(inv.expires_at).getTime() <= Date.now()) {
          inv.status="expired"; inv.responded_at=new Date().toISOString();
        }
      }
      const memberExists = memberships.some((m) => {
        if (m.vault_id !== vaultId) return false;
        if (m.role !== "owner" && !m.confirmed_at) return false;
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
      const confirmationCode = generateToken();
      const { confirmationHash } = await nativeMutation({command: "invitation-proof", confirmationCode});
      requireUser(inviterId);
      if (!memberships.some(m=>m.vault_id===vaultId && m.user_id===inviterId && m.role==="owner")) throw authHttpError(403,"PS032","Password box owner access required");
      if (invitations.some((inv) => inv.vault_id === vaultId && inv.invitee_email === inviteeEmail && inv.status === "pending")) {
        throw authHttpError(409, "PS038", "A pending invitation already exists for this email");
      }
      const row = {
        id,
        vault_id: vaultId,
        inviter_id: inviterId,
        invitee_email: inviteeEmail,
        role,
        status: "pending",
        expires_at: expiresAt,
        created_at: createdAt,
        confirmation_hash: confirmationHash,
      };
      invitations.push(row);
      return { ...row, confirmationCode };
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

    async acceptVaultInvitation(invitationId, userId, confirmationCode) {
      const user = requireUser(userId);
      const invitation = invitations.find((inv) => inv.id === invitationId);
      const inviter = memberships.find((m) => m.user_id === invitation?.inviter_id && m.vault_id === invitation?.vault_id);
      const result = await nativeMutation({command: "invitation-accept", confirmationCode, email: user.email,
        inviterRole: inviter?.role, nowMs: Date.now(), invitation: invitation ? {...invitation, expiresMs: new Date(invitation.expires_at).getTime()} : null});
      if (usersById.get(userId)!==user || !invitations.includes(invitation)) throw authHttpError(401,"PS024","Session is invalid or expired");
      // Native processing yields to other requests. Recheck mutable state before
      // the synchronous commit so revoke/decline/removal can never be overwritten.
      if (invitation.status !== "pending") throw authHttpError(404, "PS039", "Invitation not found");
      if (new Date(invitation.expires_at).getTime() <= Date.now()) throw authHttpError(410, "PS040", "Invitation has expired");
      if (!memberships.some((m) => m.user_id === invitation.inviter_id && m.vault_id === invitation.vault_id && m.role === "owner")) {
        throw authHttpError(403, "PS032", "Invitation owner no longer has access");
      }
      if (!memberships.some((m) => m.user_id === userId && m.vault_id === invitation.vault_id)) {
        memberships.push({ user_id: userId, vault_id: invitation.vault_id, role: result.role, created_at: new Date().toISOString(), confirmed_at: new Date().toISOString() });
      }
      const membership=memberships.find((m)=>m.user_id===userId && m.vault_id===invitation.vault_id);
      membership.confirmed_at=new Date().toISOString();
      invitation.status = "accepted";
      invitation.responded_at = new Date().toISOString();
      return result;
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
