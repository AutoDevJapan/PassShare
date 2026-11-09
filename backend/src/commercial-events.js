import express from 'express';
import Stripe from 'stripe';
import {createHash} from 'node:crypto';
import {authHttpError,sendAuthError} from './auth/errors.js';
import {applySchemaWithAdvisoryLock} from './db/migration-lock.js';
import {rateLimit} from 'express-rate-limit';
import {nativeMutation} from './lib/native-mutations.js';
import {lockTestPayment,recordTestRefund} from './commercial-test-refunds.js';

export const PAYMENT_EVENT_SCHEMA=`CREATE TABLE IF NOT EXISTS commercial_payment_events (
 account_id TEXT NOT NULL, event_id TEXT NOT NULL, contract_id UUID NOT NULL REFERENCES commercial_contracts(id) ON DELETE CASCADE,
 event_hash TEXT NOT NULL, event_type TEXT NOT NULL, provider_object_id TEXT NOT NULL,
 amount_jpy BIGINT NOT NULL, provider_created BIGINT NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(account_id,event_id));
CREATE UNIQUE INDEX IF NOT EXISTS commercial_payment_events_provider_object ON commercial_payment_events(account_id,provider_object_id);
CREATE TABLE IF NOT EXISTS commercial_paid_periods (
 account_id TEXT NOT NULL, event_id TEXT NOT NULL, contract_id UUID NOT NULL REFERENCES commercial_contracts(id) ON DELETE CASCADE,
 period_start DATE NOT NULL, period_end DATE NOT NULL CHECK(period_end>period_start), amount_jpy BIGINT NOT NULL CHECK(amount_jpy>0),
 evidence TEXT NOT NULL CHECK(evidence='provider_test_sandbox'), PRIMARY KEY(account_id,event_id),
 FOREIGN KEY(account_id,event_id) REFERENCES commercial_payment_events(account_id,event_id) ON DELETE CASCADE);`;
export const migrateCommercialEvents=pool=>applySchemaWithAdvisoryLock(pool,4820129,PAYMENT_EVENT_SCHEMA);

// No API request is made. The official SDK verifies the raw snapshot signature.
export function commercialEventHandler({pool,secret=process.env.PASSSHARE_STRIPE_TEST_WEBHOOK_SECRET,account=process.env.PASSSHARE_STRIPE_TEST_ACCOUNT,scope=process.env.PASSSHARE_STRIPE_TEST_ENDPOINT_SCOPE??'connect'}){
 const router=express.Router();
 router.use(rateLimit({windowMs:60000,limit:120,standardHeaders:'draft-6',legacyHeaders:false}));
 router.post('/',express.raw({type:'application/json',limit:'256kb'}),async(req,res)=>{
  try{
   if(!pool||!secret||!/^acct_[A-Za-z0-9]+$/.test(account??'')||!['direct','connect'].includes(scope))throw authHttpError(503,'PS019','Payment event intake unavailable');
   let event;try{event=Stripe.webhooks.constructEvent(req.body,req.headers['stripe-signature'],secret,300);}catch{throw authHttpError(400,'PS018','Invalid payment event signature');}
   const o=event.data?.object,m=o?.metadata;
   const accountMatches=scope==='direct'?event.account==null:event.account===account;
   if(event.livemode===false&&accountMatches&&['refund.created','refund.updated'].includes(event.type)){
    res.json(await recordTestRefund(pool,event,account,createHash('sha256').update(req.body).digest('hex')));return;
   }
   if(event.livemode!==false||o?.livemode!==false||!accountMatches||event.type!=='payment_intent.succeeded'||o.object!=='payment_intent'||o.status!=='succeeded'||o.currency!=='jpy'||!Number.isSafeInteger(o.amount_received)||o.amount_received<=0||o.amount!==o.amount_received||!/^evt_[A-Za-z0-9]+$/.test(event.id??'')||!/^pi_[A-Za-z0-9]+$/.test(o.id??'')||!Number.isSafeInteger(event.created))throw authHttpError(400,'PS018','Unsupported payment event scope');
   const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
   if(!uuid(m?.contractId)||!uuid(m?.ownerId)||!/^[a-f0-9]{64}$/.test(m?.quoteHash??''))throw authHttpError(400,'PS018','Invalid contract event binding');
   const digest=createHash('sha256').update(req.body).digest('hex');const c=await pool.connect();
   try{
    await c.query('BEGIN');
    await lockTestPayment(c,account,event.id,o.id);
    if((await c.query('SELECT 1 FROM commercial_test_refund_events WHERE account_id=$1 AND event_id=$2',[account,event.id])).rowCount)throw authHttpError(409,'PS015','Event identity belongs to a refund');
    // Follow retirement's identity-before-resource lock order.
    const user=await c.query('SELECT id FROM users WHERE id=$1 FOR SHARE',[m.ownerId]);
    if(!user.rowCount)throw authHttpError(409,'PS015','Contract binding unavailable');
    const r=(await c.query('SELECT * FROM commercial_contracts WHERE id=$1 AND user_id=$2 FOR UPDATE',[m.contractId,m.ownerId])).rows[0];
    if(!r||r.state!=='accepted_unpaid'||r.quote_hash!==m.quoteHash||r.quote.currency!=='JPY'||r.quote.monthlyTotalJpy!==o.amount_received||r.quote.oneTimeTotalJpy!==0)throw authHttpError(409,'PS015','Payment does not match accepted quote');
    const old=(await c.query('SELECT event_hash FROM commercial_payment_events WHERE account_id=$1 AND event_id=$2',[account,event.id])).rows[0];
    if(old&&old.event_hash!==digest)throw authHttpError(409,'PS015','Payment event changed');
    if(!old&&r.cancellation_requested_at)throw authHttpError(409,'PS015','Contract acceptance was withdrawn');
    if(!old)await c.query('INSERT INTO commercial_payment_events(account_id,event_id,contract_id,event_hash,event_type,provider_object_id,amount_jpy,provider_created) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[account,event.id,r.id,digest,event.type,o.id,o.amount_received,event.created]);
    if(!old){const start=new Date((event.created+32400)*1000).toISOString().slice(0,10);const prev=await nativeMutation({command:'commercial-lifecycle-decision',operation:'renewal-preview',contractStart:start,cycles:1});const end=prev.periods?.[0]?.renewalDate;if(!/^\d{4}-\d{2}-\d{2}$/.test(end??''))throw authHttpError(500,'PS019','Period derivation failed');await c.query('INSERT INTO commercial_paid_periods(account_id,event_id,contract_id,period_start,period_end,amount_jpy,evidence) VALUES($1,$2,$3,$4,$5,$6,$7)',[account,event.id,r.id,start,end,o.amount_received,'provider_test_sandbox']);}
    await c.query('COMMIT');res.json({received:true,duplicate:!!old,meaning:'signed_test_payment_recorded_not_live_entitlement'});
   }catch(e){await c.query('ROLLBACK').catch(()=>{});if(e?.code==='23505')throw authHttpError(409,'PS015','Payment event belongs to another binding');throw e;}finally{c.release();}
  }catch(e){sendAuthError(res,e);}
 });return router;
}

