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
