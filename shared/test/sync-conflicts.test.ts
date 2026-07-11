import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConnectItem } from "../types/item.js";
import { detectSyncConflicts, planCloudSync, resolveSyncConflicts } from "../lib/sync-conflicts.ts";

const ID_A = "abcdefghijklmnopqrstuvwxyz";
const ID_B = "bcdefghijklmnopqrstuvwxyzab";
const ID_C = "cdefghijklmnopqrstuvwxyzabc";

const baseItem = (overrides: Partial<ConnectItem> = {}): ConnectItem => ({
  id: ID_A,
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
    const localOnly = baseItem({ id: ID_B });
    const remoteOnly = baseItem({ id: ID_C });
    const conflicts = detectSyncConflicts([localOnly], [remoteOnly]);
    assert.equal(conflicts.length, 0);
  });
});

describe("resolveSyncConflicts", () => {
  it("returns empty buckets when both sides match", () => {
    const item = baseItem({ revision: 3 });
    const resolution = resolveSyncConflicts([item], [{ ...item }]);
    assert.equal(resolution.conflicts.length, 0);
    assert.equal(resolution.pushLocal.length, 0);
    assert.equal(resolution.pullRemote.length, 0);
  });

  it("auto-applies the local side when it has a higher revision", () => {
    const local = baseItem({ title: "Local newer", revision: 5 });
    const remote = baseItem({ title: "Remote stale", revision: 4 });
    const resolution = resolveSyncConflicts([local], [remote]);
    assert.equal(resolution.conflicts.length, 0);
    assert.equal(resolution.pullRemote.length, 0);
    assert.deepEqual(resolution.pushLocal, [local]);
  });

  it("auto-applies the remote side when it has a higher revision", () => {
    const local = baseItem({ title: "Local stale", revision: 4 });
    const remote = baseItem({ title: "Remote newer", revision: 5 });
    const resolution = resolveSyncConflicts([local], [remote]);
    assert.equal(resolution.conflicts.length, 0);
    assert.equal(resolution.pushLocal.length, 0);
    assert.deepEqual(resolution.pullRemote, [remote]);
  });

  it("flags a conflict when revisions match but content differs", () => {
    const local = baseItem({ title: "Local edit", revision: 7 });
    const remote = baseItem({ title: "Remote edit", revision: 7 });
    const resolution = resolveSyncConflicts([local], [remote]);
    assert.equal(resolution.pushLocal.length, 0);
    assert.equal(resolution.pullRemote.length, 0);
    assert.equal(resolution.conflicts.length, 1);
    assert.equal(resolution.conflicts[0]?.itemId, local.id);
  });

  it("falls back to updatedAt when revisions are absent", () => {
    const local = baseItem({ title: "Local newer", updatedAt: "2026-07-11T10:00:00Z" });
    const remote = baseItem({ title: "Remote older", updatedAt: "2026-07-11T09:00:00Z" });
    const localWins = resolveSyncConflicts([local], [remote]);
    assert.deepEqual(localWins.pushLocal, [local]);
    assert.equal(localWins.conflicts.length, 0);

    const remoteWins = resolveSyncConflicts([remote], [local]);
    assert.deepEqual(remoteWins.pullRemote, [local]);
    assert.equal(remoteWins.conflicts.length, 0);
  });

  it("flags a conflict when neither revision nor updatedAt can decide", () => {
    const local = baseItem({ title: "Local edit" });
    const remote = baseItem({ title: "Remote edit" });
    const resolution = resolveSyncConflicts([local], [remote]);
    assert.equal(resolution.conflicts.length, 1);
    assert.equal(resolution.pushLocal.length, 0);
    assert.equal(resolution.pullRemote.length, 0);
  });

  it("excludes one-sided items from every bucket", () => {
    const localOnly = baseItem({ id: ID_B });
    const remoteOnly = baseItem({ id: ID_C });
    const resolution = resolveSyncConflicts([localOnly], [remoteOnly]);
    assert.equal(resolution.conflicts.length, 0);
    assert.equal(resolution.pushLocal.length, 0);
    assert.equal(resolution.pullRemote.length, 0);
  });
});

describe("planCloudSync", () => {
  it("plans local-only items as create", () => {
    const localOnly = baseItem({ id: ID_B });
    const plan = planCloudSync([localOnly], []);
    assert.deepEqual(plan.create, [localOnly]);
    assert.equal(plan.overwriteRemote.length, 0);
    assert.equal(plan.pull.length, 0);
    assert.equal(plan.conflicts.length, 0);
  });

  it("plans remote-only items as pull", () => {
    const remoteOnly = baseItem({ id: ID_C });
    const plan = planCloudSync([], [remoteOnly]);
    assert.equal(plan.create.length, 0);
    assert.deepEqual(plan.pull, [remoteOnly]);
    assert.equal(plan.conflicts.length, 0);
  });

  it("plans a local-newer edit as overwriteRemote", () => {
    const local = baseItem({ title: "Local newer", revision: 5 });
    const remote = baseItem({ title: "Remote stale", revision: 4 });
    const plan = planCloudSync([local], [remote]);
    assert.deepEqual(plan.overwriteRemote, [local]);
    assert.equal(plan.create.length, 0);
    assert.equal(plan.pull.length, 0);
    assert.equal(plan.conflicts.length, 0);
  });

  it("plans a remote-newer edit as pull", () => {
    const local = baseItem({ title: "Local stale", revision: 4 });
    const remote = baseItem({ title: "Remote newer", revision: 5 });
    const plan = planCloudSync([local], [remote]);
    assert.deepEqual(plan.pull, [remote]);
    assert.equal(plan.overwriteRemote.length, 0);
    assert.equal(plan.conflicts.length, 0);
  });

  it("keeps genuine conflicts out of create/overwrite/pull", () => {
    const local = baseItem({ title: "Local edit", revision: 7 });
    const remote = baseItem({ title: "Remote edit", revision: 7 });
    const plan = planCloudSync([local], [remote]);
    assert.equal(plan.conflicts.length, 1);
    assert.equal(plan.create.length, 0);
    assert.equal(plan.overwriteRemote.length, 0);
    assert.equal(plan.pull.length, 0);
  });
});
