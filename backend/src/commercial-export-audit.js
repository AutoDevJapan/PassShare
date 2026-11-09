import {randomUUID} from 'node:crypto';
import {applySchemaWithAdvisoryLock} from './db/migration-lock.js';
import {authHttpError,sendAuthError} from './auth/errors.js';
export const EXPORT_AUDIT_SCHEMA=`CREATE TABLE IF NOT EXISTS commercial_export_events (
 id UUID PRIMARY KEY,contract_id UUID NOT NULL REFERENCES commercial_contracts(id) ON DELETE CASCADE,
 actor_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,box_id VARCHAR(26) NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('state','items','attachment-index','attachment')),
 key_epoch BIGINT NOT NULL CHECK(key_epoch>0),snapshot_revision BIGINT NOT NULL CHECK(snapshot_revision>0),
 item_id VARCHAR(26),attachment_id VARCHAR(26),issued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp());`;
export const migrateExportAudit=p=>applySchemaWithAdvisoryLock(p,4820132,EXPORT_AUDIT_SCHEMA);
export async function recordExport(c,{contractId,actorId,boxId,kind,epoch,revision,itemId,attachmentId}){
 const id=randomUUID();
 await c.query('INSERT INTO commercial_export_events(id,contract_id,actor_id,box_id,kind,key_epoch,snapshot_revision,item_id,attachment_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,contractId,actorId,boxId,kind,epoch,revision,itemId??null,attachmentId??null]);
 return id;
}
const uuid=s=>typeof s==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(s);
export function registerExportAudit(router,persist){
 router.get('/:id/export-events',async(req,res)=>{try{
  if(!uuid(req.params.id)||Object.keys(req.query).some(k=>k!=='after')||(req.query.after!==undefined&&!uuid(req.query.after)))throw authHttpError(400,'PS018','Invalid export audit selector');
  // Reuse the contract transaction: user/session SHARE -> contract SHARE.
  // Revocation/deletion serializes with the read, and persist rechecks the
  // session by database clock after all query waits, before releasing data.
  const rows=await persist(req,async c=>{
   const own=await c.query('SELECT id FROM commercial_contracts WHERE id=$1 AND user_id=$2 FOR SHARE',[req.params.id,req.auth.userId]);
   if(!own.rowCount)throw authHttpError(404,'PS022','Contract not found');
   return (await c.query(`SELECT e.id,e.actor_id,e.box_id,e.kind,e.key_epoch::text,e.snapshot_revision::text,e.item_id,e.attachment_id,e.issued_at
    FROM commercial_export_events e WHERE e.contract_id=$1 AND ($2::uuid IS NULL OR e.id>$2::uuid) ORDER BY e.id LIMIT 100`,[req.params.id,req.query.after??null])).rows;
  });
  res.set('Cache-Control','no-store');res.json({events:rows,nextCursor:rows.length===100?rows.at(-1).id:null,ordering:'receipt_id'});
 }catch(e){sendAuthError(res,e?.status?e:authHttpError(503,'PS019','Export audit unavailable'));}});
}
