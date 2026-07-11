import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { CSRF_COOKIE } from "../src/auth/constants.js";
import { createApp } from "../src/app.js";
import { generateConnectId } from "../src/lib/connect.js";
import {
  checkSyncConflicts,
  connectItemFromApi,
  connectItemToCreateBody,
  resolveConflictKeepLocal,
  resolveConflictKeepRemote,
  runCloudSync,
} from "./helpers/desktop-cloud-sync-flow.js";

const { Pool } = pg;

const PASSWORD = "CloudSyncTest1!";
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://passshare:passshare@localhost:5432/passshare";

/** @param {Headers} headers */
function getSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

/** @param {Headers} headers */
function sessionCookieFrom(headers) {
  const cookies = getSetCookies(headers);
  const session = cookies.find((entry) => entry.startsWith("passshare_session="));
  assert.ok(session, "expected passshare_session cookie");
  return session.split(";")[0];
}

/** @param {Headers} headers @param {string} name */
function cookieValueFrom(headers, name) {
  const cookies = getSetCookies(headers);
  const match = cookies.find((entry) => entry.startsWith(`${name}=`));
  if (!match) return null;
  return decodeURIComponent(match.slice(name.length + 1).split(";")[0]);
}

/** @param {string} baseUrl */
async function fetchCsrf(baseUrl) {
  const res = await fetch(`${baseUrl}/api/auth/csrf`);
  assert.equal(res.status, 200);
  const body = await res.json();
  return {
    csrfToken: body.csrfToken,
    csrfCookie: cookieValueFrom(res.headers, CSRF_COOKIE),
  };
}

/**
 * @param {string} baseUrl
 * @param {string} email
 */
async function signupUser(baseUrl, email) {
  const { csrfToken, csrfCookie } = await fetchCsrf(baseUrl);
  const signupRes = await fetch(`${baseUrl}/api/auth/signup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
      Cookie: `${CSRF_COOKIE}=${encodeURIComponent(csrfCookie ?? csrfToken)}`,
    },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  assert.equal(signupRes.status, 201);
  const sessionCookie = sessionCookieFrom(signupRes.headers);

  const tokenRes = await fetch(`${baseUrl}/api/auth/connect-token`, {
    headers: { Cookie: sessionCookie },
  });
  assert.equal(tokenRes.status, 200);
  const tokenBody = await tokenRes.json();

  const vaultsRes = await fetch(`${baseUrl}/v1/vaults`, {
    headers: { Authorization: `Bearer ${tokenBody.accessToken}` },
  });
  assert.equal(vaultsRes.status, 200);
  const vaults = await vaultsRes.json();
  assert.equal(vaults.length, 1);

  return {
    email,
    password: PASSWORD,
    sessionCookie,
    vaultId: vaults[0].id,
    accessToken: tokenBody.accessToken,
  };
}

/** @param {ConnectItem} overrides */
function localLoginItem(overrides = {}) {
  const id = overrides.id ?? generateConnectId();
  return {
    id,
    title: overrides.title ?? "Desktop Local Login",
    category: "LOGIN",
    tags: overrides.tags ?? ["desktop"],
    favorite: false,
    url: "https://example.com",
    username: "user@example.com",
    password: "local-secret",
    notes: "",
    ...overrides,
  };
}

describe(
  "Desktop cloud sync (Auth + Connect API integration)",
  { skip: !process.env.DATABASE_URL },
  () => {
    /** @type {import('pg').Pool} */
    let pool;
    /** @type {import('http').Server} */
    let server;
    /** @type {string} */
    let baseUrl;
    /** @type {{ email: string, password: string, sessionCookie: string, vaultId: string, accessToken: string }} */
    let user;

    before(async () => {
      delete process.env.OP_CONNECT_TOKEN;
      process.env.APP_ENV = "local";
      pool = new Pool({ connectionString: DATABASE_URL });

      const { app } = await createApp({ pool });
      server = app.listen(0);
      await new Promise((resolve) => server.once("listening", resolve));
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;

      user = await signupUser(baseUrl, `cloud-sync-${generateConnectId()}@example.com`);
    });

    after(async () => {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await pool.end();
      delete process.env.APP_ENV;
    });

    it("pushes local-only items to remote and pulls remote-only items to local", async () => {
      const localOnlyId = generateConnectId();
      const remoteOnlyId = generateConnectId();

      const createRemoteRes = await fetch(`${baseUrl}/v1/vaults/${user.vaultId}/items`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          connectItemToCreateBody(
            localLoginItem({
              id: remoteOnlyId,
              title: "Remote Only Login",
              username: "remote@example.com",
            }),
            { id: remoteOnlyId },
          ),
        ),
      });
      assert.equal(createRemoteRes.status, 201);

      const localItems = [
        localLoginItem({ id: localOnlyId, title: "Local Only Login", username: "local@example.com" }),
      ];
      /** @type {import('./helpers/desktop-cloud-sync-flow.js').ConnectItem[]} */
      const pulledItems = [];

      const config = {
        apiBaseUrl: baseUrl,
        email: user.email,
        password: user.password,
        vaultId: user.vaultId,
      };

      const result = await runCloudSync(config, user.sessionCookie, localItems, async (item) => {
        pulledItems.push(item);
      });

      assert.equal(result.pushed, 1);
      assert.equal(result.pulled, 1);
      assert.equal(result.conflicts.length, 0);

      const remoteRes = await fetch(`${baseUrl}/v1/vaults/${user.vaultId}/items/${localOnlyId}`, {
        headers: { Authorization: `Bearer ${user.accessToken}` },
      });
      assert.equal(remoteRes.status, 200);
      const remoteItem = connectItemFromApi(await remoteRes.json());
      assert.equal(remoteItem.title, "Local Only Login");

      assert.equal(pulledItems.length, 1);
      assert.equal(pulledItems[0].id, remoteOnlyId);
      assert.equal(pulledItems[0].title, "Remote Only Login");
    });

    it("detects conflicts and resolves with keep-local or keep-remote", async () => {
      const conflictId = generateConnectId();
      const localItem = localLoginItem({
        id: conflictId,
        title: "Local Version",
        password: "local-pass",
      });
      const remoteItem = localLoginItem({
        id: conflictId,
        title: "Remote Version",
        password: "remote-pass",
      });

      const createRes = await fetch(`${baseUrl}/v1/vaults/${user.vaultId}/items`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(connectItemToCreateBody(remoteItem, { id: conflictId })),
      });
      assert.equal(createRes.status, 201);

      const config = {
        apiBaseUrl: baseUrl,
        email: user.email,
        password: user.password,
        vaultId: user.vaultId,
      };

      const conflicts = await checkSyncConflicts(config, user.sessionCookie, [localItem]);
      assert.equal(conflicts.length, 1);
      assert.equal(conflicts[0].itemId, conflictId);
      assert.equal(conflicts[0].local.title, "Local Version");
      assert.equal(conflicts[0].remote.title, "Remote Version");

      await resolveConflictKeepLocal(config, user.sessionCookie, localItem);
      const afterLocalRes = await fetch(`${baseUrl}/v1/vaults/${user.vaultId}/items/${conflictId}`, {
        headers: { Authorization: `Bearer ${user.accessToken}` },
      });
      assert.equal(afterLocalRes.status, 200);
      const afterLocal = connectItemFromApi(await afterLocalRes.json());
      assert.equal(afterLocal.title, "Local Version");
      assert.equal(afterLocal.password, "local-pass");

      const conflictId2 = generateConnectId();
      const localItem2 = localLoginItem({
        id: conflictId2,
        title: "Local Version 2",
        password: "local-pass-2",
      });
      const remoteItem2 = localLoginItem({
        id: conflictId2,
        title: "Remote Version 2",
        password: "remote-pass-2",
      });

      const createRes2 = await fetch(`${baseUrl}/v1/vaults/${user.vaultId}/items`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(connectItemToCreateBody(remoteItem2, { id: conflictId2 })),
      });
      assert.equal(createRes2.status, 201);

      /** @type {import('./helpers/desktop-cloud-sync-flow.js').ConnectItem | null} */
      let resolvedLocal = null;
      await resolveConflictKeepRemote(remoteItem2, async (item) => {
        resolvedLocal = item;
      });
      assert.ok(resolvedLocal);
      assert.equal(resolvedLocal.id, conflictId2);
      assert.equal(resolvedLocal.title, "Remote Version 2");
      assert.equal(resolvedLocal.password, "remote-pass-2");
    });

    it("auto-pushes a local one-sided edit after a prior sync (merge-base tracking)", async () => {
      // Use a dedicated user (and therefore a fresh, empty vault) so item counts
      // are not polluted by the other subtests that share the top-level `user`.
      const editUser = await signupUser(baseUrl, `merge-base-${generateConnectId()}@example.com`);
      const itemId = generateConnectId();
      const config = {
        apiBaseUrl: baseUrl,
        email: editUser.email,
        password: editUser.password,
        vaultId: editUser.vaultId,
      };

      // Seed the remote and perform an initial sync so the merge base is recorded.
      const createRes = await fetch(`${baseUrl}/v1/vaults/${editUser.vaultId}/items`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${editUser.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          connectItemToCreateBody(
            localLoginItem({ id: itemId, title: "Base Login", password: "base-secret" }),
            { id: itemId },
          ),
        ),
      });
      assert.equal(createRes.status, 201);

      // A merge-base store the caller persists across syncs (desktop keeps this in
      // localStorage as revision-only integers).
      const bases = new Map();
      const firstSync = await runCloudSync(config, editUser.sessionCookie, [], async () => {}, bases);
      assert.equal(firstSync.pulled, 1);
      assert.equal(firstSync.pushed, 0);
      assert.ok(bases.has(itemId), "the initial sync records a merge base for the item");

      // Local-only edit: same id, changed content, no revision (mirrors the local
      // vault, which stores form values without the server revision).
      const editedLocal = localLoginItem({
        id: itemId,
        title: "Base Login",
        password: "local-edited-secret",
      });
      assert.equal(editedLocal.revision, undefined);

      const secondSync = await runCloudSync(
        config,
        editUser.sessionCookie,
        [editedLocal],
        async () => {},
        bases,
      );
      assert.equal(secondSync.conflicts.length, 0, "a local one-sided edit is not a conflict");
      assert.equal(secondSync.pushed, 1, "the local one-sided edit is auto-pushed");
      assert.equal(secondSync.pulled, 0);

      // The remote now reflects the local edit.
      const remoteRes = await fetch(`${baseUrl}/v1/vaults/${editUser.vaultId}/items/${itemId}`, {
        headers: { Authorization: `Bearer ${editUser.accessToken}` },
      });
      assert.equal(remoteRes.status, 200);
      const remoteItem = connectItemFromApi(await remoteRes.json());
      assert.equal(remoteItem.password, "local-edited-secret");
    });
  },
);
