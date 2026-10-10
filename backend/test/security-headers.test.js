import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { createMemoryAuthStore } from "../src/auth/index.js";
import { createMemoryStore } from "../src/store/memory-store.js";
import { createApp } from "../src/app.js";
import { defaultWebOrigin, isAllowedWebOrigin } from "../src/middleware/web-origin.js";

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

  it("allows truncated Vercel preview hosts bound to the team slug (#358)", () => {
    // Vercel truncates the project prefix (`pass-share-frontend` -> `pass-share-fron`)
    // and injects a hash when the branch label exceeds 63 chars.
    const teamSlug = "masashi-matsumotos-projects-c5830f3d";
    const truncated =
      "https://pass-share-fron-git-ac642b-masashi-matsumotos-projects-c5830f3d.vercel.app";
    assert.equal(isAllowedWebOrigin(truncated, "preview", undefined, teamSlug), true);
    // Non-truncated previews under the same team are also admitted.
    assert.equal(
      isAllowedWebOrigin(
        "https://pass-share-frontend-git-feat-x-masashi-matsumotos-projects-c5830f3d.vercel.app",
        "preview",
        undefined,
        teamSlug,
      ),
      true,
    );
    // Without the team slug the truncated host stays denied (fail-safe, pre-#358 behavior).
    assert.equal(isAllowedWebOrigin(truncated, "preview"), false);
  });

  it("keeps the #315 boundary even when a team slug is configured (#358)", () => {
    const teamSlug = "masashi-matsumotos-projects-c5830f3d";
    // Attacker host that does not end with our scope slug: denied.
    assert.equal(isAllowedWebOrigin("https://evil.vercel.app", "preview", undefined, teamSlug), false);
    // Attacker host that lacks the project prefix but appends the slug text: denied.
    assert.equal(
      isAllowedWebOrigin(
        "https://evil-git-x-masashi-matsumotos-projects-c5830f3d.vercel.app",
        "preview",
        undefined,
        teamSlug,
      ),
      false,
    );
    // Slug as a bare subdomain or spoofed apex: denied.
    assert.equal(
      isAllowedWebOrigin(
        "https://pass-share-fron-git-ac642b-masashi-matsumotos-projects-c5830f3d.vercel.app.evil.com",
        "preview",
        undefined,
        teamSlug,
      ),
      false,
    );
    // A malformed/empty slug must be ignored (fail-safe), not turned into a wildcard.
    assert.equal(
      isAllowedWebOrigin("https://pass-share-fron-git-x-anything.vercel.app", "preview", undefined, "  "),
      false,
    );
    assert.equal(
      isAllowedWebOrigin("https://evil.vercel.app", "preview", undefined, ".*"),
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

describe("defaultWebOrigin fallback (#374)", () => {
  /** @type {string | undefined} */
  let previousWebOrigin;

  before(() => {
    previousWebOrigin = process.env.WEB_ORIGIN;
    delete process.env.WEB_ORIGIN;
  });

  after(() => {
    if (previousWebOrigin === undefined) {
      delete process.env.WEB_ORIGIN;
    } else {
      process.env.WEB_ORIGIN = previousWebOrigin;
    }
  });

  it("falls back to the live custom domain (not the 404 vercel alias) for prod when WEB_ORIGIN unset", () => {
    // The canonical vercel alias returns 404; the fallback must point at the live host.
    assert.equal(defaultWebOrigin("prd"), "https://pass-share.bm1314.net");
    assert.notEqual(defaultWebOrigin("prd"), "https://pass-share-frontend.vercel.app");
  });

  it("uses the local origin for local env", () => {
    assert.equal(defaultWebOrigin("local"), "http://localhost:5173");
  });

  it("prefers a configured WEB_ORIGIN when set", () => {
    process.env.WEB_ORIGIN = "https://pass-share.bm1314.net";
    assert.equal(defaultWebOrigin("prd"), "https://pass-share.bm1314.net");
    delete process.env.WEB_ORIGIN;
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

  it("admits fixed native asset origins for token preflight without cookies", async () => {
    for (const origin of ["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"]) {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type, x-passshare-client" },
      });
      assert.equal(res.status, 204);
      assert.equal(res.headers.get("access-control-allow-origin"), origin);
      assert.equal(res.headers.get("access-control-allow-credentials"), null);
      assert.match(res.headers.get("access-control-allow-headers") ?? "", /x-passshare-client/i);
      assert.equal(isAllowedWebOrigin(origin, "prd"), false);
    }
  });

  it("keeps native token headers distinct from Web origin and cookie permission", async () => {
    for (const headers of [{ "x-passshare-client": "mobile" }, { Authorization: "Bearer invalid-token" }]) {
      const res = await fetch(`${baseUrl}/health`, { headers: { Origin: "http://tauri.localhost", ...headers } });
      assert.equal(res.headers.get("access-control-allow-origin"), "http://tauri.localhost");
      assert.equal(res.headers.get("access-control-allow-credentials"), null);
    }
    for (const origin of ["null", "http://tauri.localhost.evil.example", "http://tauri.localhost:8080", "https://evil.example"]) {
      const res = await fetch(`${baseUrl}/api/auth/login`, { method: "OPTIONS", headers: {
        Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,x-passshare-client",
      } });
      assert.equal(res.headers.get("access-control-allow-origin"), null);
      assert.equal(res.headers.get("access-control-allow-credentials"), null);
    }
    const noToken = await fetch(`${baseUrl}/health`, { headers: { Origin: "http://tauri.localhost" } });
    assert.equal(noToken.headers.get("access-control-allow-origin"), null);
  });
});

describe("preview CORS with VERCEL_TEAM_SLUG (#358)", () => {
  /** @type {import('http').Server} */
  let server;
  /** @type {string} */
  let baseUrl;
  /** @type {string | undefined} */
  let previousWebOrigin;
  /** @type {string | undefined} */
  let previousTeamSlug;
  const truncatedPreviewOrigin =
    "https://pass-share-fron-git-ac642b-masashi-matsumotos-projects-c5830f3d.vercel.app";

  before(async () => {
    previousWebOrigin = process.env.WEB_ORIGIN;
    previousTeamSlug = process.env.VERCEL_TEAM_SLUG;
    delete process.env.WEB_ORIGIN;
    process.env.APP_ENV = "preview";
    process.env.VERCEL_TEAM_SLUG = "masashi-matsumotos-projects-c5830f3d";

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
    if (previousTeamSlug === undefined) {
      delete process.env.VERCEL_TEAM_SLUG;
    } else {
      process.env.VERCEL_TEAM_SLUG = previousTeamSlug;
    }
    delete process.env.APP_ENV;
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve(undefined)));
    });
  });

  it("reflects the truncated preview origin with credentials", async () => {
    const res = await fetch(`${baseUrl}/api/auth/csrf`, {
      method: "OPTIONS",
      headers: {
        Origin: truncatedPreviewOrigin,
        "Access-Control-Request-Method": "POST",
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), truncatedPreviewOrigin);
    assert.equal(res.headers.get("access-control-allow-credentials"), "true");
  });

  it("still denies untrusted vercel.app origins (#315 regression)", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "https://evil.vercel.app" },
    });
    assert.equal(res.headers.get("access-control-allow-origin"), null);
    assert.equal(res.headers.get("access-control-allow-credentials"), null);
  });
});
