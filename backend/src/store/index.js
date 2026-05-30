import pg from "pg";
import { createMemoryStore } from "./memory-store.js";
import { createPgStore } from "./pg-store.js";

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
    return createMemoryStore();
  }

  const store = createPgStore(pool);
  await store.migrate();
  return store;
}

export { normalizeDatabaseUrl, Pool };
