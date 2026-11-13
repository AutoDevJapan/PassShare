import type { ConnectClient } from "@passshare/connect";
const pendingSessionImports=new Map<string,string>();
const activeSessionImports=new Set<string>();

export type Import1puxResult = {
  imported: number;
  partial?: boolean;
  changed?: number;
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
  operationKey?: string,
): Promise<Import1puxResult> {
  const buffer = await file.arrayBuffer();
  return client.import1pux(vaultId, bufferToBase64(buffer), operationKey);
}

/** Upload 1PUX via session auth (Desktop cloud sync credentials). */
export async function import1puxWithSession(
  apiBaseUrl: string,
  vaultId: string,
  file: File,
  email: string,
  password: string,
): Promise<Import1puxResult> {
  const flightScope=JSON.stringify([apiBaseUrl,email.trim().toLowerCase(),vaultId]);
  if(activeSessionImports.has(flightScope))throw Object.assign(new Error('1PUX import already in progress'),{code:'IMPORT_IN_PROGRESS'});
  activeSessionImports.add(flightScope);
  try {
  const loginRes = await fetch(`${apiBaseUrl}/api/auth/login`, {
    method: "POST",
    credentials: "omit",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      "X-Passshare-Client": "mobile",
    },
    body: JSON.stringify({ email, password }),
  });
  if (!loginRes.ok) {
    throw new Error("Login failed");
  }
  const loginBody=await loginRes.json() as {user?:{id?:string;email?:string};refreshToken?:string;connectAccessToken?:string};
  if(!loginBody.user?.id||loginBody.user.email?.trim().toLowerCase()!==email.trim().toLowerCase()||!loginBody.refreshToken||!loginBody.connectAccessToken)throw new Error('Invalid import authentication response');
  const sessionHeaders={Authorization:`Bearer ${loginBody.refreshToken}`};

  const modeResponse = await fetch(`${apiBaseUrl}/api/encrypted/boxes/${encodeURIComponent(vaultId)}`, {
    credentials: "omit",headers:sessionHeaders, cache: "no-store", redirect: "error",
  });
  if (modeResponse.status !== 404) {
    if (!modeResponse.ok) throw new Error("Password box mode unavailable");
    const mode = await modeResponse.json() as { mode: string; keyEpoch: number | null };
    if (mode.mode !== "compatibility" || mode.keyEpoch !== null) throw new Error("Encrypted password box requires encrypted migration");
  }

  const tokenBody = { accessToken: loginBody.connectAccessToken };

  if (modeResponse.status === 404) {
    // Metadata only; flag-off still preserves the server's ciphertext boundary.
    const metadata = await fetch(`${apiBaseUrl}/v1/vaults/${encodeURIComponent(vaultId)}`, {
      credentials: "omit",
      headers: { Authorization: `Bearer ${tokenBody.accessToken}` }, cache: "no-store", redirect: "error",
    });
    if (metadata.status !== 200) throw new Error("Compatibility password box unavailable");
  }

  const buffer = await file.arrayBuffer();
  const base64 = bufferToBase64(buffer);
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer)),b=>b.toString(16).padStart(2,'0')).join('');
  const scope=JSON.stringify([apiBaseUrl,loginBody.user.id,vaultId,digest]);
  const operationKey=pendingSessionImports.get(scope)??crypto.randomUUID();
  pendingSessionImports.set(scope,operationKey);
  const importRes = await fetch(`${apiBaseUrl}/v1/vaults/${vaultId}/imports/1pux`, {
    method: "POST",
    credentials: "omit", redirect: "error",
    headers: {
      Authorization: `Bearer ${tokenBody.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Idempotency-Key": operationKey,
    },
    body: JSON.stringify({ base64 }),
  });

  if (!importRes.ok) {
    const body = (await importRes.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `1PUX import failed (${importRes.status})`);
  }

  const result=(await importRes.json()) as Import1puxResult;
  if(result.partial)throw Object.assign(new Error('1PUX import remains partial'),{code:'IMPORT_PARTIAL',imported:result.imported,changed:result.changed});
  if(!result.partial&&pendingSessionImports.get(scope)===operationKey)pendingSessionImports.delete(scope);
  return result;
  } finally {activeSessionImports.delete(flightScope);}
}
