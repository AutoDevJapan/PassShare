import { nativeMutation } from "../lib/native-mutations.js";
import { createPgStore } from "./pg-store.js";
import { generateConnectId } from "../lib/connect.js";
import { normalizeItemBody } from "../lib/categories.js";
import { connectHttpError } from "../middleware/connect-errors.js";
import { applySchemaWithAdvisoryLock } from "../db/migration-lock.js";
function nativeInput(input){const {importFiles,...rest}=input;return rest;}

// Persistence adapter only: scope, replay and payload decisions belong to Rust.
export async function createMutationStore({ store, authStore, pool }) {
  const records = new Map();
  const pendingRollback = new Map();
  let memoryTail = Promise.resolve();
  if (pool && process.env.PASSSHARE_MUTATIONS_BIN) {
    await applySchemaWithAdvisoryLock(pool, 4820123, await nativeMutation({ command: "schema" }));
  }

  async function execute(input, transactionStore, client, existing, memoryScope) {
    if (client && input.operation === "box" && existing?.result?.vaultId) {
      // Deletion locks the Box before changing this creation scope. A record
      // read before that wait is not current evidence after the lock returns.
      await client.query("SELECT id FROM connect_vaults WHERE id=$1 FOR UPDATE",[existing.result.vaultId]);
      const scope = await nativeMutation({ ...nativeInput(input), command: "scope" });
      existing = (await client.query("SELECT request_hash,result FROM mutation_operations WHERE actor=$1 AND resource=$2 AND operation=$3 AND request_key=$4",scope.parts)).rows[0];
    }
    const currentSession = async () => {
      if(input.connectTokenHash){
        const token=client
          ? (await client.query("SELECT id FROM connect_tokens WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp() AND vault_ids @> $3::jsonb FOR SHARE",[input.connectTokenHash,input.actor,JSON.stringify([input.resource])])).rowCount>0
          : Boolean(await authStore.findConnectTokenByHash(input.connectTokenHash));
        if(!token)throw connectHttpError(401,"PS011: Invalid or expired Connect token");
      }
      if (client && input.sessionId && !(await client.query("SELECT s.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND u.id=$2 AND s.expires_at>clock_timestamp() FOR SHARE OF u,s",[input.sessionId,input.actor])).rowCount) {
        throw connectHttpError(401,"PS024: Session is invalid or expired");
      }
    };
    async function requireCurrentMembership(boxId) {
      // Sharing, retirement and ciphertext activation lock the parent first.
      if (client) await client.query("SELECT id FROM connect_vaults WHERE id=$1 FOR UPDATE",[boxId]);
      const permitted = client
        ? (await client.query("SELECT vault_id FROM vault_memberships WHERE user_id=$1 AND vault_id=$2 AND passshare_membership_active(role,confirmed_at) FOR SHARE", [input.actor,boxId])).rowCount > 0
        : (await authStore.listVaultIdsForUser(input.actor)).includes(boxId);
      if (!permitted) throw connectHttpError(403, "PS016: Access denied to password box");
    }
    if (input.actor !== "legacy" && input.operation === "item") await requireCurrentMembership(input.resource);
    await currentSession();
    if (existing?.result?.deleted === true) {
      throw Object.assign(connectHttpError(409, "PS015: Creation result was deleted; use a new operation"),{reason:'creation_result_changed'});
    }
    if(input.importKey){
      if(client){
        await client.query("INSERT INTO mutation_operations(actor,resource,operation,request_key,request_hash,result) VALUES($1,$2,'import_binding',$3,$4,'{}'::jsonb) ON CONFLICT DO NOTHING",[input.actor,input.resource,input.importKey,input.archiveDigest]);
        const bound=(await client.query("SELECT request_hash AS archive_digest FROM mutation_operations WHERE actor=$1 AND resource=$2 AND operation='import_binding' AND request_key=$3 FOR SHARE",[input.actor,input.resource,input.importKey])).rows[0];
        if(bound?.archive_digest!==input.archiveDigest)throw connectHttpError(409,'PS015: Import operation archive changed');
      }else{
        const key=JSON.stringify(['archive',input.actor,input.resource,input.importKey]);
        if(records.has(key)&&records.get(key)!==input.archiveDigest)throw connectHttpError(409,'PS015: Import operation archive changed');
        records.set(key,input.archiveDigest);
      }
    }
    let live = null;
    if (existing) {
      try {
        if (input.operation === "box") await requireCurrentMembership(existing.result.vaultId);
        if (input.operation === "item") live = await transactionStore.getItem(input.resource, existing.result.id);
        else { const box = await transactionStore.getVault(existing.result.vaultId); live = { vaultId: box.id, name: box.name }; }
      } catch (error) { if (error?.status !== 404) throw error; }
    }
    const plan = await nativeMutation({ ...nativeInput(input), command: "create", existing: existing ?? null, live });
    if (plan.action === "replay") {
      for(const file of input.importFiles??[]){
        let content;try{content=await transactionStore.getFileContent(input.resource,plan.result.id,file.id);}catch(error){if(error?.status!==404)throw error;}
        if(!content||!Buffer.from(content).equals(file.content))throw Object.assign(connectHttpError(409,'PS015: Imported attachment changed'),{reason:'creation_result_changed'});
      }
      await currentSession(); return plan.result;
    }
    let result;
    if (input.operation === "item") {
      result = await transactionStore.createItem(input.resource, normalizeItemBody(input.request));
      if(!client)pendingRollback.set(memoryScope,{resource:input.resource,itemId:result.id,document:JSON.stringify(result)});
      try {
        for(const file of input.importFiles??[])await transactionStore.createFile(input.resource,result.id,{id:file.id,name:file.name,content:file.content});
      } catch (error) {
        if(!client) {
          try { await transactionStore.deleteItem(input.resource,result.id,JSON.stringify(result)); }
          catch(cleanupError) {
            throw new AggregateError([error,cleanupError],'Import storage failed and rollback is unconfirmed',{cause:error});
          }
        }
        throw error;
      }
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
    const scope = await nativeMutation({ ...nativeInput(input), command: "scope" });
    const record = await nativeMutation({ ...nativeInput(input), command: "record", result });
    if (client) await client.query("INSERT INTO mutation_operations(actor,resource,operation,request_key,request_hash,result) VALUES($1,$2,$3,$4,$5,$6::jsonb)", [...scope.parts,record.request_hash,JSON.stringify(record.result)]);
    else {records.set(scope.lock, record);pendingRollback.delete(memoryScope);}
    await currentSession();
    return result;
  }

  return async function mutateOnce(input) {
    const scope = await nativeMutation({ ...nativeInput(input), command: "scope" });
    if (!pool) {
      const pending = memoryTail.then(async () => {
        const rollback=pendingRollback.get(scope.lock);
        if(rollback){
          if(input.actor!=='legacy'&&!(await authStore.listVaultIdsForUser(input.actor)).includes(input.resource))throw connectHttpError(403,'PS016: Access denied to password box');
          if(input.connectTokenHash&&!await authStore.findConnectTokenByHash(input.connectTokenHash))throw connectHttpError(401,'PS011: Invalid or expired Connect token');
          try {
            const current=await store.getItem(rollback.resource,rollback.itemId);
            if(JSON.stringify(current)!==rollback.document)throw connectHttpError(409,'PS015: Pending import changed; recovery requires original item');
            await store.deleteItem(rollback.resource,rollback.itemId,rollback.document);
          }
          catch(error){if(error?.status!==404)throw error;}
          pendingRollback.delete(scope.lock);
        }
        return execute(input,store,null,records.get(scope.lock),scope.lock);
      });
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
