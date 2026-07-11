import {
  clampClipboardClearSeconds,
  DEFAULT_CLIPBOARD_CLEAR_SECONDS,
} from "@shared/ui/clipboard-auto-clear.js";

/**
 * Service-worker-driven clipboard auto-clear.
 *
 * The popup's own `setTimeout` clear (see the shared `copyTextWithAutoClear`)
 * is destroyed the moment the MV3 popup closes — which is exactly the common
 * "copy password → click page → paste" flow. To make the clear survive the
 * popup (and even the service worker being spun down), we schedule it with
 * `chrome.alarms` and persist the target in `chrome.storage.session`. When the
 * alarm fires, an offscreen document does the actual clipboard read/write,
 * since a service worker cannot reach `navigator.clipboard`.
 *
 * Only a SHA-256 hash of the secret is ever stored or messaged; the plaintext
 * stays in the popup and the OS clipboard.
 */

export const CLIPBOARD_CLEAR_ALARM = "passshare.clipboardClear";
export const CLIPBOARD_CLEAR_STATE_KEY = "passshare.clipboardClearState";
export const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";

export type ClipboardClearState = {
  hash: string;
  clearAt: number;
};

/**
 * The slice of the `chrome.*` surface this module needs, injected so the logic
 * is unit-testable with in-memory fakes instead of the real extension APIs.
 */
export interface ClipboardClearEnv {
  now(): number;
  alarms: {
    create(name: string, alarmInfo: { when: number }): void;
  };
  session: {
    get(key: string): Promise<ClipboardClearState | null>;
    set(key: string, value: ClipboardClearState): Promise<void>;
    remove(key: string): Promise<void>;
  };
  offscreen: {
    hasDocument(): Promise<boolean>;
    create(path: string): Promise<void>;
    close(): Promise<void>;
  };
  /** Ask the offscreen document to clear the clipboard if it matches `hash`. */
  requestOffscreenClear(hash: string): Promise<void>;
}

/**
 * Persist the expected secret hash and (re)arm the clear alarm. A single alarm
 * name is reused so a subsequent copy simply supersedes the previous target —
 * the latest copy is the one sitting on the clipboard, so clearing it is enough.
 */
export async function scheduleClipboardClear(
  env: ClipboardClearEnv,
  hash: string,
  seconds: number = DEFAULT_CLIPBOARD_CLEAR_SECONDS,
): Promise<void> {
  const clearAt = env.now() + clampClipboardClearSeconds(seconds) * 1000;
  await env.session.set(CLIPBOARD_CLEAR_STATE_KEY, { hash, clearAt });
  env.alarms.create(CLIPBOARD_CLEAR_ALARM, { when: clearAt });
}

/**
 * Handle a fired alarm: look up the pending target, spin up the offscreen
 * document if needed, and delegate the match-and-clear. The stored state is
 * removed up front so a failure can't leave a stale target armed forever, and
 * the offscreen document is always closed afterwards to free resources.
 */
export async function handleClipboardClearAlarm(
  env: ClipboardClearEnv,
  alarmName: string,
): Promise<void> {
  if (alarmName !== CLIPBOARD_CLEAR_ALARM) {
    return;
  }

  const state = await env.session.get(CLIPBOARD_CLEAR_STATE_KEY);
  if (!state) {
    return;
  }
  await env.session.remove(CLIPBOARD_CLEAR_STATE_KEY);

  const created = !(await env.offscreen.hasDocument());
  if (created) {
    await env.offscreen.create(OFFSCREEN_DOCUMENT_PATH);
  }
  try {
    await env.requestOffscreenClear(state.hash);
  } finally {
    if (created) {
      await env.offscreen.close();
    }
  }
}
