import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { CSRF_COOKIE } from "../src/auth/constants.js";
import { createMemoryAuthStore } from "../src/auth/index.js";
import { createMemoryStore } from "../src/store/memory-store.js";
import { createApp } from "../src/app.js";

const PASSWORD = "password123";

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
  return { csrfToken: body.csrfToken, cookie: cookieValueFrom(res.headers, CSRF_COOKIE) };
}

/**
 * @param {string} baseUrl
 * @param {string} email
 */
async function signupUser(baseUrl, email) {
  const { csrfToken, cookie: csrfCookie } = await fetchCsrf(baseUrl);
  const res = await fetch(`${baseUrl}/api/auth/signup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
      Cookie: `${CSRF_COOKIE}=${encodeURIComponent(csrfCookie ?? csrfToken)}`,
    },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  assert.equal(res.status, 201);
  return {
    sessionCookie: sessionCookieFrom(res.headers),
    user: (await res.json()).user,
  };
}

/**
 * @param {string} baseUrl
 * @param {string} sessionCookie
 * @param {string} method
 * @param {string} path
 * @param {object} [body]
 */
async function authRequest(baseUrl, sessionCookie, method, path, body) {
  const { csrfToken, cookie: csrfCookie } = await fetchCsrf(baseUrl);
  /** @type {Record<string, string>} */
  const headers = {
    "X-CSRF-Token": csrfToken,
    Cookie: [sessionCookie, `${CSRF_COOKIE}=${encodeURIComponent(csrfCookie ?? csrfToken)}`]
      .filter(Boolean)
      .join("; "),
  };
  if (body) {
    headers["Content-Type"] = "application/json";
  }
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

/**
 * @param {string} baseUrl
 * @param {string} sessionCookie
 */
async function getDefaultVaultId(baseUrl, sessionCookie) {
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
  return vaults[0].id;
}

describe("Vault share API (#100)", () => {
  /** @type {import('http').Server} */
  let server;
  /** @type {string} */
  let baseUrl;

  before(async () => {
    process.env.APP_ENV = "local";
    delete process.env.OP_CONNECT_TOKEN;
    const store = createMemoryStore();
    const authStore = createMemoryAuthStore();
    const { app } = await createApp({ store, authStore, pool: null });
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("owner invites member and member accepts", async () => {
    const owner = await signupUser(baseUrl, "owner@example.com");
    const member = await signupUser(baseUrl, "member@example.com");
    const vaultId = await getDefaultVaultId(baseUrl, owner.sessionCookie);

    const inviteRes = await authRequest(
      baseUrl,
      owner.sessionCookie,
      "POST",
      `/api/auth/vaults/${vaultId}/invitations`,
      { email: "member@example.com", role: "member" },
    );
    assert.equal(inviteRes.status, 201);
    const inviteBody = await inviteRes.json();
    assert.ok(inviteBody.id);

    const pendingRes = await fetch(`${baseUrl}/api/auth/invitations`, {
      headers: { Cookie: member.sessionCookie },
    });
    assert.equal(pendingRes.status, 200);
    const pendingBody = await pendingRes.json();
    assert.equal(pendingBody.invitations.length, 1);
    assert.equal(pendingBody.invitations[0].vaultId, vaultId);

    const acceptRes = await authRequest(
      baseUrl,
      member.sessionCookie,
      "POST",
      `/api/auth/invitations/${inviteBody.id}/accept`,
    );
    assert.equal(acceptRes.status, 200);

    const tokenRes = await fetch(`${baseUrl}/api/auth/connect-token`, {
      headers: { Cookie: member.sessionCookie },
    });
    const tokenBody = await tokenRes.json();
    const vaultsRes = await fetch(`${baseUrl}/v1/vaults`, {
      headers: { Authorization: `Bearer ${tokenBody.accessToken}` },
    });
    const vaults = await vaultsRes.json();
    assert.ok(vaults.some((vault) => vault.id === vaultId));
  });

  it("owner can list and remove members", async () => {
    const owner = await signupUser(baseUrl, "owner2@example.com");
    const member = await signupUser(baseUrl, "member2@example.com");
    const vaultId = await getDefaultVaultId(baseUrl, owner.sessionCookie);

    const inviteRes = await authRequest(
      baseUrl,
      owner.sessionCookie,
      "POST",
      `/api/auth/vaults/${vaultId}/invitations`,
      { email: "member2@example.com" },
    );
    const inviteBody = await inviteRes.json();
    await authRequest(
      baseUrl,
      member.sessionCookie,
      "POST",
      `/api/auth/invitations/${inviteBody.id}/accept`,
    );

    const membersRes = await fetch(`${baseUrl}/api/auth/vaults/${vaultId}/members`, {
      headers: { Cookie: owner.sessionCookie },
    });
    assert.equal(membersRes.status, 200);
    const membersBody = await membersRes.json();
    assert.equal(membersBody.members.length, 2);

    const removeRes = await authRequest(
      baseUrl,
      owner.sessionCookie,
      "DELETE",
      `/api/auth/vaults/${vaultId}/members/${member.user.id}`,
    );
    assert.equal(removeRes.status, 204);

    const tokenRes = await fetch(`${baseUrl}/api/auth/connect-token`, {
      headers: { Cookie: member.sessionCookie },
    });
    const tokenBody = await tokenRes.json();
    const vaultsRes = await fetch(`${baseUrl}/v1/vaults`, {
      headers: { Authorization: `Bearer ${tokenBody.accessToken}` },
    });
    const vaults = await vaultsRes.json();
    assert.equal(vaults.some((vault) => vault.id === vaultId), false);
  });

  it("non-owner cannot invite", async () => {
    const owner = await signupUser(baseUrl, "owner3@example.com");
    const member = await signupUser(baseUrl, "member3@example.com");
    const vaultId = await getDefaultVaultId(baseUrl, owner.sessionCookie);

    const inviteRes = await authRequest(
      baseUrl,
      owner.sessionCookie,
      "POST",
      `/api/auth/vaults/${vaultId}/invitations`,
      { email: "member3@example.com" },
    );
    const inviteBody = await inviteRes.json();
    await authRequest(
      baseUrl,
      member.sessionCookie,
      "POST",
      `/api/auth/invitations/${inviteBody.id}/accept`,
    );

    const forbiddenRes = await authRequest(
      baseUrl,
      member.sessionCookie,
      "POST",
      `/api/auth/vaults/${vaultId}/invitations`,
      { email: "owner3@example.com" },
    );
    assert.equal(forbiddenRes.status, 403);
  });
});
