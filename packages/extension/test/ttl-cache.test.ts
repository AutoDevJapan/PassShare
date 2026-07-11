import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TtlCache } from "../src/lib/ttl-cache.ts";

describe("TtlCache", () => {
  it("returns a stored value before it expires", () => {
    let now = 1_000;
    const cache = new TtlCache<number>(100, () => now);
    cache.set("a", 42);
    now = 1_099;
    assert.equal(cache.get("a"), 42);
  });

  it("expires a value once the TTL has elapsed", () => {
    let now = 1_000;
    const cache = new TtlCache<number>(100, () => now);
    cache.set("a", 42);
    now = 1_100;
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.size, 0);
  });

  it("returns undefined for unknown keys", () => {
    const cache = new TtlCache<number>(100);
    assert.equal(cache.get("missing"), undefined);
  });

  it("clear() invalidates every entry", () => {
    const cache = new TtlCache<string>(1_000);
    cache.set("a", "x");
    cache.set("b", "y");
    cache.clear();
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.get("b"), undefined);
    assert.equal(cache.size, 0);
  });

  it("delete() removes a single entry", () => {
    const cache = new TtlCache<string>(1_000);
    cache.set("a", "x");
    cache.set("b", "y");
    cache.delete("a");
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.get("b"), "y");
  });

  it("caches an empty array as a valid (non-repeated) result", () => {
    let now = 0;
    const cache = new TtlCache<string[]>(100, () => now);
    cache.set("host", []);
    assert.deepEqual(cache.get("host"), []);
  });
});
