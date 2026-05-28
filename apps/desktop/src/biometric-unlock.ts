const BIOMETRY_DOMAIN = "com.passshare.desktop";

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

function storageName(boxPath: string): string {
  return `master-password:${boxPath.trim().toLowerCase()}`;
}

export async function isBiometricAvailable(): Promise<boolean> {
  const api = await loadBiometryApi();
  if (!api) {
    return false;
  }

  const status = await api.checkStatus();
  return status.isAvailable;
}

export async function hasBiometricUnlock(boxPath: string): Promise<boolean> {
  const api = await loadBiometryApi();
  if (!api || !boxPath.trim()) {
    return false;
  }

  return api.hasData({ domain: BIOMETRY_DOMAIN, name: storageName(boxPath) });
}

export async function enableBiometricUnlock(boxPath: string, masterPassword: string): Promise<void> {
  const api = await loadBiometryApi();
  if (!api) {
    throw new Error("生体認証はこの環境では利用できません。");
  }

  await api.authenticate("生体認証を有効にする", {
    allowDeviceCredential: true,
    title: "PassShare",
    subtitle: "生体認証の有効化",
  });

  await api.setData({
    domain: BIOMETRY_DOMAIN,
    name: storageName(boxPath),
    data: masterPassword,
  });
}

export async function disableBiometricUnlock(boxPath: string): Promise<void> {
  const api = await loadBiometryApi();
  if (!api || !boxPath.trim()) {
    return;
  }

  await api.removeData({ domain: BIOMETRY_DOMAIN, name: storageName(boxPath) });
}

export async function unlockWithBiometric(boxPath: string): Promise<string> {
  const api = await loadBiometryApi();
  if (!api) {
    throw new Error("生体認証はこの環境では利用できません。");
  }

  const response = await api.getData({
    domain: BIOMETRY_DOMAIN,
    name: storageName(boxPath),
    reason: "パスワードボックスを開く",
  });

  if (!response.data) {
    throw new Error("生体認証でパスワードを取得できませんでした。");
  }

  return response.data;
}
