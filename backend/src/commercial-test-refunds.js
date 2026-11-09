import {randomUUID} from 'node:crypto';
import {authHttpError,sendAuthError} from './auth/errors.js';
import {applySchemaWithAdvisoryLock} from './db/migration-lock.js';

export const TEST_REFUND_SCHEMA=`
 CREATE UNIQUE INDEX IF NOT EXISTS commercial_payment_events_refund_scope
 ON commercial_payment_events(account_id,event_id,contract_id,provider_object_id);
 CREATE TABLE IF NOT EXISTS commercial_test_refunds (
 id UUID NOT NULL UNIQUE,account_id TEXT NOT NULL,refund_id TEXT NOT NULL,
 payment_event_id TEXT NOT NULL,contract_id UUID NOT NULL,provider_object_id TEXT NOT NULL,
 amount_jpy BIGINT NOT NULL CHECK(amount_jpy>0),refund_created BIGINT NOT NULL CHECK(refund_created>0),
 received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 evidence TEXT NOT NULL CHECK(evidence='provider_test_sandbox'),
 PRIMARY KEY(account_id,refund_id),UNIQUE(account_id,refund_id,contract_id),
 FOREIGN KEY(account_id,payment_event_id,contract_id,provider_object_id)
 REFERENCES commercial_payment_events(account_id,event_id,contract_id,provider_object_id) ON DELETE CASCADE);
 CREATE INDEX IF NOT EXISTS commercial_test_refunds_owner_page ON commercial_test_refunds(contract_id,id);
 CREATE TABLE IF NOT EXISTS commercial_test_refund_events (
 account_id TEXT NOT NULL,event_id TEXT NOT NULL,refund_id TEXT NOT NULL,contract_id UUID NOT NULL,
 event_hash TEXT NOT NULL,provider_created BIGINT NOT NULL CHECK(provider_created>0),
 received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(account_id,event_id),
 FOREIGN KEY(account_id,refund_id,contract_id) REFERENCES commercial_test_refunds(account_id,refund_id,contract_id) ON DELETE CASCADE);`;
export const migrateTestRefunds=p=>applySchemaWithAdvisoryLock(p,4820134,TEST_REFUND_SCHEMA);

export async function lockTestPayment(c,account,eventId,paymentIntent){
 for(const key of [account+':event:'+eventId,account+':intent:'+paymentIntent].sort())
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,4820134))',[key]);
}
const uuid=s=>typeof s==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(s);
const conflict=message=>authHttpError(409,'PS015',message);

// Only called after the existing receiver verifies the raw Stripe signature,
// sandbox mode and its configured direct/Connect account scope. No provider API
// request is made and neither live payments nor entitlements are changed.
export async function recordTestRefund(pool,event,account,digest){
 const o=event.data?.object;
 // Stripe's Refund object does not require a livemode property. The signed
 // Event's mode is authoritative; a contradictory explicit property is refused.
 if(event.livemode!==false||o?.livemode===true||!['refund.created','refund.updated'].includes(event.type)||
  o?.object!=='refund'||o.status!=='succeeded'||o.currency!=='jpy'||!Number.isSafeInteger(o.amount)||o.amount<=0||
  !/^re_[A-Za-z0-9]+$/.test(o.id??'')||!/^pi_[A-Za-z0-9]+$/.test(o.payment_intent??'')||
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
   const total=(await c.query('SELECT COALESCE(SUM(amount_jpy),0)::text n FROM commercial_test_refunds WHERE account_id=$1 AND provider_object_id=$2',[account,o.payment_intent])).rows[0].n;
   if(BigInt(total)+BigInt(o.amount)>BigInt(payment.amount_jpy))throw conflict('Refund total exceeds the recorded test payment');
   await c.query('INSERT INTO commercial_test_refunds(id,account_id,refund_id,payment_event_id,contract_id,provider_object_id,amount_jpy,refund_created,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[randomUUID(),account,o.id,payment.event_id,binding.contract_id,o.payment_intent,o.amount,o.created,'provider_test_sandbox']);
  }
  if(!oldEvent)await c.query('INSERT INTO commercial_test_refund_events(account_id,event_id,refund_id,contract_id,event_hash,provider_created) VALUES($1,$2,$3,$4,$5,$6)',[account,event.id,o.id,binding.contract_id,digest,event.created]);
  await c.query('COMMIT');
  return {received:true,duplicate:!!oldEvent,duplicateRefund:!!old,liveRefundExecuted:false,entitlementsGranted:false,meaning:'verified_test_refund_recorded_not_live_payment_or_entitlement'};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});if(e?.code==='23505')throw conflict('Refund identity belongs to another binding');throw e;}finally{c.release();}
}

export function registerTestRefundRoutes(router,persist){
 router.get('/:id/test-refunds',async(req,res)=>{try{
  if(!uuid(req.params.id))throw authHttpError(404,'PS022','Contract not found');
  if(req.query.after!==undefined&&!uuid(req.query.after))throw authHttpError(400,'PS018','Invalid refund cursor');
  const rows=await persist(req,async c=>{
   if(!(await c.query('SELECT id FROM commercial_contracts WHERE id=$1 AND user_id=$2 FOR UPDATE',[req.params.id,req.auth.userId])).rowCount)throw authHttpError(404,'PS022','Contract not found');
   return (await c.query('SELECT id,refund_id,provider_object_id,amount_jpy::text,refund_created::text,received_at,evidence FROM commercial_test_refunds WHERE contract_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 101',[req.params.id,req.query.after??null])).rows;
  });const page=rows.slice(0,100);
  res.json({refunds:page.map(r=>({id:r.id,refundId:r.refund_id,paymentIntentId:r.provider_object_id,amountJpy:Number(r.amount_jpy),providerCreated:Number(r.refund_created),receivedAt:r.received_at,evidence:r.evidence})),nextCursor:rows.length>100?page.at(-1).id:null,liveRefundExecuted:false,entitlementsGranted:false});
 }catch(e){sendAuthError(res,e);}});
}
