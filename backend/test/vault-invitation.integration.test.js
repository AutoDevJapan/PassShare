import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createApp } from "../src/app.js";
import { generateConnectId } from "../src/lib/connect.js";
import { authRequest, signupUser } from "./helpers/auth-flow.js";

const { Pool } = pg;

const PASSWORD = "VaultInviteTest1!";
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://passshare:passshare@localhost:5432/passshare";

/** @param {string} baseUrl @param {string} sessionCookie @param {string} accessToken helper unused */
async function vaultIdsFor(baseUrl, sessionCookie) {
  const tokenRes = await fetch(`${baseUrl}/api/auth/connect-token`, {
    headers: { Cookie: sessionCookie },
  });
  assert.equal(tokenRes.status, 200);
  const { accessToken } = await tokenRes.json();
  const vaultsRes = await fetch(`${baseUrl}/v1/vaults`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assert.equal(vaultsRes.status, 200);
  return (await vaultsRes.json()).map((v) => v.id);
}

// Issue #314: acceptVaultInvitation must run its INSERT + UPDATE inside one
// pinned-connection transaction against real Postgres. Exercises the pg-auth-store
// path (memory-store covers the API contract separately in vault-share.test.js).
describe(
  "Vault invitation accept (pg transaction)",
  { skip: !process.env.DATABASE_URL },
  () => {
    /** @type {import('pg').Pool} */
    let pool;
    /** @type {import('http').Server} */
    let server;
    /** @type {string} */
    let baseUrl;

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
    });

    after(async () => {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await pool.end();
      delete process.env.APP_ENV;
    });

    it("commits membership + marks invitation accepted atomically", async () => {
      const ownerEmail = `owner-${generateConnectId()}@example.com`;
      const memberEmail = `member-${generateConnectId()}@example.com`;
      const owner = await signupUser(baseUrl, ownerEmail, PASSWORD);
      const member = await signupUser(baseUrl, memberEmail, PASSWORD);

      const inviteRes = await authRequest(
        baseUrl,
        owner.sessionCookie,
        "POST",
        `/api/auth/vaults/${owner.vaultId}/invitations`,
        { email: memberEmail, role: "member" },
      );
      assert.equal(inviteRes.status, 201);
      const invite = await inviteRes.json();
      assert.ok(invite.id);

      const acceptRes = await authRequest(
        baseUrl,
        member.sessionCookie,
        "POST",
        `/api/auth/invitations/${invite.id}/accept`,
      );
      assert.equal(acceptRes.status, 200);

      // Membership INSERT committed: the shared vault now appears for the member.
      const memberVaults = await vaultIdsFor(baseUrl, member.sessionCookie);
      assert.ok(
        memberVaults.includes(owner.vaultId),
        "member should have access to the shared vault after accepting",
      );

      // Invitation UPDATE committed: no pending invitations remain.
      const pendingRes = await fetch(`${baseUrl}/api/auth/invitations`, {
        headers: { Cookie: member.sessionCookie },
      });
      assert.equal(pendingRes.status, 200);
      const pending = await pendingRes.json();
      assert.equal(pending.invitations.length, 0, "invitation should be marked accepted");

      // Accepting again is a no-op / not-found (already accepted), not a 500.
      const secondAccept = await authRequest(
        baseUrl,
        member.sessionCookie,
        "POST",
        `/api/auth/invitations/${invite.id}/accept`,
      );
      assert.notEqual(secondAccept.status, 500, "re-accept must not 500");
    });
  },
);
