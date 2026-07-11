import { applySchemaWithAdvisoryLock } from "../db/migration-lock.js";
import { SCHEMA_SQL } from "../db/schema.js";
import { generateConnectId, isValidConnectId, nowIso, rowToVault, toItemOverview } from "../lib/connect.js";
import { patchDocument } from "../lib/json-patch.js";
import { connectHttpError } from "../middleware/connect-errors.js";

// Arbitrary fixed key for the advisory lock guarding schema migration.
const MIGRATION_LOCK_KEY = 4820121;

/**
 * @param {import('pg').Pool} pool
 * @returns {import('./memory-store.js').ConnectStore}
 */
export function createPgStore(pool) {
  async function countItems(vaultId) {
    const result = await pool.query(
      "SELECT COUNT(*)::int AS count FROM connect_items WHERE vault_id = $1",
      [vaultId],
    );
    return result.rows[0]?.count ?? 0;
  }

  async function requireVault(vaultId) {
    if (!isValidConnectId(vaultId)) {
      throw connectHttpError(400, "PS009: Invalid vault id format");
    }
    const result = await pool.query("SELECT * FROM connect_vaults WHERE id = $1", [vaultId]);
    if (result.rowCount === 0) {
      throw connectHttpError(404, "PS012: Vault not found");
    }
    return result.rows[0];
  }

  async function requireItem(vaultId, itemId) {
    await requireVault(vaultId);
    if (!isValidConnectId(itemId)) {
      throw connectHttpError(400, "PS009: Invalid item id format");
    }
    const result = await pool.query(
      "SELECT * FROM connect_items WHERE id = $1 AND vault_id = $2",
      [itemId, vaultId],
    );
    if (result.rowCount === 0) {
      throw connectHttpError(404, "PS007: Item not found");
    }
    return result.rows[0];
  }

  return {
    async migrate() {
      await applySchemaWithAdvisoryLock(pool, MIGRATION_LOCK_KEY, SCHEMA_SQL);
    },

    async listVaults() {
      const vaults = await pool.query("SELECT * FROM connect_vaults ORDER BY created_at ASC");
      const result = [];
      for (const vault of vaults.rows) {
        const itemCount = await countItems(vault.id);
        result.push(rowToVault(vault, itemCount));
      }
      return result;
    },

    async getVault(vaultId) {
      const vault = await requireVault(vaultId);
      const itemCount = await countItems(vaultId);
      return rowToVault(vault, itemCount);
    },

    async listItemOverviews(vaultId) {
      await requireVault(vaultId);
      const result = await pool.query(
        "SELECT document FROM connect_items WHERE vault_id = $1 ORDER BY created_at ASC",
        [vaultId],
      );
      return result.rows.map((row) => toItemOverview(row.document));
    },

    async getItem(vaultId, itemId) {
      const row = await requireItem(vaultId, itemId);
      return row.document;
    },

    async createItem(vaultId, body) {
      await requireVault(vaultId);
      const requestedId = typeof body.id === "string" && isValidConnectId(body.id) ? body.id : null;
      if (requestedId) {
        const existing = await pool.query(
          `SELECT id FROM connect_items WHERE id = $1 LIMIT 1`,
          [requestedId],
        );
        if (existing.rowCount > 0) {
          throw connectHttpError(409, "PS015: Item already exists");
        }
      }
      const id = requestedId ?? generateConnectId();
      const now = nowIso();
      const document = {
        ...body,
        id,
        vault: { id: vaultId },
        createdAt: now,
        updatedAt: now,
        version: body.version ?? 1,
      };
      try {
        await pool.query(
          `INSERT INTO connect_items (id, vault_id, document, created_at, updated_at)
           VALUES ($1, $2, $3::jsonb, $4::timestamptz, $5::timestamptz)`,
          [id, vaultId, JSON.stringify(document), now, now],
        );
      } catch (error) {
        // Concurrent create with the same requested id: the pre-check above is not
        // atomic, so surface the unique-violation as a 409 rather than a 500.
        if (error && error.code === "23505") {
          throw connectHttpError(409, "PS015: Item already exists");
        }
        throw error;
      }
      return document;
    },

    async replaceItem(vaultId, itemId, body) {
      const row = await requireItem(vaultId, itemId);
      const now = nowIso();
      const document = {
        ...body,
        id: itemId,
        vault: { id: vaultId },
        createdAt: row.document.createdAt ?? row.created_at,
        updatedAt: now,
        version: (row.document.version ?? 1) + 1,
      };
      await pool.query(
        `UPDATE connect_items SET document = $1::jsonb, updated_at = $2::timestamptz WHERE id = $3`,
        [JSON.stringify(document), now, itemId],
      );
      return document;
    },

    async patchItem(vaultId, itemId, patches) {
      const row = await requireItem(vaultId, itemId);
      let patched;
      try {
        patched = patchDocument(row.document, patches);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid patch";
        throw connectHttpError(400, `PS013: Invalid JSON Patch — ${message}`);
      }
      patched.id = itemId;
      patched.vault = { id: vaultId };
      patched.updatedAt = nowIso();
      patched.version = (row.document.version ?? 1) + 1;
      await pool.query(
        `UPDATE connect_items SET document = $1::jsonb, updated_at = $2::timestamptz WHERE id = $3`,
        [JSON.stringify(patched), patched.updatedAt, itemId],
      );
      return patched;
    },

    async deleteItem(vaultId, itemId) {
      await requireItem(vaultId, itemId);
      await pool.query("DELETE FROM connect_items WHERE id = $1", [itemId]);
    },

    async getFileMeta(vaultId, itemId, fileId) {
      await requireItem(vaultId, itemId);
      if (!isValidConnectId(fileId)) {
        throw connectHttpError(400, "PS009: Invalid file id format");
      }
      const result = await pool.query(
        `SELECT id, item_id, name, size, created_at, updated_at
         FROM connect_item_files WHERE id = $1 AND item_id = $2`,
        [fileId, itemId],
      );
      if (result.rowCount === 0) {
        throw connectHttpError(404, "PS014: File not found");
      }
      const file = result.rows[0];
      return {
        id: file.id,
        name: file.name,
        size: Number(file.size),
        createdAt: file.created_at,
        updatedAt: file.updated_at,
      };
    },

    async getFileContent(vaultId, itemId, fileId) {
      await requireItem(vaultId, itemId);
      const result = await pool.query(
        "SELECT content FROM connect_item_files WHERE id = $1 AND item_id = $2",
        [fileId, itemId],
      );
      if (result.rowCount === 0) {
        throw connectHttpError(404, "PS014: File not found");
      }
      return result.rows[0].content ?? Buffer.alloc(0);
    },

    async createFile(vaultId, itemId, input = {}) {
      await requireItem(vaultId, itemId);
      const fileId = generateConnectId();
      const now = nowIso();
      const content = input.content ?? Buffer.alloc(0);
      const name = input.name ?? "attachment";
      await pool.query(
        `INSERT INTO connect_item_files (id, item_id, name, size, content, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz)`,
        [fileId, itemId, name, content.length, content, now, now],
      );
      return {
        id: fileId,
        name,
        size: content.length,
        createdAt: now,
        updatedAt: now,
      };
    },

    async deleteFile(vaultId, itemId, fileId) {
      await requireItem(vaultId, itemId);
      if (!isValidConnectId(fileId)) {
        throw connectHttpError(400, "PS009: Invalid file id format");
      }
      const result = await pool.query(
        "DELETE FROM connect_item_files WHERE id = $1 AND item_id = $2 RETURNING id",
        [fileId, itemId],
      );
      if (result.rowCount === 0) {
        throw connectHttpError(404, "PS014: File not found");
      }
    },

    async createVault({ id, name, description = "", type = "USER_CREATED" }) {
      const vaultId = id ?? generateConnectId();
      const now = nowIso();
      await pool.query(
        `INSERT INTO connect_vaults (id, name, description, type, content_version, attribute_version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 1, 1, $5::timestamptz, $6::timestamptz)`,
        [vaultId, name, description, type, now, now],
      );
      return vaultId;
    },
  };
}
