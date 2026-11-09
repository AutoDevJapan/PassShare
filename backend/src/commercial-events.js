import express from 'express';
import Stripe from 'stripe';
import {createHash} from 'node:crypto';
import {authHttpError,sendAuthError} from './auth/errors.js';
import {applySchemaWithAdvisoryLock} from './db/migration-lock.js';
import {rateLimit} from 'express-rate-limit';

export const PAYMENT_EVENT_SCHEMA=`CREATE TABLE IF NOT EXISTS commercial_payment_events (
 account_id TEXT NOT NULL, event_id TEXT NOT NULL, contract_id UUID NOT NULL REFERENCES commercial_contracts(id) ON DELETE CASCADE,
 event_hash TEXT NOT NULL, event_type TEXT NOT NULL, provider_object_id TEXT NOT NULL,
 amount_jpy BIGINT NOT NULL, provider_created BIGINT NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(account_id,event_id));`;
export const migrateCommercialEvents=pool=>applySchemaWithAdvisoryLock(pool,4820129,PAYMENT_EVENT_SCHEMA);

// No API request is made. The official SDK verifies the raw snapshot signature.
export function commercialEventHandler({pool,secret=process.env.PASSSHARE_STRIPE_TEST_WEBHOOK_SECRET,account=process.env.PASSSHARE_STRIPE_TEST_ACCOUNT}){
 const router=express.Router();
 router.use(rateLimit({windowMs:60000,limit:120,standardHeaders:'draft-6',legacyHeaders:false}));
 router.post('/',express.raw({type:'application/json',limit:'256kb'}),async(req,res)=>{
  try{
   if(!pool||!secret||!/^acct_[A-Za-z0-9]+$/.test(account??''))throw authHttpError(503,'PS019','Payment event intake unavailable');
   let event;try{event=Stripe.webhooks.constructEvent(req.body,req.headers['stripe-signature'],secret,300);}catch{throw authHttpError(400,'PS018','Invalid payment event signature');}
   const o=event.data?.object,m=o?.metadata;
   if(event.livemode!==false||o?.livemode!==false||event.account!==account||event.type!=='payment_intent.succeeded'||o.object!=='payment_intent'||o.status!=='succeeded'||o.currency!=='jpy'||!Number.isSafeInteger(o.amount_received)||o.amount_received<=0||o.amount!==o.amount_received||!/^evt_[A-Za-z0-9]+$/.test(event.id??'')||!/^pi_[A-Za-z0-9]+$/.test(o.id??'')||!Number.isSafeInteger(event.created))throw authHttpError(400,'PS018','Unsupported payment event scope');
   const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
   if(!uuid(m?.contractId)||!uuid(m?.ownerId)||!/^[a-f0-9]{64}$/.test(m?.quoteHash??''))throw authHttpError(400,'PS018','Invalid contract event binding');
   const digest=createHash('sha256').update(req.body).digest('hex');const c=await pool.connect();
   try{
    await c.query('BEGIN');
    // Follow retirement's identity-before-resource lock order.
    const user=await c.query('SELECT id FROM users WHERE id=$1 FOR SHARE',[m.ownerId]);
    if(!user.rowCount)throw authHttpError(409,'PS015','Contract binding unavailable');
    const r=(await c.query('SELECT * FROM commercial_contracts WHERE id=$1 AND user_id=$2 FOR UPDATE',[m.contractId,m.ownerId])).rows[0];
    if(!r||r.state!=='accepted_unpaid'||r.quote_hash!==m.quoteHash||r.quote.currency!=='JPY'||r.quote.monthlyTotalJpy!==o.amount_received||r.quote.oneTimeTotalJpy!==0)throw authHttpError(409,'PS015','Payment does not match accepted quote');
    const old=(await c.query('SELECT event_hash FROM commercial_payment_events WHERE account_id=$1 AND event_id=$2',[account,event.id])).rows[0];
    if(old&&old.event_hash!==digest)throw authHttpError(409,'PS015','Payment event changed');
    if(!old)await c.query('INSERT INTO commercial_payment_events(account_id,event_id,contract_id,event_hash,event_type,provider_object_id,amount_jpy,provider_created) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[account,event.id,r.id,digest,event.type,o.id,o.amount_received,event.created]);
    await c.query('COMMIT');res.json({received:true,duplicate:!!old,meaning:'signed_test_payment_recorded_not_live_entitlement'});
   }catch(e){await c.query('ROLLBACK').catch(()=>{});if(e?.code==='23505')throw authHttpError(409,'PS015','Payment event belongs to another binding');throw e;}finally{c.release();}
  }catch(e){sendAuthError(res,e);}
 });return router;
}
