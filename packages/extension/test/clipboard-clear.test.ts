import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLIPBOARD_CLEAR_ALARM,
  CLIPBOARD_CLEAR_STATE_KEY,
  type ClipboardClearEnv,
  type ClipboardClearState,
  handleClipboardClearAlarm,
  OFFSCREEN_DOCUMENT_PATH,
  scheduleClipboardClear,
} from "../src/background/clipboard-clear.ts";
import {
  type ClipboardIo,
  clearClipboardIfHashMatches,
} from "../src/offscreen/clipboard-ops.ts";
import { sha256Hex } from "../src/lib/hash.ts";

// These tests exercise the service-worker-side clipboard auto-clear that keeps
// the wipe alive after the MV3 popup (and its `setTimeout`) is destroyed. The
// `chrome.*` surface is faked so the scheduling / alarm / offscreen policy is
// verified without a real extension runtime.

type Recorder = {
  env: ClipboardClearEnv;
  state: Map<string, ClipboardClearState>;
  alarms: Array<{ name: string; when: number }>;
  offscreen: { exists: boolean; created: number; closed: number };
  clearRequests: string[];
};

function makeEnv(nowMs: number, options: { hasDocument?: boolean } = {}): Recorder {
  const state = new Map<string, ClipboardClearState>();
  const alarms: Recorder["alarms"] = [];
  const offscreen = { exists: options.hasDocument ?? false, created: 0, closed: 0 };
  const clearRequests: string[] = [];

  const env: ClipboardClearEnv = {
    now: () => nowMs,
    alarms: {
      create(name, alarmInfo) {
        alarms.push({ name, when: alarmInfo.when });
      },
    },
    session: {
      async get(key) {
        return state.get(key) ?? null;
      },
      async set(key, value) {
        state.set(key, value);
      },
      async remove(key) {
        state.delete(key);
      },
    },
    offscreen: {
      async hasDocument() {
        return offscreen.exists;
      },
      async create(path) {
        assert.equal(path, OFFSCREEN_DOCUMENT_PATH);
        offscreen.exists = true;
        offscreen.created += 1;
      },
      async close() {
        offscreen.exists = false;
        offscreen.closed += 1;
      },
    },
    async requestOffscreenClear(hash) {
      clearRequests.push(hash);
    },
  };

  return { env, state, alarms, offscreen, clearRequests };
}

describe("scheduleClipboardClear", () => {
  it("persists the hash and arms an alarm at now + delay", async () => {
    const rec = makeEnv(1_000);

    await scheduleClipboardClear(rec.env, "hash-a", 30);

    assert.deepEqual(rec.state.get(CLIPBOARD_CLEAR_STATE_KEY), {
      hash: "hash-a",
      clearAt: 1_000 + 30_000,
    });
    assert.deepEqual(rec.alarms, [{ name: CLIPBOARD_CLEAR_ALARM, when: 1_000 + 30_000 }]);
  });

  it("clamps the delay to the shared min/max bounds", async () => {
    const rec = makeEnv(0);

    await scheduleClipboardClear(rec.env, "hash-b", 1); // below the 5s minimum

    const stored = rec.state.get(CLIPBOARD_CLEAR_STATE_KEY);
    assert.equal(stored?.clearAt, 5_000);
  });

  it("supersedes a previous target with the latest copy", async () => {
    const rec = makeEnv(500);

    await scheduleClipboardClear(rec.env, "hash-old", 30);
    await scheduleClipboardClear(rec.env, "hash-new", 30);

    assert.equal(rec.state.get(CLIPBOARD_CLEAR_STATE_KEY)?.hash, "hash-new");
    assert.equal(rec.alarms.length, 2);
    assert.equal(rec.alarms[0].name, rec.alarms[1].name);
  });
});

describe("handleClipboardClearAlarm", () => {
  it("ignores alarms with a different name", async () => {
    const rec = makeEnv(0);
    rec.state.set(CLIPBOARD_CLEAR_STATE_KEY, { hash: "h", clearAt: 0 });

    await handleClipboardClearAlarm(rec.env, "some.other.alarm");

    assert.equal(rec.clearRequests.length, 0);
    assert.equal(rec.state.has(CLIPBOARD_CLEAR_STATE_KEY), true);
  });

  it("does nothing when no clear is pending", async () => {
    const rec = makeEnv(0);

    await handleClipboardClearAlarm(rec.env, CLIPBOARD_CLEAR_ALARM);

    assert.equal(rec.clearRequests.length, 0);
    assert.equal(rec.offscreen.created, 0);
  });

  it("creates an offscreen document, requests the clear, then closes it", async () => {
    const rec = makeEnv(0);
    await scheduleClipboardClear(rec.env, "hash-c", 30);

    await handleClipboardClearAlarm(rec.env, CLIPBOARD_CLEAR_ALARM);

    assert.deepEqual(rec.clearRequests, ["hash-c"]);
    assert.equal(rec.offscreen.created, 1);
    assert.equal(rec.offscreen.closed, 1);
    // State is consumed so a stale target can never re-fire.
    assert.equal(rec.state.has(CLIPBOARD_CLEAR_STATE_KEY), false);
  });

  it("reuses an existing offscreen document without closing it", async () => {
    const rec = makeEnv(0, { hasDocument: true });
    await scheduleClipboardClear(rec.env, "hash-d", 30);

    await handleClipboardClearAlarm(rec.env, CLIPBOARD_CLEAR_ALARM);

    assert.deepEqual(rec.clearRequests, ["hash-d"]);
    assert.equal(rec.offscreen.created, 0);
    assert.equal(rec.offscreen.closed, 0);
  });

  it("still clears the pending state when the offscreen request throws", async () => {
    const rec = makeEnv(0);
    await scheduleClipboardClear(rec.env, "hash-e", 30);
    rec.env.requestOffscreenClear = async () => {
      throw new Error("offscreen unreachable");
    };

    await assert.rejects(handleClipboardClearAlarm(rec.env, CLIPBOARD_CLEAR_ALARM));

    // The target is consumed and the freshly created document is closed even on
    // failure, so nothing leaks.
    assert.equal(rec.state.has(CLIPBOARD_CLEAR_STATE_KEY), false);
    assert.equal(rec.offscreen.closed, 1);
  });
});

describe("clearClipboardIfHashMatches", () => {
  function ioFor(initial: string): { io: ClipboardIo; get: () => string } {
    let value = initial;
    return {
      io: {
        async read() {
          return value;
        },
        async write(text) {
          value = text;
        },
      },
      get: () => value,
    };
  }

  it("wipes the clipboard when its contents still match the copied secret", async () => {
    const secret = "correct horse battery staple";
    const { io, get } = ioFor(secret);

    const cleared = await clearClipboardIfHashMatches(io, await sha256Hex(secret));

    assert.equal(cleared, true);
    assert.equal(get(), "");
  });

  it("leaves the clipboard alone when the user has copied something else", async () => {
    const { io, get } = ioFor("something the user copied later");

    const cleared = await clearClipboardIfHashMatches(io, await sha256Hex("the old secret"));

    assert.equal(cleared, false);
    assert.equal(get(), "something the user copied later");
  });

  it("does nothing for an already-empty clipboard", async () => {
    const { io } = ioFor("");

    const cleared = await clearClipboardIfHashMatches(io, await sha256Hex(""));

    assert.equal(cleared, false);
  });

  it("does not clobber the clipboard when it cannot be read", async () => {
    let value = "unknown";
    const io: ClipboardIo = {
      async read() {
        throw new Error("no clipboardRead permission");
      },
      async write(text) {
        value = text;
      },
    };

    const cleared = await clearClipboardIfHashMatches(io, await sha256Hex("secret"));

    assert.equal(cleared, false);
    assert.equal(value, "unknown");
  });
});
