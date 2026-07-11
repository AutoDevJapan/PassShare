import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
  DEFAULT_CLIPBOARD_CLEAR_SECONDS,
  copyTextWithAutoClear,
} from "../../../shared/ui/clipboard-auto-clear.ts";

// The popup copies secrets through the shared `copyTextWithAutoClear` helper so
// the extension keeps clipboard parity with desktop/mobile/web. These tests
// exercise that contract in the environment the popup runs in (a document with
// `window` timers and `navigator.clipboard`) to prove the auto-clear fires.

type ClipboardStub = {
  value: string;
  clipboard: {
    writeText: (text: string) => Promise<void>;
    readText: () => Promise<string>;
  };
};

function installClipboard(): ClipboardStub {
  const state: ClipboardStub = {
    value: "",
    clipboard: {
      writeText: async (text: string) => {
        state.value = text;
      },
      readText: async () => state.value,
    },
  };

  Object.defineProperty(globalThis, "window", {
    value: globalThis,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: state.clipboard },
    configurable: true,
    writable: true,
  });

  return state;
}

// Let the microtasks queued by the timer callback (readText → writeText) settle.
// `setImmediate` stays real (only `setTimeout` is mocked), so awaiting it drains
// the microtask queue deterministically instead of guessing a hop count.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("copyTextWithAutoClear (extension popup clipboard)", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout"] });
  });

  afterEach(() => {
    mock.timers.reset();
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "navigator");
  });

  // Each test uses a distinct secret: the shared helper keys its pending clear
  // timers by the copied text in a module-level map, so reusing one string would
  // leak timer state across tests.
  it("writes the secret to the clipboard immediately", async () => {
    const state = installClipboard();

    await copyTextWithAutoClear("secret-write");

    assert.equal(state.value, "secret-write");
  });

  it("clears the clipboard after the default delay", async () => {
    const state = installClipboard();

    await copyTextWithAutoClear("secret-clear");
    assert.equal(state.value, "secret-clear");

    mock.timers.tick(DEFAULT_CLIPBOARD_CLEAR_SECONDS * 1000);
    await flushMicrotasks();

    assert.equal(state.value, "");
  });

  it("does not clear before the delay elapses", async () => {
    const state = installClipboard();

    await copyTextWithAutoClear("secret-early");

    mock.timers.tick(DEFAULT_CLIPBOARD_CLEAR_SECONDS * 1000 - 1);
    await flushMicrotasks();

    assert.equal(state.value, "secret-early");
  });

  it("leaves the clipboard untouched when the content changed", async () => {
    const state = installClipboard();

    await copyTextWithAutoClear("secret-changed");
    // Simulate the user copying something else before the timer fires.
    state.value = "unrelated";

    mock.timers.tick(DEFAULT_CLIPBOARD_CLEAR_SECONDS * 1000);
    await flushMicrotasks();

    assert.equal(state.value, "unrelated");
  });
});
