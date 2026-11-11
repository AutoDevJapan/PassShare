import {createHash,randomUUID} from 'node:crypto';
import {requireCsrf} from './auth/csrf.js';
import {authHttpError,sendAuthError} from './auth/errors.js';
import {applySchemaWithAdvisoryLock} from './db/migration-lock.js';

export const REFUND_REQUEST_SCHEMA=`
 CREATE UNIQUE INDEX IF NOT EXISTS commercial_live_periods_refund_request_scope
 ON commercial_live_periods(account_id,event_id,contract_id,provider_object_id,amount_jpy,event_hash);
 CREATE UNIQUE INDEX IF NOT EXISTS commercial_seat_changes_refund_request_scope
 ON commercial_seat_changes(account_id,id,contract_id,event_id,provider_object_id,paid_amount_jpy,event_hash);
 CREATE UNIQUE INDEX IF NOT EXISTS commercial_exceptions_refund_request_scope
 ON commercial_plan_payment_exceptions(account_id,event_id,contract_id,provider_object_id,amount_jpy,event_hash);
 CREATE TABLE IF NOT EXISTS commercial_refund_requests (
 id UUID PRIMARY KEY,contract_id UUID NOT NULL REFERENCES commercial_contracts(id) ON DELETE CASCADE,
 request_id UUID NOT NULL,request_fingerprint TEXT NOT NULL CHECK(request_fingerprint ~ '^[a-f0-9]{64}$'),
 account_id TEXT NOT NULL,payment_event_id TEXT NOT NULL,provider_object_id TEXT NOT NULL,
 payment_amount_jpy BIGINT NOT NULL CHECK(payment_amount_jpy BETWEEN 1 AND 9007199254740991),
 payment_event_hash TEXT NOT NULL CHECK(payment_event_hash ~ '^[a-f0-9]{64}$'),
 quote_hash TEXT NOT NULL CHECK(quote_hash ~ '^[a-f0-9]{64}$'),
 requested_amount_jpy BIGINT NOT NULL CHECK(requested_amount_jpy BETWEEN 1 AND payment_amount_jpy),
 reason TEXT NOT NULL CHECK(reason IN ('duplicate_charge','service_unprovided','statutory_right','other')),
 status TEXT NOT NULL DEFAULT 'received' CHECK(status='received'),
 requested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),UNIQUE(contract_id,request_id));
 ALTER TABLE commercial_refund_requests ADD COLUMN IF NOT EXISTS payment_source TEXT NOT NULL DEFAULT 'period';
 ALTER TABLE commercial_refund_requests ADD COLUMN IF NOT EXISTS period_event_id TEXT;
 ALTER TABLE commercial_refund_requests ADD COLUMN IF NOT EXISTS seat_change_id UUID;
 ALTER TABLE commercial_refund_requests ADD COLUMN IF NOT EXISTS exception_event_id TEXT;
 -- Existing requests were constrained to this exact period identity. Preserve
 -- their IDs, fingerprints and timestamps while adding explicit source binding.
 UPDATE commercial_refund_requests SET period_event_id=payment_event_id WHERE payment_source='period' AND period_event_id IS NULL;
 DO $binding$ DECLARE old_fk RECORD; BEGIN
 FOR old_fk IN SELECT c.conname FROM pg_constraint c
 WHERE c.conrelid='public.commercial_refund_requests'::regclass AND c.confrelid='public.commercial_live_periods'::regclass AND c.contype='f'
 AND (SELECT array_agg(a.attname::text ORDER BY k.pos) FROM unnest(c.conkey) WITH ORDINALITY k(num,pos) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num)=ARRAY['account_id','payment_event_id','contract_id','provider_object_id','payment_amount_jpy','payment_event_hash']
 LOOP EXECUTE format('ALTER TABLE public.commercial_refund_requests DROP CONSTRAINT %I',old_fk.conname); END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.commercial_refund_requests'::regclass AND conname='refund_request_source_binding') THEN
 ALTER TABLE commercial_refund_requests ADD CONSTRAINT refund_request_source_binding CHECK(
 (payment_source='period' AND period_event_id IS NOT NULL AND period_event_id=payment_event_id AND seat_change_id IS NULL AND exception_event_id IS NULL) OR
 (payment_source='seat_change' AND seat_change_id IS NOT NULL AND period_event_id IS NULL AND exception_event_id IS NULL) OR
 (payment_source='payment_exception' AND exception_event_id IS NOT NULL AND exception_event_id=payment_event_id AND period_event_id IS NULL AND seat_change_id IS NULL)); END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.commercial_refund_requests'::regclass AND conname='refund_request_period_scope') THEN
 ALTER TABLE commercial_refund_requests ADD CONSTRAINT refund_request_period_scope FOREIGN KEY(account_id,period_event_id,contract_id,provider_object_id,payment_amount_jpy,payment_event_hash)
 REFERENCES commercial_live_periods(account_id,event_id,contract_id,provider_object_id,amount_jpy,event_hash) ON DELETE CASCADE; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.commercial_refund_requests'::regclass AND conname='refund_request_seat_scope') THEN
 ALTER TABLE commercial_refund_requests ADD CONSTRAINT refund_request_seat_scope FOREIGN KEY(account_id,seat_change_id,contract_id,payment_event_id,provider_object_id,payment_amount_jpy,payment_event_hash)
 REFERENCES commercial_seat_changes(account_id,id,contract_id,event_id,provider_object_id,paid_amount_jpy,event_hash) ON DELETE CASCADE; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.commercial_refund_requests'::regclass AND conname='refund_request_exception_scope') THEN
 ALTER TABLE commercial_refund_requests ADD CONSTRAINT refund_request_exception_scope FOREIGN KEY(account_id,exception_event_id,contract_id,provider_object_id,payment_amount_jpy,payment_event_hash)
 REFERENCES commercial_plan_payment_exceptions(account_id,event_id,contract_id,provider_object_id,amount_jpy,event_hash) ON DELETE CASCADE; END IF;
 END $binding$;`;
export const migrateRefundRequests=pool=>applySchemaWithAdvisoryLock(pool,4820135,REFUND_REQUEST_SCHEMA);
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
export const publicRefundRequest=r=>({id:r.id,requestId:r.request_id,contractId:r.contract_id,paymentIntentId:r.provider_object_id,paymentAmountJpy:Number(r.payment_amount_jpy),paymentSource:r.payment_source,paymentEvidence:'provider_live',requestedAmountJpy:Number(r.requested_amount_jpy),currency:'JPY',reason:r.reason,status:r.status,requestedAt:r.requested_at,approvalGranted:r.review?.decision==='approved',approvedAmountJpy:r.review?.decision==='approved'?Number(r.review.amount_jpy):null,refundExecuted:false,meaning:r.review?'refund_request_reviewed_not_executed':'refund_request_received_not_approved_or_executed',...(r.review?{review:{decision:r.review.decision,approvedAmountJpy:r.review.decision==='approved'?Number(r.review.amount_jpy):null,reason:r.review.reason,revision:r.review.revision,reviewedAt:r.review.created_at,executionAuthorized:false}}:{})});
async function withReview(c,row){const review=(await c.query('SELECT decision,amount_jpy,reason,revision,created_at FROM commercial_refund_reviews WHERE request_id=$1 ORDER BY revision DESC LIMIT 1',[row.id])).rows[0];return publicRefundRequest({...row,review});}

export async function refundPaymentBinding(c,row,contract,ownerId){
 if(row.quote_hash!==contract.quote_hash)throw authHttpError(409,'PS015','Refund request binding changed');
 let quoteHash=row.quote_hash;
 if(row.payment_source==='seat_change'){
  const seat=(await c.query('SELECT quote_hash FROM commercial_seat_changes WHERE id=$1 AND contract_id=$2',[row.seat_change_id,contract.id])).rows[0];
  if(!seat)throw authHttpError(409,'PS015','Refund payment binding unavailable');quoteHash=seat.quote_hash;
 }
 return {account:row.account_id,paymentIntentId:row.provider_object_id,amountJpy:Number(row.payment_amount_jpy),contractId:contract.id,ownerId,quoteHash,requestedAmountJpy:Number(row.requested_amount_jpy)};
}

// Historical signed payment evidence identifies a claim, not a currently
// refundable balance. Intake never invokes a provider or changes entitlements.
export function registerRefundRequestRoutes(router,persist,lookup){
 router.post('/:id/refund-requests',requireCsrf,async(req,res)=>{try{
  const b=req.body;
  if(!uuid(req.params.id)||!exact(b,['requestId','paymentIntentId','amountJpy','reason'])||!uuid(b.requestId)||typeof b.paymentIntentId!=='string'||!/^pi_[A-Za-z0-9]{1,252}$/.test(b.paymentIntentId)||!Number.isSafeInteger(b.amountJpy)||b.amountJpy<1||!['duplicate_charge','service_unprovided','statutory_right','other'].includes(b.reason))throw authHttpError(400,'PS018','Invalid refund request');
  const result=await persist(req,async c=>{
   const contract=(await c.query('SELECT id,quote_hash FROM commercial_contracts WHERE id=$1 AND user_id=$2 FOR UPDATE',[req.params.id,req.auth.userId])).rows[0];
   if(!contract)throw authHttpError(404,'PS022','Contract not found');
   const payments=(await c.query(`
    SELECT account_id,event_id,provider_object_id,amount_jpy,event_hash,'period' AS payment_source,event_id AS period_event_id,NULL::uuid AS seat_change_id,NULL::text AS exception_event_id
    FROM commercial_live_periods WHERE contract_id=$1 AND provider_object_id=$2 AND evidence='provider_live'
    UNION ALL
    SELECT account_id,event_id,provider_object_id,paid_amount_jpy AS amount_jpy,event_hash,'seat_change',NULL::text,id,NULL::text
    FROM commercial_seat_changes WHERE contract_id=$1 AND provider_object_id=$2 AND state IN ('applied','refund_review') AND paid_amount_jpy>0 AND account_id IS NOT NULL AND event_id IS NOT NULL AND event_hash IS NOT NULL
    UNION ALL
    SELECT account_id,event_id,provider_object_id,amount_jpy,event_hash,'payment_exception',NULL::text,NULL::uuid,event_id
    FROM commercial_plan_payment_exceptions WHERE contract_id=$1 AND provider_object_id=$2`,[contract.id,b.paymentIntentId])).rows;
   if(payments.length!==1)throw authHttpError(409,'PS015','An unambiguous recorded paid payment is required');
   const payment=payments[0],paid=BigInt(payment.amount_jpy);
   if(paid>BigInt(Number.MAX_SAFE_INTEGER)||BigInt(b.amountJpy)>paid)throw authHttpError(400,'PS018','Requested amount exceeds this payment');
   const requestId=b.requestId.toLowerCase();
   const fingerprint=createHash('sha256').update(JSON.stringify({requestId,contractId:contract.id,account:payment.account_id,event:payment.event_id,paymentIntent:b.paymentIntentId,paymentAmount:payment.amount_jpy,paymentHash:payment.event_hash,quoteHash:contract.quote_hash,requestedAmount:b.amountJpy,reason:b.reason})).digest('hex');
   const old=(await c.query('SELECT * FROM commercial_refund_requests WHERE contract_id=$1 AND request_id=$2',[contract.id,requestId])).rows[0];
   if(old){if(old.request_fingerprint!==fingerprint)throw authHttpError(409,'PS015','Refund request changed');return withReview(c,old);}
   const row=(await c.query('INSERT INTO commercial_refund_requests(id,contract_id,request_id,request_fingerprint,account_id,payment_event_id,provider_object_id,payment_amount_jpy,payment_event_hash,quote_hash,requested_amount_jpy,reason,payment_source,period_event_id,seat_change_id,exception_event_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *',[randomUUID(),contract.id,requestId,fingerprint,payment.account_id,payment.event_id,payment.provider_object_id,payment.amount_jpy,payment.event_hash,contract.quote_hash,b.amountJpy,b.reason,payment.payment_source,payment.period_event_id,payment.seat_change_id,payment.exception_event_id])).rows[0];return withReview(c,row);
  });res.status(201).json(result);
 }catch(e){sendAuthError(res,e);}});
 router.get('/:id/refund-requests/:request',async(req,res)=>{try{
  if(!uuid(req.params.id)||!uuid(req.params.request))throw authHttpError(404,'PS022','Refund request not found');
  const result=await persist(req,async c=>{
   const contract=(await c.query('SELECT id FROM commercial_contracts WHERE id=$1 AND user_id=$2 FOR UPDATE',[req.params.id,req.auth.userId])).rows[0];
   if(!contract)throw authHttpError(404,'PS022','Refund request not found');
   const row=(await c.query('SELECT * FROM commercial_refund_requests WHERE contract_id=$1 AND id=$2',[contract.id,req.params.request])).rows[0];
   if(!row)throw authHttpError(404,'PS022','Refund request not found');return withReview(c,row);
  });res.json(result);
 }catch(e){sendAuthError(res,e);}});
 router.post('/:id/refund-requests/:request/reconcile',requireCsrf,async(req,res)=>{try{
  if(!uuid(req.params.id)||!uuid(req.params.request))throw authHttpError(404,'PS022','Refund request not found');
  if(!exact(req.body,[]))throw authHttpError(400,'PS018','No client financial state is accepted');
  const result=await persist(req,async c=>{
   const contract=(await c.query('SELECT id,quote_hash FROM commercial_contracts WHERE id=$1 AND user_id=$2 FOR UPDATE',[req.params.id,req.auth.userId])).rows[0];
   if(!contract)throw authHttpError(404,'PS022','Refund request not found');
   const row=(await c.query('SELECT * FROM commercial_refund_requests WHERE contract_id=$1 AND id=$2',[contract.id,req.params.request])).rows[0];
   if(!row)throw authHttpError(404,'PS022','Refund request not found');
   const binding=await refundPaymentBinding(c,row,contract,req.auth.userId);
   const active=await c.query('SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND expires_at>clock_timestamp()',[req.auth.sessionId,req.auth.userId]);
   if(!active.rowCount)throw authHttpError(401,'PS024','Session expired');
   let current=null;
   try{if(typeof lookup==='function')current=await lookup({account:row.account_id,paymentIntentId:row.provider_object_id});}catch{}
   const balance=liveRefundBalance(binding,current);
   const checkedAt=balance.qualified?(await c.query('SELECT clock_timestamp() AS now')).rows[0].now:null;
   return {...await withReview(c,row),balance:{...balance,checkedAt},meaning:'current_refund_balance_observed_not_approval_reservation_or_execution'};
  });res.json(result);
 }catch(e){sendAuthError(res,e);}});
}

// An observed provider inventory is not an atomic reservation or a promise to
// refund. Approval/execution must recheck its own current authority and balance.
export function liveRefundBalance(binding,current){
 const unknown={qualified:false,confirmedRefundedJpy:0,reservedRefundJpy:0,availableRefundJpy:0,requestAmountAvailable:false,statusBasis:'status_review'};
 const p=current?.payment,m=p?.metadata;
 if(current?.inventoryComplete!==true||current.account!==binding.account||p?.object!=='payment_intent'||p.id!==binding.paymentIntentId||p.livemode!==true||p.status!=='succeeded'||p.currency!=='jpy'||p.amount!==binding.amountJpy||p.amount_received!==binding.amountJpy||typeof m?.ownerId!=='string'||m.ownerId.toLowerCase()!==binding.ownerId||typeof m?.contractId!=='string'||m.contractId.toLowerCase()!==binding.contractId||m?.quoteHash!==binding.quoteHash||!Array.isArray(current.refunds)||!Number.isSafeInteger(binding.amountJpy)||binding.amountJpy<1||!Number.isSafeInteger(binding.requestedAmountJpy)||binding.requestedAmountJpy<1||binding.requestedAmountJpy>binding.amountJpy)return unknown;
 let confirmed=0n,reserved=0n;const seen=new Set();
 for(const r of current.refunds){
  const paymentIntent=typeof r?.payment_intent==='string'?r.payment_intent:r?.payment_intent?.id;
  if(r?.object!=='refund'||typeof r.id!=='string'||!/^((re|pyr)_[A-Za-z0-9]+)$/.test(r.id)||seen.has(r.id)||paymentIntent!==binding.paymentIntentId||r.currency!=='jpy'||!Number.isSafeInteger(r.amount)||r.amount<1||r.amount>binding.amountJpy||!['succeeded','pending','requires_action','failed','canceled'].includes(r.status))return unknown;
  seen.add(r.id);
  if(r.status==='succeeded')confirmed+=BigInt(r.amount);
  if(['succeeded','pending','requires_action'].includes(r.status))reserved+=BigInt(r.amount);
 }
 if(reserved>BigInt(binding.amountJpy))return unknown;
 const available=BigInt(binding.amountJpy)-reserved;
 return {qualified:true,confirmedRefundedJpy:Number(confirmed),reservedRefundJpy:Number(reserved),availableRefundJpy:Number(available),requestAmountAvailable:BigInt(binding.requestedAmountJpy)<=available,statusBasis:'provider_api_live'};
}
