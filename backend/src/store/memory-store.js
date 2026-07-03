import { generateConnectId, isValidConnectId, nowIso, rowToVault, toItemOverview } from "../lib/connect.js";
import { patchDocument } from "../lib/json-patch.js";
import { connectHttpError } from "../middleware/connect-errors.js";

/**
 * @typedef {object} ConnectStore
 * @property {() => Promise<void>} migrate
 * @property {() => Promise<object[]>} listVaults
 * @property {(vaultId: string) => Promise<object|null>} getVault
 * @property {(vaultId: string) => Promise<object[]>} listItemOverviews
 * @property {(vaultId: string, itemId: string) => Promise<object|null>} getItem
 * @property {(vaultId: string, body: object) => Promise<object>} createItem
 * @property {(vaultId: string, itemId: string, body: object) => Promise<object>} replaceItem
 * @property {(vaultId: string, itemId: string, patches: object[]) => Promise<object>} patchItem
 * @property {(vaultId: string, itemId: string) => Promise<void>} deleteItem
 * @property {(vaultId: string, itemId: string, fileId: string) => Promise<object|null>} getFileMeta
 * @property {(vaultId: string, itemId: string, fileId: string) => Promise<Buffer|null>} getFileContent
 * @property {(vaultId: string, itemId: string, input: { name?: string, content?: Buffer }) => Promise<object>} createFile
 * @property {(vaultId: string, itemId: string, fileId: string) => Promise<void>} deleteFile
 * @property {(input: { id?: string, name: string, description?: string, type?: string }) => Promise<string>} createVault
 */

/** @returns {ConnectStore} */
export function createMemoryStore() {
  /** @type {Map<string, object>} */
  const vaults = new Map();
  /** @type {Map<string, object>} */
  const items = new Map();
  /** @type {Map<string, { meta: object, content: Buffer|null }>} */
  const files = new Map();

  async function countItems(vaultId) {
    let count = 0;
    for (const item of items.values()) {
      if (item.vault_id === vaultId) count += 1;
    }
    return count;
  }

  async function requireVault(vaultId) {
    if (!isValidConnectId(vaultId)) {
      throw connectHttpError(400, "PS009: Invalid vault id format");
    }
    const vault = vaults.get(vaultId);
    if (!vault) {
      throw connectHttpError(404, "PS012: Vault not found");
    }
    return vault;
  }

  async function requireItem(vaultId, itemId) {
    await requireVault(vaultId);
    if (!isValidConnectId(itemId)) {
      throw connectHttpError(400, "PS009: Invalid item id format");
    }
    const row = items.get(itemId);
    if (!row || row.vault_id !== vaultId) {
      throw connectHttpError(404, "PS007: Item not found");
    }
    return row;
  }

  return {
    async migrate() {},

    async listVaults() {
      const result = [];
      for (const vault of vaults.values()) {
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
      const overviews = [];
      for (const row of items.values()) {
        if (row.vault_id === vaultId) {
          overviews.push(toItemOverview(row.document));
        }
      }
      return overviews;
    },

    async getItem(vaultId, itemId) {
      const row = await requireItem(vaultId, itemId);
      return row.document;
    },

    async createItem(vaultId, body) {
      await requireVault(vaultId);
      const requestedId = typeof body.id === "string" && isValidConnectId(body.id) ? body.id : null;
      if (requestedId && items.has(requestedId)) {
        throw connectHttpError(409, "PS015: Item already exists");
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
      items.set(id, {
        id,
        vault_id: vaultId,
        document,
        created_at: now,
        updated_at: now,
      });
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
      row.document = document;
      row.updated_at = now;
      items.set(itemId, row);
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
      row.document = patched;
      row.updated_at = patched.updatedAt;
      items.set(itemId, row);
      return patched;
    },

    async deleteItem(vaultId, itemId) {
      await requireItem(vaultId, itemId);
      items.delete(itemId);
      for (const [fileId, file] of files.entries()) {
        if (file.meta.item_id === itemId) {
          files.delete(fileId);
        }
      }
    },

    async getFileMeta(vaultId, itemId, fileId) {
      await requireItem(vaultId, itemId);
      if (!isValidConnectId(fileId)) {
        throw connectHttpError(400, "PS009: Invalid file id format");
      }
      const file = files.get(fileId);
      if (!file || file.meta.item_id !== itemId) {
        throw connectHttpError(404, "PS014: File not found");
      }
      return file.meta;
    },

    async getFileContent(vaultId, itemId, fileId) {
      await requireItem(vaultId, itemId);
      const file = files.get(fileId);
      if (!file || file.meta.item_id !== itemId) {
        throw connectHttpError(404, "PS014: File not found");
      }
      return file.content ?? Buffer.alloc(0);
    },

    async createFile(vaultId, itemId, input = {}) {
      await requireItem(vaultId, itemId);
      const fileId = generateConnectId();
      const now = nowIso();
      const content = input.content ?? Buffer.alloc(0);
      const meta = {
        id: fileId,
        item_id: itemId,
        name: input.name ?? "attachment",
        size: content.length,
        createdAt: now,
        updatedAt: now,
      };
      files.set(fileId, { meta, content });
      return meta;
    },

    async deleteFile(vaultId, itemId, fileId) {
      await requireItem(vaultId, itemId);
      if (!isValidConnectId(fileId)) {
        throw connectHttpError(400, "PS009: Invalid file id format");
      }
      const file = files.get(fileId);
      if (!file || file.meta.item_id !== itemId) {
        throw connectHttpError(404, "PS014: File not found");
      }
      files.delete(fileId);
    },

    async createVault({ id, name, description = "", type = "USER_CREATED" }) {
      const vaultId = id ?? generateConnectId();
      const now = nowIso();
      vaults.set(vaultId, {
        id: vaultId,
        name,
        description,
        type,
        content_version: 1,
        attribute_version: 1,
        created_at: now,
        updated_at: now,
      });
      return vaultId;
    },

    /** Test helper */
    seedVault(vault) {
      vaults.set(vault.id, vault);
    },

    /** Test helper */
    seedItem(row) {
      items.set(row.id, row);
    },

    /** Test helper */
    seedFile(fileId, meta, content) {
      files.set(fileId, { meta, content });
    },
  };
}
