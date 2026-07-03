/**
 * Shared Web-auth flow helpers for backend integration tests.
 * Mirrors the signup -> connect-token -> vault path used by the Web portal.
 */

import assert from "node:assert/strict";
import { CSRF_COOKIE } from "../../src/auth/constants.js";

/** @param {Headers} headers */
function getSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

/** @param {Headers} headers */
export function sessionCookieFrom(headers) {
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
export async function fetchCsrf(baseUrl) {
  const res = await fetch(`${baseUrl}/api/auth/csrf`);
  assert.equal(res.status, 200);
  const body = await res.json();
  return {
    csrfToken: body.csrfToken,
    csrfCookie: cookieValueFrom(res.headers, CSRF_COOKIE),
  };
}

/**
 * Sign up a user, then resolve their Connect access token and (single) vault.
 * @param {string} baseUrl
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ email: string, password: string, sessionCookie: string, vaultId: string, vaultName: string, accessToken: string }>}
 */
export async function signupUser(baseUrl, email, password) {
  const { csrfToken, csrfCookie } = await fetchCsrf(baseUrl);
  const signupRes = await fetch(`${baseUrl}/api/auth/signup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
      Cookie: `${CSRF_COOKIE}=${encodeURIComponent(csrfCookie ?? csrfToken)}`,
    },
    body: JSON.stringify({ email, password }),
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
    password,
    sessionCookie,
    vaultId: vaults[0].id,
    vaultName: vaults[0].name,
    accessToken: tokenBody.accessToken,
  };
}
