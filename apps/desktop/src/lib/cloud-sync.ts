import { ConnectClient } from "@passshare/connect";
import type { ConnectItem } from "@shared/types/item.js";
import { formValuesFromItem } from "@shared/types/item.js";
import { connectItemFromApi, connectItemToCreateBody } from "./connect-items";
import { detectSyncConflicts, type SyncConflict } from "@shared/lib/sync-conflicts";
import {
  SyncError,
  executeSyncTasks,
  type SyncItemOutcome,
  type SyncProgressHandler,
  type SyncTask,
} from "./sync-run";

export type { SyncConflict };
export {
  SyncError,
  classifySyncError,
  type SyncErrorKind,
  type SyncItemOutcome,
  type SyncProgress,
  type SyncProgressHandler,
} from "./sync-run";

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
  outcomes: SyncItemOutcome[];
  failures: SyncItemOutcome[];
};

const STORAGE_KEY = "passshare.desktop.cloudSync.enabled";

export function isCloudSyncEnabled(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "true";
}

export function setCloudSyncEnabled(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEY, enabled ? "true" : "false");
}

export { detectSyncConflicts };

/** `fetch` wrapper that reports connection failures as a network `SyncError`. */
async function syncFetch(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    throw new SyncError("network", error instanceof Error ? error.message : "network error");
  }
}

/** Translate a non-OK response into a classified `SyncError`. */
function assertOk(response: Response, context: string): void {
  if (response.ok) {
    return;
  }
  const detail = `${context} (${response.status})`;
  if (response.status === 401 || response.status === 403) {
    throw new SyncError("auth", detail);
  }
  if (response.status >= 500) {
    throw new SyncError("server", detail);
  }
  throw new SyncError("unknown", detail);
}

async function loginAndGetClient(config: CloudSyncConfig): Promise<ConnectClient> {
  const csrfRes = await syncFetch(`${config.apiBaseUrl}/api/auth/csrf`, { credentials: "include" });
  assertOk(csrfRes, "CSRF fetch failed");
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };

  const loginRes = await syncFetch(`${config.apiBaseUrl}/api/auth/login`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify({ email: config.email, password: config.password }),
  });
  assertOk(loginRes, "Login failed");

  const tokenRes = await syncFetch(`${config.apiBaseUrl}/api/auth/connect-token`, {
    credentials: "include",
  });
  assertOk(tokenRes, "Connect token fetch failed");
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
  onProgress?: SyncProgressHandler,
): Promise<SyncRunResult> {
  const client = await loginAndGetClient(config);
  const remoteItems = await fetchRemoteItems(client, config.vaultId);
  const conflicts = detectSyncConflicts(localItems, remoteItems);
  const conflictIds = new Set(conflicts.map((c) => c.itemId));

  const localById = new Map(localItems.map((item) => [item.id, item]));
  const remoteById = new Map(remoteItems.map((item) => [item.id, item]));

  const tasks: SyncTask[] = [];

  for (const local of localItems) {
    if (conflictIds.has(local.id) || remoteById.has(local.id)) {
      continue;
    }
    tasks.push({
      itemId: local.id,
      title: local.title,
      direction: "push",
      run: () =>
        client
          .createItem(
            config.vaultId,
            connectItemToCreateBody(formValuesFromItem(local), { id: local.id }),
          )
          .then(() => undefined),
    });
  }

  for (const remote of remoteItems) {
    if (conflictIds.has(remote.id) || localById.has(remote.id)) {
      continue;
    }
    tasks.push({
      itemId: remote.id,
      title: remote.title,
      direction: "pull",
      run: () => onPull(remote),
    });
  }

  const summary = await executeSyncTasks(tasks, onProgress);

  return {
    pushed: summary.pushed,
    pulled: summary.pulled,
    conflicts,
    outcomes: summary.outcomes,
    failures: summary.failures,
  };
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
