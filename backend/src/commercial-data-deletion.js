import {createHash,randomUUID} from 'node:crypto';
import {authHttpError,sendAuthError} from './auth/errors.js';
import {requireCsrf} from './auth/csrf.js';
import {parsePassword} from './auth/validation.js';
import {verifyPassword} from './auth/password.js';
import {createLoginGuard,resolveClientIp} from './auth/login-guard.js';
import {applySchemaWithAdvisoryLock} from './db/migration-lock.js';
import {loadEntitlement} from './commercial-live.js';
import {migrateDeletionJournal,recordCompletedDeletion} from './commercial-deletion-journal.js';

export const DATA_DELETION_SCHEMA=`CREATE TABLE IF NOT EXISTS commercial_data_deletion_requests (
 id UUID PRIMARY KEY,contract_id UUID NOT NULL REFERENCES commercial_contracts(id) ON DELETE CASCADE,
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,request_id UUID NOT NULL,
 box_id VARCHAR(26) NOT NULL CHECK(box_id ~ '^[a-z0-9]{26}$'),quote_hash TEXT NOT NULL CHECK(quote_hash ~ '^[a-f0-9]{64}$'),
 fingerprint TEXT NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),data_fingerprint TEXT NOT NULL CHECK(data_fingerprint ~ '^[a-f0-9]{64}$'),content_version INTEGER NOT NULL CHECK(content_version>0),
 attribute_version INTEGER NOT NULL CHECK(attribute_version>0),encrypted_state_revision BIGINT CHECK(encrypted_state_revision>0),
 encrypted_key_epoch BIGINT CHECK(encrypted_key_epoch>0),paid_through DATE NOT NULL,not_before DATE NOT NULL CHECK(not_before=paid_through+30),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','canceled','completed')),revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
 requested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),canceled_at TIMESTAMPTZ,completed_at TIMESTAMPTZ,
 UNIQUE(user_id,request_id),
 CHECK((encrypted_state_revision IS NULL)=(encrypted_key_epoch IS NULL)),
 CHECK((state='pending' AND canceled_at IS NULL AND completed_at IS NULL AND revision=0)
 OR(state='canceled' AND canceled_at IS NOT NULL AND completed_at IS NULL AND revision=1)
 OR(state='completed' AND completed_at IS NOT NULL AND canceled_at IS NULL AND revision=1)));`;
export const migrateDataDeletion=async pool=>{await applySchemaWithAdvisoryLock(pool,4820138,DATA_DELETION_SCHEMA);await migrateDeletionJournal(pool);};
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const boxId=value=>typeof value==='string'&&/^[a-z0-9]{26}$/.test(value);
const exact=(body,keys)=>body&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).length===keys.length&&keys.every(key=>Object.hasOwn(body,key));
const digest=value=>createHash('sha256').update(value).digest('hex');
const failure=(status,message)=>authHttpError(status,status===401?'PS024':status===403?'PS032':status===404?'PS022':status===409?'PS015':'PS018',message);
const view=row=>({id:row.id,contractId:row.contract_id,boxId:row.box_id,state:row.state,revision:row.revision,requestedAt:row.requested_at,canceledAt:row.canceled_at,completedAt:row.completed_at,notBefore:row.not_before,paidThrough:row.paid_through,dataDeleted:row.state==='completed',accountDeleted:false,financialRecordsDeleted:false,localFilesDeleted:false,meaning:'explicit_solely_owned_hosted_box_request_not_account_or_billing_deletion'});

// No scheduled process discovers boxes from billing ownership. The current Box
// owner explicitly selects one box and confirms its unchanged state at execution.
export function registerDataDeletionRoutes(router,{pool,authStore,loginGuardStore}){
 const guard=createLoginGuard({store:loginGuardStore});
 const reauthenticate=async req=>{
  const user=await authStore.findUserById(req.auth.userId);if(!user)throw failure(401,'Session expired');
  const ip=resolveClientIp(req);await guard.assertIpAllowed(ip);await guard.recordIpRequest(ip);await guard.assertNotLocked(user.email);
  if(!await verifyPassword(user.password_hash,parsePassword(req.body.currentPassword))){await guard.recordFailure(user.email);throw failure(401,'Invalid credentials');}
  // Auxiliary counter storage must succeed before any irreversible work. A
  // failure after commit must not turn a completed deletion into an HTTP500.
  await guard.clearFailures(user.email);
  return {hash:digest(user.password_hash),email:user.email};
 };
 const transaction=async(req,selectedBox,proof,work)=>{
  if(!uuid(req.params.id))throw failure(404,'Contract not found');if(!pool)throw failure(503,'Persistent deletion requests unavailable');
  const client=await pool.connect();try{
   await client.query('BEGIN');
   // Match existing encrypted operations and retirement: Box before identities.
   const box=selectedBox?(await client.query('SELECT * FROM connect_vaults WHERE id=$1 FOR UPDATE',[selectedBox])).rows[0]:null;
   const user=(await client.query('SELECT id,password_hash FROM users WHERE id=$1 '+(selectedBox?'FOR UPDATE':'FOR SHARE'),[req.auth.userId])).rows[0];
   if(!user)throw failure(401,'Session expired');
   const session=await client.query('SELECT id FROM sessions WHERE id=$1 AND user_id=$2 FOR SHARE',[req.auth.sessionId,req.auth.userId]);if(!session.rowCount)throw failure(401,'Session expired');
   const contract=(await client.query('SELECT * FROM commercial_contracts WHERE id=$1 AND user_id=$2 FOR UPDATE',[req.params.id,req.auth.userId])).rows[0];if(!contract)throw failure(404,'Contract not found');
   const live=async()=>{if(!(await client.query('SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND expires_at>clock_timestamp()',[req.auth.sessionId,req.auth.userId])).rowCount)throw failure(401,'Session expired');if(proof&&digest(user.password_hash)!==proof.hash)throw failure(401,'Credentials changed');};
   await live();const result=await work(client,contract,box);await live();await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
 };
 const snapshot=async(client,box,owner)=>{
  if(!box)throw failure(404,'Password box not found');
  const members=(await client.query('SELECT user_id,role,passshare_membership_active(role,confirmed_at) active FROM vault_memberships WHERE vault_id=$1 ORDER BY user_id FOR SHARE',[box.id])).rows;
  if(!members.some(member=>member.user_id===owner&&member.role==='owner'&&member.active))throw failure(403,'Current password box owner access required');
  if(members.length!==1)throw failure(409,'Shared password box must be preserved');
  const pending=await client.query("SELECT id FROM vault_invitations WHERE vault_id=$1 AND status='pending' AND expires_at>clock_timestamp() FOR SHARE",[box.id]);if(pending.rowCount)throw failure(409,'Pending invitation must be resolved before deletion');
  const encrypted=(await client.query('SELECT state_revision,key_epoch FROM encrypted_box_state WHERE box_id=$1 FOR SHARE',[box.id])).rows[0];
  if((await client.query("SELECT 1 FROM encrypted_rotations WHERE box_id=$1 AND status='pending' UNION ALL SELECT 1 FROM encrypted_migrations WHERE box_id=$1 AND status='pending' LIMIT 1",[box.id])).rowCount)throw failure(409,'Pending encrypted work must finish before deletion');
  const fingerprint=(await client.query(`WITH inventory AS (
   SELECT 'box' kind,id key,to_jsonb(v)::text value FROM connect_vaults v WHERE id=$1
   UNION ALL SELECT 'item',id,to_jsonb(i)::text FROM connect_items i WHERE vault_id=$1
   UNION ALL SELECT 'file',f.id,to_jsonb(f)::text FROM connect_item_files f JOIN connect_items i ON i.id=f.item_id WHERE i.vault_id=$1)
   SELECT encode(sha256(convert_to(COALESCE(string_agg(kind||':'||key||':'||encode(sha256(convert_to(value,'UTF8')),'hex'),',' ORDER BY kind,key),''),'UTF8')),'hex') digest FROM inventory`,[box.id])).rows[0].digest;
  return {content:Number(box.content_version),attribute:Number(box.attribute_version),revision:encrypted?.state_revision??null,epoch:encrypted?.key_epoch??null,fingerprint};
 };
 const ended=async(client,contract)=>{
  const cancellation=(await client.query('SELECT cancel_after_cycle FROM commercial_live_contracts WHERE contract_id=$1 FOR SHARE',[contract.id])).rows[0];
  const clock=(await client.query('SELECT clock_timestamp() AS now')).rows[0].now,entitlement=await loadEntitlement(client,contract.id,new Date(clock).getTime());
  if(cancellation?.cancel_after_cycle==null||entitlement.state!=='closed'||!entitlement.exportWindow||entitlement.exportWindow.open)throw failure(409,'A canceled paid contract must finish its30day export window');
  const others=(await client.query('SELECT id FROM commercial_contracts WHERE user_id=$1 AND id<>$2 ORDER BY id FOR SHARE',[contract.user_id,contract.id])).rows;
  for(const other of others){const current=await loadEntitlement(client,other.id,new Date(clock).getTime());if(current.effective||current.state==='not_started'||current.exportWindow?.open)throw failure(409,'Another paid contract still protects hosted data');}
  return entitlement;
 };
 const read=async(client,req)=>{if(!uuid(req.params.request))throw failure(404,'Deletion request not found');const row=(await client.query('SELECT *,paid_through::text paid_through,not_before::text not_before FROM commercial_data_deletion_requests WHERE id=$1 AND contract_id=$2 AND user_id=$3 FOR UPDATE',[req.params.request,req.params.id,req.auth.userId])).rows[0];if(!row)throw failure(404,'Deletion request not found');return row;};
 router.post('/:id/data-deletion-requests',requireCsrf,async(req,res)=>{try{
  const body=req.body;if(!exact(body,['requestId','boxId','quoteHash','expectedContentVersion','expectedAttributeVersion','expectedStateRevision','expectedKeyEpoch','confirmationBoxId','currentPassword'])||!uuid(body.requestId)||!boxId(body.boxId)||body.confirmationBoxId!==body.boxId||!/^[a-f0-9]{64}$/.test(body.quoteHash??'')||![body.expectedContentVersion,body.expectedAttributeVersion].every(value=>Number.isSafeInteger(value)&&value>0)||![body.expectedStateRevision,body.expectedKeyEpoch].every(value=>value===null||Number.isSafeInteger(value)&&value>0))throw failure(400,'Invalid explicit password box deletion request');
  const proof=await reauthenticate(req),result=await transaction(req,body.boxId,proof,async(client,contract,box)=>{
   if(contract.quote_hash!==body.quoteHash)throw failure(409,'Contract quote changed');
   const fingerprint=digest(JSON.stringify({contract:contract.id,owner:req.auth.userId,box:body.boxId,quote:body.quoteHash,content:body.expectedContentVersion,attribute:body.expectedAttributeVersion,revision:body.expectedStateRevision,epoch:body.expectedKeyEpoch}));
   const previous=(await client.query('SELECT *,paid_through::text paid_through,not_before::text not_before FROM commercial_data_deletion_requests WHERE user_id=$1 AND request_id=$2',[req.auth.userId,body.requestId])).rows[0];if(previous){if(previous.fingerprint!==fingerprint)throw failure(409,'Deletion request changed');return view(previous);}
   const state=await snapshot(client,box,req.auth.userId),entitlement=await ended(client,contract);
   if(state.content!==body.expectedContentVersion||state.attribute!==body.expectedAttributeVersion||String(state.revision)!==String(body.expectedStateRevision)||String(state.epoch)!==String(body.expectedKeyEpoch))throw failure(409,'Password box version changed');
   return view((await client.query('INSERT INTO commercial_data_deletion_requests(id,contract_id,user_id,request_id,box_id,quote_hash,fingerprint,data_fingerprint,content_version,attribute_version,encrypted_state_revision,encrypted_key_epoch,paid_through,not_before) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::date,$14::date) RETURNING *,paid_through::text paid_through,not_before::text not_before',[randomUUID(),contract.id,req.auth.userId,body.requestId,box.id,contract.quote_hash,fingerprint,state.fingerprint,state.content,state.attribute,state.revision,state.epoch,entitlement.paidThrough,entitlement.exportWindow.endExclusive])).rows[0]);
  });res.status(201).json(result);
 }catch(error){sendAuthError(res,error?.code==='23505'&&error.constraint==='commercial_data_deletion_requests_user_id_request_id_key'?failure(409,'Deletion request identity changed'):error);}});
 router.get('/:id/data-deletion-requests/:request',async(req,res)=>{try{res.json(await transaction(req,null,null,async client=>view(await read(client,req))));}catch(error){sendAuthError(res,error);}});
 router.post('/:id/data-deletion-requests/:request/cancel',requireCsrf,async(req,res)=>{try{
  if(!exact(req.body,['revision'])||!Number.isSafeInteger(req.body.revision)||req.body.revision<0)throw failure(400,'Invalid deletion cancellation');
  const result=await transaction(req,null,null,async client=>{const row=await read(client,req);if(row.state==='canceled'&&req.body.revision===row.revision-1)return view(row);if(row.state!=='pending'||row.revision!==req.body.revision)throw failure(409,'Deletion request is no longer cancelable');return view((await client.query("UPDATE commercial_data_deletion_requests SET state='canceled',revision=1,canceled_at=clock_timestamp() WHERE id=$1 RETURNING *,paid_through::text paid_through,not_before::text not_before",[row.id])).rows[0]);});res.json(result);
 }catch(error){sendAuthError(res,error);}});
 router.post('/:id/data-deletion-requests/:request/execute',requireCsrf,async(req,res)=>{try{
  if(!exact(req.body,['revision','currentPassword','confirmationBoxId'])||!Number.isSafeInteger(req.body.revision)||req.body.revision<0||!boxId(req.body.confirmationBoxId))throw failure(400,'Invalid confirmed deletion');
  const proof=await reauthenticate(req),result=await transaction(req,req.body.confirmationBoxId,proof,async(client,contract,box)=>{
   const row=await read(client,req);if(row.box_id!==req.body.confirmationBoxId)throw failure(409,'Confirmed password box changed');if(row.state==='completed'&&req.body.revision===row.revision-1)return view(row);if(row.state!=='pending'||row.revision!==req.body.revision)throw failure(409,'Deletion request changed');
   if(row.quote_hash!==contract.quote_hash)throw failure(409,'Contract quote changed');
   const state=await snapshot(client,box,req.auth.userId),entitlement=await ended(client,contract);
   if(row.paid_through!==entitlement.paidThrough||row.not_before!==entitlement.exportWindow.endExclusive)throw failure(409,'Paid period changed; review a new deletion request');
   if(state.content!==row.content_version||state.attribute!==row.attribute_version||String(state.revision)!==String(row.encrypted_state_revision)||String(state.epoch)!==String(row.encrypted_key_epoch)||state.fingerprint!==row.data_fingerprint)throw failure(409,'Password box changed; review a new deletion request');
   // A confirmed Box deletion is not account retirement. Do not revoke tokens
   // for the owner's other boxes or alter independent core/self-hosted access.
   await recordCompletedDeletion(client,row);
   await client.query('DELETE FROM mutation_operations WHERE resource=$1',[row.box_id]);
   await client.query("UPDATE mutation_operations SET request_hash='',result='{\"deleted\":true}'::jsonb WHERE operation='box' AND result->>'vaultId'=$1",[row.box_id]);
   await client.query('DELETE FROM connect_vaults WHERE id=$1',[row.box_id]);
   return view((await client.query("UPDATE commercial_data_deletion_requests SET state='completed',revision=1,completed_at=clock_timestamp() WHERE id=$1 RETURNING *,paid_through::text paid_through,not_before::text not_before",[row.id])).rows[0]);
  });res.json(result);
 }catch(error){sendAuthError(res,error);}});
}
