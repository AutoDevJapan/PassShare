import { Router } from "express";
import { isValidConnectId } from "../lib/connect.js";
import {
  map1puxItemToConnectBody,
  parse1puxBuffer,
  readRequestBodyBuffer,
} from "../lib/1pux-import.js";
import { normalizeItemBody } from "../lib/categories.js";
import { connectHttpError } from "../middleware/connect-errors.js";

/** @param {import('../store/memory-store.js').ConnectStore} store */
export function createVaultRoutes(store, options = {}) {
  const { requireVaultAccess = (_req, _res, next) => next() } = options;
  const router = Router();

  router.get("/", async (req, res, next) => {
    try {
      let vaults = await store.listVaults();
      const auth = req.connectAuth;
      if (auth && !auth.legacy && auth.vaultIds) {
        const allowed = new Set(auth.vaultIds);
        vaults = vaults.filter((vault) => allowed.has(vault.id));
      }
      res.json(vaults);
    } catch (err) {
      next(err);
    }
  });

  router.get("/:vaultUuid", requireVaultAccess, async (req, res, next) => {
    try {
      const { vaultUuid } = req.params;
      if (!isValidConnectId(vaultUuid)) {
        throw connectHttpError(400, "PS009: Invalid vault id format");
      }
      const vault = await store.getVault(vaultUuid);
      res.json(vault);
    } catch (err) {
      next(err);
    }
  });

  router.post("/:vaultUuid/imports/1pux", requireVaultAccess, async (req, res, next) => {
    try {
      const { vaultUuid } = req.params;
      if (!isValidConnectId(vaultUuid)) {
        throw connectHttpError(400, "PS009: Invalid vault id format");
      }

      const contentType = req.headers["content-type"] ?? "";
      let zipBuffer;
      if (contentType.includes("application/zip") || contentType.includes("application/octet-stream")) {
        zipBuffer = await readRequestBodyBuffer(req);
      } else if (contentType.includes("application/json")) {
        const payload = req.body ?? {};
        if (typeof payload.base64 !== "string") {
          throw connectHttpError(400, "PS017: Invalid 1PUX — expected base64 payload");
        }
        zipBuffer = Buffer.from(payload.base64, "base64");
      } else {
        throw connectHttpError(
          415,
          "PS017: Invalid 1PUX — use application/zip or application/json with base64",
        );
      }

      const sourceItems = await parse1puxBuffer(zipBuffer);
      // Reject invalid input before any item is persisted. Storage failures can
      // still leave a partial import; this is not a batch transaction.
      const bodies = sourceItems.map(map1puxItemToConnectBody);
      const created = [];
      for (const body of bodies) {
        const item = await store.createItem(vaultUuid, body);
        created.push(item);
      }

      res.status(201).json({
        imported: created.length,
        items: created,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** @param {import('../store/memory-store.js').ConnectStore} store */
export function createItemRoutes(store) {
  const router = Router({ mergeParams: true });

  router.get("/", async (req, res, next) => {
    try {
      const items = await store.listItemOverviews(req.params.vaultUuid);
      res.json(items);
    } catch (err) {
      next(err);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const body = normalizeItemBody(req.body ?? {});
      const item = await store.createItem(req.params.vaultUuid, body);
      res.status(201).json(item);
    } catch (err) {
      next(err);
    }
  });

  router.get("/:itemUuid", async (req, res, next) => {
    try {
      const item = await store.getItem(req.params.vaultUuid, req.params.itemUuid);
      res.json(item);
    } catch (err) {
      next(err);
    }
  });

  router.put("/:itemUuid", async (req, res, next) => {
    try {
      const body = normalizeItemBody(req.body ?? {});
      const item = await store.replaceItem(
        req.params.vaultUuid,
        req.params.itemUuid,
        body,
      );
      res.json(item);
    } catch (err) {
      next(err);
    }
  });

  router.patch("/:itemUuid", async (req, res, next) => {
    try {
      const contentType = req.headers["content-type"] ?? "";
      if (!contentType.includes("application/json-patch+json")) {
        throw connectHttpError(
          415,
          "PS015: PATCH requires Content-Type application/json-patch+json",
        );
      }
      const patches = Array.isArray(req.body) ? req.body : [];
      const item = await store.patchItem(
        req.params.vaultUuid,
        req.params.itemUuid,
        patches,
      );
      res.json(item);
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:itemUuid", async (req, res, next) => {
    try {
      await store.deleteItem(req.params.vaultUuid, req.params.itemUuid);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** @param {import('../store/memory-store.js').ConnectStore} store */
export function createFileRoutes(store) {
  const router = Router({ mergeParams: true });

  router.post("/", async (req, res, next) => {
    try {
      const name =
        typeof req.body?.name === "string" && req.body.name.trim() !== ""
          ? req.body.name
          : "attachment";
      let content = Buffer.alloc(0);
      if (typeof req.body?.contentBase64 === "string") {
        content = Buffer.from(req.body.contentBase64, "base64");
      } else if (typeof req.body?.content === "string") {
        content = Buffer.from(req.body.content, "utf8");
      }
      const meta = await store.createFile(req.params.vaultUuid, req.params.itemUuid, {
        name,
        content,
      });
      res.status(201).json(meta);
    } catch (err) {
      next(err);
    }
  });

  router.get("/:fileUuid", async (req, res, next) => {
    try {
      const meta = await store.getFileMeta(
        req.params.vaultUuid,
        req.params.itemUuid,
        req.params.fileUuid,
      );
      res.json(meta);
    } catch (err) {
      next(err);
    }
  });

  router.get("/:fileUuid/content", async (req, res, next) => {
    try {
      const content = await store.getFileContent(
        req.params.vaultUuid,
        req.params.itemUuid,
        req.params.fileUuid,
      );
      res.setHeader("Content-Type", "application/octet-stream");
      res.send(content);
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:fileUuid", async (req, res, next) => {
    try {
      await store.deleteFile(
        req.params.vaultUuid,
        req.params.itemUuid,
        req.params.fileUuid,
      );
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** @param {import('../store/memory-store.js').ConnectStore} store @param {object} [options] */
export function createConnectRouter(store, options = {}) {
  const { requireVaultAccess = (_req, _res, next) => next() } = options;
  const router = Router();
  router.use("/vaults", createVaultRoutes(store, { requireVaultAccess }));
  router.use(
    "/vaults/:vaultUuid/items",
    requireVaultAccess,
    createItemRoutes(store),
  );
  router.use(
    "/vaults/:vaultUuid/items/:itemUuid/files",
    requireVaultAccess,
    createFileRoutes(store),
  );
  return router;
}
