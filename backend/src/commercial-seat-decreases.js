import {randomUUID,createHash} from 'node:crypto';
import {nativeMutation} from './lib/native-mutations.js';
import {authHttpError,sendAuthError} from './auth/errors.js';
import {requireCsrf} from './auth/csrf.js';
import {applySchemaWithAdvisoryLock} from './db/migration-lock.js';
import {planInput} from './commercial-seats.js';
import {currentBillingPlan} from './commercial-plan.js';

export const SEAT_DECREASE_SCHEMA=`CREATE TABLE IF NOT EXISTS commercial_seat_decreases (
 id UUID PRIMARY KEY,contract_id UUID NOT NULL REFERENCES commercial_contracts(id) ON DELETE CASCADE,
 request_id UUID NOT NULL,base_revision INTEGER NOT NULL,target_cycle INTEGER NOT NULL CHECK(target_cycle BETWEEN 2 AND 120),
 quote JSONB NOT NULL,quote_hash TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'quoted' CHECK(state IN ('quoted','scheduled','funded','historical_funded','settlement_review','applied','superseded')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),accepted_at TIMESTAMPTZ,applied_at TIMESTAMPTZ,
 UNIQUE(contract_id,request_id));
 CREATE UNIQUE INDEX IF NOT EXISTS commercial_seat_decreases_one_scheduled ON commercial_seat_decreases(contract_id) WHERE state='scheduled';
 ALTER TABLE commercial_seat_decreases DROP CONSTRAINT IF EXISTS commercial_seat_decreases_state_check;
 ALTER TABLE commercial_seat_decreases ADD CONSTRAINT commercial_seat_decreases_state_check CHECK(state IN ('quoted','scheduled','funded','historical_funded','settlement_review','applied','superseded'));
 ALTER TABLE commercial_seat_decreases ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;
 ALTER TABLE commercial_live_periods ADD COLUMN IF NOT EXISTS billing_plan JSONB;
 ALTER TABLE commercial_live_periods ADD COLUMN IF NOT EXISTS plan_adjustment_review BOOLEAN NOT NULL DEFAULT false;
 ALTER TABLE commercial_live_periods ADD COLUMN IF NOT EXISTS seat_decrease_id UUID;
 CREATE UNIQUE INDEX IF NOT EXISTS commercial_seat_decreases_scope ON commercial_seat_decreases(id,contract_id);
 DO $binding$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='commercial_live_period_decrease_scope' AND conrelid='commercial_live_periods'::regclass) THEN
 ALTER TABLE commercial_live_periods ADD CONSTRAINT commercial_live_period_decrease_scope FOREIGN KEY(seat_decrease_id,contract_id) REFERENCES commercial_seat_decreases(id,contract_id);
 END IF; END $binding$;
 CREATE TABLE IF NOT EXISTS commercial_plan_payment_exceptions (
 account_id TEXT NOT NULL,event_id TEXT NOT NULL,contract_id UUID NOT NULL REFERENCES commercial_contracts(id) ON DELETE CASCADE,
 seat_decrease_id UUID NOT NULL,cycle INTEGER NOT NULL CHECK(cycle BETWEEN 1 AND 120),
 amount_jpy BIGINT NOT NULL CHECK(amount_jpy>0),provider_object_id TEXT NOT NULL,event_hash TEXT NOT NULL,reason TEXT NOT NULL,
 received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(account_id,event_id),UNIQUE(account_id,provider_object_id),
 FOREIGN KEY(seat_decrease_id,contract_id) REFERENCES commercial_seat_decreases(id,contract_id) ON DELETE CASCADE);`;
export const migrateSeatDecreases=p=>applySchemaWithAdvisoryLock(p,4820133,SEAT_DECREASE_SCHEMA);
const uuid=s=>typeof s==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(s);
const exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));
const out=r=>({id:r.id,state:r.state,quote:r.quote,quoteHash:r.quote_hash,baseRevision:r.base_revision,targetCycle:r.target_cycle,acceptedAt:r.accepted_at,schedulePersisted:['scheduled','funded','applied'].includes(r.state),paymentRecorded:['funded','historical_funded','applied'].includes(r.state),billingAdjustmentReviewRequired:r.state==='settlement_review',activePlanChanged:false,paymentRequired:false,boxMembershipOrKeysGranted:false});
async function contract(c,id,user){
 const r=(await c.query('SELECT * FROM commercial_contracts WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,user])).rows[0];
 if(!r)throw authHttpError(404,'PS022','Contract not found');
 r.current_plan=await currentBillingPlan(c,r);
 return r;
}
async function active(c,r){
 const p=(await c.query(`SELECT p.cycle,p.period_end::text AS finish FROM commercial_live_periods p
 JOIN commercial_live_contracts l ON l.contract_id=p.contract_id
 WHERE p.contract_id=$1 AND p.disposition='effective' AND l.cancel_after_cycle IS NULL
 AND p.period_start<=(clock_timestamp() AT TIME ZONE 'Asia/Tokyo')::date
 AND p.period_end>(clock_timestamp() AT TIME ZONE 'Asia/Tokyo')::date ORDER BY p.cycle LIMIT 1`,[r.id])).rows[0];
 if(!p||r.cancellation_requested_at||p.cycle>=120)throw authHttpError(409,'PS015','An active non-canceling paid period is required');
 return p;
}
async function samePeriod(c,r,p){
 const now=await active(c,r);
 if(now.cycle!==p.cycle||now.finish!==p.finish)throw authHttpError(409,'PS015','Paid period changed while preparing the decrease');
}
async function unpaidTarget(c,r,cycle){
 if((await c.query("SELECT 1 FROM commercial_live_periods WHERE contract_id=$1 AND cycle=$2 AND disposition='effective'",[r.id,cycle])).rowCount)throw authHttpError(409,'PS015','The target period is already funded; a billing adjustment is required');
}
export function registerSeatDecreaseRoutes(router,persist){
 router.post('/:id/seat-decrease-quotes',requireCsrf,async(req,res)=>{try{
  if(!uuid(req.params.id)||!exact(req.body,['requestId','requestedPlan'])||!uuid(req.body.requestId))throw authHttpError(400,'PS018','Invalid seat decrease quote');
  const result=await persist(req,async c=>{
   const r=await contract(c,req.params.id,req.auth.userId),p=await active(c,r);
   const proposal=await nativeMutation({command:'commercial-lifecycle-decision',operation:'seat-decrease',currency:'JPY',currentPlan:planInput(r.current_plan??r.quote.plan),requestedPlan:req.body.requestedPlan,currentPeriodEnd:p.finish,actor:{sessionValid:true,accountRemoved:false,identityConfirmed:true,billingAdministrator:true,membershipActive:false,hasExportScope:false}});
   const renewalQuote=await nativeMutation({command:'commercial-quote',currency:'JPY',plan:planInput(proposal.requestedPlan),setup:{installationCompanies:0,supportHours:0,maintenanceMonthlyJpy:r.quote.monthlyMaintenanceJpy||null}});
   const quote={...proposal,contractId:r.id,contractQuoteHash:r.quote_hash,targetCycle:p.cycle+1,renewalQuote};
   const hash=createHash('sha256').update(JSON.stringify(quote)).digest('hex');
   const old=(await c.query('SELECT * FROM commercial_seat_decreases WHERE contract_id=$1 AND request_id=$2',[r.id,req.body.requestId])).rows[0];
   if(old){if(old.quote_hash!==hash)throw authHttpError(409,'PS015','Request id reused with a different decrease');await samePeriod(c,r,p);return out(old);}
   await unpaidTarget(c,r,p.cycle+1);
   const saved=(await c.query('INSERT INTO commercial_seat_decreases(id,contract_id,request_id,base_revision,target_cycle,quote,quote_hash) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING *',[randomUUID(),r.id,req.body.requestId,r.seat_revision,p.cycle+1,JSON.stringify(quote),hash])).rows[0];
   await samePeriod(c,r,p);return out(saved);
  });res.status(201).json(result);
 }catch(e){sendAuthError(res,e);}});
 router.post('/:id/seat-decrease-quotes/:change/accept',requireCsrf,async(req,res)=>{try{
  if(!uuid(req.params.id)||!uuid(req.params.change)||!exact(req.body,['quoteHash'])||!/^[a-f0-9]{64}$/.test(req.body.quoteHash??''))throw authHttpError(400,'PS018','Invalid seat decrease acceptance');
  const result=await persist(req,async c=>{
   const r=await contract(c,req.params.id,req.auth.userId);
   const q=(await c.query('SELECT * FROM commercial_seat_decreases WHERE id=$1 AND contract_id=$2 FOR UPDATE',[req.params.change,r.id])).rows[0];
   if(!q)throw authHttpError(404,'PS022','Seat decrease quote not found');
   if(q.quote_hash!==req.body.quoteHash)throw authHttpError(409,'PS015','Seat decrease quote changed');
   if(['scheduled','funded','applied'].includes(q.state))return out(q);
   if(q.state!=='quoted')throw authHttpError(409,'PS015','Seat decrease was superseded');
   const p=await active(c,r);
   await unpaidTarget(c,r,q.target_cycle);
   if(q.base_revision!==r.seat_revision||q.target_cycle!==p.cycle+1||q.quote.effectiveDate!==p.finish||q.quote.contractQuoteHash!==r.quote_hash||JSON.stringify(planInput(q.quote.currentPlan))!==JSON.stringify(planInput(r.current_plan??r.quote.plan)))throw authHttpError(409,'PS015','Seat decrease quote expired or plan changed');
   await c.query("UPDATE commercial_seat_decreases SET state='superseded',superseded_at=clock_timestamp() WHERE contract_id=$1 AND state='scheduled'",[r.id]);
   const saved=(await c.query("UPDATE commercial_seat_decreases SET state='scheduled',accepted_at=clock_timestamp() WHERE id=$1 RETURNING *",[q.id])).rows[0];
   await samePeriod(c,r,p);return out(saved);
  });res.json(result);
 }catch(e){sendAuthError(res,e);}});
 router.get('/:id/seat-decrease-quotes/:change',async(req,res)=>{try{
  if(!uuid(req.params.id)||!uuid(req.params.change))throw authHttpError(404,'PS022','Seat decrease quote not found');
  const result=await persist(req,async c=>{
   const r=await contract(c,req.params.id,req.auth.userId);
   const q=(await c.query('SELECT * FROM commercial_seat_decreases WHERE id=$1 AND contract_id=$2',[req.params.change,r.id])).rows[0];
   if(!q)throw authHttpError(404,'PS022','Seat decrease quote not found');
   return out(q);
  });res.json(result);
 }catch(e){sendAuthError(res,e);}});
}


// A signed amount tied to an accepted but no-longer-current decrease remains
// confidential financial evidence; it never turns into a paid service period.
export async function existingPlanException(c,event,account,digest){
 const row=(await c.query('SELECT * FROM commercial_plan_payment_exceptions WHERE account_id=$1 AND (event_id=$2 OR provider_object_id=$3)',[account,event.id,event.data.object.id])).rows[0];
 if(!row)return null;
 if(row.event_id!==event.id||row.provider_object_id!==event.data.object.id||row.event_hash!==digest||row.contract_id!==event.data.object.metadata.contractId)throw authHttpError(409,'PS015','Payment identity is already bound');
 return {received:true,duplicate:true,refundReviewRequired:true,seatDecreaseFunded:false};
}
export async function resolveDecreasePayment(c,r,period,cycle,event,account,digest){
 const m=event.data.object.metadata;
 if(!m.seatDecreaseId){
  const pending=(await c.query("SELECT id FROM commercial_seat_decreases WHERE contract_id=$1 AND target_cycle=$2 AND state='scheduled'",[r.id,cycle])).rows[0];
  // An exact original-plan payment remains paid evidence even when its
  // delivery follows a later decrease request. The new request needs explicit
  // financial adjustment, not loss of the customer's already-paid period.
  return pending?{adjustmentId:pending.id}:null;
 }
 if(!uuid(m.seatDecreaseId)||!/^[a-f0-9]{64}$/.test(m.seatDecreaseQuoteHash??''))throw authHttpError(400,'PS018','Invalid seat decrease payment binding');
 const q=(await c.query('SELECT * FROM commercial_seat_decreases WHERE id=$1 AND contract_id=$2 FOR UPDATE',[m.seatDecreaseId,r.id])).rows[0];
 if(!q||q.quote_hash!==m.seatDecreaseQuoteHash||!q.accepted_at)throw authHttpError(409,'PS015','Accepted seat decrease binding unavailable');
 const amount=q.quote.renewalQuote?.monthlyTotalJpy;
 if(!Number.isSafeInteger(amount)||amount<=0||event.data.object.amount_received!==amount)throw authHttpError(409,'PS015','Payment amount does not match the accepted decrease');
 const scopeMatches=q.target_cycle===cycle&&q.quote.effectiveDate===period.periodStart&&q.quote.contractQuoteHash===r.quote_hash;
 const invalidations=[];
 if(q.state==='superseded')invalidations.push(q.superseded_at);
 else if(q.state!=='scheduled')invalidations.push(null);
 if(q.base_revision!==r.seat_revision){const later=(await c.query("SELECT min(accepted_at) t FROM commercial_seat_changes WHERE contract_id=$1 AND state='applied' AND base_revision>=$2",[r.id,q.base_revision])).rows[0];invalidations.push(later?.t);}
 const historical=scopeMatches&&invalidations.length>0&&invalidations.every(t=>t&&event.created<Math.floor(new Date(t).getTime()/1000));
 const stale=!scopeMatches||invalidations.length>0&&!historical;
 if(stale){
  if((await c.query('SELECT 1 FROM commercial_live_periods WHERE account_id=$1 AND (event_id=$2 OR provider_object_id=$3)',[account,event.id,event.data.object.id])).rowCount)throw authHttpError(409,'PS015','Payment is already bound to a billing period');
  await c.query('INSERT INTO commercial_plan_payment_exceptions(account_id,event_id,contract_id,seat_decrease_id,cycle,amount_jpy,provider_object_id,event_hash,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[account,event.id,r.id,q.id,cycle,amount,event.data.object.id,digest,'seat_decrease_no_longer_applicable']);
  return {exception:true};
 }
 return {id:q.id,plan:q.quote.requestedPlan,amount,historical};
}
export async function fundDecrease(c,id){
 if(!id)return false;
 const q=(await c.query('SELECT d.*,c.seat_revision current_revision FROM commercial_seat_decreases d JOIN commercial_contracts c ON c.id=d.contract_id WHERE d.id=$1',[id])).rows[0];
 const historical=q&&(q.state==='superseded'||q.base_revision!==q.current_revision);
 if(q&&['scheduled','superseded'].includes(q.state))await c.query('UPDATE commercial_seat_decreases SET state=$2 WHERE id=$1',[id,historical?'historical_funded':'funded']);
 if(historical)await c.query("UPDATE commercial_seat_decreases SET state='settlement_review' WHERE contract_id=$1 AND target_cycle=$2 AND id<>$3 AND state='scheduled'",[q.contract_id,q.target_cycle,id]);
 return !!historical;
}
