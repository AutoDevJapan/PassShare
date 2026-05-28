import type { ConnectClient } from "@passshare/connect";

export type Import1puxResult = {
  imported: number;
};

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** Upload a 1PUX (.1pux / .zip) archive to Connect API. */
export async function import1puxFile(
  client: ConnectClient,
  vaultId: string,
  file: File,
): Promise<Import1puxResult> {
  const buffer = await file.arrayBuffer();
  return client.import1pux(vaultId, bufferToBase64(buffer));
}

/** Upload 1PUX via session auth (Desktop cloud sync credentials). */
export async function import1puxWithSession(
  apiBaseUrl: string,
  vaultId: string,
  file: File,
  email: string,
  password: string,
): Promise<Import1puxResult> {
  const csrfRes = await fetch(`${apiBaseUrl}/api/auth/csrf`, { credentials: "include" });
  if (!csrfRes.ok) {
    throw new Error("CSRF fetch failed");
  }
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };

  const loginRes = await fetch(`${apiBaseUrl}/api/auth/login`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify({ email, password }),
  });
  if (!loginRes.ok) {
    throw new Error("Login failed");
  }

  const tokenRes = await fetch(`${apiBaseUrl}/api/auth/connect-token`, {
    credentials: "include",
  });
  if (!tokenRes.ok) {
    throw new Error("Connect token fetch failed");
  }
  const tokenBody = (await tokenRes.json()) as { accessToken: string };

  const buffer = await file.arrayBuffer();
  const base64 = bufferToBase64(buffer);
  const importRes = await fetch(`${apiBaseUrl}/v1/vaults/${vaultId}/imports/1pux`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenBody.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ base64 }),
  });

  if (!importRes.ok) {
    const body = (await importRes.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `1PUX import failed (${importRes.status})`);
  }

  return (await importRes.json()) as Import1puxResult;
}
