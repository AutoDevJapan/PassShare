import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { AUTH_ROUTE_WINDOW_MS, AUTH_ROUTE_MAX_REQUESTS } from "./rate-limit-constants.js";
import { isValidConnectId } from "../lib/connect.js";
import { requireCsrf } from "./csrf.js";
import { authHttpError, sendAuthError } from "./errors.js";
import { requireSession } from "./session.js";
import {
  parseInviteRole,
  parseMemberRole,
  requireVaultMembership,
  requireVaultOwner,
} from "./vault-access.js";
import { parseEmail } from "./validation.js";

/**
 * @param {object} deps
 * @param {import('./index.js').AuthStore} deps.authStore
 * @param {import('../store/memory-store.js').ConnectStore} deps.connectStore
 */
export function createShareRouter({ authStore, connectStore }) {
  const router = Router({ mergeParams: true });
  router.use(rateLimit({windowMs:AUTH_ROUTE_WINDOW_MS,limit:AUTH_ROUTE_MAX_REQUESTS,
    standardHeaders:"draft-6",legacyHeaders:false,
    handler:(_req,_res,next)=>next(authHttpError(429,"PS029","Too many requests. Try again later."))}));
  const sessionGuard = requireSession(authStore);

  router.get("/members", sessionGuard, async (req, res) => {
    try {
      const vaultId = parseVaultId(req.params.vaultId);
      await assertVaultExists(connectStore, vaultId);
      await requireVaultMembership(authStore, req.auth.userId, vaultId);

      const rows = await authStore.listVaultMembers(vaultId);
      res.json({
        members: rows.map((row) => ({
          userId: row.user_id,
          email: row.email,
          role: row.role,
          joinedAt: row.created_at,
          identityConfirmed: row.identity_confirmed,
        })),
      });
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  router.patch("/members/:userId", sessionGuard, requireCsrf, async (req, res) => {
    try {
      const vaultId = parseVaultId(req.params.vaultId);
      const targetUserId = req.params.userId;
      await assertVaultExists(connectStore, vaultId);
      await requireVaultOwner(authStore, req.auth.userId, vaultId);

      const role = parseMemberRole(req.body?.role);
      await authStore.updateVaultMemberRole(vaultId, targetUserId, role, req.auth.userId, req.auth.sessionId);
      res.json({ userId: targetUserId, role });
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  router.delete("/members/:userId", sessionGuard, requireCsrf, async (req, res) => {
    try {
      const vaultId = parseVaultId(req.params.vaultId);
      const targetUserId = req.params.userId;
      await assertVaultExists(connectStore, vaultId);
      await requireVaultOwner(authStore, req.auth.userId, vaultId);

      await authStore.removeVaultMember(vaultId, targetUserId, req.auth.userId, req.auth.sessionId);
      res.status(204).end();
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  router.get("/invitations", sessionGuard, async (req, res) => {
    try {
      const vaultId = parseVaultId(req.params.vaultId);
      await assertVaultExists(connectStore, vaultId);
      await requireVaultOwner(authStore, req.auth.userId, vaultId);

      const rows = await authStore.listVaultInvitations(vaultId);
      res.json({
        invitations: rows.map((row) => ({
          id: row.id,
          email: row.invitee_email,
          role: row.role,
          expiresAt: row.expires_at,
          createdAt: row.created_at,
        })),
      });
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  router.post("/invitations", sessionGuard, requireCsrf, async (req, res) => {
    try {
      const vaultId = parseVaultId(req.params.vaultId);
      await assertVaultExists(connectStore, vaultId);
      const owner = await authStore.findUserById(req.auth.userId);
      if (!owner) {
        throw authHttpError(404, "PS022", "User not found");
      }

      await requireVaultOwner(authStore, req.auth.userId, vaultId);
      const inviteeEmail = parseEmail(req.body?.email);
      if (inviteeEmail === owner.email) {
        throw authHttpError(400, "PS042", "Cannot invite yourself");
      }
      const role = parseInviteRole(req.body?.role);

      const invitation = await authStore.createVaultInvitation({
        vaultId,
        inviterId: req.auth.userId,
        sessionId: req.auth.sessionId,
        inviteeEmail,
        role,
      });

      res.status(201).json({
        id: invitation.id,
        email: invitation.invitee_email,
        role: invitation.role,
        expiresAt: invitation.expires_at,
        confirmationCode: invitation.confirmationCode,
      });
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  router.delete("/invitations/:invitationId", sessionGuard, requireCsrf, async (req, res) => {
    try {
      const vaultId = parseVaultId(req.params.vaultId);
      await assertVaultExists(connectStore, vaultId);
      await requireVaultOwner(authStore, req.auth.userId, vaultId);

      await authStore.revokeVaultInvitation(vaultId, req.params.invitationId, req.auth.userId, req.auth.sessionId);
      res.status(204).end();
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  return router;
}

/**
 * @param {object} deps
 * @param {import('./index.js').AuthStore} deps.authStore
 * @param {import('../store/memory-store.js').ConnectStore} deps.connectStore
 */
export function createInvitationsRouter({ authStore, connectStore }) {
  const router = Router();
  router.use(rateLimit({windowMs:AUTH_ROUTE_WINDOW_MS,limit:AUTH_ROUTE_MAX_REQUESTS,
    standardHeaders:"draft-6",legacyHeaders:false,
    handler:(_req,_res,next)=>next(authHttpError(429,"PS029","Too many requests. Try again later."))}));
  const sessionGuard = requireSession(authStore);

  router.get("/", sessionGuard, async (req, res) => {
    try {
      const user = await authStore.findUserById(req.auth.userId);
      if (!user) {
        throw authHttpError(404, "PS022", "User not found");
      }

      const rows = await authStore.listUserPendingInvitations(user.email);
      const invitations = await Promise.all(
        rows.map(async (row) => {
          const vault = await connectStore.getVault(row.vault_id);
          return {
            id: row.id,
            vaultId: row.vault_id,
            vaultName: vault?.name ?? row.vault_name ?? row.vault_id,
            inviterEmail: row.inviter_email,
            role: row.role,
            expiresAt: row.expires_at,
            createdAt: row.created_at,
          };
        }),
      );
      res.json({ invitations });
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  router.post("/:invitationId/accept", sessionGuard, requireCsrf, async (req, res) => {
    try {
      const result = await authStore.acceptVaultInvitation(req.params.invitationId, req.auth.userId, req.body?.confirmationCode, req.auth.sessionId);
      res.json(result);
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  router.post("/:invitationId/decline", sessionGuard, requireCsrf, async (req, res) => {
    try {
      await authStore.declineVaultInvitation(req.params.invitationId, req.auth.userId, req.auth.sessionId);
      res.status(204).end();
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  return router;
}

/** @param {string} vaultId */
function parseVaultId(vaultId) {
  if (!isValidConnectId(vaultId)) {
    throw authHttpError(400, "PS043", "Invalid password box id");
  }
  return vaultId;
}

/**
 * @param {import('../store/memory-store.js').ConnectStore} connectStore
 * @param {string} vaultId
 */
async function assertVaultExists(connectStore, vaultId) {
  const vault = await connectStore.getVault(vaultId);
  if (!vault) {
    throw authHttpError(404, "PS044", "Password box not found");
  }
}
