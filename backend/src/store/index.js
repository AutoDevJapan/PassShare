import pg from "pg";
import { createMemoryStore } from "./memory-store.js";
import { createPgStore, ensureDefaultVault } from "./pg-store.js";

const { Pool } = pg;

function normalizeDatabaseUrl(rawUrl) {
  if (!rawUrl) return null;
  return rawUrl.startsWith("postgres://")
    ? rawUrl.replace("postgres://", "postgresql://")
    : rawUrl;
}

/**
 * @param {import('pg').Pool | null} pool
 * @returns {Promise<import('./memory-store.js').ConnectStore>}
 */
export async function createStore(pool) {
  if (!pool) {
    const store = createMemoryStore();
    const now = new Date().toISOString();
    const vaultId = "abcdefghijklmnopqrstuvwxyz";
    store.seedVault({
      id: vaultId,
      name: "Default Password Box",
      description: "",
      type: "USER_CREATED",
      content_version: 1,
      attribute_version: 1,
      created_at: now,
      updated_at: now,
    });
    return store;
  }

  const store = createPgStore(pool);
  await store.migrate();
  await ensureDefaultVault(pool);
  return store;
}

export { normalizeDatabaseUrl, Pool };
