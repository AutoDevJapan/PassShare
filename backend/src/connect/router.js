import { Router } from "express";
import { isValidConnectId } from "../lib/connect.js";
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
      const item = await store.createItem(req.params.vaultUuid, req.body ?? {});
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
      const item = await store.replaceItem(
        req.params.vaultUuid,
        req.params.itemUuid,
        req.body ?? {},
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
