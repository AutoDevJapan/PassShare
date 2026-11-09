import express from 'express';
import Stripe from 'stripe';
import {createHash} from 'node:crypto';
import {rateLimit} from 'express-rate-limit';
import {authHttpError,sendAuthError} from './auth/errors.js';
import {applySchemaWithAdvisoryLock} from './db/migration-lock.js';
import {nativeMutation} from './lib/native-mutations.js';
import {entitlementState,jstDate} from './commercial-entitlement.js';
import {applySeatPayment,planInput} from './commercial-seats.js';

// Verified live payment evidence. This is a separate responsibility from the
// sandbox ledger: its own tables, its own receiver and its own secret. The
// receiver stays closed (503) unless an operator explicitly enables it.
export const LIVE_SCHEMA=`CREATE TABLE IF NOT EXISTS commercial_live_contracts (
 contract_id UUID PRIMARY KEY REFERENCES commercial_contracts(id) ON DELETE CASCADE,
 contract_start DATE NOT NULL, cancel_after_cycle INTEGER CHECK(cancel_after_cycle>=1),
 cancel_requested_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS commercial_live_periods (
 account_id TEXT NOT NULL, event_id TEXT NOT NULL,
 contract_id UUID NOT NULL REFERENCES commercial_live_contracts(contract_id) ON DELETE CASCADE,
 cycle INTEGER NOT NULL CHECK(cycle BETWEEN 1 AND 120), period_start DATE NOT NULL,
 period_end DATE NOT NULL CHECK(period_end>period_start), amount_jpy BIGINT NOT NULL CHECK(amount_jpy>0),
 provider_object_id TEXT NOT NULL, event_hash TEXT NOT NULL,
 evidence TEXT NOT NULL CHECK(evidence='provider_live'), received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 disposition TEXT NOT NULL DEFAULT 'effective' CHECK(disposition IN ('effective','refund_review')), PRIMARY KEY(account_id,event_id), UNIQUE(contract_id,cycle), UNIQUE(account_id,provider_object_id));
ALTER TABLE commercial_live_periods ADD COLUMN IF NOT EXISTS disposition TEXT NOT NULL DEFAULT 'effective' CHECK(disposition IN ('effective','refund_review'));
ALTER TABLE commercial_live_periods ADD COLUMN IF NOT EXISTS provider_event_created BIGINT CHECK(provider_event_created>0);
ALTER TABLE commercial_live_periods ADD COLUMN IF NOT EXISTS disposition_reason TEXT NOT NULL DEFAULT 'legacy_unclassified';
ALTER TABLE commercial_live_periods ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ;`;
export const migrateCommercialLive=pool=>applySchemaWithAdvisoryLock(pool,4820130,LIVE_SCHEMA);
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);

// Stripe's signed success-event timestamp is provider evidence, not arrival
// time or the PaymentIntent's earlier creation time. Second-level precision
// cannot establish ordering within the cancellation second.
export function classifyPayment(lc,cycle,providerSecond,precedingEffective=true){
 if(lc.cancel_after_cycle==null||cycle<=lc.cancel_after_cycle)return {disposition:'effective',reason:'paid_recorded'};
 if(!lc.cancel_requested_at)return {disposition:'refund_review',reason:'cancellation_time_unavailable'};
 const cancelSecond=Math.floor(new Date(lc.cancel_requested_at).getTime()/1000);
 if(providerSecond<cancelSecond&&precedingEffective)return {disposition:'effective',reason:'paid_before_cancellation'};
 return {disposition:'refund_review',reason:providerSecond===cancelSecond?'payment_time_boundary_review':providerSecond<cancelSecond?'payment_sequence_review':'payment_after_cancellation'};
}

// The contract anchor (first paid day) and the cycle number are the source of truth.
// Arrival time and event order never move a period.
export async function cyclePeriod(contractStart,cycle){
 const prev=await nativeMutation({command:'commercial-lifecycle-decision',operation:'renewal-preview',contractStart,cycles:cycle});
 const p=prev.periods?.[cycle-1];
 if(!/^\d{4}-\d{2}-\d{2}$/.test(p?.periodStart??'')||!/^\d{4}-\d{2}-\d{2}$/.test(p?.renewalDate??''))throw authHttpError(500,'PS019','Period derivation failed');
 return {periodStart:p.periodStart,periodEnd:p.renewalDate};
}

export async function loadEntitlement(db,contractId,nowMs){
 const live=(await db.query("SELECT p.period_start::text AS \"periodStart\",p.period_end::text AS \"periodEnd\",p.evidence FROM commercial_live_periods p WHERE p.contract_id=$1 AND p.disposition='effective'",[contractId])).rows;
 const sandbox=(await db.query("SELECT period_start::text AS \"periodStart\",period_end::text AS \"periodEnd\",evidence FROM commercial_paid_periods WHERE contract_id=$1",[contractId])).rows;
 const c=(await db.query('SELECT cancel_after_cycle,contract_start::text AS start_text FROM commercial_live_contracts WHERE contract_id=$1',[contractId])).rows[0];
 // contractStart is the first paid day (JST); renewals fall on the same day each month.
 return {...entitlementState({periods:[...live,...sandbox],cancelAtPeriodEnd:c?.cancel_after_cycle!=null,nowMs}),contractStart:c?.start_text??null};
}

export function liveEventHandler({pool,secret=process.env.PASSSHARE_STRIPE_LIVE_WEBHOOK_SECRET,account=process.env.PASSSHARE_STRIPE_LIVE_ACCOUNT,enabled=process.env.PASSSHARE_COMMERCIAL_LIVE_ENABLED==='true'}){
 const router=express.Router();
 router.use(rateLimit({windowMs:60000,limit:120,standardHeaders:'draft-6',legacyHeaders:false}));
 router.post('/',express.raw({type:'application/json',limit:'256kb'}),async(req,res)=>{
  try{
   if(!pool||!enabled||!secret||!/^acct_[A-Za-z0-9]+$/.test(account??''))throw authHttpError(503,'PS019','Payment event intake unavailable');
   let event;try{event=Stripe.webhooks.constructEvent(req.body,req.headers['stripe-signature'],secret,300);}catch{throw authHttpError(400,'PS018','Invalid payment event signature');}
   const o=event.data?.object,m=o?.metadata,cycle=Number(m?.cycle);
   if(event.livemode!==true||o?.livemode!==true||event.account!==account||event.type!=='payment_intent.succeeded'||o.object!=='payment_intent'||o.status!=='succeeded'||o.currency!=='jpy'||!Number.isSafeInteger(o.amount_received)||o.amount_received<=0||o.amount!==o.amount_received||!/^evt_[A-Za-z0-9]+$/.test(event.id??'')||!/^pi_[A-Za-z0-9]+$/.test(o.id??'')||(!Number.isSafeInteger(event.created)||event.created<=0))throw authHttpError(400,'PS018','Unsupported payment event scope');
   if(!uuid(m?.contractId)||!uuid(m?.ownerId)||!/^[a-f0-9]{64}$/.test(m?.quoteHash??'')||!/^[1-9][0-9]{0,2}$/.test(m?.cycle??'')||cycle>120)throw authHttpError(400,'PS018','Invalid contract event binding');
   const digest=createHash('sha256').update(req.body).digest('hex');const c=await pool.connect();
   try{
    await c.query('BEGIN');
    // Serialize event and PaymentIntent identities across period and seat ledgers.
    for(const key of [account+':event:'+event.id,account+':intent:'+o.id].sort())await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,4820132))',[key]);
    if(m.seatChangeId){
     const result=await applySeatPayment(c,event,account,digest);
     await c.query('COMMIT');res.json(result);return;
    }
    if((await c.query('SELECT 1 FROM commercial_seat_changes WHERE account_id=$1 AND (event_id=$2 OR provider_object_id=$3)',[account,event.id,o.id])).rowCount)throw authHttpError(409,'PS015','Payment is already bound to a seat change');
    const user=await c.query('SELECT id FROM users WHERE id=$1 FOR SHARE',[m.ownerId]);
    if(!user.rowCount)throw authHttpError(409,'PS015','Contract binding unavailable');
    const r=(await c.query('SELECT * FROM commercial_contracts WHERE id=$1 AND user_id=$2 FOR UPDATE',[m.contractId,m.ownerId])).rows[0];
    if(!r||r.state!=='accepted_unpaid'||r.quote_hash!==m.quoteHash||r.quote.currency!=='JPY'||r.quote.oneTimeTotalJpy!==0)throw authHttpError(409,'PS015','Payment does not match accepted quote');
    const old=(await c.query('SELECT event_hash,disposition,contract_id,cycle FROM commercial_live_periods WHERE account_id=$1 AND event_id=$2',[account,event.id])).rows[0];
    if(old&&old.event_hash!==digest)throw authHttpError(409,'PS015','Payment event changed');
    if(old&&(old.contract_id!==r.id||old.cycle!==cycle))throw authHttpError(409,'PS015','Payment binding changed');
    let lc=(await c.query('SELECT *,contract_start::text AS start_text FROM commercial_live_contracts WHERE contract_id=$1 FOR UPDATE',[r.id])).rows[0];
    const precedingEffective=cycle===1||(await c.query("SELECT 1 FROM commercial_live_periods WHERE contract_id=$1 AND cycle=$2 AND disposition='effective'",[r.id,cycle-1])).rowCount>0;
    if(old?.disposition==='refund_review'&&lc?.cancel_requested_at&&event.created<Math.floor(new Date(lc.cancel_requested_at).getTime()/1000)&&precedingEffective){
     await c.query("UPDATE commercial_live_periods SET disposition='effective',disposition_reason='paid_before_cancellation',provider_event_created=$3,reconciled_at=clock_timestamp() WHERE account_id=$1 AND event_id=$2",[account,event.id,event.created]);
     await c.query('UPDATE commercial_live_contracts SET cancel_after_cycle=GREATEST(cancel_after_cycle,$2) WHERE contract_id=$1',[r.id,cycle]);
    }
    if(!old){
     let monthly=r.quote.monthlyTotalJpy;
     if(r.current_plan)monthly=(await nativeMutation({command:'commercial-quote',currency:'JPY',plan:planInput(r.current_plan),setup:{installationCompanies:0,supportHours:0,maintenanceMonthlyJpy:r.quote.monthlyMaintenanceJpy||null}})).monthlyTotalJpy;
     if(monthly!==o.amount_received)throw authHttpError(409,'PS015','Payment amount does not match current plan');
     if(r.cancellation_requested_at)throw authHttpError(409,'PS015','Contract acceptance was withdrawn');
     if(!lc){
      if(cycle!==1)throw authHttpError(409,'PS015','Earlier payment cycle is not recorded yet');
      lc=(await c.query('INSERT INTO commercial_live_contracts(contract_id,contract_start) VALUES($1,$2) RETURNING *,contract_start::text AS start_text',[r.id,jstDate(event.created*1000)])).rows[0];
     }else{
      if(cycle>1&&!(await c.query('SELECT 1 FROM commercial_live_periods WHERE contract_id=$1 AND cycle=$2',[r.id,cycle-1])).rowCount)throw authHttpError(409,'PS015','Earlier payment cycle is not recorded yet');
      // Preserve unexpected paid evidence for refund reconciliation without granting access.
     }
     const p=await cyclePeriod(lc.start_text,cycle);
     const classification=classifyPayment(lc,cycle,event.created,precedingEffective);
     await c.query("INSERT INTO commercial_live_periods(account_id,event_id,contract_id,cycle,period_start,period_end,amount_jpy,provider_object_id,event_hash,disposition,provider_event_created,disposition_reason,reconciled_at,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CASE WHEN $12='paid_before_cancellation' THEN clock_timestamp() ELSE NULL END,'provider_live')",[account,event.id,r.id,cycle,p.periodStart,p.periodEnd,o.amount_received,o.id,digest,classification.disposition,event.created,classification.reason]);
     if(classification.reason==='paid_before_cancellation')await c.query('UPDATE commercial_live_contracts SET cancel_after_cycle=GREATEST(cancel_after_cycle,$2) WHERE contract_id=$1',[r.id,cycle]);
    }
    await c.query('COMMIT');res.json({received:true,duplicate:!!old,meaning:'signed_live_payment_recorded'});
   }catch(e){await c.query('ROLLBACK').catch(()=>{});if(e?.code==='23505')throw authHttpError(409,'PS015','Payment event belongs to another binding');throw e;}finally{c.release();}
  }catch(e){sendAuthError(res,e);}
 });return router;
}
