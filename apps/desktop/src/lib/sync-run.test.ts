import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SyncError,
  classifySyncError,
  executeSyncTasks,
  type SyncProgress,
  type SyncTask,
} from "./sync-run.ts";

describe("classifySyncError", () => {
  it("keeps the explicit kind of a SyncError", () => {
    assert.equal(classifySyncError(new SyncError("auth", "nope")), "auth");
    assert.equal(classifySyncError(new SyncError("server", "boom")), "server");
  });

  it("treats fetch/TypeError failures as network", () => {
    assert.equal(classifySyncError(new TypeError("Failed to fetch")), "network");
    assert.equal(classifySyncError(new Error("fetch failed")), "network");
    assert.equal(classifySyncError(new Error("connect ECONNREFUSED 127.0.0.1:3000")), "network");
  });

  it("maps HTTP status codes embedded in the message", () => {
    assert.equal(classifySyncError(new Error("Connect API error 401")), "auth");
    assert.equal(classifySyncError(new Error("Connect API error 403")), "auth");
    assert.equal(classifySyncError(new Error("Connect API error 500")), "server");
    assert.equal(classifySyncError(new Error("Connect API error 503")), "server");
  });

  it("falls back to unknown for unrecognised errors", () => {
    assert.equal(classifySyncError(new Error("Connect API error 400")), "unknown");
    assert.equal(classifySyncError("weird"), "unknown");
  });
});

describe("executeSyncTasks", () => {
  const task = (
    id: string,
    direction: "push" | "pull",
    run: () => Promise<void>,
  ): SyncTask => ({ itemId: id, title: `Item ${id}`, direction, run });

  it("counts pushed/pulled successes", async () => {
    const summary = await executeSyncTasks([
      task("a", "push", async () => {}),
      task("b", "push", async () => {}),
      task("c", "pull", async () => {}),
    ]);
    assert.equal(summary.pushed, 2);
    assert.equal(summary.pulled, 1);
    assert.equal(summary.failures.length, 0);
    assert.equal(summary.outcomes.length, 3);
  });

  it("records a failing item and continues the run (non-atomic, resumable)", async () => {
    const ran: string[] = [];
    const summary = await executeSyncTasks([
      task("a", "push", async () => {
        ran.push("a");
      }),
      task("b", "push", async () => {
        ran.push("b");
        throw new Error("Connect API error 500");
      }),
      task("c", "pull", async () => {
        ran.push("c");
      }),
    ]);

    // The run keeps going after item b fails.
    assert.deepEqual(ran, ["a", "b", "c"]);
    assert.equal(summary.pushed, 1);
    assert.equal(summary.pulled, 1);
    assert.equal(summary.failures.length, 1);
    assert.equal(summary.failures[0]?.itemId, "b");
    assert.equal(summary.failures[0]?.errorKind, "server");
  });

  it("classifies per-item error kinds independently", async () => {
    const summary = await executeSyncTasks([
      task("a", "push", async () => {
        throw new SyncError("auth", "denied");
      }),
      task("b", "pull", async () => {
        throw new TypeError("Failed to fetch");
      }),
    ]);
    assert.equal(summary.failures.length, 2);
    assert.equal(summary.outcomes[0]?.errorKind, "auth");
    assert.equal(summary.outcomes[1]?.errorKind, "network");
  });

  it("reports progress before and after each item", async () => {
    const events: SyncProgress[] = [];
    await executeSyncTasks(
      [task("a", "push", async () => {}), task("b", "pull", async () => {})],
      (progress) => events.push(progress),
    );

    // Two events per task: one "current" then one "completed".
    assert.equal(events.length, 4);
    assert.deepEqual(events[0], {
      completed: 0,
      total: 2,
      current: { title: "Item a", direction: "push" },
    });
    assert.deepEqual(events[1], { completed: 1, total: 2, current: null });
    assert.deepEqual(events[3], { completed: 2, total: 2, current: null });
  });
});
