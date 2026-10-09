import { Router } from "express";
import { nativeMutation } from "../lib/native-mutations.js";
import { createHash } from "node:crypto";
import { rateLimit } from "express-rate-limit";
import { requireSession, parseBearerToken } from "../auth/session.js";
import { requireCsrf } from "../auth/csrf.js";
import { authHttpError, sendAuthError } from "../auth/errors.js";
import { createLoginGuard, resolveClientIp } from "../auth/login-guard.js";
import { LOGIN_IP_MAX_REQUESTS, LOGIN_IP_WINDOW_MS } from "../auth/rate-limit-constants.js";
import { verifyPassword } from "../auth/password.js";
import { parsePassword } from "../auth/validation.js";
import { applySchemaWithAdvisoryLock } from "../db/migration-lock.js";

// Mount under /api/encrypted, never under the Connect-token /v1 router.
// This additive bridge leaves the existing compatibility routes untouched.
export async function createAccountIdentityRouter({ pool, authStore, loginGuardStore, schemaReady = false }) {
  const mounted = Router();
  const router = Router({ mergeParams: true });
  const enabled = process.env.PASSSHARE_ENCRYPTED_STORAGE === "true";
  if (!enabled) return mounted;
  if (pool && !schemaReady) {
    await applySchemaWithAdvisoryLock(pool, 4820124, await nativeMutation({ command: "encrypted-schema" }));
  }
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!pool || !authStore || !loginGuardStore) {
      res.status(503).json({ error: "PS019", message: "PS019: Encrypted storage unavailable" });
      return;
    }
    next();
  });
  router.use(rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: "draft-6", legacyHeaders: false,
    handler: (_req, _res, next) => next(authHttpError(429, "PS029", "Too many requests. Try again later.")) }));
  router.use(requireSession(authStore));
  const loginGuard = createLoginGuard({ store: loginGuardStore });
  const proofThrottle = rateLimit({ windowMs: LOGIN_IP_WINDOW_MS, limit: LOGIN_IP_MAX_REQUESTS,
    standardHeaders: "draft-6", legacyHeaders: false,
    handler: (_req, _res, next) => next(authHttpError(429, "PS029", "Too many requests. Try again later.")) });
  const proofBudget = (req, res, next) => Number.isSafeInteger(req.body?.expectedVersion) && req.body.expectedVersion > 0
    ? proofThrottle(req, res, next) : next();
  const csrf = (req, res, next) => parseBearerToken(req) ? next() : requireCsrf(
    { headers: { ...req.headers, "x-passshare-client": undefined } }, res, next);
  function operation(name) {
    return async (req, res) => {
      try {
        if (Object.keys(req.query).length) throw authHttpError(400, "PS051", "Unexpected account identity selector");
        const put = name === "put";
        const publicRequest = put && req.body && !Array.isArray(req.body) && typeof req.body === "object"
          ? { ...req.body } : req.body ?? null;
        if (put && publicRequest && typeof publicRequest === "object") delete publicRequest.currentPassword;
        const plan = await nativeMutation({ command: "account-identity-plan", operation: name,
          actor: req.auth.userId, session: req.auth.sessionId,
          boxId: req.params.boxId, accountId: req.params.accountId, request: publicRequest });
        if (put && !plan.requiresReauthentication && Object.hasOwn(req.body, "currentPassword")) {
          throw authHttpError(400, "PS051", "Unexpected authentication field on initial identity creation");
        }
        let reauthenticatedEmail;
        if (plan.requiresReauthentication) {
          const ip = resolveClientIp(req);
          await loginGuard.assertIpAllowed(ip);
          await loginGuard.recordIpRequest(ip);
          const user = await authStore.findUserById(req.auth.userId);
          if (!user) throw authHttpError(401, "PS024", "Session is invalid or expired");
          await loginGuard.assertNotLocked(user.email);
          if (typeof req.body.currentPassword !== "string") {
            throw authHttpError(401, "PS026", "Reauthentication required to replace account identity bundle");
          }
          const password = parsePassword(req.body.currentPassword);
          if (!await verifyPassword(user.password_hash, password)) {
            await loginGuard.recordFailure(user.email);
            throw authHttpError(401, "PS026", "Invalid email or password");
          }
          // Only the SHA-256 credential snapshot crosses SQL. Password and
          // Argon2 login hash never cross the native boundary or bundle storage.
          plan.params[6] = createHash("sha256").update(user.password_hash).digest("hex");
          reauthenticatedEmail = user.email;
        }
        const { rows } = await pool.query(plan.sql, plan.params.map(value =>
          value !== null && typeof value === "object" ? JSON.stringify(value) : value));
        const reply = rows[0].reply;
        if (reply.status !== 200) { sendAuthError(res, reply); return; }
        if (reauthenticatedEmail) await loginGuard.clearFailures(reauthenticatedEmail).catch(() => {});
        res.json(reply.body);
      } catch (error) {
        if (error?.status) sendAuthError(res, error);
        else res.status(503).json({ error: "PS019", message: "PS019: Encrypted storage unavailable" });
      }
    };
  }
  router.get("/", (req, res) => operation(req.params.accountId === undefined ? "get" : "member-get")(req, res));
  router.put("/", (req, res, next) => req.params.accountId === undefined ? next() : next("router"), csrf, proofBudget, operation("put"));
  router.use((error, _req, res, _next) => sendAuthError(res, error));
  // Scope middleware to these paths so mounting this bridge ahead of the
  // existing encrypted router does not change its budgets or error handling.
  mounted.use("/account-identity", router);
  mounted.use("/boxes/:boxId/member-identities/:accountId", router);
  return mounted;
}

