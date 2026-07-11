import { ConnectClient } from "@passshare/connect";
import type { ConnectItem } from "@shared/types/item.js";
import { formValuesFromItem } from "@shared/types/item.js";
import { connectItemFromApi, connectItemToCreateBody } from "./connect-items";
import { detectSyncConflicts, planCloudSync, type SyncConflict } from "@shared/lib/sync-conflicts";
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
  return planCloudSync(localItems, remoteItems).conflicts;
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
  const plan = planCloudSync(localItems, remoteItems);

  const tasks: SyncTask[] = [];

  // Local-only items: create them on the remote.
  for (const local of plan.create) {
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

  // One-sided edits where the local copy is newer: overwrite the remote.
  for (const local of plan.overwriteRemote) {
    tasks.push({
      itemId: local.id,
      title: local.title,
      direction: "push",
      run: () =>
        client
          .replaceItem(config.vaultId, local.id, connectItemToCreateBody(formValuesFromItem(local)))
          .then(() => undefined),
    });
  }

  // Remote-only items and one-sided edits where the remote copy is newer:
  // apply to local.
  for (const remote of plan.pull) {
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
    conflicts: plan.conflicts,
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
