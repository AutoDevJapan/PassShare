import {randomUUID,createHash} from 'node:crypto';
import {nativeMutation} from './lib/native-mutations.js';
import {authHttpError,sendAuthError} from './auth/errors.js';
import {requireCsrf} from './auth/csrf.js';
import {jstDate} from './commercial-entitlement.js';
import {applySchemaWithAdvisoryLock} from './db/migration-lock.js';

export const SEAT_SCHEMA=`ALTER TABLE commercial_contracts ADD COLUMN IF NOT EXISTS current_plan JSONB;
ALTER TABLE commercial_contracts ADD COLUMN IF NOT EXISTS seat_revision INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS commercial_seat_changes (
 id UUID PRIMARY KEY, contract_id UUID NOT NULL REFERENCES commercial_contracts(id) ON DELETE CASCADE,
 request_id UUID NOT NULL, base_revision INTEGER NOT NULL, quote JSONB NOT NULL, quote_hash TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'quoted' CHECK(state IN ('quoted','accepted_unpaid','applied','refund_review')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),accepted_at TIMESTAMPTZ,applied_at TIMESTAMPTZ,payment_received_at TIMESTAMPTZ,
 account_id TEXT,event_id TEXT,provider_object_id TEXT,event_hash TEXT,paid_amount_jpy BIGINT CHECK(paid_amount_jpy>0),
 UNIQUE(contract_id,request_id),UNIQUE(account_id,event_id),UNIQUE(account_id,provider_object_id));
ALTER TABLE commercial_seat_changes ADD COLUMN IF NOT EXISTS payment_received_at TIMESTAMPTZ;`;
export const migrateCommercialSeats=p=>applySchemaWithAdvisoryLock(p,4820131,SEAT_SCHEMA);
const uuid=s=>typeof s==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(s);
const exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));
export const planInput=p=>p.type==='personal'?{type:p.type,users:p.users}:{type:p.type,administrators:p.administrators,members:p.members};
const rowOut=r=>({id:r.id,state:r.state,quote:r.quote,quoteHash:r.quote_hash,baseRevision:r.base_revision,acceptedAt:r.accepted_at,appliedAt:r.applied_at,paymentRequired:['quoted','accepted_unpaid'].includes(r.state),refundReviewRequired:r.state==='refund_review',boxMembershipOrKeysGranted:false});
async function contract(c,id,user){
 const r=(await c.query('SELECT * FROM commercial_contracts WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,user])).rows[0];
 if(!r)throw authHttpError(404,'PS022','Contract not found');return r;
}
async function currentPeriod(c,r){
 const today=jstDate(Date.now());
 const p=(await c.query("SELECT cycle,period_start::text start,period_end::text finish FROM commercial_live_periods WHERE contract_id=$1 AND disposition='effective' AND period_start<=$2::date AND period_end>$2::date ORDER BY cycle LIMIT 1",[r.id,today])).rows[0];
 if(!p||r.cancellation_requested_at||(await c.query('SELECT 1 FROM commercial_live_contracts WHERE contract_id=$1 AND cancel_after_cycle IS NOT NULL',[r.id])).rowCount)throw authHttpError(409,'PS015','An active non-canceling paid period is required');
 return {p,today};
}
function stillCurrent(r,q,p,today){
 if(q.base_revision!==r.seat_revision||q.quote.changeDate!==today||q.quote.periodStart!==p.start||q.quote.periodEnd!==p.finish)throw authHttpError(409,'PS015','Seat quote expired or plan changed');
}
export function registerSeatRoutes(router,persist){
 router.post('/:id/seat-quotes',requireCsrf,async(req,res)=>{try{
  if(!uuid(req.params.id)||!exact(req.body,['requestId','requestedPlan','roundingPolicy'])||!uuid(req.body.requestId)||!['ceil-jpy','floor-jpy','none'].includes(req.body.roundingPolicy))throw authHttpError(400,'PS018','Invalid seat quote');
  const out=await persist(req,async c=>{
   const r=await contract(c,req.params.id,req.auth.userId),{p,today}=await currentPeriod(c,r);
   const currentPlan=planInput(r.current_plan??r.quote.plan);
   // Only the authenticated contract owner supplies the billing request. These assertions do not grant Box access.
   const result=await nativeMutation({command:'commercial-lifecycle-decision',operation:'seat-increase-quote',currency:'JPY',currentPlan,requestedPlan:req.body.requestedPlan,periodStart:p.start,periodEnd:p.finish,changeDate:today,roundingPolicy:req.body.roundingPolicy,actor:{sessionValid:true,accountRemoved:false,identityConfirmed:true,billingAdministrator:true,membershipActive:false,hasExportScope:false},acceptedQuote:null});
   result.quote.billingCycle=p.cycle;
   const hash=createHash('sha256').update(JSON.stringify(result.quote)).digest('hex');
   const q=(await c.query("INSERT INTO commercial_seat_changes(id,contract_id,request_id,base_revision,quote,quote_hash) VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(contract_id,request_id) DO UPDATE SET request_id=EXCLUDED.request_id RETURNING *",[randomUUID(),r.id,req.body.requestId,r.seat_revision,JSON.stringify(result.quote),hash])).rows[0];
   if(q.quote_hash!==hash)throw authHttpError(409,'PS015','Request id reused with a different quote');return rowOut(q);
  });res.status(201).json(out);
 }catch(e){sendAuthError(res,e);}});
 router.post('/:id/seat-quotes/:change/accept',requireCsrf,async(req,res)=>{try{
  if(!uuid(req.params.id)||!uuid(req.params.change)||!exact(req.body,['quoteHash'])||!/^[a-f0-9]{64}$/.test(req.body.quoteHash??''))throw authHttpError(400,'PS018','Invalid seat acceptance');
  const out=await persist(req,async c=>{
   const r=await contract(c,req.params.id,req.auth.userId);
   const q=(await c.query('SELECT * FROM commercial_seat_changes WHERE id=$1 AND contract_id=$2 FOR UPDATE',[req.params.change,r.id])).rows[0];
   if(!q)throw authHttpError(404,'PS022','Seat quote not found');
   if(q.quote_hash!==req.body.quoteHash)throw authHttpError(409,'PS015','Seat quote changed');
   if(q.state==='applied')return rowOut(q);
   if(q.state==='refund_review')throw authHttpError(409,'PS015','Payment is pending refund review');
   const {p,today}=await currentPeriod(c,r);stillCurrent(r,q,p,today);
   return rowOut((await c.query("UPDATE commercial_seat_changes SET state='accepted_unpaid',accepted_at=COALESCE(accepted_at,clock_timestamp()) WHERE id=$1 RETURNING *",[q.id])).rows[0]);
  });res.json(out);
 }catch(e){sendAuthError(res,e);}});
 router.get('/:id/seat-quotes/:change',async(req,res)=>{try{
  if(!uuid(req.params.id)||!uuid(req.params.change))throw authHttpError(404,'PS022','Seat quote not found');
  const out=await persist(req,async c=>{const r=await contract(c,req.params.id,req.auth.userId);const q=(await c.query('SELECT * FROM commercial_seat_changes WHERE id=$1 AND contract_id=$2',[req.params.change,r.id])).rows[0];if(!q)throw authHttpError(404,'PS022','Seat quote not found');return rowOut(q);});
  res.json(out);
 }catch(e){sendAuthError(res,e);}});
}
// Called only after live-mode signature, account, JPY, event/PI checks. The transaction and identity lock order are unchanged.
export async function applySeatPayment(c,event,account,digest){
 const o=event.data.object,m=o.metadata;
 if(!uuid(m.seatChangeId))throw authHttpError(400,'PS018','Invalid seat change binding');
 if(!(await c.query('SELECT id FROM users WHERE id=$1 FOR SHARE',[m.ownerId])).rowCount)throw authHttpError(409,'PS015','Owner unavailable');
 const r=await contract(c,m.contractId,m.ownerId);
 const q=(await c.query('SELECT * FROM commercial_seat_changes WHERE id=$1 AND contract_id=$2 FOR UPDATE',[m.seatChangeId,r.id])).rows[0];
 if(!q||q.quote_hash!==m.quoteHash)throw authHttpError(409,'PS015','Seat quote binding changed');
 if(q.state==='applied'||q.state==='refund_review'){
  if(q.account_id!==account||q.event_id!==event.id||q.provider_object_id!==o.id||q.event_hash!==digest)throw authHttpError(409,'PS015','Payment already applied with a different binding');
  return {received:true,duplicate:true,seatChangeApplied:q.state==='applied',refundReviewRequired:q.state==='refund_review'};
 }
 const fraction=q.quote.proration;
 const amount=q.quote.proposedRoundedJpy??(fraction.exactNumeratorJpy%fraction.exactDenominator===0?fraction.exactNumeratorJpy/fraction.exactDenominator:null);
 if(q.state!=='accepted_unpaid'||!Number.isSafeInteger(amount)||amount<=0||amount!==o.amount_received)throw authHttpError(409,'PS015','Accepted seat amount does not match payment');
 if(Number(m.cycle)!==q.quote.billingCycle)throw authHttpError(409,'PS015','Seat payment cycle binding changed');
 if((await c.query('SELECT 1 FROM commercial_live_periods WHERE account_id=$1 AND (event_id=$2 OR provider_object_id=$3)',[account,event.id,o.id])).rowCount)throw authHttpError(409,'PS015','Payment is already bound to a billing period');
 let stale=false;
 try {const {p,today}=await currentPeriod(c,r);stillCurrent(r,q,p,today);if(Number(m.cycle)!==p.cycle||jstDate(Date.now())!==today)stale=true;}
 catch(e){if(e?.status===409||e?.statusCode===409)stale=true;else throw e;}
 if(stale){
  await c.query("UPDATE commercial_seat_changes SET state='refund_review',payment_received_at=clock_timestamp(),account_id=$2,event_id=$3,provider_object_id=$4,event_hash=$5,paid_amount_jpy=$6 WHERE id=$1",[q.id,account,event.id,o.id,digest,o.amount_received]);
  return {received:true,duplicate:false,seatChangeApplied:false,refundReviewRequired:true};
 }
 await c.query('UPDATE commercial_contracts SET current_plan=$2::jsonb,seat_revision=seat_revision+1 WHERE id=$1',[r.id,JSON.stringify(planInput(q.quote.requestedPlan))]);
 await c.query("UPDATE commercial_seat_changes SET state='applied',applied_at=clock_timestamp(),payment_received_at=clock_timestamp(),account_id=$2,event_id=$3,provider_object_id=$4,event_hash=$5,paid_amount_jpy=$6 WHERE id=$1",[q.id,account,event.id,o.id,digest,o.amount_received]);
 return {received:true,duplicate:false,seatChangeApplied:true,boxMembershipOrKeysGranted:false};
}
