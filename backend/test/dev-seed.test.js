import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { DEV_SEED, applyDevSeed, isDevSeedEnvironment } from "../src/db/dev-seed.js";
import { verifyPassword } from "../src/auth/password.js";
import { createMemoryStore } from "../src/store/memory-store.js";

describe("dev-seed", () => {
  it("targets local, dev, and preview only", () => {
    assert.equal(isDevSeedEnvironment("local"), true);
    assert.equal(isDevSeedEnvironment("dev"), true);
    assert.equal(isDevSeedEnvironment("preview"), true);
    assert.equal(isDevSeedEnvironment("stg"), false);
    assert.equal(isDevSeedEnvironment("prd"), false);
  });

  it("seeds deterministic demo user, vault, and item in memory", async () => {
    const authStore = createMemoryAuthStore();
    const connectStore = createMemoryStore();

    await applyDevSeed({ authStore, connectStore });
    await applyDevSeed({ authStore, connectStore });

    const user = await authStore.findUserByEmail(DEV_SEED.email);
    assert.ok(user);
    assert.equal(user.id, DEV_SEED.userId);

    const valid = await verifyPassword(user.password_hash, DEV_SEED.password);
    assert.equal(valid, true);

    const vaults = await connectStore.listVaults();
    assert.equal(vaults.length, 1);
    assert.equal(vaults[0].id, DEV_SEED.vaultId);
    assert.equal(vaults[0].name, DEV_SEED.vaultName);

    const vaultIds = await authStore.listVaultIdsForUser(user.id);
    assert.deepEqual(vaultIds, [DEV_SEED.vaultId]);

    const items = await connectStore.listItemOverviews(DEV_SEED.vaultId);
    assert.equal(items.length, 1);
    assert.equal(items[0].id, DEV_SEED.sampleItemId);
  });
});
