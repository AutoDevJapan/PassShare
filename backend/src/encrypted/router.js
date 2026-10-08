import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { requireSession, parseBearerToken } from "../auth/session.js";
import { requireCsrf } from "../auth/csrf.js";
import { sendAuthError } from "../auth/errors.js";
import { nativeMutation } from "../lib/native-mutations.js";
import { applySchemaWithAdvisoryLock } from "../db/migration-lock.js";

// Transport/SQL adapter only. Ciphertext never passes through old item stores.
// PostgreSQL is required; no fallback to process-memory or plaintext storage.
export async function createEncryptedRouter({ pool, authStore }) {
  if (!pool) throw new Error("Encrypted storage requires PostgreSQL");
  await applySchemaWithAdvisoryLock(pool, 4820124, await nativeMutation({ command: "encrypted-schema" }));
  const router = Router();
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
  function operation(name) {
    return async (req, res) => {
      try {
        const plan = await nativeMutation({ command: "encrypted-plan", operation: name,
          actor: req.auth.userId, session: req.auth.sessionId,
          boxId: req.params.boxId, itemId: req.params.itemId,
          request: name === "list" ? { after: req.query.after ?? null } : ["enable", "put"].includes(name) ? req.body : null });
        const { rows } = await pool.query(plan.sql, plan.params.map((value) =>
          value !== null && typeof value === "object" ? JSON.stringify(value) : value));
        const reply = rows[0].reply;
        if (reply.status !== 200) { sendAuthError(res, reply); return; }
        res.json(reply.body);
      } catch (error) {
        if (error?.status) sendAuthError(res, error);
        else res.status(503).json({ error: "PS019", message: "PS019: Encrypted storage unavailable" });
      }
    };
  }
  router.get("/boxes/:boxId", operation("state"));
  router.post("/boxes/:boxId/enable", csrf, operation("enable"));
  router.get("/boxes/:boxId/items", operation("list"));
  router.get("/boxes/:boxId/items/:itemId", operation("get"));
  router.put("/boxes/:boxId/items/:itemId", csrf, operation("put"));
  router.use((error, _req, res, _next) => sendAuthError(res, error));
  return router;
}

// Mount on /v1/vaults/:vaultUuid BEFORE the old router. Use Express parameters
// rather than regexp URL parsing so encoding, case and slash variants cannot
// bypass the boundary. The DB trigger is authoritative for legacy writes.
export function createPlaintextBoundary({ pool }) {
  const router = Router({ mergeParams: true });
  router.use(async (req, res, next) => {
    try {
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
