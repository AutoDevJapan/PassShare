import type { ConnectItem } from "../types/item.js";

export type SyncConflict = {
  itemId: string;
  title: string;
  local: ConnectItem;
  remote: ConnectItem;
};

/**
 * The merge base for an item: the state both sides last agreed on (captured at
 * the previous successful sync). Either signal is optional so consumers can
 * persist only what is safe for their storage:
 *
 * - `revision` is the server-monotonic version (Connect `Item.version`) at the
 *   last sync. Because the server bumps it on every write, an unchanged remote
 *   revision *proves* the remote is still the merge base — no server-side edit
 *   has happened since. It is a non-sensitive integer, so it may be persisted
 *   outside the encrypted vault (e.g. desktop `localStorage`).
 * - `fingerprint` is the content fingerprint at the last sync. It embeds
 *   plaintext secrets, so it MUST only be kept inside the encrypted boundary
 *   (or in memory); never persist it to plaintext storage.
 */
export type SyncBase = {
  revision?: number | null;
  fingerprint?: string | null;
};

/** Per-item merge-base lookup consumed by the resolution functions. */
export type SyncBaseLookup = ReadonlyMap<string, SyncBase>;

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

/**
 * Content fingerprint of an item (metadata like `revision`/`updatedAt` is
 * excluded — those are not content). Exported so consumers can capture a merge
 * base and so orchestrators can detect already-in-sync items.
 *
 * NOTE: the fingerprint embeds plaintext secrets. Treat it like the secret
 * itself — compare it in memory, but never persist it to plaintext storage.
 */
export function itemFingerprint(item: ConnectItem): string {
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
 * Capture the merge base for an item that is currently in sync (i.e. the state
 * both sides agree on right now). Consumers persist the parts appropriate for
 * their storage — desktop keeps only `revision`, dropping the plaintext-bearing
 * `fingerprint`.
 */
export function captureSyncBase(item: ConnectItem): SyncBase {
  return {
    revision: typeof item.revision === "number" ? item.revision : null,
    fingerprint: itemFingerprint(item),
  };
}

/**
 * Three-way resolution against a recorded merge base, used only when the item's
 * content already differs between the two sides.
 *
 * Returns which side to auto-apply, `"conflict"` when both sides diverged from
 * the base, or `null` when the base cannot decide safely (caller then falls
 * back to {@link compareItemRecency}).
 */
function resolveWithBase(
  local: ConnectItem,
  remote: ConnectItem,
  base: SyncBase,
): "local" | "remote" | "conflict" | null {
  const baseRevision = typeof base.revision === "number" ? base.revision : null;
  const baseFingerprint = typeof base.fingerprint === "string" ? base.fingerprint : null;

  // Did each side diverge from the merge base?
  const localChanged: boolean | null =
    baseFingerprint !== null ? itemFingerprint(local) !== baseFingerprint : null;

  let remoteChanged: boolean | null = null;
  if (baseRevision !== null && typeof remote.revision === "number") {
    // Server revision is monotonic: an unchanged revision proves the remote is
    // still the merge base (no server-side write since the last sync).
    remoteChanged = remote.revision !== baseRevision;
  } else if (baseFingerprint !== null) {
    remoteChanged = itemFingerprint(remote) !== baseFingerprint;
  }

  // Full three-way merge when both divergence signals are known.
  if (localChanged !== null && remoteChanged !== null) {
    if (localChanged && !remoteChanged) {
      return "local";
    }
    if (!localChanged && remoteChanged) {
      return "remote";
    }
    // Both diverged (content already known to differ) -> genuine conflict.
    return "conflict";
  }

  // Revision-only base (no fingerprint to prove the local side): we can still
  // safely auto-push a local edit iff the remote is provably unchanged, because
  // the differing content must then be the local one-sided edit.
  if (remoteChanged === false) {
    return "local";
  }

  // Not enough signal to decide safely -> fall back to conservative recency.
  return null;
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
 *
 * When a merge base is available for an item (via `bases`), a three-way merge
 * decides the outcome: an edit on exactly one side auto-applies, both sides
 * diverging is a conflict. Without a base, or when the base cannot decide
 * safely, resolution falls back to the conservative recency comparison so no
 * edit is ever silently overwritten.
 */
export function resolveSyncConflicts(
  localItems: ConnectItem[],
  remoteItems: ConnectItem[],
  bases?: SyncBaseLookup,
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
    const base = bases?.get(local.id);
    const decided = base ? resolveWithBase(local, remote, base) : null;
    switch (decided ?? compareItemRecency(local, remote)) {
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
export function detectSyncConflicts(
  localItems: ConnectItem[],
  remoteItems: ConnectItem[],
  bases?: SyncBaseLookup,
): SyncConflict[] {
  return resolveSyncConflicts(localItems, remoteItems, bases).conflicts;
}

/**
 * Build the complete, side-effect-free sync plan: which items to create, which
 * to overwrite in either direction, and which remain genuine conflicts. Kept
 * pure (no network/client) so it is fully unit-testable and so the orchestrator
 * ({@link runCloudSync}) is a thin mapping from plan entries to API calls.
 */
export function planCloudSync(
  localItems: ConnectItem[],
  remoteItems: ConnectItem[],
  bases?: SyncBaseLookup,
): CloudSyncPlan {
  const localById = new Map(localItems.map((item) => [item.id, item]));
  const remoteById = new Map(remoteItems.map((item) => [item.id, item]));
  const resolution = resolveSyncConflicts(localItems, remoteItems, bases);

  const create = localItems.filter((local) => !remoteById.has(local.id));
  const remoteOnly = remoteItems.filter((remote) => !localById.has(remote.id));

  return {
    create,
    overwriteRemote: resolution.pushLocal,
    pull: [...remoteOnly, ...resolution.pullRemote],
    conflicts: resolution.conflicts,
  };
}
