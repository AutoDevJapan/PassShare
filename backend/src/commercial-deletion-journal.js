import {createHash,timingSafeEqual} from 'node:crypto';
import {applySchemaWithAdvisoryLock} from './db/migration-lock.js';

// Keep only the deletion barrier needed by older archives. No user/contract FK,
// payload, password, content digest or key is retained. Retirement cannot erase
// this record while a restorable archive could still contain the deleted Box.
export const DELETION_JOURNAL_SCHEMA=`CREATE TABLE IF NOT EXISTS commercial_deletion_journal (
 deletion_id UUID PRIMARY KEY,box_id VARCHAR(26) NOT NULL UNIQUE CHECK(box_id ~ '^[a-z0-9]{26}$'),
 completed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp());`;
export const migrateDeletionJournal=pool=>applySchemaWithAdvisoryLock(pool,4820139,DELETION_JOURNAL_SCHEMA);
export async function recordCompletedDeletion(client,request){
 await client.query('INSERT INTO commercial_deletion_journal(deletion_id,box_id) VALUES($1,$2)',[request.id,request.box_id]);
}
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const box=v=>typeof v==='string'&&/^[a-z0-9]{26}$/.test(v);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const timestampSql="to_char(completed_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')";
async function verifyCurrentSource(client,{expectedSourceDatabase,expectedSourceSystemIdentifier,expectedSourceDatabaseOid}){
 if(!/^[a-z][a-z0-9_]{0,62}$/.test(expectedSourceDatabase??'')||!/^\d{1,20}$/.test(expectedSourceSystemIdentifier??'')||!/^\d{1,10}$/.test(expectedSourceDatabaseOid??''))throw Error('Trusted source cluster/database identity required');
 const r=(await client.query('SELECT current_database() name,(pg_control_system()).system_identifier::text system_id,(SELECT oid::text FROM pg_database WHERE datname=current_database()) database_oid')).rows[0];
 if(r.name!==expectedSourceDatabase||r.system_id!==expectedSourceSystemIdentifier||r.database_oid!==expectedSourceDatabaseOid)throw Error('Current source cluster/database identity does not match trusted binding');
}

export async function exportDeletionJournal(client,sourceId){
 if(!uuid(sourceId))throw Error('Explicit current journal source identity required');
 const rows=(await client.query('SELECT deletion_id,box_id,'+timestampSql+' completed_at FROM commercial_deletion_journal ORDER BY box_id LIMIT 100001')).rows;
 if(rows.length>100000)throw Error('Deletion journal exceeds bounded recovery batch');
 return Buffer.from(JSON.stringify({format:'passshare-deletion-journal-v1',sourceId,entries:rows.map(r=>({deletionId:r.deletion_id,boxId:r.box_id,completedAt:r.completed_at}))}));
}

// The expected digest/source originate in the current, independently retained
// operational record, never in the old archive or a checksum beside that archive.
export function parseDeletionJournal(bytes,{expectedSha256,expectedSourceId}){
 if(!Buffer.isBuffer(bytes)||bytes.length>16*1024*1024||!/^[a-f0-9]{64}$/.test(expectedSha256??'')||!uuid(expectedSourceId))throw Error('Trusted current deletion journal binding required');
 if(!timingSafeEqual(Buffer.from(hash(bytes),'hex'),Buffer.from(expectedSha256,'hex')))throw Error('Deletion journal content does not match the trusted current digest');
 let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{throw Error('Invalid deletion journal');}
 if(!exact(value,['format','sourceId','entries'])||value.format!=='passshare-deletion-journal-v1'||value.sourceId!==expectedSourceId||!Array.isArray(value.entries)||value.entries.length>100000)throw Error('Invalid deletion journal identity');
 const boxes=new Set(),ids=new Set();
 for(const e of value.entries){const date=typeof e.completedAt==='string'?e.completedAt.replace(/(\.\d{3})\d{3}Z$/,'$1Z'):'';if(!exact(e,['deletionId','boxId','completedAt'])||!uuid(e.deletionId)||!box(e.boxId)||typeof e.completedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(e.completedAt)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString()!==date||boxes.has(e.boxId)||ids.has(e.deletionId))throw Error('Invalid or repeated deletion barrier');boxes.add(e.boxId);ids.add(e.deletionId);}
 return value;
}

// Only the trusted, stopped restore process holds this role and purpose marker.
// Presence of a marker is necessary but not itself proof of an external network
// stop; the caller must stop all API/worker connections before invoking this.
export async function reconcileCompletedDeletions(client,{bytes,expectedSha256,expectedSourceId,expectedTargetDatabase,restoreOperationId,currentSource,expectedSourceDatabase,expectedSourceSystemIdentifier,expectedSourceDatabaseOid}){
 const journal=parseDeletionJournal(bytes,{expectedSha256,expectedSourceId});
 const expected=new Map(journal.entries.map(e=>[e.boxId,e]));
 if(typeof expectedTargetDatabase!=='string'||!/^([a-z][a-z0-9_]{0,62})$/.test(expectedTargetDatabase)||!uuid(restoreOperationId)||!currentSource||!/^[a-z][a-z0-9_]{0,62}$/.test(expectedSourceDatabase??'')||expectedSourceDatabase===expectedTargetDatabase)throw Error('Explicit current source and isolated restore identities required');
 await currentSource.query('BEGIN');let targetStarted=false;
 try{
  await verifyCurrentSource(currentSource,{expectedSourceDatabase,expectedSourceSystemIdentifier,expectedSourceDatabaseOid});
  // Prevent any new deletion barrier from committing until the target and its
  // partial gate have been reconciled. A captured-but-no-longer-current journal
  // cannot qualify an older archive, even if its historical digest is genuine.
  await currentSource.query('LOCK TABLE commercial_deletion_journal IN SHARE MODE');
  const currentBytes=await exportDeletionJournal(currentSource,expectedSourceId);
  if(hash(currentBytes)!==expectedSha256)throw Error('Deletion journal is no longer current at the authoritative source');
  await client.query('BEGIN');targetStarted=true;
  if((await client.query('SELECT current_database() name')).rows[0].name!==expectedTargetDatabase)throw Error('Wrong restore database');
  // Lock readers/writers of the affected data until the complete journal and
  // its gate checkpoint are committed. A wrong/missing closed marker fails.
  const control=(await client.query('SELECT operation_id,source_id,phase FROM passshare_restore_control.recovery WHERE singleton=true FOR UPDATE')).rows;
  if(control.length!==1||control[0].operation_id!==restoreOperationId||control[0].source_id!==expectedSourceId||control[0].phase!=='closed')throw Error('Restore target is not independently closed');
  const active=(await client.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'")).rows[0].n;
  if(active!==0)throw Error('Other restore target client connections must be stopped');
  await client.query(DELETION_JOURNAL_SCHEMA);
  await client.query('LOCK TABLE connect_vaults,mutation_operations,commercial_deletion_journal IN ACCESS EXCLUSIVE MODE');
  const current=(await client.query('SELECT deletion_id,box_id FROM commercial_deletion_journal')).rows;
  if(current.some(r=>expected.get(r.box_id)?.deletionId!==r.deletion_id))throw Error('Journal omits a newer target deletion barrier');
  for(const e of journal.entries){
   const known=(await client.query('SELECT deletion_id,box_id,'+timestampSql+' completed_at FROM commercial_deletion_journal WHERE deletion_id=$1 OR box_id=$2',[e.deletionId,e.boxId])).rows;
   if(known.some(r=>r.deletion_id!==e.deletionId||r.box_id!==e.boxId||r.completed_at!==e.completedAt))throw Error('Conflicting deletion journal identity');
   await client.query('DELETE FROM mutation_operations WHERE resource=$1',[e.boxId]);
   await client.query("UPDATE mutation_operations SET request_hash='',result='{\"deleted\":true}'::jsonb WHERE operation='box' AND result->>'vaultId'=$1",[e.boxId]);
   await client.query('DELETE FROM connect_vaults WHERE id=$1',[e.boxId]);
   await client.query('INSERT INTO commercial_deletion_journal(deletion_id,box_id,completed_at) VALUES($1,$2,$3) ON CONFLICT(deletion_id) DO NOTHING',[e.deletionId,e.boxId,e.completedAt]);
  }
  await client.query('UPDATE passshare_restore_control.recovery SET deletion_journal_sha256=$1 WHERE singleton=true AND deletion_journal_sha256 IS DISTINCT FROM $1',[expectedSha256]);
  await client.query('COMMIT');targetStarted=false;await currentSource.query('COMMIT');return{reconciledEntries:journal.entries.length,closed:true,journalSha256:expectedSha256};
 }catch(e){if(targetStarted)await client.query('ROLLBACK').catch(()=>{});await currentSource.query('ROLLBACK').catch(()=>{});throw e;}
}

export async function completedDeletionGate(client,{bytes,expectedSha256,expectedSourceId,restoreOperationId,currentSource,expectedSourceDatabase,expectedSourceSystemIdentifier,expectedSourceDatabaseOid}){
 const journal=parseDeletionJournal(bytes,{expectedSha256,expectedSourceId});
 if(!currentSource||typeof expectedSourceDatabase!=='string')return false;
 await currentSource.query('BEGIN');let targetStarted=false;
 try{
 try{await verifyCurrentSource(currentSource,{expectedSourceDatabase,expectedSourceSystemIdentifier,expectedSourceDatabaseOid});}catch{return false;}
 await currentSource.query('LOCK TABLE commercial_deletion_journal IN SHARE MODE');
 if(hash(await exportDeletionJournal(currentSource,expectedSourceId))!==expectedSha256)return false;
 await client.query('BEGIN');targetStarted=true;
 if(!(await client.query("SELECT to_regclass('public.commercial_deletion_journal') IS NOT NULL present")).rows[0].present)return false;
 await client.query('LOCK TABLE connect_vaults,mutation_operations,commercial_deletion_journal IN SHARE MODE');
 if(hash(await exportDeletionJournal(client,expectedSourceId))!==expectedSha256)return false;
 const control=(await client.query('SELECT operation_id,source_id,phase,deletion_journal_sha256 FROM passshare_restore_control.recovery WHERE singleton=true FOR SHARE')).rows;
 if(control.length!==1||control[0].operation_id!==restoreOperationId||control[0].source_id!==expectedSourceId||control[0].phase!=='closed'||control[0].deletion_journal_sha256!==expectedSha256)return false;
 for(const e of journal.entries){
  if((await client.query('SELECT 1 FROM connect_vaults WHERE id=$1',[e.boxId])).rowCount)return false;
  if(!(await client.query('SELECT 1 FROM commercial_deletion_journal WHERE deletion_id=$1 AND box_id=$2',[e.deletionId,e.boxId])).rowCount)return false;
  if((await client.query("SELECT 1 FROM mutation_operations WHERE resource=$1 OR (operation='box' AND result->>'vaultId'=$1)",[e.boxId])).rowCount)return false;
 }
 if((await client.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'")).rows[0].n!==0)return false;
 return true;
 }finally{if(targetStarted)await client.query('ROLLBACK');await currentSource.query('ROLLBACK');}
}

export async function prepareClosedDeletionRestore(client,{expectedTargetDatabase,sourceId,restoreOperationId}){
 if(!/^[a-z][a-z0-9_]{0,62}$/.test(expectedTargetDatabase??'')||!uuid(sourceId)||!uuid(restoreOperationId))throw Error('Explicit closed restore identity required');
 await client.query('BEGIN');
 try{
  if((await client.query('SELECT current_database() name')).rows[0].name!==expectedTargetDatabase)throw Error('Wrong restore database');
  if((await client.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'")).rows[0].n!==0)throw Error('Stop every restore target client before preparing closure');
  await client.query("CREATE SCHEMA IF NOT EXISTS passshare_restore_control; CREATE TABLE IF NOT EXISTS passshare_restore_control.recovery(singleton BOOLEAN PRIMARY KEY CHECK(singleton),operation_id UUID NOT NULL,source_id UUID NOT NULL,phase TEXT NOT NULL CHECK(phase IN('closed','open')),deletion_journal_sha256 TEXT)");
  const rows=(await client.query('SELECT * FROM passshare_restore_control.recovery FOR UPDATE')).rows;
  if(rows.length&&!(rows.length===1&&rows[0].operation_id===restoreOperationId&&rows[0].source_id===sourceId&&rows[0].phase==='closed'))throw Error('Existing recovery binding cannot be replaced');
  if(!rows.length)await client.query("INSERT INTO passshare_restore_control.recovery VALUES(true,$1,$2,'closed',NULL)",[restoreOperationId,sourceId]);
  if((await client.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='public' AND table_name='commercial_data_deletion_requests' AND column_name IN('execution_mode','consent_invalidated_at')")).rows[0].n===2)await client.query("UPDATE commercial_data_deletion_requests SET consent_invalidated_at=clock_timestamp() WHERE execution_mode='due' AND state='pending' AND consent_invalidated_at IS NULL");
  await client.query('COMMIT');return{closed:true,restoreOperationId};
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}
}

export async function assertNotClosedRestoreTarget(pool){
 if(!pool)return;
 const present=(await pool.query("SELECT to_regclass('passshare_restore_control.recovery') IS NOT NULL present")).rows[0].present;
 if(present&&(await pool.query("SELECT 1 FROM passshare_restore_control.recovery WHERE phase='closed'")).rowCount)throw Error('RESTORE_TARGET_CLOSED');
}
