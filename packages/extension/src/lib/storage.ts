import { STORAGE_KEYS } from "./constants";
import type { StoredConnectSession } from "@shared/lib/connect-session";

// Existing Chrome storage transport, serialized across popup/background.
// Only formal session credentials are persisted here; never encryption keys.
async function withSessionStorage<T>(action: () => Promise<T>): Promise<T> {
  return await navigator.locks.request("passshare.extension.session", action);
}

function storageGet<T>(keys: string[]): Promise<Record<string, T>> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result as Record<string, T>);
    });
  });
}

function storageSet(values: Record<string, string | null>): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function storageRemove(keys: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

export async function saveRefreshToken(token: string): Promise<void> {
  await withSessionStorage(() => storageSet({ [STORAGE_KEYS.refreshToken]: token }));
}

export async function loadRefreshToken(): Promise<string | null> {
  const result = await storageGet<string>([STORAGE_KEYS.refreshToken]);
  const token = result[STORAGE_KEYS.refreshToken];
  return typeof token === "string" && token.length > 0 ? token : null;
}

export async function saveConnectToken(token: string, expiresAt: string, expectedRefreshToken?: string, isCurrent = () => true): Promise<void> {
  await withSessionStorage(async () => {
    if (!isCurrent() || (expectedRefreshToken !== undefined && await loadRefreshToken() !== expectedRefreshToken)) return;
    await storageSet({
      [STORAGE_KEYS.connectToken]: token,
      [STORAGE_KEYS.connectExpiresAt]: expiresAt,
    });
  });
}

export async function loadStoredAuthSession(): Promise<StoredConnectSession | null> {
  const stored = await storageGet<string>([STORAGE_KEYS.refreshToken, STORAGE_KEYS.connectToken, STORAGE_KEYS.connectExpiresAt]);
  const refreshToken = stored[STORAGE_KEYS.refreshToken];
  if (typeof refreshToken !== "string" || !refreshToken) return null;
  return { refreshToken,
    connectAccessToken: typeof stored[STORAGE_KEYS.connectToken] === "string" ? stored[STORAGE_KEYS.connectToken] : "",
    connectExpiresAt: typeof stored[STORAGE_KEYS.connectExpiresAt] === "string" ? stored[STORAGE_KEYS.connectExpiresAt] : "" };
}

export async function saveStoredAuthSession(session: StoredConnectSession, isCurrent = () => true): Promise<boolean> {
  return withSessionStorage(async () => {
    if (!isCurrent()) return false;
    await storageSet({ [STORAGE_KEYS.refreshToken]: session.refreshToken,
      [STORAGE_KEYS.connectToken]: session.connectAccessToken, [STORAGE_KEYS.connectExpiresAt]: session.connectExpiresAt });
    if (isCurrent()) return true;
    // A stale write owns this lock. Remove only its own just-written session
    // before a newer popup/background storage operation may enter.
    if (await loadRefreshToken() === session.refreshToken) await removeAuthStorage();
    return false;
  });
}

/**
 * Read the raw stored Connect token and its expiry (both empty strings when
 * absent). Expiry is validated by the shared session bootstrap
 * (`isConnectTokenUsable`), so this returns the token unfiltered.
 */
export async function loadStoredConnectToken(): Promise<{ token: string; expiresAt: string } | null> {
  const result = await storageGet<string>([
    STORAGE_KEYS.connectToken,
    STORAGE_KEYS.connectExpiresAt,
  ]);
  const token = result[STORAGE_KEYS.connectToken];
  if (typeof token !== "string" || !token) {
    return null;
  }
  const expiresAt = result[STORAGE_KEYS.connectExpiresAt];
  return { token, expiresAt: typeof expiresAt === "string" ? expiresAt : "" };
}

async function removeAuthStorage(): Promise<void> {
  await storageRemove([
    STORAGE_KEYS.refreshToken,
    STORAGE_KEYS.connectToken,
    STORAGE_KEYS.connectExpiresAt,
  ]);
}

export async function clearAllAuthStorage(expectedRefreshToken?: string, isCurrent = () => true): Promise<void> {
  await withSessionStorage(async () => {
    if (!isCurrent() || (expectedRefreshToken !== undefined && await loadRefreshToken() !== expectedRefreshToken)) return;
    await removeAuthStorage();
  });
}

export async function loadLocale(): Promise<string | null> {
  const result = await storageGet<string>([STORAGE_KEYS.locale]);
  const locale = result[STORAGE_KEYS.locale];
  return typeof locale === "string" ? locale : null;
}

export async function saveLocale(locale: string): Promise<void> {
  await storageSet({ [STORAGE_KEYS.locale]: locale });
}
