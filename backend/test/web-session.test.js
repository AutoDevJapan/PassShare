import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { createMemoryAuthStore } from "../src/auth/index.js";
import { CSRF_COOKIE } from "../src/auth/constants.js";
import { createMemoryStore } from "../src/store/memory-store.js";
import { createApp } from "../src/app.js";

const EMAIL = "session@example.com";
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
  assert.match(session, /HttpOnly/i);
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
  assert.equal(body.csrfToken, cookieValueFrom(res.headers, CSRF_COOKIE));
  return body.csrfToken;
}

/** @param {string} baseUrl @param {string} csrfToken @param {string|null} cookieHeader @param {object} payload */
async function authPost(baseUrl, path, csrfToken, cookieHeader, payload) {
  /** @type {Record<string, string>} */
  const headers = {
    "Content-Type": "application/json",
    "X-CSRF-Token": csrfToken,
    Cookie: [`${CSRF_COOKIE}=${encodeURIComponent(csrfToken)}`, cookieHeader]
      .filter(Boolean)
      .join("; "),
  };
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
}

describe("Web session CSRF", () => {
  /** @type {import('http').Server} */
  let server;
  /** @type {string} */
  let baseUrl;

  before(async () => {
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

  it("rejects state-changing auth requests without CSRF token", async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, "PS027");
  });

  it("issues HttpOnly session cookie and validates CSRF on login/logout", async () => {
    const csrfToken = await fetchCsrf(baseUrl);
    const signupRes = await authPost(baseUrl, "/api/auth/signup", csrfToken, null, {
      email: EMAIL,
      password: PASSWORD,
    });
    assert.equal(signupRes.status, 201);
    const cookieHeader = sessionCookieFrom(signupRes.headers);

    const logoutCsrf = await fetchCsrf(baseUrl);
    const logoutRes = await authPost(baseUrl, "/api/auth/logout", logoutCsrf, cookieHeader, {});
    assert.equal(logoutRes.status, 204);

    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: cookieHeader },
    });
    assert.equal(meRes.status, 401);
  });
});
