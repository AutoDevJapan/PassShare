import { randomUUID, createHash } from "node:crypto";
import { AUTH_SCHEMA_SQL } from "../db/auth-schema.js";
import { applySchemaWithAdvisoryLock } from "../db/migration-lock.js";
import { SESSION_TTL_MS, CONNECT_TOKEN_TTL_MS, INVITATION_TTL_MS } from "./constants.js";
import { authHttpError } from "./errors.js";
import { generateToken, hashToken } from "./tokens.js";
import { nativeMutation } from "../lib/native-mutations.js";

// Arbitrary fixed key for the advisory lock guarding auth schema migration.
// Distinct from the connect store's MIGRATION_LOCK_KEY so the two migrations
// do not contend on the same lock.
const AUTH_MIGRATION_LOCK_KEY = 4820122;

/**
 * @param {import('pg').Pool} pool
 * @returns {import('./index.js').AuthStore}
 */
export function createPgAuthStore(pool) {
  async function executeReply(sql, params, client = pool) {
    try {
      const reply = (await client.query(sql, params)).rows[0]?.reply;
      if (!reply || ![200, 204].includes(reply.status)) {
        if (reply?.status && reply?.code) throw authHttpError(reply.status, reply.code, reply.message);
        throw authHttpError(503, "PS019", "Encrypted membership service unavailable");
      }
      return reply.body;
    } catch (error) {
      if (error?.status) throw error;
      if (["P0015", "22003"].includes(error?.code)) throw authHttpError(409, "PS015", "Membership state conflict or safe integer limit reached");
      throw authHttpError(503, "PS019", "Encrypted membership service unavailable");
    }
  }
  const credentialSnapshot = hash => createHash("sha256").update(hash).digest("hex");
  return {
    async migrate() {
      await applySchemaWithAdvisoryLock(pool, AUTH_MIGRATION_LOCK_KEY, AUTH_SCHEMA_SQL);
      await applySchemaWithAdvisoryLock(pool, AUTH_MIGRATION_LOCK_KEY,
        await nativeMutation({command:"sharing-schema"}));
      await applySchemaWithAdvisoryLock(pool, AUTH_MIGRATION_LOCK_KEY,
        await nativeMutation({command:"account-recovery-schema"}));
      // DB fences and legacy adapters must survive a flag rollback. No box is
      // activated here; HTTP encrypted routes remain separately feature-gated.
      await applySchemaWithAdvisoryLock(pool, 4820124,
        await nativeMutation({command:"encrypted-schema"}));
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

    async createUser({ email, passwordHash, id: requestedId }) {
      const id = requestedId ?? randomUUID();
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
      // Trusted signup/seed adapter: no session exists yet. It cannot add a new
      // membership to an encrypted box; those use authenticated invitations.
      await executeReply("SELECT passshare_trusted_membership_add($1::uuid,$2::varchar,$3::text) AS reply",
        [userId,vaultId,role]);
    },
    async createOwnedBox(userId,_connectStore,vaultId,name,sessionId) {
      const client=await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("INSERT INTO connect_vaults(id,name) VALUES($1,$2)",[vaultId,name]);
        const user=await client.query("SELECT id FROM users WHERE id=$1 FOR SHARE",[userId]);
        if (!user.rowCount) throw authHttpError(401,"PS024","Session is invalid or expired");
        if (sessionId !== undefined) await executeReply("SELECT passshare_membership_lock($1::uuid,$2::uuid,$3::varchar,$1::uuid,FALSE) AS reply",
          [userId,sessionId,vaultId],client);
        await client.query("INSERT INTO vault_memberships(user_id,vault_id,role,confirmed_at) VALUES($1,$2,'owner',NOW())",[userId,vaultId]);
        await client.query("COMMIT");
      }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}
      finally{client.release();}
    },

    async listVaultIdsForUser(userId) {
      const result = await pool.query(
        "SELECT vault_id FROM vault_memberships WHERE user_id = $1 AND passshare_membership_active(role,confirmed_at) ORDER BY created_at ASC",
        [userId],
      );
      return result.rows.map((row) => row.vault_id);
    },

    async createSession(userId, expectedPasswordHash) {
      const sessionToken = generateToken();
      const tokenHash = hashToken(sessionToken);
      const id = randomUUID();
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
      const result = await pool.query(
        `INSERT INTO sessions (id, user_id, token_hash, expires_at)
         SELECT $1, u.id, $3, $4::timestamptz FROM users u
         WHERE u.id=$2 AND u.password_hash=$5 FOR SHARE OF u`,
        [id, userId, tokenHash, expiresAt.toISOString(), expectedPasswordHash],
      );
      if (!result.rowCount) throw authHttpError(401, "PS024", "Session is invalid or expired");
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

    async createConnectToken(userId, label = "session", sessionId) {
      const accessToken = generateToken();
      const tokenHash = hashToken(accessToken);
      const id = randomUUID();
      const expiresAt = new Date(Date.now() + CONNECT_TOKEN_TTL_MS);
      const client = await pool.connect();
      let vaultIds;
      try {
        await client.query("BEGIN");
        // The same user-row lock order is used by credential changes. A token
        // minted before the change is deleted; a session after it is rejected.
        await client.query("SELECT id FROM users WHERE id=$1 FOR SHARE", [userId]);
        const session = await client.query(
          "SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND expires_at > clock_timestamp() FOR SHARE",
          [sessionId, userId]);
        if (!session.rowCount) throw authHttpError(401, "PS024", "Session is invalid or expired");
        vaultIds = (await client.query(
          "SELECT vault_id FROM vault_memberships WHERE user_id=$1 AND passshare_membership_active(role,confirmed_at) ORDER BY created_at", [userId])).rows.map((row) => row.vault_id);
        await client.query(
          `INSERT INTO connect_tokens (id,user_id,token_hash,vault_ids,expires_at,label) VALUES($1,$2,$3,$4::jsonb,$5::timestamptz,$6)`,
          [id,userId,tokenHash,JSON.stringify(vaultIds),expiresAt.toISOString(),label]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally { client.release(); }
      return { accessToken, expiresAt: expiresAt.toISOString(), expiresIn: Math.floor(CONNECT_TOKEN_TTL_MS / 1000), vaultIds, tokenHash };
    },

    async changePassword(userId, sessionId, expectedHash, nextHash) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const user = (await client.query("SELECT password_hash FROM users WHERE id=$1 FOR UPDATE", [userId])).rows[0];
        const session = await client.query("SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND expires_at > clock_timestamp() FOR SHARE", [sessionId,userId]);
        await nativeMutation({command:"account-password-change", currentHash:user?.password_hash,
          verifiedHash:expectedHash, nextHash, sessionExists:session.rowCount > 0});
        await client.query("UPDATE users SET password_hash=$2 WHERE id=$1", [userId,nextHash]);
        await client.query("DELETE FROM sessions WHERE user_id=$1", [userId]);
        await client.query("DELETE FROM connect_tokens WHERE user_id=$1", [userId]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally { client.release(); }
    },
    async deleteConnectTokensForUser(userId) {
      await pool.query("DELETE FROM connect_tokens WHERE user_id = $1", [userId]);
    },

    async setRecoveryKey(userId, sessionId, expectedHash, recoveryHash) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const user = (await client.query("SELECT password_hash FROM users WHERE id=$1 FOR UPDATE",[userId])).rows[0];
        const session = await client.query("SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND expires_at > clock_timestamp() FOR SHARE",[sessionId,userId]);
        await nativeMutation({command:"account-recovery-issue",currentHash:user?.password_hash,
          verifiedHash:expectedHash,recoveryHash,sessionExists:session.rowCount > 0});
        await client.query("UPDATE users SET recovery_hash=$2 WHERE id=$1",[userId,recoveryHash]);
        await client.query("COMMIT");
      } catch(error) { await client.query("ROLLBACK").catch(()=>{}); throw error; }
      finally { client.release(); }
    },

    async findRecoveryByEmail(email) {
      return (await pool.query("SELECT id,password_hash,recovery_hash FROM users WHERE email=$1",[email])).rows[0] ?? null;
    },

    async recoverPassword(userId, expectedHash, recoveryHash, nextHash) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const user = (await client.query("SELECT password_hash,recovery_hash FROM users WHERE id=$1 FOR UPDATE",[userId])).rows[0];
        await nativeMutation({command:"account-recovery-consume",currentHash:user?.password_hash,
          verifiedHash:expectedHash,recoveryHash,storedRecoveryHash:user?.recovery_hash,nextHash});
        await client.query("UPDATE users SET password_hash=$2,recovery_hash=NULL WHERE id=$1",[userId,nextHash]);
        await client.query("DELETE FROM sessions WHERE user_id=$1",[userId]);
        await client.query("DELETE FROM connect_tokens WHERE user_id=$1",[userId]);
        await client.query("COMMIT");
      } catch(error) { await client.query("ROLLBACK").catch(()=>{}); throw error; }
      finally { client.release(); }
    },

    async transferOwnership(userId, sessionId, expectedHash, vaultId, targetUserId) {
      await executeReply("SELECT passshare_legacy_transfer($1::uuid,$2::uuid,$3::varchar,$4::uuid,$5::text) AS reply",
        [userId,sessionId,vaultId,targetUserId,credentialSnapshot(expectedHash)]);
    },

    async retireAccount(userId, sessionId, expectedHash, confirmationEmail) {
      await executeReply("SELECT passshare_legacy_retire($1::uuid,$2::uuid,$3::text,$4::text) AS reply",
        [userId,sessionId,credentialSnapshot(expectedHash),confirmationEmail]);
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
         WHERE user_id = $1 AND vault_id = $2 AND passshare_membership_active(role,confirmed_at)`,
        [userId, vaultId],
      );
      return result.rows[0] ?? null;
    },

    async listVaultMembers(vaultId) {
      const result = await pool.query(
        `SELECT vm.user_id, vm.role, vm.created_at, u.email, passshare_membership_active(vm.role,vm.confirmed_at) AS identity_confirmed
         FROM vault_memberships vm
         JOIN users u ON u.id = vm.user_id
         WHERE vm.vault_id = $1
         ORDER BY vm.created_at ASC`,
        [vaultId],
      );
      return result.rows;
    },

    // Display only: boxes where the user is an owner and no other owner exists,
    // so a confirmed member must take over before deletion. Transfer and
    // retirement re-check everything under their own locks.
    async listSoleOwnedSharedBoxes(userId, limit) {
      const ids = (await pool.query(
        `SELECT vm.vault_id FROM vault_memberships vm
         WHERE vm.user_id=$1 AND vm.role='owner'
           AND EXISTS (SELECT 1 FROM vault_memberships o WHERE o.vault_id=vm.vault_id AND o.user_id<>$1)
           AND NOT EXISTS (SELECT 1 FROM vault_memberships w WHERE w.vault_id=vm.vault_id AND w.user_id<>$1 AND w.role='owner')
         ORDER BY vm.vault_id LIMIT $2`, [userId, limit])).rows.map((row) => row.vault_id);
      if (!ids.length) return [];
      const rows = (await pool.query(
        `SELECT vm.vault_id, vm.user_id, vm.role, u.email,
                passshare_membership_active(vm.role,vm.confirmed_at) AS identity_confirmed
         FROM vault_memberships vm JOIN users u ON u.id=vm.user_id
         WHERE vm.vault_id=ANY($1::varchar[]) ORDER BY vm.vault_id, vm.created_at`, [ids])).rows;
      return ids.map((id) => ({ id, members: rows.filter((row) => row.vault_id === id).map(({ vault_id: _box, ...member }) => member) }));
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

    async updateVaultMemberRole(vaultId, targetUserId, role, actorUserId, sessionId) {
      await executeReply("SELECT passshare_legacy_member_change($1::uuid,$2::uuid,$3::varchar,$4::uuid,$5::text,$6::text) AS reply",
        [actorUserId,sessionId,vaultId,targetUserId,"role",role]);
    },

    async removeVaultMember(vaultId, targetUserId, actorUserId, sessionId) {
      await executeReply("SELECT passshare_legacy_member_change($1::uuid,$2::uuid,$3::varchar,$4::uuid,$5::text,$6::text) AS reply",
        [actorUserId,sessionId,vaultId,targetUserId,"remove",null]);
    },

    async createVaultInvitation({ vaultId, inviterId, sessionId, inviteeEmail, role }) {
      const id = randomUUID();
      const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
      const confirmationCode = generateToken();
      const {confirmationHash} = await nativeMutation({command:"invitation-proof",confirmationCode});
      await executeReply("SELECT passshare_legacy_invite_change($1::uuid,$2::uuid,$3::varchar,$4::text,$5::uuid,$6::text,$7::text,$8::timestamptz,$9::text) AS reply",
        [inviterId,sessionId,vaultId,"create",id,inviteeEmail,role,expiresAt.toISOString(),confirmationHash]);
      return {id,vault_id:vaultId,inviter_id:inviterId,invitee_email:inviteeEmail,role,status:"pending",expires_at:expiresAt.toISOString(),confirmationCode};
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

    async revokeVaultInvitation(vaultId, invitationId, userId, sessionId) {
      await executeReply("SELECT passshare_legacy_invite_change($1::uuid,$2::uuid,$3::varchar,$4::text,$5::uuid,NULL,NULL,NULL,NULL) AS reply",
        [userId,sessionId,vaultId,"revoke",invitationId]);
    },
    async acceptVaultInvitation(invitationId, userId, confirmationCode, sessionId) {
      const {confirmationHash} = await nativeMutation({command:"invitation-proof",confirmationCode});
      return executeReply("SELECT passshare_legacy_invite_accept($1::uuid,$2::uuid,$3::uuid,$4::text) AS reply",
        [userId,sessionId,invitationId,confirmationHash]);
    },

    async declineVaultInvitation(invitationId, userId, sessionId) {
      await executeReply("SELECT passshare_legacy_invite_change($1::uuid,$2::uuid,NULL,$3::text,$4::uuid,NULL,NULL,NULL,NULL) AS reply",
        [userId,sessionId,"decline",invitationId]);
    },
  };
}
