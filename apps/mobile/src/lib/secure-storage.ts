const BIOMETRY_DOMAIN = "com.passshare.mobile";
const REFRESH_TOKEN_KEY = "refresh-token";
const CONNECT_TOKEN_KEY = "connect-access-token";
const CONNECT_EXPIRES_KEY = "connect-expires-at";

type BiometryApi = typeof import("@choochmeque/tauri-plugin-biometry-api");

let biometryApi: BiometryApi | null | undefined;

// Test seam: when set, loadBiometryApi() resolves to this value without touching
// the real plugin, so the fallback path can be exercised deterministically.
let forcedBiometryApi: BiometryApi | null | undefined;

// Session-only fallback (#321 H9a). When no OS-backed secure store is available
// we keep secrets in memory for the lifetime of the process only. They are
// never written to localStorage / disk, so a refresh token cannot silently
// persist in plaintext where file, WebView, or XSS access could read it.
const memoryStore = new Map<string, string>();

async function loadBiometryApi(): Promise<BiometryApi | null> {
  if (forcedBiometryApi !== undefined) {
    return forcedBiometryApi;
  }
  if (biometryApi !== undefined) {
    return biometryApi;
  }
  try {
    biometryApi = await import("@choochmeque/tauri-plugin-biometry-api");
    return biometryApi;
  } catch {
    biometryApi = null;
    return null;
  }
}

/**
 * Remove any plaintext value a previous build may have left in localStorage for
 * this key. Secrets must never live there; this purges legacy at-rest copies.
 */
function purgeLegacyPlaintext(name: string): void {
  try {
    globalThis.localStorage?.removeItem(`${BIOMETRY_DOMAIN}:${name}`);
  } catch {
    // localStorage may be unavailable; nothing to purge.
  }
}

async function setSecureValue(name: string, data: string): Promise<void> {
  purgeLegacyPlaintext(name);
  const api = await loadBiometryApi();
  if (api) {
    await api.setData({ domain: BIOMETRY_DOMAIN, name, data });
    return;
  }
  memoryStore.set(name, data);
}

async function getSecureValue(name: string, reason: string): Promise<string | null> {
  const api = await loadBiometryApi();
  if (api) {
    const response = await api.getData({ domain: BIOMETRY_DOMAIN, name, reason });
    return response.data ?? null;
  }
  return memoryStore.get(name) ?? null;
}

async function removeSecureValue(name: string): Promise<void> {
  purgeLegacyPlaintext(name);
  const api = await loadBiometryApi();
  if (api) {
    await api.removeData({ domain: BIOMETRY_DOMAIN, name });
    return;
  }
  memoryStore.delete(name);
}

export async function saveRefreshToken(token: string): Promise<void> {
  await setSecureValue(REFRESH_TOKEN_KEY, token);
}

export async function loadRefreshToken(reason = "PassShare にログイン"): Promise<string | null> {
  return getSecureValue(REFRESH_TOKEN_KEY, reason);
}

export async function clearRefreshToken(): Promise<void> {
  await removeSecureValue(REFRESH_TOKEN_KEY);
}

export async function saveConnectToken(accessToken: string, expiresAt: string): Promise<void> {
  await setSecureValue(CONNECT_TOKEN_KEY, accessToken);
  await setSecureValue(CONNECT_EXPIRES_KEY, expiresAt);
}

export async function loadConnectToken(reason = "Connect API"): Promise<string | null> {
  const token = await getSecureValue(CONNECT_TOKEN_KEY, reason);
  if (!token) {
    return null;
  }
  const expiresAt = await getSecureValue(CONNECT_EXPIRES_KEY, reason);
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
    return null;
  }
  return token;
}

export async function clearConnectToken(): Promise<void> {
  await removeSecureValue(CONNECT_TOKEN_KEY);
  await removeSecureValue(CONNECT_EXPIRES_KEY);
}

export async function clearAllSecureAuth(): Promise<void> {
  await clearRefreshToken();
  await clearConnectToken();
}

/**
 * Whether an OS-backed secure store is available. When false, secrets live only
 * in memory for the current session and the UI should surface that state.
 */
export async function isSecureStorageAvailable(): Promise<boolean> {
  return (await loadBiometryApi()) !== null;
}

export async function isBiometricAvailable(): Promise<boolean> {
  const api = await loadBiometryApi();
  if (!api) {
    return false;
  }
  const status = await api.checkStatus();
  return status.isAvailable;
}

export async function authenticateBiometric(reason: string): Promise<void> {
  const api = await loadBiometryApi();
  if (!api) {
    throw new Error("Biometric auth is unavailable in this environment.");
  }
  await api.authenticate(reason, {
    allowDeviceCredential: true,
    title: "PassShare",
    subtitle: reason,
  });
}

/** Test-only: force the biometry backend (or `null` for the memory fallback). */
export function __setBiometryApiForTests(api: BiometryApi | null): void {
  forcedBiometryApi = api;
  biometryApi = undefined;
  memoryStore.clear();
}

/** Test-only: restore normal plugin resolution and clear the memory fallback. */
export function __resetBiometryApiForTests(): void {
  forcedBiometryApi = undefined;
  biometryApi = undefined;
  memoryStore.clear();
}
