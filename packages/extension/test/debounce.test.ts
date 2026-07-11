import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { debounce } from "../src/lib/debounce.ts";

describe("debounce", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout"] });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  it("invokes the function only once for a burst of calls", () => {
    let calls = 0;
    const fn = debounce(() => {
      calls += 1;
    }, 150);

    fn();
    fn();
    fn();
    assert.equal(calls, 0);

    mock.timers.tick(150);
    assert.equal(calls, 1);
  });

  it("passes the latest arguments through", () => {
    const seen: number[] = [];
    const fn = debounce((value: number) => {
      seen.push(value);
    }, 100);

    fn(1);
    fn(2);
    fn(3);
    mock.timers.tick(100);
    assert.deepEqual(seen, [3]);
  });

  it("cancel() prevents a pending invocation", () => {
    let calls = 0;
    const fn = debounce(() => {
      calls += 1;
    }, 100);

    fn();
    fn.cancel();
    mock.timers.tick(100);
    assert.equal(calls, 0);
  });

  it("allows a new invocation after the window elapses", () => {
    let calls = 0;
    const fn = debounce(() => {
      calls += 1;
    }, 100);

    fn();
    mock.timers.tick(100);
    fn();
    mock.timers.tick(100);
    assert.equal(calls, 2);
  });
});
