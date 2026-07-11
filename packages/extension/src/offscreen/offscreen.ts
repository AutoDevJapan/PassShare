import type {
  OffscreenClearClipboardRequest,
  OffscreenClearClipboardResponse,
} from "../lib/constants";
import { OFFSCREEN_CLEAR_CLIPBOARD } from "../lib/constants";
import { type ClipboardIo, clearClipboardIfHashMatches } from "./clipboard-ops.js";

/**
 * A service worker cannot touch `navigator.clipboard`, and an offscreen document
 * is never focused — so the Async Clipboard API is unavailable here too. The one
 * reliable path is a `<textarea>` driven by `document.execCommand`, gated by the
 * `clipboardRead` / `clipboardWrite` permissions.
 */
const clipboardIo: ClipboardIo = {
  async read() {
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    textarea.focus();
    try {
      document.execCommand("paste");
      return textarea.value;
    } finally {
      textarea.remove();
    }
  },
  async write(text) {
    const textarea = document.createElement("textarea");
    // Copying an empty selection is a no-op in Chromium and would leave the
    // secret in place, so clearing writes a single harmless space instead of "".
    textarea.value = text === "" ? " " : text;
    document.body.append(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
    } finally {
      textarea.remove();
    }
  },
};

chrome.runtime.onMessage.addListener(
  (
    message: OffscreenClearClipboardRequest,
    _sender,
    sendResponse: (response: OffscreenClearClipboardResponse) => void,
  ) => {
    if (message?.type !== OFFSCREEN_CLEAR_CLIPBOARD) {
      return undefined;
    }

    void clearClipboardIfHashMatches(clipboardIo, message.hash).then((cleared) => {
      sendResponse({ ok: true, cleared });
    });
    // Keep the message channel open for the async response.
    return true;
  },
);
