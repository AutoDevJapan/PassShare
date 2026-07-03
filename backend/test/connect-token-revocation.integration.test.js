import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createApp } from "../src/app.js";
import { generateConnectId } from "../src/lib/connect.js";
import { authRequest, signupUser } from "./helpers/auth-flow.js";

const { Pool } = pg;

const PASSWORD = "RevokeTest1!";
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://passshare:passshare@localhost:5432/passshare";

/** @param {string} baseUrl @param {string} token */
async function vaultsStatus(baseUrl, token) {
  const res = await fetch(`${baseUrl}/v1/vaults`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.status;
}

/** @param {string} baseUrl @param {string} sessionCookie */
async function freshConnectToken(baseUrl, sessionCookie) {
  const res = await fetch(`${baseUrl}/api/auth/connect-token`, {
    headers: { Cookie: sessionCookie },
  });
  assert.equal(res.status, 200);
  return (await res.json()).accessToken;
}

// Issue #317: connect tokens must be revoked on logout and on vault-member removal
// so API access does not outlive the session / membership for the token TTL.
describe(
  "Connect token revocation (pg)",
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

    it("logout revokes the user's connect token", async () => {
      const user = await signupUser(baseUrl, `revoke-${generateConnectId()}@example.com`, PASSWORD);
      assert.equal(await vaultsStatus(baseUrl, user.accessToken), 200);

      const logoutRes = await authRequest(baseUrl, user.sessionCookie, "POST", "/api/auth/logout");
      assert.equal(logoutRes.status, 204);

      assert.equal(
        await vaultsStatus(baseUrl, user.accessToken),
        401,
        "connect token must be rejected after logout",
      );
    });

    it("removing a vault member revokes their connect token", async () => {
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

      const acceptRes = await authRequest(
        baseUrl,
        member.sessionCookie,
        "POST",
        `/api/auth/invitations/${invite.id}/accept`,
      );
      assert.equal(acceptRes.status, 200);

      // Fresh token now includes the shared vault and works.
      const memberToken = await freshConnectToken(baseUrl, member.sessionCookie);
      assert.equal(await vaultsStatus(baseUrl, memberToken), 200);

      // Owner looks up the member's id and removes them.
      const membersRes = await fetch(`${baseUrl}/api/auth/vaults/${owner.vaultId}/members`, {
        headers: { Cookie: owner.sessionCookie },
      });
      assert.equal(membersRes.status, 200);
      const members = await membersRes.json();
      const memberRow = (members.members ?? members).find((m) => m.email === memberEmail);
      assert.ok(memberRow, "member should be listed");

      const removeRes = await authRequest(
        baseUrl,
        owner.sessionCookie,
        "DELETE",
        `/api/auth/vaults/${owner.vaultId}/members/${memberRow.userId ?? memberRow.user_id}`,
      );
      assert.equal(removeRes.status, 204);

      assert.equal(
        await vaultsStatus(baseUrl, memberToken),
        401,
        "removed member's connect token must be revoked",
      );
    });
  },
);
