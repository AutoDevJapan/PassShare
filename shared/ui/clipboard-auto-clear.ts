export const CLIPBOARD_CLEAR_STORAGE_KEY = "passshare.clipboardClearSeconds";
export const DEFAULT_CLIPBOARD_CLEAR_SECONDS = 30;
export const MIN_CLIPBOARD_CLEAR_SECONDS = 5;
export const MAX_CLIPBOARD_CLEAR_SECONDS = 300;

const activeClearTimers = new Map<string, number>();

function timerKey(text: string): string {
  return text;
}

export function parseClipboardClearSeconds(raw: string | null): number {
  if (raw === null) {
    return DEFAULT_CLIPBOARD_CLEAR_SECONDS;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_CLIPBOARD_CLEAR_SECONDS;
  }

  return clampClipboardClearSeconds(parsed);
}

export function clampClipboardClearSeconds(seconds: number): number {
  return Math.min(MAX_CLIPBOARD_CLEAR_SECONDS, Math.max(MIN_CLIPBOARD_CLEAR_SECONDS, seconds));
}

export function getClipboardClearSeconds(): number {
  if (typeof localStorage === "undefined") {
    return DEFAULT_CLIPBOARD_CLEAR_SECONDS;
  }

  return parseClipboardClearSeconds(localStorage.getItem(CLIPBOARD_CLEAR_STORAGE_KEY));
}

export function setClipboardClearSeconds(seconds: number): number {
  const clamped = clampClipboardClearSeconds(seconds);
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(CLIPBOARD_CLEAR_STORAGE_KEY, String(clamped));
  }
  return clamped;
}

export function scheduleClipboardAutoClear(text: string, seconds = getClipboardClearSeconds()): void {
  if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
    return;
  }

  const key = timerKey(text);
  const existing = activeClearTimers.get(key);
  if (existing !== undefined) {
    window.clearTimeout(existing);
  }

  const timeoutId = window.setTimeout(() => {
    activeClearTimers.delete(key);
    void clearClipboardIfMatches(text);
  }, clampClipboardClearSeconds(seconds) * 1000);

  activeClearTimers.set(key, timeoutId);
}

export async function copyTextWithAutoClear(text: string, seconds?: number): Promise<void> {
  if (!text || !navigator.clipboard?.writeText) {
    return;
  }

  await navigator.clipboard.writeText(text);
  scheduleClipboardAutoClear(text, seconds);
}

async function clearClipboardIfMatches(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    return;
  }

  try {
    if (navigator.clipboard.readText) {
      const current = await navigator.clipboard.readText();
      if (current !== text) {
        return;
      }
    }
    await navigator.clipboard.writeText("");
  } catch {
    // Clipboard read may fail without permission; best-effort clear only when content matches.
  }
}
