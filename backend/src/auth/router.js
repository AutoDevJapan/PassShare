import { Router } from "express";
import { generateConnectId } from "../lib/connect.js";
import { isTokenAuthClient } from "./client.js";
import { clearCsrfCookie, issueCsrfToken, requireCsrf } from "./csrf.js";
import { authHttpError, sendAuthError } from "./errors.js";
import { createLoginGuard, resolveClientIp } from "./login-guard.js";
import { toMobileAuthResponse } from "./mobile-response.js";
import { hashPassword, verifyPassword } from "./password.js";
import { createInvitationsRouter, createShareRouter } from "./share-router.js";
import { clearSessionCookie, parseBearerToken, requireSession, setSessionCookie } from "./session.js";
import { parseEmail, parsePassword } from "./validation.js";

/**
 * @param {object} deps
 * @param {import('./index.js').AuthStore} deps.authStore
 * @param {import('../store/memory-store.js').ConnectStore} deps.connectStore
 * @param {string} [deps.appEnv]
 * @param {import('./login-guard-store.js').LoginGuardStore} [deps.loginGuardStore]
 *   Shared backing for the login throttle / lockout state. Defaults to a
 *   process-local in-memory store when omitted.
 */
export function createAuthRouter({ authStore, connectStore, appEnv = "local", loginGuardStore }) {
  const router = Router();
  const sessionGuard = requireSession(authStore);
  const loginGuard = createLoginGuard({ store: loginGuardStore });

  router.get("/csrf", (_req, res) => {
    const csrfToken = issueCsrfToken(res, appEnv);
    res.json({ csrfToken });
  });

  router.post("/signup", requireCsrf, async (req, res) => {
    try {
      const email = parseEmail(req.body?.email);
      const password = parsePassword(req.body?.password);
      const passwordHash = await hashPassword(password);
      const user = await authStore.createUser({ email, passwordHash });

      const vaultId = generateConnectId();
      await connectStore.createVault({
        id: vaultId,
        name: "My Password Box",
      });
      await authStore.addVaultMembership(user.id, vaultId, "owner");

      const session = await authStore.createSession(user.id);
      const connectToken = await authStore.createConnectToken(user.id);

      if (isTokenAuthClient(req)) {
        res.status(201).json(toMobileAuthResponse({ user, session, connectToken }));
        return;
      }

      setSessionCookie(res, session.sessionToken, appEnv);
      const csrfToken = issueCsrfToken(res, appEnv);
      res.status(201).json({
        user: toPublicUser(user),
        sessionExpiresAt: session.expiresAt,
        csrfToken,
      });
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  router.post("/login", requireCsrf, async (req, res) => {
    try {
      const clientIp = resolveClientIp(req);
      await loginGuard.assertIpAllowed(clientIp);
      await loginGuard.recordIpRequest(clientIp);

      const email = parseEmail(req.body?.email);
      await loginGuard.assertNotLocked(email);
      const password = parsePassword(req.body?.password);
      const user = await authStore.findUserByEmail(email);
      if (!user) {
        await loginGuard.recordFailure(email);
        throw authHttpError(401, "PS026", "Invalid email or password");
      }
      const valid = await verifyPassword(user.password_hash, password);
      if (!valid) {
        await loginGuard.recordFailure(email);
        throw authHttpError(401, "PS026", "Invalid email or password");
      }

      await loginGuard.clearFailures(email);
      const session = await authStore.createSession(user.id);
      const connectToken = await authStore.createConnectToken(user.id);

      if (isTokenAuthClient(req)) {
        res.json(toMobileAuthResponse({ user, session, connectToken }));
        return;
      }

      setSessionCookie(res, session.sessionToken, appEnv);
      const csrfToken = issueCsrfToken(res, appEnv);
      res.json({
        user: toPublicUser(user),
        sessionExpiresAt: session.expiresAt,
        csrfToken,
      });
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  router.post("/token/refresh", async (req, res) => {
    try {
      const refreshToken =
        typeof req.body?.refreshToken === "string" ? req.body.refreshToken.trim() : "";
      if (!refreshToken) {
        throw authHttpError(400, "PS030", "refreshToken is required");
      }

      const session = await authStore.findSessionByToken(refreshToken);
      if (!session) {
        throw authHttpError(401, "PS024", "Session is invalid or expired");
      }

      const expiresAt = await authStore.refreshSession(session.id);
      const connectToken = await authStore.createConnectToken(session.user_id);
      res.json({
        sessionExpiresAt: expiresAt,
        connectAccessToken: connectToken.accessToken,
        connectExpiresIn: connectToken.expiresIn,
        connectExpiresAt: connectToken.expiresAt,
      });
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  router.post("/logout", sessionGuard, requireCsrf, async (req, res) => {
    try {
      await authStore.deleteSession(req.auth.sessionId);
      // Revoke the user's Connect access tokens on logout so API access does not
      // outlive the session for up to the token TTL (#317).
      await authStore.deleteConnectTokensForUser(req.auth.userId);
      if (!parseBearerToken(req)) {
        clearSessionCookie(res, appEnv);
        clearCsrfCookie(res, appEnv);
      }
      res.status(204).end();
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  router.post("/refresh", sessionGuard, requireCsrf, async (req, res) => {
    try {
      const expiresAt = await authStore.refreshSession(req.auth.sessionId);
      res.json({ sessionExpiresAt: expiresAt });
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  router.get("/me", sessionGuard, async (req, res) => {
    try {
      const user = await authStore.findUserById(req.auth.userId);
      if (!user) {
        throw authHttpError(404, "PS022", "User not found");
      }
      res.json({ user: toPublicUser(user) });
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  router.get("/connect-token", sessionGuard, async (req, res) => {
    try {
      const token = await authStore.createConnectToken(req.auth.userId);
      res.json({
        accessToken: token.accessToken,
        expiresIn: token.expiresIn,
        expiresAt: token.expiresAt,
      });
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  router.post("/vaults", sessionGuard, requireCsrf, async (req, res) => {
    try {
      const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
      if (!name) {
        throw authHttpError(400, "PS023", "Password box name is required");
      }
      const vaultId = generateConnectId();
      await connectStore.createVault({ id: vaultId, name });
      await authStore.addVaultMembership(req.auth.userId, vaultId, "owner");
      res.status(201).json({ vaultId, name });
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  router.use("/vaults/:vaultId", createShareRouter({ authStore, connectStore }));
  router.use("/invitations", createInvitationsRouter({ authStore, connectStore }));

  router.use((err, _req, res, _next) => {
    sendAuthError(res, err);
  });

  return router;
}

/** @param {{ id: string, email: string, created_at: string }} user */
function toPublicUser(user) {
  return {
    id: user.id,
    email: user.email,
    createdAt: user.created_at,
  };
}
