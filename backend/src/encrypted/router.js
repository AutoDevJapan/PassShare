import { Router } from "express";
import { createHash } from "node:crypto";
import { rateLimit } from "express-rate-limit";
import { requireSession, parseBearerToken } from "../auth/session.js";
import { requireCsrf } from "../auth/csrf.js";
import { authHttpError, sendAuthError } from "../auth/errors.js";
import { createLoginGuard, resolveClientIp } from "../auth/login-guard.js";
import { LOGIN_IP_MAX_REQUESTS, LOGIN_IP_WINDOW_MS } from "../auth/rate-limit-constants.js";
import { verifyPassword } from "../auth/password.js";
import { parsePassword } from "../auth/validation.js";
import { nativeMutation } from "../lib/native-mutations.js";
import { applySchemaWithAdvisoryLock } from "../db/migration-lock.js";

// Transport/SQL adapter only. Ciphertext never passes through old item stores.
// PostgreSQL is required; no fallback to process-memory or plaintext storage.
export async function createEncryptedRouter({ pool, authStore, loginGuardStore }) {
  if (!pool) throw new Error("Encrypted storage requires PostgreSQL");
  await applySchemaWithAdvisoryLock(pool, 4820124, await nativeMutation({ command: "encrypted-schema" }));
  const router = Router();
  const loginGuard = createLoginGuard({ store: loginGuardStore });
  const proofThrottle = rateLimit({windowMs:LOGIN_IP_WINDOW_MS,limit:LOGIN_IP_MAX_REQUESTS,
    standardHeaders:"draft-6",legacyHeaders:false,
    handler:(_req,_res,next)=>next(authHttpError(429,"PS029","Too many requests. Try again later."))});
  const proofBudget = (req,res,next) => Number.isSafeInteger(req.body?.expectedVersion) && req.body.expectedVersion>0
    ? proofThrottle(req,res,next) : next();
  // Bound authenticated lookup/native work before checking a session. Match the
  // general auth budget; password hashing retains its separate tighter limit.
  router.use(rateLimit({windowMs:60*1000,limit:600,standardHeaders:"draft-6",legacyHeaders:false,
    handler:(_req,res)=>res.status(429).json({error:"PS029",message:"PS029: Too many requests. Try again later."})}));
  router.use(requireSession(authStore));
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  // A claimed client type does not make cookie authentication CSRF-safe.
  // Reuse the existing CSRF validator while disabling that transport shortcut.
  const csrf = (req, res, next) => parseBearerToken(req) ? next() : requireCsrf(
    { headers: { ...req.headers, "x-passshare-client": undefined } }, res, next);
  function operation(name, command = "encrypted-plan") {
    return async (req, res) => {
      try {
        let reauthenticatedEmail;
        // Authentication credentials are transport metadata, never sent to the
        // opaque Rust header validator or stored inside a key bundle.
        const ownerPut = command === "owner-key-plan" && name === "put";
        const publicRequest = ownerPut ? {...req.body} : req.body;
        if (ownerPut) delete publicRequest.currentPassword;
        const plan = await nativeMutation({ command, operation: name,
          actor: req.auth.userId, session: req.auth.sessionId,
          boxId: req.params.boxId, itemId: req.params.itemId,
          request: name === "list" ? { after: req.query.after ?? null } : ["enable", "put", "setup"].includes(name) ? publicRequest : null });
        if (ownerPut && !plan.requiresReauthentication && Object.hasOwn(req.body,"currentPassword")) {
          throw authHttpError(400,"PS051","Unexpected authentication field on initial key creation");
        }
        if (plan.requiresReauthentication) {
          const ip=resolveClientIp(req);
          await loginGuard.assertIpAllowed(ip);await loginGuard.recordIpRequest(ip);
          const user=await authStore.findUserById(req.auth.userId);
          if (!user) throw authHttpError(401,"PS024","Session is invalid or expired");
          await loginGuard.assertNotLocked(user.email);
          if (typeof req.body.currentPassword !== "string") throw authHttpError(401,"PS026","Reauthentication required to replace owner key bundle");
          const password=parsePassword(req.body.currentPassword);
          if (!await verifyPassword(user.password_hash,password)) {
            await loginGuard.recordFailure(user.email);
            throw authHttpError(401,"PS026","Invalid email or password");
          }
          // SQL rechecks this snapshot under the box/user locks before CAS.
          plan.params[7]=createHash("sha256").update(user.password_hash).digest("hex");
          reauthenticatedEmail=user.email;
        }
        const { rows } = await pool.query(plan.sql, plan.params.map((value) =>
          value !== null && typeof value === "object" ? JSON.stringify(value) : value));
        const reply = rows[0].reply;
        if (reply.status !== 200) { sendAuthError(res, reply); return; }
        if (reauthenticatedEmail) await loginGuard.clearFailures(reauthenticatedEmail).catch(()=>{});
        res.json(reply.body);
      } catch (error) {
        if (error?.status) sendAuthError(res, error);
        else res.status(503).json({ error: "PS019", message: "PS019: Encrypted storage unavailable" });
      }
    };
  }
  router.get("/boxes/:boxId", operation("state"));
  router.post("/boxes/:boxId/enable", csrf, operation("enable"));
  router.post("/boxes/:boxId/setup", csrf, operation("setup", "encrypted-setup-plan"));
  router.get("/boxes/:boxId/items", operation("list"));
  router.get("/boxes/:boxId/items/:itemId", operation("get"));
  router.put("/boxes/:boxId/items/:itemId", csrf, operation("put"));
  router.get("/boxes/:boxId/owner-key", operation("get", "owner-key-plan"));
  router.put("/boxes/:boxId/owner-key", csrf, proofBudget, operation("put", "owner-key-plan"));
  router.use((error, _req, res, _next) => sendAuthError(res, error));
  return router;
}

// Mount on /v1/vaults/:vaultUuid BEFORE the old router. Use Express parameters
// rather than regexp URL parsing so encoding, case and slash variants cannot
// bypass the boundary. The DB trigger is authoritative for legacy writes.
export function createPlaintextBoundary({ pool }) {
  const router = Router({ mergeParams: true });
  let stateReady = false;
  router.use(rateLimit({windowMs:60*1000,limit:600,standardHeaders:"draft-6",legacyHeaders:false,
    handler:(_req,res)=>res.status(429).json({error:"PS029",message:"PS029: Too many requests. Try again later."})}));
  router.use(async (req, res, next) => {
    try {
      // Check on demand until initialized, so an instance booted with the
      // flag off observes a later migration without blocking app startup.
      if (!stateReady) {
        stateReady = (await pool.query(
          "SELECT to_regclass('encrypted_box_state') IS NOT NULL AS present")).rows[0].present;
        if (!stateReady) { next(); return; }
      }
      const { rows } = await pool.query("SELECT 1 FROM encrypted_box_state WHERE box_id=$1", [req.params.vaultUuid]);
      if (rows.length) {
        res.status(409).json({ error: "PS055", message: "PS055: Ciphertext storage required" });
        return;
      }
      next();
    } catch { res.status(503).json({ error: "PS019", message: "PS019: Encrypted storage unavailable" }); }
  });
  return router;
}
