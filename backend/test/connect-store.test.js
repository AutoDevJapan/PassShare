import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryStore } from "../src/store/memory-store.js";

describe("connect store createItem", () => {
  it("rejects a duplicate requested id with 409 (not 500)", async () => {
    const store = createMemoryStore();
    const vaultId = await store.createVault({ name: "Test" });
    const id = "a".repeat(26); // valid ConnectId (26 lowercase)
    const body = { id, title: "First", category: "LOGIN", fields: [] };

    await store.createItem(vaultId, body);

    await assert.rejects(
      () => store.createItem(vaultId, { ...body, title: "Second" }),
      (err) => err.status === 409,
      "duplicate requested id should surface as 409",
    );
  });
});

describe("connect store versioned replacement", () => {
  it("keeps the winning edit and rejects an outdated snapshot", async () => {
    const store = createMemoryStore();
    const vaultId = await store.createVault({ name: "Concurrent edits" });
    const original = await store.createItem(vaultId, { title: "Original", fields: [], category: "LOGIN" });
    const results = await Promise.allSettled([
      store.replaceItem(vaultId, original.id, { ...original, title: "First" }),
      store.replaceItem(vaultId, original.id, { ...original, title: "Second" }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const winner = results.find((r) => r.status === "fulfilled").value;
    const rejected = results.find((r) => r.status === "rejected").reason;
    assert.equal(rejected.status, 409);
    const saved = await store.getItem(vaultId, original.id);
    assert.deepEqual(saved, winner);
    assert.equal(saved.version, 2);
    await assert.rejects(() => store.replaceItem(vaultId, original.id, original), (err) => err.status === 409);
    assert.deepEqual(await store.getItem(vaultId, original.id), winner);
  });
});
