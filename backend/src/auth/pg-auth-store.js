import { randomUUID } from "node:crypto";
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
  return {
    async migrate() {
      await applySchemaWithAdvisoryLock(pool, AUTH_MIGRATION_LOCK_KEY, AUTH_SCHEMA_SQL);
      await applySchemaWithAdvisoryLock(pool, AUTH_MIGRATION_LOCK_KEY,
        await nativeMutation({command:"sharing-schema"}));
      await applySchemaWithAdvisoryLock(pool, AUTH_MIGRATION_LOCK_KEY,
        await nativeMutation({command:"account-recovery-schema"}));
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
      await pool.query(
        `INSERT INTO vault_memberships (user_id, vault_id, role, confirmed_at)
         VALUES ($1, $2, $3, CASE WHEN $3='owner' THEN NOW() ELSE NULL END)
         ON CONFLICT (user_id, vault_id) DO NOTHING`,
        [userId, vaultId, role],
      );
    },

    async createOwnedBox(userId,_connectStore,vaultId,name) {
      const client=await pool.connect();
      try {
        await client.query("BEGIN");
        const user=await client.query("SELECT id FROM users WHERE id=$1 FOR SHARE",[userId]);
        if (!user.rowCount) throw authHttpError(401,"PS024","Session is invalid or expired");
        await client.query("INSERT INTO connect_vaults(id,name) VALUES($1,$2)",[vaultId,name]);
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
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT id FROM connect_vaults WHERE id=$1 FOR UPDATE",[vaultId]);
        const user = (await client.query("SELECT password_hash FROM users WHERE id=$1 FOR UPDATE",[userId])).rows[0];
        const session = await client.query("SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND expires_at > clock_timestamp() FOR SHARE",[sessionId,userId]);
        const members = (await client.query("SELECT user_id,role,passshare_membership_active(role,confirmed_at) AS identity_confirmed FROM vault_memberships WHERE vault_id=$1 FOR UPDATE",[vaultId])).rows;
        await nativeMutation({command:"account-owner-transfer",userId,targetUserId,currentHash:user?.password_hash,verifiedHash:expectedHash,sessionExists:session.rowCount>0,members});
        await client.query("UPDATE vault_memberships SET role=CASE WHEN user_id=$2 THEN 'owner' ELSE 'member' END,confirmed_at=COALESCE(confirmed_at,NOW()) WHERE vault_id=$1 AND user_id IN ($2,$3)",[vaultId,targetUserId,userId]);
        await client.query("DELETE FROM connect_tokens WHERE user_id IN ($1,$2)",[userId,targetUserId]);
        await client.query("COMMIT");
      } catch(error) { await client.query("ROLLBACK").catch(()=>{});throw error; }
      finally { client.release(); }
    },

    async retireAccount(userId, sessionId, expectedHash, confirmationEmail) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Match sharing's box-before-user lock order. A late membership or box
        // creation is detected again before any destructive writes.
        const locked = (await client.query("SELECT cv.id FROM connect_vaults cv WHERE cv.id IN (SELECT vault_id FROM vault_memberships WHERE user_id=$1) ORDER BY cv.id FOR UPDATE",[userId])).rows.map(row=>row.id);
        const user = (await client.query("SELECT email,password_hash FROM users WHERE id=$1 FOR UPDATE",[userId])).rows[0];
        const session = await client.query("SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND expires_at > clock_timestamp() FOR SHARE",[sessionId,userId]);
        const current = (await client.query("SELECT vault_id FROM vault_memberships WHERE user_id=$1 ORDER BY vault_id",[userId])).rows.map(row=>row.vault_id);
        if (JSON.stringify(locked) !== JSON.stringify(current)) throw authHttpError(409,"PS049","Password box memberships changed; review and retry deletion");
        const boxes=[];
        for (const id of locked) {
          const members=(await client.query("SELECT user_id,role FROM vault_memberships WHERE vault_id=$1 FOR UPDATE",[id])).rows;
          boxes.push({id,members});
        }
        const {privateBoxIds}=await nativeMutation({command:"account-retire",userId,currentHash:user?.password_hash,verifiedHash:expectedHash,sessionExists:session.rowCount>0,email:user?.email,confirmationEmail,boxes});
        await client.query("DELETE FROM connect_vaults WHERE id=ANY($1::varchar[])",[privateBoxIds]);
        await client.query("DELETE FROM mutation_operations WHERE actor=$1 OR resource=ANY($2::text[])",[userId,privateBoxIds]);
        await client.query("DELETE FROM vault_invitations WHERE invitee_email=$1",[user.email]);
        await client.query("DELETE FROM login_failures WHERE email=$1",[user.email]);
        await client.query("DELETE FROM users WHERE id=$1",[userId]);
        await client.query("COMMIT");
      } catch(error) { await client.query("ROLLBACK").catch(()=>{});throw error; }
      finally { client.release(); }
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

    async removeVaultMember(vaultId, targetUserId, actorUserId) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT id FROM connect_vaults WHERE id = $1 FOR UPDATE", [vaultId]);
        const actor = (await client.query(
          "SELECT role FROM vault_memberships WHERE vault_id = $1 AND user_id = $2", [vaultId, actorUserId])).rows[0];
        if (actor?.role !== "owner") throw authHttpError(403, "PS032", "Password box owner access required");
        const membership = (await client.query(
          "SELECT role FROM vault_memberships WHERE vault_id = $1 AND user_id = $2", [vaultId, targetUserId])).rows[0];
        if (!membership) throw authHttpError(404, "PS035", "Member not found");
        if (membership.role === "owner") {
          const owners = (await client.query(
            "SELECT COUNT(*)::int AS count FROM vault_memberships WHERE vault_id = $1 AND role = 'owner'", [vaultId])).rows[0].count;
          if (owners <= 1) throw authHttpError(400, "PS036", "Cannot remove the last owner");
        }
        await client.query("DELETE FROM vault_memberships WHERE vault_id = $1 AND user_id = $2", [vaultId, targetUserId]);
        await client.query("DELETE FROM connect_tokens WHERE user_id = $1", [targetUserId]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async createVaultInvitation({ vaultId, inviterId, inviteeEmail, role }) {
      await pool.query("SELECT passshare_expire_invites($1,$2)", [vaultId,inviteeEmail]);
      const existingMember = await pool.query(
        `SELECT 1 FROM vault_memberships vm
         JOIN users u ON u.id = vm.user_id
         WHERE vm.vault_id = $1 AND u.email = $2 AND passshare_membership_active(vm.role,vm.confirmed_at)`,
        [vaultId, inviteeEmail],
      );
      if (existingMember.rowCount > 0) {
        throw authHttpError(409, "PS037", "User is already a member of this password box");
      }

      const id = randomUUID();
      const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
      const confirmationCode = generateToken();
      const { confirmationHash } = await nativeMutation({command: "invitation-proof", confirmationCode});
      const client=await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT id FROM connect_vaults WHERE id=$1 FOR UPDATE",[vaultId]);
        const owner=await client.query("SELECT u.id FROM users u JOIN vault_memberships vm ON vm.user_id=u.id WHERE u.id=$1 AND vm.vault_id=$2 AND vm.role='owner' FOR SHARE OF u,vm",[inviterId,vaultId]);
        if (!owner.rowCount) throw authHttpError(403,"PS032","Password box owner access required");
        await client.query(
          `INSERT INTO vault_invitations (id, vault_id, inviter_id, invitee_email, role, expires_at, confirmation_hash)
           VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7)`,
          [id, vaultId, inviterId, inviteeEmail, role, expiresAt.toISOString(), confirmationHash],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(()=>{});
        if (error && typeof error === "object" && "code" in error && error.code === "23505") {
          throw authHttpError(409, "PS038", "A pending invitation already exists for this email");
        }
        throw error;
      } finally {client.release();}

      return {
        id,
        vault_id: vaultId,
        inviter_id: inviterId,
        invitee_email: inviteeEmail,
        role,
        status: "pending",
        expires_at: expiresAt.toISOString(),
        confirmationCode,
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

    async acceptVaultInvitation(invitationId, userId, confirmationCode) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Serialize membership changes on the box, then invitation responses on
        // the invitation. A revoked row is read only after the revoker commits.
        await client.query(
          `SELECT cv.id FROM connect_vaults cv
           JOIN vault_invitations vi ON vi.vault_id = cv.id
           WHERE vi.id = $1 FOR UPDATE OF cv`, [invitationId]);
        const row = (await client.query(
          "SELECT * FROM vault_invitations WHERE id = $1 FOR UPDATE", [invitationId])).rows[0];
        const user = (await client.query("SELECT email FROM users WHERE id = $1", [userId])).rows[0];
        if (!user) throw authHttpError(404, "PS022", "User not found");
        const inviter = row ? (await client.query(
          "SELECT role FROM vault_memberships WHERE vault_id = $1 AND user_id = $2",
          [row.vault_id, row.inviter_id])).rows[0] : null;
        const result = await nativeMutation({command: "invitation-accept", confirmationCode, email: user.email,
          inviterRole: inviter?.role, nowMs: Date.now(), invitation: row ? {...row, expiresMs: new Date(row.expires_at).getTime()} : null});
        const updated = await client.query(
          `UPDATE vault_invitations SET status = 'accepted', responded_at = NOW()
           WHERE id = $1 AND status = 'pending' AND expires_at > clock_timestamp() RETURNING id`, [invitationId]);
        if (!updated.rowCount) throw authHttpError(410, "PS040", "Invitation has expired");
        await client.query(
          `INSERT INTO vault_memberships (user_id, vault_id, role, confirmed_at) VALUES ($1, $2, $3, NOW())
           ON CONFLICT (user_id, vault_id) DO UPDATE SET confirmed_at=NOW() WHERE vault_memberships.role='member'`, [userId, row.vault_id, result.role]);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
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
