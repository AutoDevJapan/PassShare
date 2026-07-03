import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createApp } from "../src/app.js";
import { generateConnectId } from "../src/lib/connect.js";
import { signupUser } from "./helpers/auth-flow.js";
import {
  connectItemFromApi,
  connectItemToCreateBody,
  runCloudSync,
} from "./helpers/desktop-cloud-sync-flow.js";

const { Pool } = pg;

const PASSWORD = "CrossClientTest1!";
const OP_BIN = process.env.OP_CLI_BIN ?? "/app/target/release/op";
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://passshare:passshare@localhost:5432/passshare";

/**
 * Run the op-cli binary against the running backend as the signed-up user.
 * @param {string[]} args
 * @param {{ baseUrl: string, token: string }} ctx
 */
function runOp(args, ctx) {
  return new Promise((resolve, reject) => {
    const child = spawn(OP_BIN, args, {
      env: {
        ...process.env,
        OP_CONNECT_HOST: ctx.baseUrl,
        OP_CONNECT_TOKEN: ctx.token,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`op ${args.join(" ")} failed (${code}): ${stderr || stdout}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/** @param {{ id: string, title: string, username: string, password: string }} overrides */
function loginItem(overrides) {
  return {
    id: overrides.id,
    title: overrides.title,
    category: "LOGIN",
    tags: ["cross-client"],
    favorite: false,
    url: "https://example.com",
    username: overrides.username,
    password: overrides.password,
    notes: "",
  };
}

// Issue #214: single cross-client smoke chaining Web API -> op-cli -> Desktop sync
// on one vault/item. Requires the op-cli binary + PostgreSQL (Docker backend-e2e).
describe(
  "Cross-client smoke (Web -> CLI -> Desktop)",
  { skip: !process.env.DATABASE_URL || !process.env.OP_CLI_BIN },
  () => {
    /** @type {import('pg').Pool} */
    let pool;
    /** @type {import('http').Server} */
    let server;
    /** @type {string} */
    let baseUrl;
    /** @type {{ email: string, password: string, sessionCookie: string, vaultId: string, vaultName: string, accessToken: string }} */
    let user;

    before(async () => {
      // op-cli must authenticate as the signed-up user, not the shared fixed token.
      delete process.env.OP_CONNECT_TOKEN;
      process.env.APP_ENV = "local";
      pool = new Pool({ connectionString: DATABASE_URL });

      const { app } = await createApp({ pool });
      server = app.listen(0);
      await new Promise((resolve) => server.once("listening", resolve));
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;

      user = await signupUser(baseUrl, `cross-client-${generateConnectId()}@example.com`, PASSWORD);
    });

    after(async () => {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await pool.end();
      delete process.env.APP_ENV;
    });

    it("Web-added item is read by op-cli and pulled by Desktop sync; Desktop push is read by op-cli", async () => {
      const opCtx = { baseUrl, token: user.accessToken };
      const suffix = generateConnectId().slice(0, 8);

      // 1. Web API: user (signed up in `before`) adds an item to their vault.
      const webId = generateConnectId();
      const webTitle = `Web Item ${suffix}`;
      const webPassword = "web-added-secret";
      const createRes = await fetch(`${baseUrl}/v1/vaults/${user.vaultId}/items`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          connectItemToCreateBody(
            loginItem({ id: webId, title: webTitle, username: "web@example.com", password: webPassword }),
            { id: webId },
          ),
        ),
      });
      assert.equal(createRes.status, 201);

      // 2. op-cli: `op read op://<vault>/<item>/password` returns the same password.
      const cliValue = await runOp(["read", `op://${user.vaultName}/${webTitle}/password`], opCtx);
      assert.equal(cliValue, webPassword, "op-cli should read the Web-added password");

      // 3. Desktop sync: pull reflects the Web-added item into the local set.
      /** @type {import('./helpers/desktop-cloud-sync-flow.js').ConnectItem[]} */
      const pulled = [];
      const config = {
        apiBaseUrl: baseUrl,
        email: user.email,
        password: user.password,
        vaultId: user.vaultId,
      };
      const pullResult = await runCloudSync(config, user.sessionCookie, [], async (item) => {
        pulled.push(item);
      });
      assert.equal(pullResult.pushed, 0);
      assert.equal(pullResult.pulled, 1);
      assert.equal(pullResult.conflicts.length, 0);
      assert.equal(pulled.length, 1);
      assert.equal(pulled[0].id, webId);
      assert.equal(pulled[0].title, webTitle);
      assert.equal(pulled[0].password, webPassword, "Desktop pull should carry the password");

      // 4. Desktop sync: push a local-only item to remote.
      const deskId = generateConnectId();
      const deskTitle = `Desktop Item ${suffix}`;
      const deskPassword = "desktop-push-secret";
      const localItems = [
        ...pulled, // already-synced item stays put (no re-push)
        loginItem({ id: deskId, title: deskTitle, username: "desktop@example.com", password: deskPassword }),
      ];
      const pushResult = await runCloudSync(config, user.sessionCookie, localItems, async () => {});
      assert.equal(pushResult.pushed, 1, "only the new local item is pushed");
      assert.equal(pushResult.pulled, 0);
      assert.equal(pushResult.conflicts.length, 0);

      // 5. op-cli: the Desktop-pushed item is now readable via the CLI (loop closed).
      const deskViaCli = await runOp(["read", `op://${user.vaultName}/${deskTitle}/password`], opCtx);
      assert.equal(deskViaCli, deskPassword, "op-cli should read the Desktop-pushed password");

      // 6. Web API: confirm both items exist in the vault.
      const listRes = await fetch(`${baseUrl}/v1/vaults/${user.vaultId}/items/${deskId}`, {
        headers: { Authorization: `Bearer ${user.accessToken}` },
      });
      assert.equal(listRes.status, 200);
      const remoteDesk = connectItemFromApi(await listRes.json());
      assert.equal(remoteDesk.title, deskTitle);
    });
  },
);
