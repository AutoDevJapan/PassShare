const APP_PIN_KEY = "app-pin-hash";

async function digestPin(pin: string): Promise<string> {
  const data = new TextEncoder().encode(pin);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hasAppPin(): Promise<boolean> {
  return Boolean(localStorage.getItem(APP_PIN_KEY));
}

export async function setAppPin(pin: string): Promise<void> {
  if (!/^\d{4,8}$/.test(pin)) {
    throw new Error("PIN must be 4-8 digits.");
  }
  localStorage.setItem(APP_PIN_KEY, await digestPin(pin));
}

export async function verifyAppPin(pin: string): Promise<boolean> {
  const stored = localStorage.getItem(APP_PIN_KEY);
  if (!stored) {
    return false;
  }
  return stored === (await digestPin(pin));
}

export async function clearAppPin(): Promise<void> {
  localStorage.removeItem(APP_PIN_KEY);
}
