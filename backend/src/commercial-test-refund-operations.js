import {createHash} from 'node:crypto';
import {authHttpError,sendAuthError} from './auth/errors.js';
import {requireCsrf} from './auth/csrf.js';
import {applySchemaWithAdvisoryLock} from './db/migration-lock.js';
import {createTestRefundLookup} from './commercial-refund-provider.js';

export const TEST_REFUND_OPERATION_SCHEMA=`
 CREATE UNIQUE INDEX IF NOT EXISTS commercial_payment_events_refund_operation_scope ON commercial_payment_events(account_id,event_id,contract_id,provider_object_id,amount_jpy,event_hash);
 CREATE TABLE IF NOT EXISTS commercial_test_refund_operations (
 operation_id UUID PRIMARY KEY,contract_id UUID NOT NULL,account_id TEXT NOT NULL,payment_event_id TEXT NOT NULL,provider_object_id TEXT NOT NULL,
 payment_amount_jpy BIGINT NOT NULL CHECK(payment_amount_jpy BETWEEN 1 AND 9007199254740991),payment_event_hash TEXT NOT NULL CHECK(payment_event_hash ~ '^[a-f0-9]{64}$'),
 quote_hash TEXT NOT NULL CHECK(quote_hash ~ '^[a-f0-9]{64}$'),decision_fingerprint TEXT NOT NULL CHECK(decision_fingerprint ~ '^[a-f0-9]{64}$'),
 reviewer_id UUID REFERENCES users(id) ON DELETE SET NULL,amount_jpy BIGINT NOT NULL CHECK(amount_jpy BETWEEN 1 AND payment_amount_jpy),
 reason TEXT NOT NULL CHECK(reason IN ('duplicate_confirmed','unprovided_period_confirmed','statutory_right_confirmed')),
 state TEXT NOT NULL CHECK(state IN ('approved','in_flight','uncertain','rejected','succeeded','pending','requires_action','failed','canceled')),
 provider_refund_id TEXT,approved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),first_dispatched_at TIMESTAMPTZ,result_recorded_at TIMESTAMPTZ,
 evidence TEXT NOT NULL CHECK(evidence='provider_test_sandbox'),UNIQUE(account_id,provider_refund_id),
 FOREIGN KEY(account_id,payment_event_id,contract_id,provider_object_id,payment_amount_jpy,payment_event_hash) REFERENCES commercial_payment_events(account_id,event_id,contract_id,provider_object_id,amount_jpy,event_hash) ON DELETE CASCADE,
 CHECK((state IN ('succeeded','pending','requires_action','failed','canceled'))=(provider_refund_id IS NOT NULL)),
 CHECK(state='approved' OR first_dispatched_at IS NOT NULL));`;
export const migrateTestRefundOperations=pool=>applySchemaWithAdvisoryLock(pool,4820137,TEST_REFUND_OPERATION_SCHEMA);
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
const exact=(b,keys)=>b&&typeof b==='object'&&!Array.isArray(b)&&Object.keys(b).length===keys.length&&keys.every(k=>Object.hasOwn(b,k));
const error=(status,message)=>authHttpError(status,status===401||status===403?'PS024':status===404?'PS022':status===409?'PS015':'PS018',message);
const view=r=>({operationId:r.operation_id,contractId:r.contract_id,paymentIntentId:r.provider_object_id,approvedAmountJpy:Number(r.amount_jpy),state:r.state,approvedAt:r.approved_at,firstDispatchedAt:r.first_dispatched_at,resultRecordedAt:r.result_recorded_at,paymentEvidence:'provider_test_sandbox',providerRefundId:r.provider_refund_id,refundExecuted:r.state==='succeeded',liveRefundExecuted:false,entitlementsGranted:false,meaning:'sandbox_refund_operation_not_live_authority'});

// A separate sandbox ledger binds merchant consent to signed test-payment
// evidence. It is never an input to paid entitlement or live refund review.
export function registerTestRefundOperationRoutes(router,{pool,executor,lookup=createTestRefundLookup(),reviewerIds=[]}){
 const reviewers=new Set(reviewerIds.filter(uuid).map(x=>x.toLowerCase()));
 const transaction=async(req,merchant,work)=>{
  if(merchant&&!reviewers.has(req.auth.userId))throw error(403,'Sandbox refund approval is not authorized');
  if(!uuid(req.params.id))throw error(404,'Contract not found');
  if(!pool)throw error(503,'Persistent sandbox refunds unavailable');
  const c=await pool.connect();try{
   await c.query('BEGIN');
   const own=(await c.query('SELECT user_id FROM commercial_contracts WHERE id=$1',[req.params.id])).rows[0];
   if(!own||(!merchant&&own.user_id!==req.auth.userId&&!reviewers.has(req.auth.userId)))throw error(404,'Contract not found');
   const ids=[...new Set([own.user_id,req.auth.userId])].sort();
   if((await c.query('SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',[ids])).rowCount!==ids.length)throw error(404,'Contract not found');
   if(!(await c.query('SELECT id FROM sessions WHERE id=$1 AND user_id=$2 FOR SHARE',[req.auth.sessionId,req.auth.userId])).rowCount)throw error(401,'Session expired');
   const contract=(await c.query('SELECT * FROM commercial_contracts WHERE id=$1 AND user_id=$2 FOR UPDATE',[req.params.id,own.user_id])).rows[0];
   if(!contract)throw error(404,'Contract not found');
   const current=async()=>{if(!(await c.query('SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND expires_at>clock_timestamp()',[req.auth.sessionId,req.auth.userId])).rowCount)throw error(401,'Session expired')};
   await current();const out=await work(c,contract);await current();await c.query('COMMIT');return out;
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e}finally{c.release()}
 };
 const read=async(c,req)=>{if(!uuid(req.params.operation))throw error(404,'Sandbox refund not found');const r=(await c.query('SELECT * FROM commercial_test_refund_operations WHERE operation_id=$1 AND contract_id=$2 FOR UPDATE',[req.params.operation,req.params.id])).rows[0];if(!r)throw error(404,'Sandbox refund not found');return r};
 router.post('/:id/test-refund-operations',requireCsrf,async(req,res)=>{try{
  const b=req.body;
  if(!exact(b,['operationId','paymentIntentId','quoteHash','amountJpy','reason'])||!uuid(b.operationId)||!/^pi_[A-Za-z0-9]+$/.test(b.paymentIntentId??'')||!/^[a-f0-9]{64}$/.test(b.quoteHash??'')||!Number.isSafeInteger(b.amountJpy)||b.amountJpy<1||!['duplicate_confirmed','unprovided_period_confirmed','statutory_right_confirmed'].includes(b.reason))throw error(400,'Invalid sandbox refund approval');
  const out=await transaction(req,true,async(c,contract)=>{
   if(contract.state!=='accepted_unpaid'||contract.quote_hash!==b.quoteHash)throw error(409,'Contract binding changed');
   const payments=(await c.query('SELECT * FROM commercial_payment_events WHERE contract_id=$1 AND provider_object_id=$2',[contract.id,b.paymentIntentId])).rows;
   if(payments.length!==1)throw error(409,'One signed sandbox payment is required');const p=payments[0];
   if(BigInt(b.amountJpy)>BigInt(p.amount_jpy))throw error(409,'Approval exceeds the sandbox payment');
   const op=b.operationId.toLowerCase(),fingerprint=createHash('sha256').update(JSON.stringify({operation:op,reviewer:req.auth.userId,contract:contract.id,account:p.account_id,event:p.event_id,payment:p.provider_object_id,paymentHash:p.event_hash,quote:b.quoteHash,amount:b.amountJpy,reason:b.reason})).digest('hex');
   const old=(await c.query('SELECT * FROM commercial_test_refund_operations WHERE operation_id=$1',[op])).rows[0];if(old){if(old.contract_id!==contract.id||old.decision_fingerprint!==fingerprint)throw error(409,'Sandbox refund operation changed');return view(old)}
   const allocated=BigInt((await c.query("SELECT COALESCE(sum(amount_jpy),0)::text n FROM commercial_test_refund_operations WHERE account_id=$1 AND provider_object_id=$2 AND state NOT IN ('failed','canceled','rejected')",[p.account_id,p.provider_object_id])).rows[0].n);
   const external=BigInt((await c.query("SELECT COALESCE(sum(r.amount_jpy),0)::text n FROM commercial_test_refunds r WHERE r.account_id=$1 AND r.provider_object_id=$2 AND NOT(r.status_verified AND r.provider_status IN ('failed','canceled')) AND NOT EXISTS(SELECT 1 FROM commercial_test_refund_operations o WHERE o.account_id=r.account_id AND o.provider_refund_id=r.refund_id)",[p.account_id,p.provider_object_id])).rows[0].n);
   if(allocated+external+BigInt(b.amountJpy)>BigInt(p.amount_jpy))throw error(409,'Other sandbox refunds reserve this payment');
   const r=(await c.query("INSERT INTO commercial_test_refund_operations(operation_id,contract_id,account_id,payment_event_id,provider_object_id,payment_amount_jpy,payment_event_hash,quote_hash,decision_fingerprint,reviewer_id,amount_jpy,reason,state,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'approved','provider_test_sandbox') RETURNING *",[op,contract.id,p.account_id,p.event_id,p.provider_object_id,p.amount_jpy,p.event_hash,b.quoteHash,fingerprint,req.auth.userId,b.amountJpy,b.reason])).rows[0];return view(r);
  });res.status(201).json(out);
 }catch(e){sendAuthError(res,e)}});
 router.get('/:id/test-refund-operations/:operation',async(req,res)=>{try{res.json(await transaction(req,false,async c=>view(await read(c,req))))}catch(e){sendAuthError(res,e)}});
 router.post('/:id/test-refund-operations/:operation/reconcile',requireCsrf,async(req,res)=>{try{
  if(!exact(req.body,[]))throw error(400,'Reconciliation accepts no client financial state');
  const captured=await transaction(req,true,async(c,contract)=>({row:await read(c,req),ownerId:contract.user_id}));
  let current=null;try{if(typeof lookup==='function')current=await lookup({account:captured.row.account_id,paymentIntentId:captured.row.provider_object_id})}catch{}
  const r=captured.row,p=current?.payment,m=p?.metadata;
  if(current?.account!==r.account_id||p?.livemode!==false||p?.object!=='payment_intent'||p.id!==r.provider_object_id||p.currency!=='jpy'||p.status!=='succeeded'||p.amount!==Number(r.payment_amount_jpy)||p.amount_received!==Number(r.payment_amount_jpy)||m?.contractId!==r.contract_id||m?.ownerId!==captured.ownerId||m?.quoteHash!==r.quote_hash||!Array.isArray(current.refunds))throw error(409,'Sandbox provider result is unconfirmed');
  const matches=current.refunds.filter(x=>x.metadata?.operationId===r.operation_id&&x.metadata?.decisionFingerprint===r.decision_fingerprint);
  const refund=matches[0],pi=typeof refund?.payment_intent==='string'?refund.payment_intent:refund?.payment_intent?.id;
  if(matches.length!==1||refund.object!=='refund'||!/^((re|pyr)_[A-Za-z0-9]+)$/.test(refund.id??'')||pi!==r.provider_object_id||refund.currency!=='jpy'||refund.amount!==Number(r.amount_jpy)||!['succeeded','pending','requires_action','failed','canceled'].includes(refund.status))throw error(409,'One exact sandbox refund result is required');
  const out=await transaction(req,true,async(c,contract)=>{const fresh=await read(c,req);if(fresh.decision_fingerprint!==r.decision_fingerprint||fresh.state!==r.state||fresh.quote_hash!==contract.quote_hash)throw error(409,'Sandbox refund changed during reconciliation');if(!fresh.first_dispatched_at)throw error(409,'Undispatched operation has no provider result');return view((await c.query('UPDATE commercial_test_refund_operations SET state=$2,provider_refund_id=$3,result_recorded_at=clock_timestamp() WHERE operation_id=$1 RETURNING *',[r.operation_id,refund.status,refund.id])).rows[0])});res.json(out);
 }catch(e){sendAuthError(res,e)}});
 router.post('/:id/test-refund-operations/:operation/execute',requireCsrf,async(req,res)=>{try{
  if(typeof executor!=='function')throw error(503,'Sandbox refund execution is not configured');
  if(!exact(req.body,[]))throw error(400,'Execution accepts no client financial state');
  const captured=await transaction(req,true,async(c,contract)=>{
   const r=await read(c,req);if(!['approved','uncertain'].includes(r.state)){if(r.state==='in_flight')throw error(409,'Sandbox operation is already in flight');return {final:view(r)}}
   if(r.quote_hash!==contract.quote_hash)throw error(409,'Sandbox payment binding changed');
   // Provider v1 may prune an idempotency key after24h. Never issue a fresh
   // mutation for an old uncertain operation; retain it for reconciliation.
   if(r.first_dispatched_at&&(await c.query("SELECT $1::timestamptz < clock_timestamp()-interval '23 hours' expired",[r.first_dispatched_at])).rows[0].expired)throw error(409,'Old uncertain operation requires provider reconciliation');
   await c.query("UPDATE commercial_test_refund_operations SET state='in_flight',first_dispatched_at=COALESCE(first_dispatched_at,clock_timestamp()) WHERE operation_id=$1",[r.operation_id]);
   return {operationId:r.operation_id,account:r.account_id,paymentIntentId:r.provider_object_id,contractId:contract.id,ownerId:contract.user_id,quoteHash:r.quote_hash,paymentAmountJpy:Number(r.payment_amount_jpy),approvedAmountJpy:Number(r.amount_jpy),decisionFingerprint:r.decision_fingerprint};
  });if(captured.final){res.json(captured.final);return}
  const authorize=()=>transaction(req,true,async(c,contract)=>{const r=await read(c,req);if(r.state!=='in_flight'||r.decision_fingerprint!==captured.decisionFingerprint||r.quote_hash!==contract.quote_hash)throw error(409,'Sandbox authority changed before dispatch');return true});
  let result;try{result=await executor(captured,authorize)}catch{result={state:'uncertain',refund:null}}
  const r=result?.refund,known=['succeeded','pending','requires_action','failed','canceled'].includes(result?.state)&&/^((re|pyr)_[A-Za-z0-9]+)$/.test(r?.id??'')&&r.paymentIntentId===captured.paymentIntentId&&r.amountJpy===captured.approvedAmountJpy&&r.currency==='jpy';
  const state=known?result.state:result?.state==='rejected'?'rejected':'uncertain';
  // Record a result even if the initiating session expired during the call.
  // Disclosure still goes through fresh authorization below.
  await pool.query("UPDATE commercial_test_refund_operations SET state=$3,provider_refund_id=$4,result_recorded_at=clock_timestamp() WHERE operation_id=$1 AND decision_fingerprint=$2 AND state='in_flight'",[captured.operationId,captured.decisionFingerprint,state,known?r.id:null]);
  const out=await transaction(req,true,async c=>view(await read(c,req)));res.status(out.state==='uncertain'?202:200).json(out);
 }catch(e){sendAuthError(res,e)}});
}
