import {randomUUID,createHash} from 'node:crypto';
import {nativeMutation} from './lib/native-mutations.js';
import {authHttpError,sendAuthError} from './auth/errors.js';
import {requireCsrf} from './auth/csrf.js';
import {applySchemaWithAdvisoryLock} from './db/migration-lock.js';
import {planInput} from './commercial-seats.js';

export const SEAT_DECREASE_SCHEMA=`CREATE TABLE IF NOT EXISTS commercial_seat_decreases (
 id UUID PRIMARY KEY,contract_id UUID NOT NULL REFERENCES commercial_contracts(id) ON DELETE CASCADE,
 request_id UUID NOT NULL,base_revision INTEGER NOT NULL,target_cycle INTEGER NOT NULL CHECK(target_cycle BETWEEN 2 AND 120),
 quote JSONB NOT NULL,quote_hash TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'quoted' CHECK(state IN ('quoted','scheduled','applied','superseded')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),accepted_at TIMESTAMPTZ,applied_at TIMESTAMPTZ,
 UNIQUE(contract_id,request_id));
 CREATE UNIQUE INDEX IF NOT EXISTS commercial_seat_decreases_one_scheduled ON commercial_seat_decreases(contract_id) WHERE state='scheduled';`;
export const migrateSeatDecreases=p=>applySchemaWithAdvisoryLock(p,4820133,SEAT_DECREASE_SCHEMA);
const uuid=s=>typeof s==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(s);
const exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));
const out=r=>({id:r.id,state:r.state,quote:r.quote,quoteHash:r.quote_hash,baseRevision:r.base_revision,targetCycle:r.target_cycle,acceptedAt:r.accepted_at,schedulePersisted:r.state==='scheduled',activePlanChanged:false,paymentRequired:false,boxMembershipOrKeysGranted:false});
async function contract(c,id,user){
 const r=(await c.query('SELECT * FROM commercial_contracts WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,user])).rows[0];
 if(!r)throw authHttpError(404,'PS022','Contract not found');
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
export function registerSeatDecreaseRoutes(router,persist){
 router.post('/:id/seat-decrease-quotes',requireCsrf,async(req,res)=>{try{
  if(!uuid(req.params.id)||!exact(req.body,['requestId','requestedPlan'])||!uuid(req.body.requestId))throw authHttpError(400,'PS018','Invalid seat decrease quote');
  const result=await persist(req,async c=>{
   const r=await contract(c,req.params.id,req.auth.userId),p=await active(c,r);
   const proposal=await nativeMutation({command:'commercial-lifecycle-decision',operation:'seat-decrease',currency:'JPY',currentPlan:planInput(r.current_plan??r.quote.plan),requestedPlan:req.body.requestedPlan,currentPeriodEnd:p.finish,actor:{sessionValid:true,accountRemoved:false,identityConfirmed:true,billingAdministrator:true,membershipActive:false,hasExportScope:false}});
   const quote={...proposal,contractId:r.id,contractQuoteHash:r.quote_hash,targetCycle:p.cycle+1};
   const hash=createHash('sha256').update(JSON.stringify(quote)).digest('hex');
   const old=(await c.query('SELECT * FROM commercial_seat_decreases WHERE contract_id=$1 AND request_id=$2',[r.id,req.body.requestId])).rows[0];
   if(old){if(old.quote_hash!==hash)throw authHttpError(409,'PS015','Request id reused with a different decrease');await samePeriod(c,r,p);return out(old);}
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
   if(q.state==='scheduled'||q.state==='applied')return out(q);
   if(q.state!=='quoted')throw authHttpError(409,'PS015','Seat decrease was superseded');
   const p=await active(c,r);
   if(q.base_revision!==r.seat_revision||q.target_cycle!==p.cycle+1||q.quote.effectiveDate!==p.finish||q.quote.contractQuoteHash!==r.quote_hash||JSON.stringify(planInput(q.quote.currentPlan))!==JSON.stringify(planInput(r.current_plan??r.quote.plan)))throw authHttpError(409,'PS015','Seat decrease quote expired or plan changed');
   await c.query("UPDATE commercial_seat_decreases SET state='superseded' WHERE contract_id=$1 AND state='scheduled'",[r.id]);
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
