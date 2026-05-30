import { hashPassword } from "../auth/password.js";

/** Deterministic dev data shared by local, preview, and dev environments. */
export const DEV_SEED = Object.freeze({
  userId: "00000000-0000-4000-8000-000000000001",
  email: "dev@passshare.local",
  password: "DevPassShare1!",
  vaultId: "abcdefghijklmnopqrstuvwxyz",
  vaultName: "Demo Password Box",
  sampleItemId: "demoabcdefghijklmnopqrstuv",
  sampleItemTitle: "Demo Login",
});

/** @param {string} appEnv */
export function isDevSeedEnvironment(appEnv) {
  return appEnv === "local" || appEnv === "dev" || appEnv === "preview";
}

/**
 * @param {{
 *   pool?: import('pg').Pool | null,
 *   authStore?: import('../auth/index.js').AuthStore,
 *   connectStore?: import('../store/memory-store.js').ConnectStore,
 * }} deps
 */
export async function applyDevSeed({ pool, authStore, connectStore }) {
  if (pool) {
    await seedPostgres(pool);
    return;
  }

  if (authStore && connectStore) {
    await seedMemory(authStore, connectStore);
  }
}

/** @param {import('pg').Pool} pool */
async function seedPostgres(pool) {
  const passwordHash = await hashPassword(DEV_SEED.password);
  const now = new Date().toISOString();
  const sampleDocument = buildSampleItemDocument(now);

  await pool.query("BEGIN");
  try {
    await pool.query(
      `INSERT INTO connect_vaults (id, name, description, type, content_version, attribute_version, created_at, updated_at)
       VALUES ($1, $2, '', 'USER_CREATED', 1, 1, $3::timestamptz, $4::timestamptz)
       ON CONFLICT (id) DO NOTHING`,
      [DEV_SEED.vaultId, DEV_SEED.vaultName, now, now],
    );

    await pool.query(
      `INSERT INTO users (id, email, password_hash, created_at)
       VALUES ($1, $2, $3, $4::timestamptz)
       ON CONFLICT (email) DO NOTHING`,
      [DEV_SEED.userId, DEV_SEED.email, passwordHash, now],
    );

    await pool.query(
      `INSERT INTO vault_memberships (user_id, vault_id, role, created_at)
       SELECT u.id, $2, 'owner', $3::timestamptz
       FROM users u
       WHERE u.email = $1
       ON CONFLICT (user_id, vault_id) DO NOTHING`,
      [DEV_SEED.email, DEV_SEED.vaultId, now],
    );

    await pool.query(
      `INSERT INTO connect_items (id, vault_id, document, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, $4::timestamptz, $5::timestamptz)
       ON CONFLICT (id) DO NOTHING`,
      [DEV_SEED.sampleItemId, DEV_SEED.vaultId, JSON.stringify(sampleDocument), now, now],
    );

    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}

/**
 * @param {import('../auth/index.js').AuthStore} authStore
 * @param {import('../store/memory-store.js').ConnectStore} connectStore
 */
async function seedMemory(authStore, connectStore) {
  const now = new Date().toISOString();
  let user = await authStore.findUserByEmail(DEV_SEED.email);
  if (!user) {
    const passwordHash = await hashPassword(DEV_SEED.password);
    user = await authStore.createUser({
      id: DEV_SEED.userId,
      email: DEV_SEED.email,
      passwordHash,
    });
  }

  const vaults = await connectStore.listVaults();
  if (!vaults.some((vault) => vault.id === DEV_SEED.vaultId)) {
    connectStore.seedVault({
      id: DEV_SEED.vaultId,
      name: DEV_SEED.vaultName,
      description: "",
      type: "USER_CREATED",
      content_version: 1,
      attribute_version: 1,
      created_at: now,
      updated_at: now,
    });
  }

  await authStore.addVaultMembership(user.id, DEV_SEED.vaultId, "owner");

  const items = await connectStore.listItemOverviews(DEV_SEED.vaultId);
  if (!items.some((item) => item.id === DEV_SEED.sampleItemId)) {
    await connectStore.createItem(DEV_SEED.vaultId, {
      id: DEV_SEED.sampleItemId,
      title: DEV_SEED.sampleItemTitle,
      category: "LOGIN",
      fields: [
        { label: "username", type: "STRING", purpose: "USERNAME", value: "demo" },
        { label: "password", type: "CONCEALED", purpose: "PASSWORD", value: "demo-secret" },
      ],
    });
  }
}

/** @param {string} now */
function buildSampleItemDocument(now) {
  return {
    id: DEV_SEED.sampleItemId,
    title: DEV_SEED.sampleItemTitle,
    category: "LOGIN",
    vault: { id: DEV_SEED.vaultId },
    fields: [
      { label: "username", type: "STRING", purpose: "USERNAME", value: "demo" },
      { label: "password", type: "CONCEALED", purpose: "PASSWORD", value: "demo-secret" },
    ],
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
}
