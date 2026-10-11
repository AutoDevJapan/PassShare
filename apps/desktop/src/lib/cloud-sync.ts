import { ConnectClient } from "@passshare/connect";
import type { ConnectItem } from "@shared/types/item.js";
import { formValuesFromItem } from "@shared/types/item.js";
import { connectItemFromApi, connectItemToCreateBody } from "./connect-items";
import {
  detectSyncConflicts,
  itemFingerprint,
  planCloudSync,
  type SyncBase,
  type SyncConflict,
} from "@shared/lib/sync-conflicts";
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

/**
 * Per-item merge-base revisions from the last successful sync, keyed by item id.
 * Only the server revision (a non-sensitive integer) is persisted here — never
 * the content fingerprint, which embeds plaintext secrets and must stay inside
 * the encrypted `.pbox`. This is enough to detect a local one-sided edit: when
 * the remote revision is unchanged from the recorded base, a content difference
 * can only be a local edit and is auto-pushed.
 */
const BASE_STORAGE_KEY = "passshare.desktop.cloudSync.baseRevisions";

export function isCloudSyncEnabled(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "true";
}

export function setCloudSyncEnabled(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEY, enabled ? "true" : "false");
}

/** Read the stored base-revision map, tolerating absent/corrupt storage. */
function loadBaseRevisionRecord(): Record<string, number> {
  const raw = localStorage.getItem(BASE_STORAGE_KEY);
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const record: Record<string, number> = {};
    for (const [id, revision] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof revision === "number" && Number.isFinite(revision)) {
        record[id] = revision;
      }
    }
    return record;
  } catch {
    return {};
  }
}

/** Build the revision-only merge-base lookup consumed by the sync planner. */
function loadSyncBases(): Map<string, SyncBase> {
  return new Map(
    Object.entries(loadBaseRevisionRecord()).map(([id, revision]) => [id, { revision }]),
  );
}

function saveBaseRevisionRecord(record: Record<string, number>): void {
  localStorage.setItem(BASE_STORAGE_KEY, JSON.stringify(record));
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

  // This legacy sync transfers plaintext. Only authoritative compatibility
  // state permits it; unknown/encrypted/disabled state never reaches Connect.
  const stateRes = await syncFetch(`${config.apiBaseUrl}/api/encrypted/boxes/${encodeURIComponent(config.vaultId)}`, {
    credentials: "include", cache: "no-store", redirect: "error",
  });
  assertOk(stateRes, "Password box mode unavailable");
  const state = await stateRes.json() as { mode: string; keyEpoch: number | null };
  if (state.mode !== "compatibility" || state.keyEpoch !== null) throw new SyncError("unknown", "Encrypted password box requires encrypted item screen");

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
  return planCloudSync(localItems, remoteItems, loadSyncBases()).conflicts;
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
  const plan = planCloudSync(localItems, remoteItems, loadSyncBases());

  // Merge-base bookkeeping: record, per item, the server revision both sides
  // agree on after this sync. Only successful tasks update it (a failed push
  // leaves the old base so the edit is retried, never lost). Conflicts are left
  // untouched. Persisted as revision-only integers — never the fingerprint.
  const nextBases: Record<string, number> = loadBaseRevisionRecord();
  const recordBase = (id: string, revision: number | null | undefined): void => {
    if (typeof revision === "number" && Number.isFinite(revision)) {
      nextBases[id] = revision;
    }
  };

  // Items already identical on both sides: adopt the remote revision as the base
  // so a subsequent local-only edit becomes auto-pushable (upgrade path).
  const localById = new Map(localItems.map((item) => [item.id, item]));
  for (const remote of remoteItems) {
    const local = localById.get(remote.id);
    if (local && itemFingerprint(local) === itemFingerprint(remote)) {
      recordBase(remote.id, remote.revision);
    }
  }

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
          .then((created) => {
            recordBase(local.id, created.version);
          }),
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
          .editItemForm(config.vaultId, local.id, remoteItems.find((item) => item.id === local.id)!.revision!, formValuesFromItem(local))
          .then((replaced) => {
            recordBase(local.id, replaced.version);
          }),
    });
  }

  // Remote-only items and one-sided edits where the remote copy is newer:
  // apply to local.
  for (const remote of plan.pull) {
    tasks.push({
      itemId: remote.id,
      title: remote.title,
      direction: "pull",
      run: () =>
        onPull(remote).then(() => {
          recordBase(remote.id, remote.revision);
        }),
    });
  }

  const summary = await executeSyncTasks(tasks, onProgress);
  saveBaseRevisionRecord(nextBases);

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
  const original = await client.getItem(config.vaultId, local.id);
  await client.editItemForm(
    config.vaultId,
    local.id,
    original.version,
    formValuesFromItem(local),
  );
}

export async function resolveConflictKeepRemote(
  remote: ConnectItem,
  onPull: SyncPullHandler,
): Promise<void> {
  await onPull(remote);
}
