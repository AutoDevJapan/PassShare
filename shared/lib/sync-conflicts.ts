import type { ConnectItem } from "../types/item.js";

export type SyncConflict = {
  itemId: string;
  title: string;
  local: ConnectItem;
  remote: ConnectItem;
};

/**
 * Outcome of comparing the two sides of an item that exists in both places and
 * whose content (fingerprint) differs.
 *
 * One-sided existence (`create` / `pull`) is handled by {@link planCloudSync},
 * not here; this type only covers items present on both sides.
 */
export type SyncResolution = {
  /** Both sides changed from a common base (or recency is undecidable): user must choose. */
  conflicts: SyncConflict[];
  /** Present on both sides, the local copy is newer -> overwrite the remote. */
  pushLocal: ConnectItem[];
  /** Present on both sides, the remote copy is newer -> overwrite the local. */
  pullRemote: ConnectItem[];
};

/** Full, side-effect-free sync plan derived purely from the two item lists. */
export type CloudSyncPlan = {
  /** Local-only items -> create on the remote. */
  create: ConnectItem[];
  /** Local newer than remote -> replace the remote copy. */
  overwriteRemote: ConnectItem[];
  /** Remote-only items and remote-newer items -> apply to local. */
  pull: ConnectItem[];
  /** Genuine conflicts requiring a manual resolution. */
  conflicts: SyncConflict[];
};

function itemFingerprint(item: ConnectItem): string {
  return JSON.stringify({
    title: item.title,
    category: item.category,
    username: item.username ?? "",
    password: item.password ?? "",
    url: item.url ?? "",
    notes: item.notes ?? item.body ?? "",
    tags: [...item.tags].sort(),
    favorite: item.favorite,
  });
}

/**
 * Decide which side of a differing item is newer.
 *
 * `revision` (server-monotonic version) is authoritative: a strictly higher
 * revision wins. An *equal* revision with divergent content means both sides
 * edited the same base version -> a genuine conflict. When revisions are
 * unavailable, fall back to `updatedAt`. If neither signal can decide, treat it
 * as a conflict so no edit is silently overwritten.
 */
function compareItemRecency(local: ConnectItem, remote: ConnectItem): "local" | "remote" | "conflict" {
  const localRevision = typeof local.revision === "number" ? local.revision : Number.NaN;
  const remoteRevision = typeof remote.revision === "number" ? remote.revision : Number.NaN;
  if (Number.isFinite(localRevision) && Number.isFinite(remoteRevision)) {
    if (localRevision > remoteRevision) {
      return "local";
    }
    if (remoteRevision > localRevision) {
      return "remote";
    }
    return "conflict";
  }

  const localTime = local.updatedAt ? Date.parse(local.updatedAt) : Number.NaN;
  const remoteTime = remote.updatedAt ? Date.parse(remote.updatedAt) : Number.NaN;
  if (!Number.isNaN(localTime) && !Number.isNaN(remoteTime)) {
    if (localTime > remoteTime) {
      return "local";
    }
    if (remoteTime > localTime) {
      return "remote";
    }
  }

  return "conflict";
}

/**
 * Classify every item present on both sides whose content differs into an
 * auto-appliable side (one-sided edit) or a genuine conflict.
 */
export function resolveSyncConflicts(
  localItems: ConnectItem[],
  remoteItems: ConnectItem[],
): SyncResolution {
  const remoteById = new Map(remoteItems.map((item) => [item.id, item]));
  const resolution: SyncResolution = { conflicts: [], pushLocal: [], pullRemote: [] };

  for (const local of localItems) {
    const remote = remoteById.get(local.id);
    if (!remote) {
      continue;
    }
    if (itemFingerprint(local) === itemFingerprint(remote)) {
      continue;
    }
    switch (compareItemRecency(local, remote)) {
      case "local":
        resolution.pushLocal.push(local);
        break;
      case "remote":
        resolution.pullRemote.push(remote);
        break;
      default:
        resolution.conflicts.push({ itemId: local.id, title: local.title, local, remote });
    }
  }

  return resolution;
}

/**
 * Detect genuine conflicts only. A one-sided edit (newer on exactly one side)
 * is auto-resolved by {@link resolveSyncConflicts} and is deliberately not
 * reported here.
 */
export function detectSyncConflicts(localItems: ConnectItem[], remoteItems: ConnectItem[]): SyncConflict[] {
  return resolveSyncConflicts(localItems, remoteItems).conflicts;
}

/**
 * Build the complete, side-effect-free sync plan: which items to create, which
 * to overwrite in either direction, and which remain genuine conflicts. Kept
 * pure (no network/client) so it is fully unit-testable and so the orchestrator
 * ({@link runCloudSync}) is a thin mapping from plan entries to API calls.
 */
export function planCloudSync(localItems: ConnectItem[], remoteItems: ConnectItem[]): CloudSyncPlan {
  const localById = new Map(localItems.map((item) => [item.id, item]));
  const remoteById = new Map(remoteItems.map((item) => [item.id, item]));
  const resolution = resolveSyncConflicts(localItems, remoteItems);

  const create = localItems.filter((local) => !remoteById.has(local.id));
  const remoteOnly = remoteItems.filter((remote) => !localById.has(remote.id));

  return {
    create,
    overwriteRemote: resolution.pushLocal,
    pull: [...remoteOnly, ...resolution.pullRemote],
    conflicts: resolution.conflicts,
  };
}
