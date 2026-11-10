import {createHash,randomUUID} from 'node:crypto';
import {requireCsrf} from './auth/csrf.js';
import {authHttpError,sendAuthError} from './auth/errors.js';
import {applySchemaWithAdvisoryLock} from './db/migration-lock.js';

export const REFUND_REQUEST_SCHEMA=`
 CREATE UNIQUE INDEX IF NOT EXISTS commercial_live_periods_refund_request_scope
 ON commercial_live_periods(account_id,event_id,contract_id,provider_object_id,amount_jpy,event_hash);
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
 requested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),UNIQUE(contract_id,request_id),
 FOREIGN KEY(account_id,payment_event_id,contract_id,provider_object_id,payment_amount_jpy,payment_event_hash)
 REFERENCES commercial_live_periods(account_id,event_id,contract_id,provider_object_id,amount_jpy,event_hash) ON DELETE CASCADE);`;
export const migrateRefundRequests=pool=>applySchemaWithAdvisoryLock(pool,4820135,REFUND_REQUEST_SCHEMA);
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const publicRow=r=>({id:r.id,requestId:r.request_id,contractId:r.contract_id,paymentIntentId:r.provider_object_id,paymentAmountJpy:Number(r.payment_amount_jpy),paymentEvidence:'provider_live',requestedAmountJpy:Number(r.requested_amount_jpy),currency:'JPY',reason:r.reason,status:r.status,requestedAt:r.requested_at,approvalGranted:false,approvedAmountJpy:null,refundExecuted:false,meaning:'refund_request_received_not_approved_or_executed'});

// Historical signed payment evidence identifies a claim, not a currently
// refundable balance. Intake never invokes a provider or changes entitlements.
export function registerRefundRequestRoutes(router,persist){
 router.post('/:id/refund-requests',requireCsrf,async(req,res)=>{try{
  const b=req.body;
  if(!uuid(req.params.id)||!exact(b,['requestId','paymentIntentId','amountJpy','reason'])||!uuid(b.requestId)||typeof b.paymentIntentId!=='string'||!/^pi_[A-Za-z0-9]{1,252}$/.test(b.paymentIntentId)||!Number.isSafeInteger(b.amountJpy)||b.amountJpy<1||!['duplicate_charge','service_unprovided','statutory_right','other'].includes(b.reason))throw authHttpError(400,'PS018','Invalid refund request');
  const result=await persist(req,async c=>{
   const contract=(await c.query('SELECT id,quote_hash FROM commercial_contracts WHERE id=$1 AND user_id=$2 FOR UPDATE',[req.params.id,req.auth.userId])).rows[0];
   if(!contract)throw authHttpError(404,'PS022','Contract not found');
   const payments=(await c.query("SELECT account_id,event_id,provider_object_id,amount_jpy,event_hash FROM commercial_live_periods WHERE contract_id=$1 AND provider_object_id=$2 AND evidence='provider_live'",[contract.id,b.paymentIntentId])).rows;
   if(payments.length!==1)throw authHttpError(409,'PS015','An unambiguous recorded paid payment is required');
   const payment=payments[0],paid=BigInt(payment.amount_jpy);
   if(paid>BigInt(Number.MAX_SAFE_INTEGER)||BigInt(b.amountJpy)>paid)throw authHttpError(400,'PS018','Requested amount exceeds this payment');
   const requestId=b.requestId.toLowerCase();
   const fingerprint=createHash('sha256').update(JSON.stringify({requestId,contractId:contract.id,account:payment.account_id,event:payment.event_id,paymentIntent:b.paymentIntentId,paymentAmount:payment.amount_jpy,paymentHash:payment.event_hash,quoteHash:contract.quote_hash,requestedAmount:b.amountJpy,reason:b.reason})).digest('hex');
   const old=(await c.query('SELECT * FROM commercial_refund_requests WHERE contract_id=$1 AND request_id=$2',[contract.id,requestId])).rows[0];
   if(old){if(old.request_fingerprint!==fingerprint)throw authHttpError(409,'PS015','Refund request changed');return old;}
   return (await c.query('INSERT INTO commercial_refund_requests(id,contract_id,request_id,request_fingerprint,account_id,payment_event_id,provider_object_id,payment_amount_jpy,payment_event_hash,quote_hash,requested_amount_jpy,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',[randomUUID(),contract.id,requestId,fingerprint,payment.account_id,payment.event_id,payment.provider_object_id,payment.amount_jpy,payment.event_hash,contract.quote_hash,b.amountJpy,b.reason])).rows[0];
  });res.status(201).json(publicRow(result));
 }catch(e){sendAuthError(res,e);}});
 router.get('/:id/refund-requests/:request',async(req,res)=>{try{
  if(!uuid(req.params.id)||!uuid(req.params.request))throw authHttpError(404,'PS022','Refund request not found');
  const result=await persist(req,async c=>{
   const contract=(await c.query('SELECT id FROM commercial_contracts WHERE id=$1 AND user_id=$2 FOR UPDATE',[req.params.id,req.auth.userId])).rows[0];
   if(!contract)throw authHttpError(404,'PS022','Refund request not found');
   const row=(await c.query('SELECT * FROM commercial_refund_requests WHERE contract_id=$1 AND id=$2',[contract.id,req.params.request])).rows[0];
   if(!row)throw authHttpError(404,'PS022','Refund request not found');return row;
  });res.json(publicRow(result));
 }catch(e){sendAuthError(res,e);}});
}
