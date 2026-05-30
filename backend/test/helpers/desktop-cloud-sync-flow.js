/**
 * Desktop cloud-sync.ts equivalent for backend integration tests.
 * Mirrors apps/desktop/src/lib/cloud-sync.ts without React/Tauri dependencies.
 */

/** @typedef {import('../../../shared/types/item.js').ConnectItem} ConnectItem */

/** @typedef {{ itemId: string, title: string, local: ConnectItem, remote: ConnectItem }} SyncConflict */

/** @typedef {{ apiBaseUrl: string, email: string, password: string, vaultId: string }} CloudSyncConfig */

/** @typedef {{ pushed: number, pulled: number, conflicts: SyncConflict[] }} SyncRunResult */

/** @param {ConnectItem} item */
function itemFingerprint(item) {
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
 * @param {ConnectItem[]} localItems
 * @param {ConnectItem[]} remoteItems
 * @returns {SyncConflict[]}
 */
export function detectSyncConflicts(localItems, remoteItems) {
  const remoteById = new Map(remoteItems.map((item) => [item.id, item]));
  /** @type {SyncConflict[]} */
  const conflicts = [];

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

/** @param {Record<string, unknown>} item */
function fieldValue(item, purpose, label) {
  const fields = /** @type {Array<Record<string, unknown>>} */ (item.fields ?? []);
  const match = fields.find(
    (field) =>
      (purpose && String(field.purpose ?? "").toUpperCase() === purpose) ||
      (label && String(field.label ?? "").toLowerCase() === label.toLowerCase()),
  );
  return match?.value != null ? String(match.value) : "";
}

/** @param {Record<string, unknown>} item @returns {ConnectItem} */
export function connectItemFromApi(item) {
  const urls = /** @type {Array<{ href?: string, primary?: boolean }>} */ (item.urls ?? []);
  const primaryUrl = urls.find((url) => url.primary) ?? urls[0];

  return {
    id: String(item.id),
    title: String(item.title ?? ""),
    category: /** @type {ConnectItem["category"]} */ (item.category ?? "LOGIN"),
    tags: /** @type {string[]} */ (item.tags ?? []),
    favorite: Boolean(item.favorite),
    url: primaryUrl?.href ?? null,
    username: fieldValue(item, "USERNAME"),
    password: fieldValue(item, "PASSWORD"),
    body: fieldValue(item, undefined, "notes") || fieldValue(item, undefined, "body"),
    notes: fieldValue(item, undefined, "notes"),
  };
}

/**
 * @param {ConnectItem} item
 * @param {{ id?: string }} [options]
 */
export function connectItemToCreateBody(item, options = {}) {
  /** @type {Array<Record<string, unknown>>} */
  const fields = [];

  if (item.category === "LOGIN") {
    fields.push(
      { label: "username", type: "STRING", purpose: "USERNAME", value: item.username ?? "" },
      { label: "password", type: "CONCEALED", purpose: "PASSWORD", value: item.password ?? "" },
    );
  } else if (item.category === "PASSWORD") {
    fields.push({
      label: "password",
      type: "CONCEALED",
      purpose: "PASSWORD",
      value: item.password ?? "",
    });
  } else {
    fields.push({ label: "notes", type: "STRING", value: item.body ?? "" });
  }

  if (item.notes && item.category !== "SECURE_NOTE") {
    fields.push({ label: "notes", type: "STRING", value: item.notes });
  }

  /** @type {Record<string, unknown>} */
  const body = {
    title: item.title,
    category: item.category,
    fields,
    tags: item.tags,
    favorite: item.favorite,
  };

  if (item.category === "LOGIN" && item.url?.trim()) {
    body.urls = [{ href: item.url.trim(), primary: true, label: "" }];
  }

  if (options.id) {
    body.id = options.id;
  }

  return body;
}

/**
 * @param {CloudSyncConfig} config
 * @param {string} sessionCookie
 */
async function loginAndGetAccessToken(config, sessionCookie) {
  const tokenRes = await fetch(`${config.apiBaseUrl}/api/auth/connect-token`, {
    headers: { Cookie: sessionCookie },
  });
  if (!tokenRes.ok) {
    throw new Error(`Connect token fetch failed (${tokenRes.status})`);
  }
  const tokenBody = /** @type {{ accessToken: string }} */ (await tokenRes.json());
  return tokenBody.accessToken;
}

/**
 * @param {string} apiBaseUrl
 * @param {string} accessToken
 * @param {string} vaultId
 * @returns {Promise<ConnectItem[]>}
 */
async function fetchRemoteItems(apiBaseUrl, accessToken, vaultId) {
  const listRes = await fetch(`${apiBaseUrl}/v1/vaults/${vaultId}/items`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!listRes.ok) {
    throw new Error(`listItems failed (${listRes.status})`);
  }
  const overviews = /** @type {Array<{ id: string }>} */ (await listRes.json());
  const details = await Promise.all(
    overviews.map(async (overview) => {
      const getRes = await fetch(`${apiBaseUrl}/v1/vaults/${vaultId}/items/${overview.id}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!getRes.ok) {
        throw new Error(`getItem failed (${getRes.status})`);
      }
      return /** @type {Record<string, unknown>} */ (await getRes.json());
    }),
  );
  return details.map(connectItemFromApi);
}

/**
 * @param {CloudSyncConfig} config
 * @param {string} sessionCookie
 * @param {ConnectItem[]} localItems
 * @returns {Promise<SyncConflict[]>}
 */
export async function checkSyncConflicts(config, sessionCookie, localItems) {
  const accessToken = await loginAndGetAccessToken(config, sessionCookie);
  const remoteItems = await fetchRemoteItems(config.apiBaseUrl, accessToken, config.vaultId);
  return detectSyncConflicts(localItems, remoteItems);
}

/** @typedef {(item: ConnectItem) => Promise<void>} SyncPullHandler */

/**
 * @param {CloudSyncConfig} config
 * @param {string} sessionCookie
 * @param {ConnectItem[]} localItems
 * @param {SyncPullHandler} onPull
 * @returns {Promise<SyncRunResult>}
 */
export async function runCloudSync(config, sessionCookie, localItems, onPull) {
  const accessToken = await loginAndGetAccessToken(config, sessionCookie);
  const remoteItems = await fetchRemoteItems(config.apiBaseUrl, accessToken, config.vaultId);
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
      const createRes = await fetch(`${config.apiBaseUrl}/v1/vaults/${config.vaultId}/items`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(connectItemToCreateBody(local, { id: local.id })),
      });
      if (!createRes.ok) {
        throw new Error(`createItem failed (${createRes.status})`);
      }
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

/**
 * @param {CloudSyncConfig} config
 * @param {string} sessionCookie
 * @param {ConnectItem} local
 */
export async function resolveConflictKeepLocal(config, sessionCookie, local) {
  const accessToken = await loginAndGetAccessToken(config, sessionCookie);
  const replaceRes = await fetch(
    `${config.apiBaseUrl}/v1/vaults/${config.vaultId}/items/${local.id}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(connectItemToCreateBody(local)),
    },
  );
  if (!replaceRes.ok) {
    throw new Error(`replaceItem failed (${replaceRes.status})`);
  }
}

/**
 * @param {ConnectItem} remote
 * @param {SyncPullHandler} onPull
 */
export async function resolveConflictKeepRemote(remote, onPull) {
  await onPull(remote);
}
