import { ConnectClient } from "@passshare/connect";
import type { ConnectItem } from "@shared/types/item.js";

export type SyncConflict = {
  itemId: string;
  title: string;
};

export type CloudSyncConfig = {
  apiBaseUrl: string;
  email: string;
  password: string;
  vaultId: string;
};

const STORAGE_KEY = "passshare.desktop.cloudSync.enabled";

export function isCloudSyncEnabled(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "true";
}

export function setCloudSyncEnabled(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEY, enabled ? "true" : "false");
}

async function loginAndGetClient(config: CloudSyncConfig): Promise<ConnectClient> {
  const csrfRes = await fetch(`${config.apiBaseUrl}/api/auth/csrf`, { credentials: "include" });
  if (!csrfRes.ok) {
    throw new Error("CSRF fetch failed");
  }
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };

  const loginRes = await fetch(`${config.apiBaseUrl}/api/auth/login`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify({ email: config.email, password: config.password }),
  });
  if (!loginRes.ok) {
    throw new Error("Login failed");
  }

  const tokenRes = await fetch(`${config.apiBaseUrl}/api/auth/connect-token`, {
    credentials: "include",
  });
  if (!tokenRes.ok) {
    throw new Error("Connect token fetch failed");
  }
  const tokenBody = (await tokenRes.json()) as { accessToken: string };

  return new ConnectClient({
    host: config.apiBaseUrl,
    token: tokenBody.accessToken,
  });
}
export async function detectSyncConflicts(
  config: CloudSyncConfig,
  localItems: ConnectItem[],
): Promise<SyncConflict[]> {
  const client = await loginAndGetClient(config);
  const remoteItems = await client.listItems(config.vaultId);
  const remoteById = new Map(remoteItems.map((item) => [item.id, item]));
  const conflicts: SyncConflict[] = [];

  for (const local of localItems) {
    const remote = remoteById.get(local.id);
    if (!remote) {
      continue;
    }
    if (remote.title !== local.title || remote.category !== local.category) {
      conflicts.push({ itemId: local.id, title: local.title });
    }
  }

  return conflicts;
}
