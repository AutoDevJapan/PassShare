import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCachedLookup } from "../src/lib/cached-lookup.ts";

describe("createCachedLookup", () => {
  it("caches results so the fetcher runs once per key within the TTL", async () => {
    let calls = 0;
    let now = 0;
    const lookup = createCachedLookup<string[]>({
      fetcher: async (key) => {
        calls += 1;
        return [key];
      },
      ttlMs: 100,
      fallback: [],
      now: () => now,
    });

    assert.deepEqual(await lookup("a"), ["a"]);
    assert.deepEqual(await lookup("a"), ["a"]);
    assert.equal(calls, 1);
  });

  it("re-fetches after the TTL expires", async () => {
    let calls = 0;
    let now = 0;
    const lookup = createCachedLookup<string[]>({
      fetcher: async (key) => {
        calls += 1;
        return [key];
      },
      ttlMs: 100,
      fallback: [],
      now: () => now,
    });

    await lookup("a");
    now = 100;
    await lookup("a");
    assert.equal(calls, 2);
  });

  it("de-duplicates concurrent lookups into a single in-flight fetch", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lookup = createCachedLookup<string[]>({
      fetcher: async (key) => {
        calls += 1;
        await gate;
        return [key];
      },
      ttlMs: 1_000,
      fallback: [],
    });

    const first = lookup("a");
    const second = lookup("a");
    release?.();
    const [a, b] = await Promise.all([first, second]);

    assert.equal(calls, 1);
    assert.deepEqual(a, ["a"]);
    assert.deepEqual(b, ["a"]);
  });

  it("does not cache a null result and returns the fallback", async () => {
    let calls = 0;
    const lookup = createCachedLookup<string[]>({
      fetcher: async () => {
        calls += 1;
        return null;
      },
      ttlMs: 1_000,
      fallback: [],
    });

    assert.deepEqual(await lookup("a"), []);
    assert.deepEqual(await lookup("a"), []);
    assert.equal(calls, 2);
  });

  it("invalidate() forces the next lookup to re-fetch", async () => {
    let calls = 0;
    const lookup = createCachedLookup<string[]>({
      fetcher: async (key) => {
        calls += 1;
        return [key];
      },
      ttlMs: 1_000,
      fallback: [],
    });

    await lookup("a");
    lookup.invalidate();
    await lookup("a");
    assert.equal(calls, 2);
  });
});
