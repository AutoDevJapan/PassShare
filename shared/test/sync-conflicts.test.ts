import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConnectItem } from "../types/item.js";
import { detectSyncConflicts } from "../lib/sync-conflicts.ts";

const baseItem = (overrides: Partial<ConnectItem> = {}): ConnectItem => ({
  id: "abcdefghijklmnopqrstuvwxyz",
  title: "Example",
  category: "LOGIN",
  tags: [],
  favorite: false,
  username: "user",
  password: "secret",
  url: "https://example.com",
  notes: "",
  ...overrides,
});

describe("detectSyncConflicts", () => {
  it("returns empty when local and remote match", () => {
    const item = baseItem();
    const conflicts = detectSyncConflicts([item], [{ ...item }]);
    assert.equal(conflicts.length, 0);
  });

  it("detects title mismatch", () => {
    const local = baseItem();
    const remote = baseItem({ title: "Changed" });
    const conflicts = detectSyncConflicts([local], [remote]);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]?.itemId, local.id);
  });

  it("ignores items only present on one side", () => {
    const localOnly = baseItem({ id: "bcdefghijklmnopqrstuvwxyzab" });
    const remoteOnly = baseItem({ id: "cdefghijklmnopqrstuvwxyzabc" });
    const conflicts = detectSyncConflicts([localOnly], [remoteOnly]);
    assert.equal(conflicts.length, 0);
  });
});
