import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createApp } from "../src/app.js";
import { generateConnectId } from "../src/lib/connect.js";

const { Pool } = pg;

const TOKEN = "test-connect-token";
const OP_BIN = process.env.OP_CLI_BIN ?? "/app/target/release/op";
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://passshare:passshare@localhost:5432/passshare";

/** @param {string[]} args */
function runOp(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(OP_BIN, args, {
      env: {
        ...process.env,
        OP_CONNECT_HOST: baseUrl,
        OP_CONNECT_TOKEN: TOKEN,
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
        reject(
          new Error(
            `op ${args.join(" ")} failed (${code}): ${stderr || stdout}`,
          ),
        );
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/** @type {string} */
let baseUrl;

describe(
  "op-cli Connect API E2E",
  { skip: !process.env.DATABASE_URL || !process.env.OP_CLI_BIN },
  () => {
    /** @type {import('pg').Pool} */
    let pool;
    /** @type {import('http').Server} */
    let server;
    /** @type {string} */
    let vaultId;
    /** @type {string} */
    let vaultName;

    /** @type {string} */
    let e2eTitle;
    /** @type {string} */
    let readRefTitle;

    before(async () => {
      const suffix = generateConnectId().slice(0, 8);
      e2eTitle = `CLI E2E Login ${suffix}`;
      readRefTitle = `CLI Read Ref ${suffix}`;

      process.env.OP_CONNECT_TOKEN = TOKEN;
      pool = new Pool({ connectionString: DATABASE_URL });

      const { app } = await createApp({ pool });
      server = app.listen(0);
      await new Promise((resolve) => server.once("listening", resolve));
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;

      const vaultRes = await fetch(`${baseUrl}/v1/vaults`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const vaults = await vaultRes.json();
      vaultId = vaults[0].id;
      vaultName = vaults[0].name;
    });

    after(async () => {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await pool.end();
      delete process.env.OP_CONNECT_TOKEN;
    });

    it("lists vaults via op-cli", async () => {
      const output = await runOp(["vault", "list"]);
      assert.match(output, new RegExp(vaultId));
    });

    it("creates, lists, gets, edits, deletes item via op-cli", async () => {
      const itemId = await runOp([
        "item",
        "create",
        "--vault",
        vaultName,
        "--category",
        "LOGIN",
        "--title",
        e2eTitle,
        "username=cli@example.com",
        "password=cli-secret",
      ]);
      assert.ok(itemId.length >= 20);

      const listOutput = await runOp(["item", "list", "--vault", vaultName]);
      assert.match(listOutput, new RegExp(e2eTitle));

      const password = await runOp([
        "item",
        "get",
        "--vault",
        vaultName,
        itemId,
        "--fields",
        "password",
      ]);
      assert.equal(password, "cli-secret");

      await runOp([
        "item",
        "edit",
        "--vault",
        vaultName,
        itemId,
        "password=cli-secret-updated",
      ]);

      const updated = await runOp([
        "item",
        "get",
        "--vault",
        vaultName,
        itemId,
        "--fields",
        "password",
      ]);
      assert.equal(updated, "cli-secret-updated");

      await runOp(["item", "delete", "--vault", vaultName, itemId]);

      const afterDelete = await runOp(["item", "list", "--vault", vaultName]);
      assert.doesNotMatch(afterDelete, new RegExp(e2eTitle));
    });

    it("reads op:// reference via op-cli", async () => {
      const itemId = await runOp([
        "item",
        "create",
        "--vault",
        vaultName,
        "--category",
        "LOGIN",
        "--title",
        readRefTitle,
        "username=u",
        "password=ref-secret",
      ]);

      const value = await runOp(["read", `op://${vaultName}/${readRefTitle}/password`]);
      assert.equal(value, "ref-secret");

      await runOp(["item", "delete", "--vault", vaultName, itemId]);
    });
  },
);
