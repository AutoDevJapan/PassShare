import { STORAGE_KEYS } from "./constants";

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
  await storageSet({ [STORAGE_KEYS.refreshToken]: token });
}

export async function loadRefreshToken(): Promise<string | null> {
  const result = await storageGet<string>([STORAGE_KEYS.refreshToken]);
  const token = result[STORAGE_KEYS.refreshToken];
  return typeof token === "string" && token.length > 0 ? token : null;
}

export async function saveConnectToken(token: string, expiresAt: string): Promise<void> {
  await storageSet({
    [STORAGE_KEYS.connectToken]: token,
    [STORAGE_KEYS.connectExpiresAt]: expiresAt,
  });
}

export async function loadConnectToken(): Promise<string | null> {
  const result = await storageGet<string>([
    STORAGE_KEYS.connectToken,
    STORAGE_KEYS.connectExpiresAt,
  ]);
  const token = result[STORAGE_KEYS.connectToken];
  const expiresAt = result[STORAGE_KEYS.connectExpiresAt];
  if (typeof token !== "string" || !token) {
    return null;
  }
  if (typeof expiresAt === "string" && expiresAt && Date.parse(expiresAt) <= Date.now()) {
    return null;
  }
  return token;
}

export async function clearAllAuthStorage(): Promise<void> {
  await storageRemove([
    STORAGE_KEYS.refreshToken,
    STORAGE_KEYS.connectToken,
    STORAGE_KEYS.connectExpiresAt,
  ]);
}

export async function loadLocale(): Promise<string | null> {
  const result = await storageGet<string>([STORAGE_KEYS.locale]);
  const locale = result[STORAGE_KEYS.locale];
  return typeof locale === "string" ? locale : null;
}

export async function saveLocale(locale: string): Promise<void> {
  await storageSet({ [STORAGE_KEYS.locale]: locale });
}
