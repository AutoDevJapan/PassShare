import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createApp } from "../src/app.js";

const { Pool } = pg;

const TOKEN = "test-connect-token";
const OP_BIN = process.env.OP_CLI_BIN ?? "/app/target/release/op";
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://passshare:passshare@localhost:5432/passshare";

/** @param {string[]} args */
function runOp(args) {
  const result = spawnSync(OP_BIN, args, {
    env: {
      ...process.env,
      OP_CONNECT_HOST: baseUrl,
      OP_CONNECT_TOKEN: TOKEN,
    },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `op ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return (result.stdout ?? "").trim();
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

    before(async () => {
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

    it("lists vaults via op-cli", () => {
      const output = runOp(["vault", "list"]);
      assert.match(output, new RegExp(vaultId));
    });

    it("creates, lists, gets, edits, deletes item via op-cli", () => {
      const itemId = runOp([
        "item",
        "create",
        "--vault",
        vaultName,
        "--category",
        "LOGIN",
        "--title",
        "CLI E2E Login",
        "username=cli@example.com",
        "password=cli-secret",
      ]);
      assert.ok(itemId.length >= 20);

      const listOutput = runOp(["item", "list", "--vault", vaultName]);
      assert.match(listOutput, /CLI E2E Login/);

      const password = runOp([
        "item",
        "get",
        "--vault",
        vaultName,
        "--item",
        itemId,
        "--fields",
        "password",
      ]);
      assert.equal(password, "cli-secret");

      runOp([
        "item",
        "edit",
        "--vault",
        vaultName,
        "--item",
        itemId,
        "password=cli-secret-updated",
      ]);

      const updated = runOp([
        "item",
        "get",
        "--vault",
        vaultName,
        "--item",
        itemId,
        "--fields",
        "password",
      ]);
      assert.equal(updated, "cli-secret-updated");

      runOp(["item", "delete", "--vault", vaultName, "--item", itemId]);

      const afterDelete = runOp(["item", "list", "--vault", vaultName]);
      assert.doesNotMatch(afterDelete, /CLI E2E Login/);
    });

    it("reads op:// reference via op-cli", () => {
      const itemId = runOp([
        "item",
        "create",
        "--vault",
        vaultName,
        "--category",
        "LOGIN",
        "--title",
        "CLI Read Ref",
        "username=u",
        "password=ref-secret",
      ]);

      const value = runOp(["read", `op://${vaultName}/CLI Read Ref/password`]);
      assert.equal(value, "ref-secret");

      runOp(["item", "delete", "--vault", vaultName, "--item", itemId]);
    });
  },
);
