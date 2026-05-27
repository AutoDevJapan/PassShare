import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { CSRF_COOKIE } from "../src/auth/constants.js";
import { MAX_LOGIN_FAILURES } from "../src/auth/rate-limit-constants.js";
import { createMemoryAuthStore } from "../src/auth/index.js";
import { createMemoryStore } from "../src/store/memory-store.js";
import { createApp } from "../src/app.js";

const EMAIL = "locked@example.com";
const PASSWORD = "password123";

/** @param {Headers} headers */
function getSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const single = headers.get("set-cookie");
  return single ? [single] : [];
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
  return { csrfToken: body.csrfToken, cookie: `${CSRF_COOKIE}=${encodeURIComponent(body.csrfToken)}` };
}

/** @param {string} baseUrl @param {string} csrfToken @param {string} csrfCookie @param {string} password */
async function loginAttempt(baseUrl, csrfToken, csrfCookie, password) {
  return fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
      Cookie: csrfCookie,
    },
    body: JSON.stringify({ email: EMAIL, password }),
  });
}

describe("Login rate limiting", () => {
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

    const signupCsrf = await fetchCsrf(baseUrl);
    const signupRes = await fetch(`${baseUrl}/api/auth/signup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": signupCsrf.csrfToken,
        Cookie: signupCsrf.cookie,
      },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    assert.equal(signupRes.status, 201);
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("locks account after consecutive failed login attempts", async () => {
    for (let i = 0; i < MAX_LOGIN_FAILURES; i += 1) {
      const csrf = await fetchCsrf(baseUrl);
      const res = await loginAttempt(baseUrl, csrf.csrfToken, csrf.cookie, "wrong-password");
      assert.equal(res.status, 401);
    }

    const csrf = await fetchCsrf(baseUrl);
    const lockedRes = await loginAttempt(baseUrl, csrf.csrfToken, csrf.cookie, PASSWORD);
    assert.equal(lockedRes.status, 429);
    const body = await lockedRes.json();
    assert.equal(body.error, "PS028");
    assert.ok(lockedRes.headers.get("retry-after"));
  });
});
