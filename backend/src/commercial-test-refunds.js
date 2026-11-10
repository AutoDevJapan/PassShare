import {randomUUID} from 'node:crypto';
import {authHttpError,sendAuthError} from './auth/errors.js';
import {applySchemaWithAdvisoryLock} from './db/migration-lock.js';
import {requireCsrf} from './auth/csrf.js';

export const TEST_REFUND_SCHEMA=`
 CREATE UNIQUE INDEX IF NOT EXISTS commercial_payment_events_refund_scope
 ON commercial_payment_events(account_id,event_id,contract_id,provider_object_id);
 CREATE TABLE IF NOT EXISTS commercial_test_refunds (
 id UUID NOT NULL UNIQUE,account_id TEXT NOT NULL,refund_id TEXT NOT NULL,
 payment_event_id TEXT NOT NULL,contract_id UUID NOT NULL,provider_object_id TEXT NOT NULL,
 amount_jpy BIGINT NOT NULL CHECK(amount_jpy>0),refund_created BIGINT NOT NULL CHECK(refund_created>0),
 provider_status TEXT NOT NULL DEFAULT 'status_review' CHECK(provider_status IN ('pending','requires_action','succeeded','failed','canceled','status_review')),
 status_event_created BIGINT CHECK(status_event_created>0),
 status_checked_at TIMESTAMPTZ,status_verified BOOLEAN NOT NULL DEFAULT false CHECK(NOT status_verified OR status_checked_at IS NOT NULL),
 api_reserved_jpy BIGINT CHECK(api_reserved_jpy>=0),
 received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 evidence TEXT NOT NULL CHECK(evidence='provider_test_sandbox'),
 PRIMARY KEY(account_id,refund_id),UNIQUE(account_id,refund_id,contract_id),
 FOREIGN KEY(account_id,payment_event_id,contract_id,provider_object_id)
 REFERENCES commercial_payment_events(account_id,event_id,contract_id,provider_object_id) ON DELETE CASCADE);
 CREATE INDEX IF NOT EXISTS commercial_test_refunds_owner_page ON commercial_test_refunds(contract_id,id);
 CREATE TABLE IF NOT EXISTS commercial_test_refund_events (
 account_id TEXT NOT NULL,event_id TEXT NOT NULL,refund_id TEXT NOT NULL,contract_id UUID NOT NULL,
 event_hash TEXT NOT NULL,provider_created BIGINT NOT NULL CHECK(provider_created>0),
 observed_status TEXT NOT NULL DEFAULT 'succeeded' CHECK(observed_status IN ('pending','requires_action','succeeded','failed','canceled')),
 received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(account_id,event_id),
 FOREIGN KEY(account_id,refund_id,contract_id) REFERENCES commercial_test_refunds(account_id,refund_id,contract_id) ON DELETE CASCADE);
 ALTER TABLE commercial_test_refunds ADD COLUMN IF NOT EXISTS provider_status TEXT NOT NULL DEFAULT 'status_review' CHECK(provider_status IN ('pending','requires_action','succeeded','failed','canceled','status_review'));
 ALTER TABLE commercial_test_refunds ADD COLUMN IF NOT EXISTS status_event_created BIGINT CHECK(status_event_created>0);
 ALTER TABLE commercial_test_refunds ADD COLUMN IF NOT EXISTS status_checked_at TIMESTAMPTZ;
 ALTER TABLE commercial_test_refunds ADD COLUMN IF NOT EXISTS status_verified BOOLEAN NOT NULL DEFAULT false CHECK(NOT status_verified OR status_checked_at IS NOT NULL);
 ALTER TABLE commercial_test_refunds ADD COLUMN IF NOT EXISTS api_reserved_jpy BIGINT CHECK(api_reserved_jpy>=0);
 ALTER TABLE commercial_test_refund_events ADD COLUMN IF NOT EXISTS observed_status TEXT NOT NULL DEFAULT 'succeeded' CHECK(observed_status IN ('pending','requires_action','succeeded','failed','canceled'));
 CREATE INDEX IF NOT EXISTS commercial_test_refund_events_status ON commercial_test_refund_events(account_id,refund_id,provider_created);
 CREATE INDEX IF NOT EXISTS commercial_test_refunds_payment ON commercial_test_refunds(account_id,provider_object_id);`;
export const migrateTestRefunds=p=>applySchemaWithAdvisoryLock(p,4820134,TEST_REFUND_SCHEMA);

export async function lockTestPayment(c,account,eventId,paymentIntent){
 for(const key of [account+':event:'+eventId,account+':intent:'+paymentIntent].sort())
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,4820134))',[key]);
}
const uuid=s=>typeof s==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(s);
const conflict=message=>authHttpError(409,'PS015',message);
const providerId=s=>typeof s==='string'&&/^[A-Za-z0-9_]{1,255}$/.test(s);
const statuses=['pending','requires_action','succeeded','failed','canceled'];
const reservedSql="COALESCE(SUM(amount_jpy) FILTER (WHERE NOT(status_verified AND provider_status IN ('failed','canceled'))),0)::text";
function financialView(r,readerConfigured=true){
 const verified=readerConfigured&&r.status_verified===true&&r.status_checked_at!=null;
 const statusReviewRequired=!verified||r.provider_status==='status_review';
 const amountReviewRequired=BigInt(r.reserved_jpy)>BigInt(r.paid_jpy)||(r.api_reserved_jpy!=null&&BigInt(r.api_reserved_jpy)>BigInt(r.paid_jpy));
 return {providerStatus:statusReviewRequired?'status_review':r.provider_status,statusReviewRequired,amountReviewRequired,statusCheckedAt:verified?r.status_checked_at:null,statusBasis:verified?'provider_api_test':'unverified',confirmedAmountJpy:!statusReviewRequired&&!amountReviewRequired&&r.provider_status==='succeeded'?Number(r.amount_jpy):0};
}

async function refreshCurrentRefunds(c,payment,lookup){
 let snapshot=null;try{if(typeof lookup==='function')snapshot=await lookup({account:payment.account_id,paymentIntentId:payment.provider_object_id})}catch{}
 const p=snapshot?.payment,refunds=snapshot?.refunds;
 const validPayment=snapshot?.account===payment.account_id&&p?.object==='payment_intent'&&p.id===payment.provider_object_id&&p.livemode===false&&p.status==='succeeded'&&p.currency==='jpy'&&Number.isSafeInteger(p.amount)&&Number.isSafeInteger(p.amount_received)&&BigInt(p.amount)===BigInt(payment.amount_jpy)&&BigInt(p.amount_received)===BigInt(payment.amount_jpy);
 const ids=new Set();
 const valid=validPayment&&Array.isArray(refunds)&&refunds.length<=1000&&refunds.every(r=>{
  if(r?.object!=='refund'||!providerId(r.id)||ids.has(r.id))return false;
  ids.add(r.id);
  return r.payment_intent===payment.provider_object_id&&r.livemode!==true&&r.currency==='jpy'&&statuses.includes(r.status)&&Number.isSafeInteger(r.amount)&&r.amount>0&&Number.isSafeInteger(r.created)&&r.created>0;
 });
 const apiReserved=valid?refunds.filter(r=>!['failed','canceled'].includes(r.status)).reduce((n,r)=>n+BigInt(r.amount),0n).toString():null;
 const rows=(await c.query('SELECT * FROM commercial_test_refunds WHERE account_id=$1 AND provider_object_id=$2 AND contract_id=$3 FOR UPDATE',[payment.account_id,payment.provider_object_id,payment.contract_id])).rows;
 const updated=[];
 for(const row of rows){
  const current=valid?refunds.find(r=>r.id===row.refund_id):null;
  const verified=!!current&&BigInt(current.amount)===BigInt(row.amount_jpy)&&BigInt(current.created)===BigInt(row.refund_created);
  updated.push((await c.query('UPDATE commercial_test_refunds SET provider_status=$3,status_event_created=NULL,status_verified=$4,status_checked_at=CASE WHEN $4 THEN clock_timestamp() ELSE NULL END,api_reserved_jpy=$5 WHERE account_id=$1 AND refund_id=$2 RETURNING *',[row.account_id,row.refund_id,verified?current.status:'status_review',verified,verified?apiReserved:null])).rows[0]);
 }
 const reserved=(await c.query('SELECT '+reservedSql+' n FROM commercial_test_refunds WHERE account_id=$1 AND provider_object_id=$2',[payment.account_id,payment.provider_object_id])).rows[0].n;
 return updated.map(r=>({...r,...financialView({...r,reserved_jpy:reserved,paid_jpy:payment.amount_jpy})}));
}

// Only called after the existing receiver verifies the raw Stripe signature,
// sandbox mode and its configured direct/Connect account scope. Provider reads
// can qualify the last checked status; live payments and entitlements never change.
export async function recordTestRefund(pool,event,account,digest,lookup){
 const o=event.data?.object;
 // Stripe's Refund object does not require a livemode property. The signed
 // Event's mode is authoritative; a contradictory explicit property is refused.
 if(event.livemode!==false||o?.livemode===true||!['refund.created','refund.updated','refund.failed'].includes(event.type)||
  o?.object!=='refund'||!statuses.includes(o.status)||(event.type==='refund.failed'&&!['failed','canceled'].includes(o.status))||o.currency!=='jpy'||!Number.isSafeInteger(o.amount)||o.amount<=0||
  !providerId(o.id)||!/^pi_[A-Za-z0-9]+$/.test(o.payment_intent??'')||
  !/^evt_[A-Za-z0-9]+$/.test(event.id??'')||!Number.isSafeInteger(event.created)||event.created<=0||
  !Number.isSafeInteger(o.created)||o.created<=0)throw authHttpError(400,'PS018','Unsupported test refund scope');
 const c=await pool.connect();
 try{
  await c.query('BEGIN');await lockTestPayment(c,account,event.id,o.payment_intent);
  const binding=(await c.query('SELECT p.contract_id,c.user_id FROM commercial_payment_events p JOIN commercial_contracts c ON c.id=p.contract_id WHERE p.account_id=$1 AND p.provider_object_id=$2',[account,o.payment_intent])).rows[0];
  if(!binding)throw conflict('The original test payment is not recorded yet');
  if(!(await c.query('SELECT id FROM users WHERE id=$1 FOR SHARE',[binding.user_id])).rowCount)throw conflict('Payment owner unavailable');
  if(!(await c.query('SELECT id FROM commercial_contracts WHERE id=$1 AND user_id=$2 FOR UPDATE',[binding.contract_id,binding.user_id])).rowCount)throw conflict('Payment contract unavailable');
  const payment=(await c.query('SELECT * FROM commercial_payment_events WHERE account_id=$1 AND provider_object_id=$2 AND contract_id=$3 FOR UPDATE',[account,o.payment_intent,binding.contract_id])).rows[0];
  if(!payment)throw conflict('The original test payment is unavailable');
  if((await c.query('SELECT 1 FROM commercial_payment_events WHERE account_id=$1 AND event_id=$2',[account,event.id])).rowCount)throw conflict('Event identity belongs to a payment');
  const oldEvent=(await c.query('SELECT event_hash,refund_id,contract_id FROM commercial_test_refund_events WHERE account_id=$1 AND event_id=$2',[account,event.id])).rows[0];
  if(oldEvent&&(oldEvent.event_hash!==digest||oldEvent.refund_id!==o.id||oldEvent.contract_id!==binding.contract_id))throw conflict('Refund event changed');
  const old=(await c.query('SELECT * FROM commercial_test_refunds WHERE account_id=$1 AND refund_id=$2',[account,o.id])).rows[0];
  if(old&&(old.provider_object_id!==o.payment_intent||old.contract_id!==binding.contract_id||BigInt(old.amount_jpy)!==BigInt(o.amount)||BigInt(old.refund_created)!==BigInt(o.created)))throw conflict('Refund identity changed');
  if(!old){
   await c.query('INSERT INTO commercial_test_refunds(id,account_id,refund_id,payment_event_id,contract_id,provider_object_id,amount_jpy,refund_created,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[randomUUID(),account,o.id,payment.event_id,binding.contract_id,o.payment_intent,o.amount,o.created,'provider_test_sandbox']);
  }
  if(!oldEvent)await c.query('INSERT INTO commercial_test_refund_events(account_id,event_id,refund_id,contract_id,event_hash,provider_created,observed_status) VALUES($1,$2,$3,$4,$5,$6,$7)',[account,event.id,o.id,binding.contract_id,digest,event.created,o.status]);
  const refreshed=await refreshCurrentRefunds(c,payment,lookup);
  const row=refreshed.find(r=>r.refund_id===o.id);
  const view={providerStatus:row.providerStatus,statusReviewRequired:row.statusReviewRequired,amountReviewRequired:row.amountReviewRequired,statusCheckedAt:row.statusCheckedAt,statusBasis:row.statusBasis,confirmedAmountJpy:row.confirmedAmountJpy};
  await c.query('COMMIT');
  // Intake observes already-issued refunds. Preserve contradictory signed facts
  // for reconciliation instead of pretending rejection prevents a provider action.
  return {received:true,duplicate:!!oldEvent,duplicateRefund:!!old,...view,liveRefundExecuted:false,entitlementsGranted:false,meaning:'signed_test_refund_event_recorded_current_status_separately_qualified'};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});if(e?.code==='23505')throw conflict('Refund identity belongs to another binding');throw e;}finally{c.release();}
}

export function registerTestRefundRoutes(router,persist,lookup){
 router.post('/:id/test-refunds/:receipt/reconcile',requireCsrf,async(req,res)=>{try{
  if(!uuid(req.params.id)||!uuid(req.params.receipt))throw authHttpError(404,'PS022','Refund not found');
  if(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).length)throw authHttpError(400,'PS018','No client refund state is accepted');
  const result=await persist(req,async c=>{
   if(!(await c.query('SELECT id FROM commercial_contracts WHERE id=$1 AND user_id=$2 FOR UPDATE',[req.params.id,req.auth.userId])).rowCount)throw authHttpError(404,'PS022','Contract not found');
   const row=(await c.query('SELECT * FROM commercial_test_refunds WHERE id=$1 AND contract_id=$2',[req.params.receipt,req.params.id])).rows[0];
   if(!row)throw authHttpError(404,'PS022','Refund not found');
   const payment=(await c.query('SELECT * FROM commercial_payment_events WHERE account_id=$1 AND event_id=$2 AND contract_id=$3 AND provider_object_id=$4',[row.account_id,row.payment_event_id,row.contract_id,row.provider_object_id])).rows[0];
   if(!payment)throw conflict('Original test payment unavailable');
   const current=(await refreshCurrentRefunds(c,payment,lookup)).find(r=>r.id===row.id);
   return {providerStatus:current.providerStatus,confirmedAmountJpy:current.confirmedAmountJpy,statusReviewRequired:current.statusReviewRequired,amountReviewRequired:current.amountReviewRequired,statusCheckedAt:current.statusCheckedAt,statusBasis:current.statusBasis};
  });res.json({...result,liveRefundExecuted:false,entitlementsGranted:false});
 }catch(e){sendAuthError(res,e);}});
 router.get('/:id/test-refunds',async(req,res)=>{try{
  if(!uuid(req.params.id))throw authHttpError(404,'PS022','Contract not found');
  if(req.query.after!==undefined&&!uuid(req.query.after))throw authHttpError(400,'PS018','Invalid refund cursor');
  const rows=await persist(req,async c=>{
   if(!(await c.query('SELECT id FROM commercial_contracts WHERE id=$1 AND user_id=$2 FOR UPDATE',[req.params.id,req.auth.userId])).rowCount)throw authHttpError(404,'PS022','Contract not found');
   return (await c.query("SELECT r.id,r.refund_id,r.provider_object_id,r.amount_jpy::text,r.refund_created::text,r.received_at,r.evidence,r.provider_status,r.status_verified,r.status_checked_at,r.api_reserved_jpy::text,p.amount_jpy::text paid_jpy,(SELECT COALESCE(ARRAY_AGG(DISTINCT observed_status ORDER BY observed_status),'{}'::text[]) FROM commercial_test_refund_events e WHERE e.account_id=r.account_id AND e.refund_id=r.refund_id AND e.contract_id=r.contract_id) observed_statuses,(SELECT "+reservedSql+' FROM commercial_test_refunds x WHERE x.account_id=r.account_id AND x.provider_object_id=r.provider_object_id) reserved_jpy FROM commercial_test_refunds r JOIN commercial_payment_events p ON (r.account_id,r.payment_event_id,r.contract_id,r.provider_object_id)=(p.account_id,p.event_id,p.contract_id,p.provider_object_id) WHERE r.contract_id=$1 AND ($2::uuid IS NULL OR r.id>$2) ORDER BY r.id LIMIT 101',[req.params.id,req.query.after??null])).rows;
  });const page=rows.slice(0,100);
  res.json({refunds:page.map(r=>({id:r.id,refundId:r.refund_id,paymentIntentId:r.provider_object_id,amountJpy:Number(r.amount_jpy),providerCreated:Number(r.refund_created),receivedAt:r.received_at,evidence:r.evidence,observedStatuses:r.observed_statuses,...financialView(r,typeof lookup==='function')})),nextCursor:rows.length>100?page.at(-1).id:null,liveRefundExecuted:false,entitlementsGranted:false});
 }catch(e){sendAuthError(res,e);}});
}
