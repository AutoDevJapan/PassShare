import { nativeMutation } from "../lib/native-mutations.js";
import { createPgStore } from "./pg-store.js";
import { generateConnectId } from "../lib/connect.js";
import { normalizeItemBody } from "../lib/categories.js";
import { connectHttpError } from "../middleware/connect-errors.js";
import { applySchemaWithAdvisoryLock } from "../db/migration-lock.js";

// Persistence adapter only: scope, replay and payload decisions belong to Rust.
export async function createMutationStore({ store, authStore, pool }) {
  const records = new Map();
  let memoryTail = Promise.resolve();
  if (pool && process.env.PASSSHARE_MUTATIONS_BIN) {
    await applySchemaWithAdvisoryLock(pool, 4820123, await nativeMutation({ command: "schema" }));
  }

  async function execute(input, transactionStore, client, existing) {
    async function requireCurrentMembership(boxId) {
      // Sharing, retirement and ciphertext activation lock the parent first.
      if (client) await client.query("SELECT id FROM connect_vaults WHERE id=$1 FOR UPDATE",[boxId]);
      const permitted = client
        ? (await client.query("SELECT vault_id FROM vault_memberships WHERE user_id=$1 AND vault_id=$2 AND passshare_membership_active(role,confirmed_at) FOR SHARE", [input.actor,boxId])).rowCount > 0
        : (await authStore.listVaultIdsForUser(input.actor)).includes(boxId);
      if (!permitted) throw connectHttpError(403, "PS016: Access denied to password box");
    }
    if (input.actor !== "legacy" && input.operation === "item") await requireCurrentMembership(input.resource);
    let live = null;
    if (existing) {
      try {
        if (input.operation === "box") await requireCurrentMembership(existing.result.vaultId);
        if (input.operation === "item") live = await transactionStore.getItem(input.resource, existing.result.id);
        else { const box = await transactionStore.getVault(existing.result.vaultId); live = { vaultId: box.id, name: box.name }; }
      } catch (error) { if (error?.status !== 404) throw error; }
    }
    const plan = await nativeMutation({ ...input, command: "create", existing: existing ?? null, live });
    if (plan.action === "replay") return plan.result;
    let result;
    if (input.operation === "item") {
      result = await transactionStore.createItem(input.resource, normalizeItemBody(input.request));
    } else {
      const vaultId = generateConnectId();
      if (client) {
        const user=await client.query("SELECT id FROM users WHERE id=$1 FOR SHARE",[input.actor]);
        if (!user.rowCount) throw connectHttpError(401,"PS024: Session is invalid or expired");
        await transactionStore.createVault({id:vaultId,name:input.request.name});
        await client.query("INSERT INTO vault_memberships(user_id,vault_id,role) VALUES($1,$2,'owner')",[input.actor,vaultId]);
      } else { await authStore.createOwnedBox(input.actor,store,vaultId,input.request.name); }
      result = { vaultId, name: input.request.name };
    }
    const scope = await nativeMutation({ ...input, command: "scope" });
    const record = await nativeMutation({ ...input, command: "record", result });
    if (client) await client.query("INSERT INTO mutation_operations(actor,resource,operation,request_key,request_hash,result) VALUES($1,$2,$3,$4,$5,$6::jsonb)", [...scope.parts,record.request_hash,JSON.stringify(record.result)]);
    else records.set(scope.lock, record);
    return result;
  }

  return async function mutateOnce(input) {
    const scope = await nativeMutation({ ...input, command: "scope" });
    if (!pool) {
      const pending = memoryTail.then(() => execute(input,store,null,records.get(scope.lock)));
      memoryTail = pending.catch(() => {});
      return pending;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [scope.lock]);
      const existing = await client.query("SELECT request_hash,result FROM mutation_operations WHERE actor=$1 AND resource=$2 AND operation=$3 AND request_key=$4", scope.parts);
      const result = await execute(input,createPgStore(client),client,existing.rows[0]);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  };
}
