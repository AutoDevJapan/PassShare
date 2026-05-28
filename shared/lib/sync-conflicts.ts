import type { ConnectItem } from "../types/item.js";

export type SyncConflict = {
  itemId: string;
  title: string;
  local: ConnectItem;
  remote: ConnectItem;
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

export function detectSyncConflicts(localItems: ConnectItem[], remoteItems: ConnectItem[]): SyncConflict[] {
  const remoteById = new Map(remoteItems.map((item) => [item.id, item]));
  const conflicts: SyncConflict[] = [];

  for (const local of localItems) {
    const remote = remoteById.get(local.id);
    if (!remote) {
      continue;
    }
    if (itemFingerprint(local) !== itemFingerprint(remote)) {
      conflicts.push({ itemId: local.id, title: local.title, local, remote });
    }
  }

  return conflicts;
}
