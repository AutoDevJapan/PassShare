import { Router } from "express";
import { createHash } from "node:crypto";
import { rateLimit } from "express-rate-limit";
import { nativeMutation } from "../lib/native-mutations.js";
import { requireSession, parseBearerToken } from "../auth/session.js";
import { requireCsrf } from "../auth/csrf.js";
import { authHttpError, sendAuthError } from "../auth/errors.js";
import { createLoginGuard, resolveClientIp } from "../auth/login-guard.js";
import { LOGIN_IP_MAX_REQUESTS, LOGIN_IP_WINDOW_MS } from "../auth/rate-limit-constants.js";
import { verifyPassword } from "../auth/password.js";
import { parsePassword } from "../auth/validation.js";

// Transport and login proof only. Rust plans; PostgreSQL authorizes and mutates.
// Schema is installed by the existing encrypted router before this is mounted.
export function createSharingRotationRouter({ pool, authStore, loginGuardStore }) {
  const mounted = Router();
  if (process.env.PASSSHARE_ENCRYPTED_STORAGE !== "true") return mounted;
  const router = Router({ mergeParams: true });
  const loginGuard = createLoginGuard({ store: loginGuardStore });
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!pool || !authStore || !loginGuardStore) {
      res.status(503).json({ error: "PS019", message: "PS019: Encrypted storage unavailable" });
      return;
    }
    next();
  });
  const tooMany = (_req, _res, next) => next(authHttpError(429, "PS029", "Too many requests. Try again later."));
  router.use(rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: "draft-6", legacyHeaders: false, handler: tooMany }));
  router.use(requireSession(authStore));
  const proofThrottle = rateLimit({ windowMs: LOGIN_IP_WINDOW_MS, limit: LOGIN_IP_MAX_REQUESTS,
    standardHeaders: "draft-6", legacyHeaders: false, handler: tooMany });
  const csrf = (req, res, next) => parseBearerToken(req) ? next() : requireCsrf(
    { headers: { ...req.headers, "x-passshare-client": undefined } }, res, next);
  function handle(operation) {
    return async (req, res) => {
      try {
        const page = ["members", "items", "item"].includes(operation);
        const allowed = page ? operation === "item" ? ["revision"] : ["revision", "after"] : [];
        if (Object.keys(req.query).some(key => !allowed.includes(key))) {
          throw authHttpError(400, "PS051", "Unexpected sharing selector");
        }
        const noBody = ["grant-get", "snapshot", "members", "items", "item", "status", "abort", "grant-delete"].includes(operation);
        if (noBody && (Number(req.headers["content-length"] ?? 0) !== 0 || req.headers["transfer-encoding"] !== undefined)) {
          throw authHttpError(400, "PS051", "Unexpected body on sharing lookup or cancellation");
        }
        let request = noBody ? null : req.body ?? null;
        if (page) {
          const revision = req.query.revision;
          if (typeof revision !== "string" || !/^[1-9][0-9]*$/.test(revision) || !Number.isSafeInteger(Number(revision))
              || (req.query.after !== undefined && typeof req.query.after !== "string")) {
            throw authHttpError(400, "PS051", "Invalid sharing snapshot selector");
          }
          request = operation === "item" ? { revision: Number(revision) } : { revision: Number(revision), after: req.query.after ?? null };
        }
        // Only commit accepts a login password. All other operations pass the
        // entire body to strict Rust validation, including unexpected fields.
        if (operation === "commit" && request && typeof request === "object" && !Array.isArray(request)) {
          request = { ...request };
          delete request.currentPassword;
        }
        const command = operation.startsWith("grant-") ? "shared-grant-plan" : "encrypted-rotation-plan";
        const plan = await nativeMutation({ command, operation, actor: req.auth.userId, session: req.auth.sessionId,
          boxId: req.params.boxId, operationId: req.params.operationId, recipientId: req.params.recipientId,
          itemId: req.params.itemId, request });
        let proofEmail;
        if (plan.requiresReauthentication) {
          const ip = resolveClientIp(req);
          await loginGuard.assertIpAllowed(ip);
          await loginGuard.recordIpRequest(ip);
          const user = await authStore.findUserById(req.auth.userId);
          if (!user) throw authHttpError(401, "PS024", "Session is invalid or expired");
          await loginGuard.assertNotLocked(user.email);
          if (typeof req.body?.currentPassword !== "string") throw authHttpError(401, "PS026", "Reauthentication required to commit rotation");
          if (!await verifyPassword(user.password_hash, parsePassword(req.body.currentPassword))) {
            await loginGuard.recordFailure(user.email);
            throw authHttpError(401, "PS026", "Invalid email or password");
          }
          plan.params[7] = createHash("sha256").update(user.password_hash).digest("hex");
          proofEmail = user.email;
        }
        const { rows } = await pool.query(plan.sql, plan.params.map(value =>
          value !== null && typeof value === "object" ? JSON.stringify(value) : value));
        const reply = rows[0]?.reply;
        if (reply?.status === 204) { res.status(204).end(); return; }
        if (reply?.status !== 200) {
          if (!reply?.code || !reply?.status) throw new Error("Invalid sharing reply");
          sendAuthError(res, reply); return;
        }
        if (proofEmail) await loginGuard.clearFailures(proofEmail).catch(() => {});
        res.json(reply.body);
      } catch (error) {
        if (error?.status && error?.code) sendAuthError(res, error);
        else if (["P0015", "22003"].includes(error?.code)) sendAuthError(res, authHttpError(409, "PS015", "Sharing state conflict or safe integer limit reached"));
        else res.status(503).json({ error: "PS019", message: "PS019: Encrypted storage unavailable" });
      }
    };
  }
  // The router is scoped to each new endpoint family; unrelated encrypted
  // routes do not acquire a second rate limit or authentication budget.
  router.get("/grants/me", handle("grant-get"));
  router.put("/grants/:recipientId", csrf, handle("grant-put"));
  router.delete("/grants/:recipientId", csrf, handle("grant-delete"));
  router.get("/sharing-snapshot", handle("snapshot"));
  router.get("/sharing-snapshot/members", handle("members"));
  router.get("/sharing-snapshot/items", handle("items"));
  router.get("/sharing-snapshot/items/:itemId", handle("item"));
  router.put("/rotations/:operationId", csrf, handle("start"));
  router.put("/rotations/:operationId/items/:itemId", csrf, handle("stage-item"));
  router.put("/rotations/:operationId/grants/:recipientId", csrf, handle("stage-grant"));
  router.post("/rotations/:operationId/commit", csrf, proofThrottle, handle("commit"));
  router.get("/rotations/:operationId", handle("status"));
  router.delete("/rotations/:operationId", csrf, handle("abort"));
  router.use((error, _req, res, _next) => {
    if (error?.status && error?.code) sendAuthError(res, error);
    else res.status(503).json({ error: "PS019", message: "PS019: Encrypted storage unavailable" });
  });
  // Scope without trimming the endpoint family from the route match.
  mounted.use("/boxes/:boxId", (req, res, next) =>
    /^\/(grants|sharing-snapshot|rotations)(\/|$)/.test(req.url) ? router(req, res, next) : next());
  return mounted;
}
