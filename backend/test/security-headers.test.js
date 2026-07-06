import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { createMemoryAuthStore } from "../src/auth/index.js";
import { createMemoryStore } from "../src/store/memory-store.js";
import { createApp } from "../src/app.js";
import { isAllowedWebOrigin } from "../src/middleware/web-origin.js";

describe("web origin allowlist", () => {
  it("allows localhost in local env", () => {
    assert.equal(isAllowedWebOrigin("http://localhost:5173", "local"), true);
    assert.equal(isAllowedWebOrigin("https://evil.example", "local"), false);
  });

  it("allows Vercel domains in production-like envs", () => {
    assert.equal(
      isAllowedWebOrigin("https://pass-share-frontend.vercel.app", "prd"),
      true,
    );
    assert.equal(
      isAllowedWebOrigin("https://pass-share-frontend-git-feat-abc.vercel.app", "stg"),
      true,
    );
    assert.equal(isAllowedWebOrigin("https://evil.example", "prd"), false);
    assert.equal(isAllowedWebOrigin("http://pass-share-frontend.vercel.app", "prd"), false);
  });

  it("rejects untrusted vercel.app subdomains", () => {
    // A bare `.vercel.app` suffix must not be trusted: anyone can deploy one.
    assert.equal(isAllowedWebOrigin("https://evil.vercel.app", "prd"), false);
    assert.equal(isAllowedWebOrigin("https://evil.vercel.app", "preview"), false);
    // Prefix-lookalikes without the exact project boundary must also be rejected.
    assert.equal(isAllowedWebOrigin("https://pass-share-frontend-evil.vercel.app", "prd"), false);
    assert.equal(isAllowedWebOrigin("https://pass-share-frontend.evil.vercel.app", "prd"), false);
    assert.equal(isAllowedWebOrigin("https://evil-pass-share-frontend.vercel.app", "prd"), false);
    assert.equal(
      isAllowedWebOrigin("https://pass-share-frontend.vercel.app.evil.com", "prd"),
      false,
    );
  });

  it("allows configured WEB_ORIGIN custom domain", () => {
    assert.equal(
      isAllowedWebOrigin("https://pass-share.bm1314.net", "prd", "https://pass-share.bm1314.net"),
      true,
    );
    assert.equal(
      isAllowedWebOrigin("https://pass-share.bm1314.net", "prd"),
      false,
    );
  });
});

describe("security headers and CORS", () => {
  /** @type {import('http').Server} */
  let server;
  /** @type {string} */
  let baseUrl;
  /** @type {string | undefined} */
  let previousWebOrigin;

  before(async () => {
    previousWebOrigin = process.env.WEB_ORIGIN;
    delete process.env.WEB_ORIGIN;
    process.env.APP_ENV = "prd";

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
    if (previousWebOrigin === undefined) {
      delete process.env.WEB_ORIGIN;
    } else {
      process.env.WEB_ORIGIN = previousWebOrigin;
    }
    delete process.env.APP_ENV;
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve(undefined)));
    });
  });

  it("sets baseline security headers on health", async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.match(res.headers.get("strict-transport-security") ?? "", /max-age=31536000/);
  });

  it("reflects allowed Vercel origin with credentials", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "https://pass-share-frontend.vercel.app" },
    });
    assert.equal(
      res.headers.get("access-control-allow-origin"),
      "https://pass-share-frontend.vercel.app",
    );
    assert.equal(res.headers.get("access-control-allow-credentials"), "true");
  });

  it("does not reflect disallowed origins", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(res.headers.get("access-control-allow-origin"), null);
    assert.equal(res.headers.get("access-control-allow-credentials"), null);
  });

  it("does not reflect untrusted vercel.app origins", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "https://evil.vercel.app" },
    });
    assert.equal(res.headers.get("access-control-allow-origin"), null);
    assert.equal(res.headers.get("access-control-allow-credentials"), null);
  });

  it("handles preflight for allowed origin", async () => {
    const res = await fetch(`${baseUrl}/api/auth/csrf`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://pass-share-frontend-git-main-autodevjapan.vercel.app",
        "Access-Control-Request-Method": "POST",
      },
    });
    assert.equal(res.status, 204);
    assert.equal(
      res.headers.get("access-control-allow-origin"),
      "https://pass-share-frontend-git-main-autodevjapan.vercel.app",
    );
  });
});
