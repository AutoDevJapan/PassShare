const BIOMETRY_DOMAIN = "com.passshare.mobile";
const AUTH_SESSION_KEY = "auth-session";

// Pre-blob storage keys — one keychain entry per secret. Kept only so we can
// purge any secret a previous build left behind after the session was unified
// into a single blob; never read back.
const LEGACY_SECURE_KEYS = [
  "refresh-token",
  "connect-access-token",
  "connect-expires-at",
] as const;

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

export type StoredAuthSession = {
  refreshToken: string;
  connectAccessToken: string;
  connectExpiresAt: string;
};

/** Best-effort removal of any secret written under the pre-blob key layout. */
async function purgeLegacySecureKeys(): Promise<void> {
  for (const name of LEGACY_SECURE_KEYS) {
    try {
      await removeSecureValue(name);
    } catch {
      // A missing legacy entry is not an error.
    }
  }
}

/**
 * Persist the whole auth session as a single secure blob. Bundling the refresh
 * token, Connect access token, and its expiry into one entry means a later read
 * ({@link loadAuthSession}) needs a single biometric unlock instead of one
 * prompt per secret.
 */
let sessionMutation: Promise<void> = Promise.resolve();

// Serialise writes and removals, including a write already inside the OS plugin.
// A newer account/lock invalidates the result; its removal cannot race a newer write.
function mutateSession(action: () => Promise<void>): Promise<void> {
  const result = sessionMutation.then(action);
  sessionMutation = result.catch(() => undefined);
  return result;
}

export async function saveAuthSession(
  session: StoredAuthSession,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  await mutateSession(async () => {
    if (!isCurrent()) throw new Error("Session changed.");
    await setSecureValue(AUTH_SESSION_KEY, JSON.stringify(session));
    await purgeLegacySecureKeys();
    if (!isCurrent()) {
      await removeSecureValue(AUTH_SESSION_KEY);
      throw new Error("Session changed.");
    }
  });
}

/**
 * Read the auth session with a single biometric prompt. `reason` is shown to the
 * user in that prompt, so it must be a localised, user-facing string.
 */
export async function loadAuthSession(reason: string): Promise<StoredAuthSession | null> {
  const raw = await getSecureValue(AUTH_SESSION_KEY, reason);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredAuthSession>;
    if (
      typeof parsed.refreshToken === "string" &&
      typeof parsed.connectAccessToken === "string" &&
      typeof parsed.connectExpiresAt === "string"
    ) {
      return {
        refreshToken: parsed.refreshToken,
        connectAccessToken: parsed.connectAccessToken,
        connectExpiresAt: parsed.connectExpiresAt,
      };
    }
  } catch {
    // Corrupt or legacy payload: treat as no stored session.
  }
  return null;
}

export async function clearAuthSession(isCurrent: () => boolean = () => true): Promise<void> {
  await mutateSession(async () => {
    if (!isCurrent()) return;
    await removeSecureValue(AUTH_SESSION_KEY);
    await purgeLegacySecureKeys();
  });
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
