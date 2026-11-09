import {Router} from 'express';
import {randomUUID,createHash} from 'node:crypto';
import {rateLimit} from 'express-rate-limit';
import {requireSession} from './auth/session.js';
import {requireCsrf} from './auth/csrf.js';
import {authHttpError,sendAuthError} from './auth/errors.js';
import {nativeMutation} from './lib/native-mutations.js';
import {applySchemaWithAdvisoryLock} from './db/migration-lock.js';
import {migrateCommercialEvents} from './commercial-events.js';

export const CONTRACT_SCHEMA=`CREATE TABLE IF NOT EXISTS commercial_contracts (
 id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 request_id UUID NOT NULL, quote JSONB NOT NULL, quote_hash TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','accepted_unpaid')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), accepted_at TIMESTAMPTZ,
 UNIQUE(user_id,request_id));
 ALTER TABLE commercial_contracts ADD COLUMN IF NOT EXISTS cancellation_requested_at TIMESTAMPTZ;
 ALTER TABLE commercial_contracts ADD COLUMN IF NOT EXISTS lifecycle_revision INTEGER NOT NULL DEFAULT 0;`;
export const migrateCommercialContracts=async pool=>{await applySchemaWithAdvisoryLock(pool,4820128,CONTRACT_SCHEMA);await migrateCommercialEvents(pool);};
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
const exact=(x,keys)=>x&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const publicRow=r=>({id:r.id,state:r.state,quote:r.quote,quoteHash:r.quote_hash,createdAt:r.created_at,acceptedAt:r.accepted_at,cancellationRequestedAt:r.cancellation_requested_at??null,lifecycleRevision:r.lifecycle_revision??0,paid:false,entitlementsGranted:false,meaning:'quote_acceptance_not_payment_or_service_activation'});
export function createCommercialContractRouter({pool,authStore}){
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
   // Idempotent replay of this terminal unpaid withdrawal; never resurrect it.
   if(r.state!=='accepted_unpaid')throw authHttpError(409,'PS015','Contract has no unpaid acceptance to withdraw');
   if(r.cancellation_requested_at){if(req.body.revision!==r.lifecycle_revision-1)throw authHttpError(409,'PS015','Contract revision changed');return r;}
   if(r.lifecycle_revision!==req.body.revision)throw authHttpError(409,'PS015','Contract revision changed');
   return (await c.query('UPDATE commercial_contracts SET cancellation_requested_at=clock_timestamp(),lifecycle_revision=lifecycle_revision+1 WHERE id=$1 RETURNING *',[r.id])).rows[0];
  });res.json({...publicRow(row),cancellationMeaning:'unpaid_acceptance_withdrawn_no_provider_subscription_canceled',refundExecuted:false,dataDeletionExecuted:false});
 }catch(e){sendAuthError(res,e);}});
 router.get('/:id',async(req,res)=>{try{
  if(!uuid(req.params.id))throw authHttpError(404,'PS022','Contract not found');
  const row=await persist(req,async c=>{const r=(await c.query('SELECT * FROM commercial_contracts WHERE id=$1 AND user_id=$2',[req.params.id,req.auth.userId])).rows[0];if(r)r.periods=(await c.query('SELECT period_start::text,period_end::text,amount_jpy::text FROM commercial_paid_periods WHERE contract_id=$1 ORDER BY period_start,event_id',[r.id])).rows;return r;});
  if(!row)throw authHttpError(404,'PS022','Contract not found');res.json({...publicRow(row),providerTestPeriods:row.periods.map(x=>({periodStart:x.period_start,periodEnd:x.period_end,amountJpy:Number(x.amount_jpy),evidence:'provider_test_sandbox',entitlementEffective:false}))});
 }catch(e){sendAuthError(res,e);}});
 return router;
}

