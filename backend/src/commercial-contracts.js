import {Router} from 'express';
import {randomUUID,createHash} from 'node:crypto';
import {rateLimit} from 'express-rate-limit';
import {requireSession} from './auth/session.js';
import {requireCsrf} from './auth/csrf.js';
import {authHttpError,sendAuthError} from './auth/errors.js';
import {nativeMutation} from './lib/native-mutations.js';
import {applySchemaWithAdvisoryLock} from './db/migration-lock.js';
import {migrateCommercialEvents} from './commercial-events.js';
import {migrateCommercialLive,loadEntitlement} from './commercial-live.js';
import {migrateCommercialSeats,registerSeatRoutes} from './commercial-seats.js';
import {migrateSeatDecreases,registerSeatDecreaseRoutes} from './commercial-seat-decreases.js';
import {currentBillingPlan} from './commercial-plan.js';
import {registerCommercialExport} from './commercial-export.js';
import {migrateExportAudit,registerExportAudit} from './commercial-export-audit.js';
import {migrateTestRefunds,registerTestRefundRoutes} from './commercial-test-refunds.js';
import {createTestRefundLookup,createLiveRefundLookup} from './commercial-refund-provider.js';
import {migrateRefundRequests,registerRefundRequestRoutes} from './commercial-refund-requests.js';

export const CONTRACT_SCHEMA=`CREATE TABLE IF NOT EXISTS commercial_contracts (
 id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 request_id UUID NOT NULL, quote JSONB NOT NULL, quote_hash TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','accepted_unpaid')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), accepted_at TIMESTAMPTZ,
 UNIQUE(user_id,request_id));
 ALTER TABLE commercial_contracts ADD COLUMN IF NOT EXISTS cancellation_requested_at TIMESTAMPTZ;
 ALTER TABLE commercial_contracts ADD COLUMN IF NOT EXISTS lifecycle_revision INTEGER NOT NULL DEFAULT 0;`;
export const migrateCommercialContracts=async pool=>{await applySchemaWithAdvisoryLock(pool,4820128,CONTRACT_SCHEMA);await migrateCommercialEvents(pool);await migrateCommercialLive(pool);await migrateCommercialSeats(pool);await migrateSeatDecreases(pool);await migrateExportAudit(pool);await migrateTestRefunds(pool);await migrateRefundRequests(pool);};
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
const exact=(x,keys)=>x&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const publicRow=r=>({id:r.id,state:r.state,quote:r.quote,quoteHash:r.quote_hash,currentPlan:r.current_plan??r.quote.plan,seatRevision:r.seat_revision??0,createdAt:r.created_at,acceptedAt:r.accepted_at,cancellationRequestedAt:r.cancellation_requested_at??null,lifecycleRevision:r.lifecycle_revision??0,paid:false,entitlementsGranted:false,meaning:'quote_acceptance_not_payment_or_service_activation'});
export function createCommercialContractRouter({pool,authStore,refundLookup=createTestRefundLookup(),liveRefundLookup=createLiveRefundLookup()}){
 const router=Router();router.use(rateLimit({windowMs:60000,limit:30,standardHeaders:'draft-6',legacyHeaders:false}));router.use(requireSession(authStore));
 router.use((_q,r,next)=>{r.set('Cache-Control','no-store');next();});
 const persist=async(req,run)=>{
  if(!pool)throw authHttpError(503,'PS019','Persistent contracts unavailable');
  const c=await pool.connect();try{
   await c.query('BEGIN');
   const active=await c.query('SELECT u.id FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=$1 AND s.id=$2 FOR SHARE OF u,s',[req.auth.userId,req.auth.sessionId]);
   if(!active.rowCount)throw authHttpError(401,'PS024','Session expired');
   const result=await run(c);
   // Do not authorize after a row-lock wait using a pre-wait timestamp.
   const live=await c.query('SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND expires_at>clock_timestamp()',[req.auth.sessionId,req.auth.userId]);
   if(!live.rowCount)throw authHttpError(401,'PS024','Session expired');
   await c.query('COMMIT');return result;
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 };
 registerSeatRoutes(router,persist);
 registerSeatDecreaseRoutes(router,persist);
 registerCommercialExport(router,{pool});
 registerExportAudit(router,persist);
 registerTestRefundRoutes(router,persist,refundLookup);
 registerRefundRequestRoutes(router,persist,liveRefundLookup);
 router.post('/',requireCsrf,async(req,res)=>{try{
  const b=req.body;if(!exact(b,['requestId','currency','plan','setup'])||!uuid(b.requestId))throw authHttpError(400,'PS018','Invalid contract quote');
  const quote=await nativeMutation({command:'commercial-quote',currency:b.currency,plan:b.plan,setup:b.setup});
  const digest=createHash('sha256').update(JSON.stringify(quote)).digest('hex');
  const row=await persist(req,async c=>{
   const r=(await c.query(`INSERT INTO commercial_contracts(id,user_id,request_id,quote,quote_hash) VALUES($1,$2,$3,$4::jsonb,$5)
    ON CONFLICT(user_id,request_id) DO UPDATE SET request_id=EXCLUDED.request_id RETURNING *`,[randomUUID(),req.auth.userId,b.requestId,JSON.stringify(quote),digest])).rows[0];
   if(r.quote_hash!==digest)throw authHttpError(409,'PS015','Contract quote changed');return r;
  });res.status(201).json(publicRow(row));
 }catch(e){sendAuthError(res,e);}});
 router.post('/:id/accept',requireCsrf,async(req,res)=>{try{
  if(!uuid(req.params.id)||!exact(req.body,['quoteHash'])||typeof req.body.quoteHash!=='string'||!/^[a-f0-9]{64}$/.test(req.body.quoteHash))throw authHttpError(400,'PS018','Invalid quote acceptance');
  const row=await persist(req,async c=>{
   const r=(await c.query('SELECT * FROM commercial_contracts WHERE id=$1 AND user_id=$2 FOR UPDATE',[req.params.id,req.auth.userId])).rows[0];
   if(!r)throw authHttpError(404,'PS022','Contract not found');
   if(r.cancellation_requested_at)throw authHttpError(409,'PS015','Contract acceptance was withdrawn');
   if(r.quote_hash!==req.body.quoteHash)throw authHttpError(409,'PS015','Contract quote changed');
   return (await c.query("UPDATE commercial_contracts SET state='accepted_unpaid',accepted_at=COALESCE(accepted_at,clock_timestamp()) WHERE id=$1 RETURNING *",[r.id])).rows[0];
  });res.json(publicRow(row));
 }catch(e){sendAuthError(res,e);}});
 router.post('/:id/cancel',requireCsrf,async(req,res)=>{try{
  if(!uuid(req.params.id)||!exact(req.body,['quoteHash','revision'])||typeof req.body.quoteHash!=='string'||!/^[a-f0-9]{64}$/.test(req.body.quoteHash)||!Number.isSafeInteger(req.body.revision)||req.body.revision<0)throw authHttpError(400,'PS018','Invalid cancellation request');
  const row=await persist(req,async c=>{
   const r=(await c.query('SELECT * FROM commercial_contracts WHERE id=$1 AND user_id=$2 FOR UPDATE',[req.params.id,req.auth.userId])).rows[0];
   if(!r)throw authHttpError(404,'PS022','Contract not found');
   if(r.quote_hash!==req.body.quoteHash)throw authHttpError(409,'PS015','Contract quote changed');
   if((await c.query('SELECT 1 FROM commercial_live_contracts WHERE contract_id=$1',[r.id])).rowCount)throw authHttpError(409,'PS015','A paid contract cannot be withdrawn as unpaid');
   // Idempotent replay of this terminal unpaid withdrawal; never resurrect it.
   if(r.state!=='accepted_unpaid')throw authHttpError(409,'PS015','Contract has no unpaid acceptance to withdraw');
   if(r.cancellation_requested_at){if(req.body.revision!==r.lifecycle_revision-1)throw authHttpError(409,'PS015','Contract revision changed');return r;}
   if(r.lifecycle_revision!==req.body.revision)throw authHttpError(409,'PS015','Contract revision changed');
   return (await c.query('UPDATE commercial_contracts SET cancellation_requested_at=clock_timestamp(),lifecycle_revision=lifecycle_revision+1 WHERE id=$1 RETURNING *',[r.id])).rows[0];
  });res.json({...publicRow(row),cancellationMeaning:'unpaid_acceptance_withdrawn_no_provider_subscription_canceled',refundExecuted:false,dataDeletionExecuted:false});
 }catch(e){sendAuthError(res,e);}});
 router.post('/:id/cancel-at-period-end',requireCsrf,async(req,res)=>{try{
  if(!uuid(req.params.id)||!exact(req.body,['quoteHash'])||!/^[a-f0-9]{64}$/.test(req.body.quoteHash??''))throw authHttpError(400,'PS018','Invalid period-end cancellation request');
  const out=await persist(req,async c=>{
   const r=(await c.query('SELECT * FROM commercial_contracts WHERE id=$1 AND user_id=$2 FOR UPDATE',[req.params.id,req.auth.userId])).rows[0];
   if(!r)throw authHttpError(404,'PS022','Contract not found');
   if(r.quote_hash!==req.body.quoteHash)throw authHttpError(409,'PS015','Contract quote changed');
   const lc=(await c.query('SELECT * FROM commercial_live_contracts WHERE contract_id=$1 FOR UPDATE',[r.id])).rows[0];
   if(!lc)throw authHttpError(409,'PS015','Contract has no paid period to end');
   if(lc.cancel_after_cycle==null)await c.query("UPDATE commercial_live_contracts SET cancel_after_cycle=(SELECT max(cycle) FROM commercial_live_periods WHERE contract_id=$1 AND disposition='effective'),cancel_requested_at=clock_timestamp() WHERE contract_id=$1",[r.id]);
   return loadEntitlement(c,r.id,Date.now());
  });res.json({entitlement:out,meaning:'ends_at_paid_period_end_no_refund_no_deletion'});
 }catch(e){sendAuthError(res,e);}});
 router.get('/:id/payment-exceptions',async(req,res)=>{try{
  if(!uuid(req.params.id))throw authHttpError(404,'PS022','Contract not found');
  const payments=await persist(req,async c=>{
   const own=(await c.query('SELECT id FROM commercial_contracts WHERE id=$1 AND user_id=$2',[req.params.id,req.auth.userId])).rows[0];
   if(!own)throw authHttpError(404,'PS022','Contract not found');
   return (await c.query("SELECT event_id,provider_object_id,cycle,amount_jpy::text,received_at,CASE WHEN disposition='refund_review' THEN disposition_reason ELSE 'paid_plan_adjustment_required' END AS reason,CASE WHEN disposition='refund_review' THEN 'refund_review_required' ELSE 'billing_adjustment_review_required' END AS status FROM commercial_live_periods WHERE contract_id=$1 AND (disposition='refund_review' OR plan_adjustment_review) UNION ALL SELECT event_id,provider_object_id,(quote->>'billingCycle')::integer,paid_amount_jpy::text,payment_received_at,'seat_quote_no_longer_applicable','refund_review_required' FROM commercial_seat_changes WHERE contract_id=$1 AND state='refund_review' UNION ALL SELECT event_id,provider_object_id,cycle,amount_jpy::text,received_at,reason,'refund_review_required' FROM commercial_plan_payment_exceptions WHERE contract_id=$1 ORDER BY cycle",[own.id])).rows;
  });
  res.json({refundExecuted:false,entitlementGranted:false,payments:payments.map(p=>({eventId:p.event_id,paymentIntentId:p.provider_object_id,cycle:p.cycle,amountJpy:Number(p.amount_jpy),receivedAt:p.received_at,reason:p.reason,status:p.status}))});
 }catch(e){sendAuthError(res,e);}});
 router.get('/:id/export-authorization',async(req,res)=>{try{
  if(!uuid(req.params.id))throw authHttpError(404,'PS022','Contract not found');
  const ent=await persist(req,async c=>{const r=(await c.query('SELECT id FROM commercial_contracts WHERE id=$1 AND user_id=$2',[req.params.id,req.auth.userId])).rows[0];return r?loadEntitlement(c,r.id,Date.now()):null;});
  if(!ent)throw authHttpError(404,'PS022','Contract not found');
  // Billing dates do not authorize identity, membership or key access.
  res.json({entitlement:ent,export:{proposalOnly:true,windowOpen:!!ent.exportWindow?.open,authorized:false,requiresCurrentIdentityMembershipAndKeyScope:true,restoresIdentityMembershipOrKeys:false}});
 }catch(e){sendAuthError(res,e);}});
 router.get('/:id',async(req,res)=>{try{
  if(!uuid(req.params.id))throw authHttpError(404,'PS022','Contract not found');
  const row=await persist(req,async c=>{const r=(await c.query('SELECT * FROM commercial_contracts WHERE id=$1 AND user_id=$2 FOR SHARE',[req.params.id,req.auth.userId])).rows[0];if(r){r.current_plan=await currentBillingPlan(c,r);r.entitlement=await loadEntitlement(c,r.id,Date.now());r.periods=(await c.query('SELECT period_start::text,period_end::text,amount_jpy::text FROM commercial_paid_periods WHERE contract_id=$1 ORDER BY period_start,event_id',[r.id])).rows;}return r;});
  if(!row)throw authHttpError(404,'PS022','Contract not found');res.json({...publicRow(row),providerTestPeriods:row.periods.map(x=>({periodStart:x.period_start,periodEnd:x.period_end,amountJpy:Number(x.amount_jpy),evidence:'provider_test_sandbox',entitlementEffective:false})),entitlement:row.entitlement});
 }catch(e){sendAuthError(res,e);}});
 return router;
}

