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
export function registerExportAudit(router,{pool}){
 router.get('/:id/export-events',async(req,res)=>{try{
  if(!pool)throw authHttpError(503,'PS019','Export audit unavailable');
  if(!uuid(req.params.id)||Object.keys(req.query).some(k=>k!=='after')||(req.query.after!==undefined&&!uuid(req.query.after)))throw authHttpError(400,'PS018','Invalid export audit selector');
  // The SQL binds every row to a currently live session and its own contract.
  const active=await pool.query('SELECT c.id FROM commercial_contracts c JOIN sessions s ON s.user_id=c.user_id WHERE c.id=$1 AND c.user_id=$2 AND s.id=$3 AND s.expires_at>clock_timestamp()',[req.params.id,req.auth.userId,req.auth.sessionId]);
  if(!active.rowCount)throw authHttpError(404,'PS022','Contract not found or session expired');
  const rows=(await pool.query(`SELECT e.id,e.actor_id,e.box_id,e.kind,e.key_epoch::text,e.snapshot_revision::text,e.item_id,e.attachment_id,e.issued_at
    FROM commercial_export_events e JOIN commercial_contracts c ON c.id=e.contract_id
    JOIN sessions s ON s.user_id=c.user_id AND s.id=$3 AND s.expires_at>clock_timestamp()
    WHERE c.id=$1 AND c.user_id=$2 AND ($4::uuid IS NULL OR e.id>$4::uuid) ORDER BY e.id LIMIT 100`,[req.params.id,req.auth.userId,req.auth.sessionId,req.query.after??null])).rows;
  res.set('Cache-Control','no-store');res.json({events:rows,nextCursor:rows.length===100?rows.at(-1).id:null,ordering:'receipt_id'});
 }catch(e){sendAuthError(res,e?.status?e:authHttpError(503,'PS019','Export audit unavailable'));}});
}
