import { sha256Hex } from "../lib/hash.js";

/**
 * Minimal clipboard surface the offscreen document provides. Injected so the
 * match-and-clear policy can be unit tested without a real DOM/clipboard: in
 * the browser these are backed by `<textarea>` + `document.execCommand`, which
 * is the only way to touch the clipboard from an (unfocused) offscreen document.
 */
export interface ClipboardIo {
  read(): Promise<string>;
  write(text: string): Promise<void>;
}

/**
 * Clear the OS clipboard only when it still holds the secret we copied.
 *
 * The secret never leaves the popup: we compare a SHA-256 hash of the current
 * clipboard contents against the expected hash. This is best-effort — if the
 * clipboard can't be read, or the user has since copied something else, we
 * leave it untouched rather than clobber unrelated data.
 *
 * @returns whether the clipboard was actually cleared.
 */
export async function clearClipboardIfHashMatches(
  io: ClipboardIo,
  expectedHash: string,
): Promise<boolean> {
  let current: string;
  try {
    current = await io.read();
  } catch {
    // No read permission / transient failure: cannot verify a match, so do not
    // risk overwriting whatever the user currently has on the clipboard.
    return false;
  }

  if (current === "") {
    return false;
  }

  const currentHash = await sha256Hex(current);
  if (currentHash !== expectedHash) {
    return false;
  }

  await io.write("");
  return true;
}
