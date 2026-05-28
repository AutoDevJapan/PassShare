const BIOMETRY_DOMAIN = "com.passshare.mobile";
const REFRESH_TOKEN_KEY = "refresh-token";
const CONNECT_TOKEN_KEY = "connect-access-token";
const CONNECT_EXPIRES_KEY = "connect-expires-at";

type BiometryApi = typeof import("@choochmeque/tauri-plugin-biometry-api");

let biometryApi: BiometryApi | null | undefined;

async function loadBiometryApi(): Promise<BiometryApi | null> {
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

async function setSecureValue(name: string, data: string): Promise<void> {
  const api = await loadBiometryApi();
  if (api) {
    await api.setData({ domain: BIOMETRY_DOMAIN, name, data });
    return;
  }
  localStorage.setItem(`${BIOMETRY_DOMAIN}:${name}`, data);
}

async function getSecureValue(name: string, reason: string): Promise<string | null> {
  const api = await loadBiometryApi();
  if (api) {
    const response = await api.getData({ domain: BIOMETRY_DOMAIN, name, reason });
    return response.data ?? null;
  }
  return localStorage.getItem(`${BIOMETRY_DOMAIN}:${name}`);
}

async function removeSecureValue(name: string): Promise<void> {
  const api = await loadBiometryApi();
  if (api) {
    await api.removeData({ domain: BIOMETRY_DOMAIN, name });
    return;
  }
  localStorage.removeItem(`${BIOMETRY_DOMAIN}:${name}`);
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
