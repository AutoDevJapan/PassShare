// Cloud-sync orchestration primitives shared by `cloud-sync.ts` and its tests.
// This module deliberately imports only types so it can run under
// `node --experimental-strip-types` without an alias/module resolver.

/** Broad category of a sync failure, used to pick an actionable message. */
export type SyncErrorKind = "auth" | "network" | "server" | "unknown";

/** Direction an item is being synchronised. */
export type SyncDirection = "push" | "pull";

/** Error carrying a classified {@link SyncErrorKind}. */
export class SyncError extends Error {
  readonly kind: SyncErrorKind;

  constructor(kind: SyncErrorKind, message: string) {
    super(message);
    this.name = "SyncError";
    this.kind = kind;
  }
}

/**
 * Map an arbitrary thrown value to a {@link SyncErrorKind}.
 *
 * - {@link SyncError} instances keep their explicit kind.
 * - `fetch` network failures (`TypeError` / "failed to fetch") -> `network`.
 * - HTTP status codes embedded in the message: 401/403 -> `auth`, 5xx -> `server`.
 * - Everything else -> `unknown`.
 */
export function classifySyncError(error: unknown): SyncErrorKind {
  if (error instanceof SyncError) {
    return error.kind;
  }

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (
    error instanceof TypeError ||
    lower.includes("failed to fetch") ||
    lower.includes("fetch failed") ||
    lower.includes("networkerror") ||
    lower.includes("network error") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("etimedout")
  ) {
    return "network";
  }

  const statusMatch = message.match(/\b(\d{3})\b/);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    if (status === 401 || status === 403) {
      return "auth";
    }
    if (status >= 500) {
      return "server";
    }
  }

  return "unknown";
}

/** Outcome of a single per-item sync attempt. */
export type SyncItemOutcome = {
  itemId: string;
  title: string;
  direction: SyncDirection;
  status: "success" | "failed";
  errorKind?: SyncErrorKind;
};

/** Progress snapshot emitted before and after each item is processed. */
export type SyncProgress = {
  completed: number;
  total: number;
  current: { title: string; direction: SyncDirection } | null;
};

export type SyncProgressHandler = (progress: SyncProgress) => void;

/** A single unit of sync work (one item, one direction). */
export type SyncTask = {
  itemId: string;
  title: string;
  direction: SyncDirection;
  run: () => Promise<void>;
};

/** Aggregate result of running a batch of {@link SyncTask}s. */
export type SyncTaskSummary = {
  pushed: number;
  pulled: number;
  outcomes: SyncItemOutcome[];
  failures: SyncItemOutcome[];
};

/**
 * Run each task sequentially, reporting progress and collecting per-item
 * outcomes. A failing item is recorded and skipped rather than aborting the
 * whole run, so the sync is non-atomic-but-resumable: items that fail simply
 * remain out of sync and are retried on the next run.
 */
export async function executeSyncTasks(
  tasks: SyncTask[],
  onProgress?: SyncProgressHandler,
): Promise<SyncTaskSummary> {
  const outcomes: SyncItemOutcome[] = [];
  const total = tasks.length;
  let completed = 0;
  let pushed = 0;
  let pulled = 0;

  for (const task of tasks) {
    onProgress?.({
      completed,
      total,
      current: { title: task.title, direction: task.direction },
    });

    try {
      await task.run();
      outcomes.push({
        itemId: task.itemId,
        title: task.title,
        direction: task.direction,
        status: "success",
      });
      if (task.direction === "push") {
        pushed += 1;
      } else {
        pulled += 1;
      }
    } catch (error) {
      outcomes.push({
        itemId: task.itemId,
        title: task.title,
        direction: task.direction,
        status: "failed",
        errorKind: classifySyncError(error),
      });
    }

    completed += 1;
    onProgress?.({ completed, total, current: null });
  }

  return {
    pushed,
    pulled,
    outcomes,
    failures: outcomes.filter((outcome) => outcome.status === "failed"),
  };
}
