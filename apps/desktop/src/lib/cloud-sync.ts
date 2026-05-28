import { ConnectClient } from "@passshare/connect";
import type { ConnectItem } from "@shared/types/item.js";
import { formValuesFromItem } from "@shared/types/item.js";
import { connectItemFromApi, connectItemToCreateBody } from "./connect-items";
import { detectSyncConflicts, type SyncConflict } from "@shared/lib/sync-conflicts";

export type { SyncConflict };

export type CloudSyncConfig = {
  apiBaseUrl: string;
  email: string;
  password: string;
  vaultId: string;
};

export type SyncRunResult = {
  pushed: number;
  pulled: number;
  conflicts: SyncConflict[];
};

const STORAGE_KEY = "passshare.desktop.cloudSync.enabled";

export function isCloudSyncEnabled(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "true";
}

export function setCloudSyncEnabled(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEY, enabled ? "true" : "false");
}

export { detectSyncConflicts };

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

async function fetchRemoteItems(client: ConnectClient, vaultId: string): Promise<ConnectItem[]> {
  const overviews = await client.listItems(vaultId);
  const details = await Promise.all(
    overviews.map((overview) => client.getItem(vaultId, overview.id)),
  );
  return details.map(connectItemFromApi);
}

export async function checkSyncConflicts(
  config: CloudSyncConfig,
  localItems: ConnectItem[],
): Promise<SyncConflict[]> {
  const client = await loginAndGetClient(config);
  const remoteItems = await fetchRemoteItems(client, config.vaultId);
  return detectSyncConflicts(localItems, remoteItems);
}

export type SyncPullHandler = (item: ConnectItem) => Promise<void>;

export async function runCloudSync(
  config: CloudSyncConfig,
  localItems: ConnectItem[],
  onPull: SyncPullHandler,
): Promise<SyncRunResult> {
  const client = await loginAndGetClient(config);
  const remoteItems = await fetchRemoteItems(client, config.vaultId);
  const conflicts = detectSyncConflicts(localItems, remoteItems);
  const conflictIds = new Set(conflicts.map((c) => c.itemId));

  const localById = new Map(localItems.map((item) => [item.id, item]));
  const remoteById = new Map(remoteItems.map((item) => [item.id, item]));

  let pushed = 0;
  for (const local of localItems) {
    if (conflictIds.has(local.id)) {
      continue;
    }
    if (!remoteById.has(local.id)) {
      await client.createItem(
        config.vaultId,
        connectItemToCreateBody(formValuesFromItem(local), { id: local.id }),
      );
      pushed += 1;
    }
  }

  let pulled = 0;
  for (const remote of remoteItems) {
    if (conflictIds.has(remote.id)) {
      continue;
    }
    if (!localById.has(remote.id)) {
      await onPull(remote);
      pulled += 1;
    }
  }

  return { pushed, pulled, conflicts };
}

export async function resolveConflictKeepLocal(
  config: CloudSyncConfig,
  local: ConnectItem,
): Promise<void> {
  const client = await loginAndGetClient(config);
  await client.replaceItem(
    config.vaultId,
    local.id,
    connectItemToCreateBody(formValuesFromItem(local)),
  );
}

export async function resolveConflictKeepRemote(
  remote: ConnectItem,
  onPull: SyncPullHandler,
): Promise<void> {
  await onPull(remote);
}
