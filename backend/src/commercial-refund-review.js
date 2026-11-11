import {randomUUID,createHash} from 'node:crypto';
import {requireCsrf} from './auth/csrf.js';
import {authHttpError,sendAuthError} from './auth/errors.js';
import {applySchemaWithAdvisoryLock} from './db/migration-lock.js';
import {liveRefundBalance,publicRefundRequest,refundPaymentBinding} from './commercial-refund-requests.js';

export const REFUND_REVIEW_SCHEMA=`
CREATE UNIQUE INDEX IF NOT EXISTS commercial_refund_requests_review_scope ON commercial_refund_requests(id,contract_id,request_fingerprint,requested_amount_jpy);
CREATE TABLE IF NOT EXISTS commercial_refund_reviews (
 id UUID PRIMARY KEY,request_id UUID NOT NULL,contract_id UUID NOT NULL,
 request_fingerprint TEXT NOT NULL CHECK(request_fingerprint ~ '^[a-f0-9]{64}$'),
 requested_amount_jpy BIGINT NOT NULL CHECK(requested_amount_jpy BETWEEN 1 AND 9007199254740991),
 operation_id UUID NOT NULL,decision_fingerprint TEXT NOT NULL CHECK(decision_fingerprint ~ '^[a-f0-9]{64}$'),
 reviewer_id UUID REFERENCES users(id) ON DELETE SET NULL,
 revision INTEGER NOT NULL CHECK(revision>=1),decision TEXT NOT NULL CHECK(decision IN ('approved','declined')),
 amount_jpy BIGINT NOT NULL CHECK(amount_jpy BETWEEN 0 AND 9007199254740991),
 reason TEXT NOT NULL CHECK(reason IN ('duplicate_confirmed','unprovided_period_confirmed','statutory_right_confirmed','insufficient_evidence','self_cancellation_no_proration')),
 balance JSONB,created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(request_id,operation_id),UNIQUE(request_id,revision),
 FOREIGN KEY(request_id,contract_id,request_fingerprint,requested_amount_jpy) REFERENCES commercial_refund_requests(id,contract_id,request_fingerprint,requested_amount_jpy) ON DELETE CASCADE,
 CHECK(amount_jpy<=requested_amount_jpy),
 CHECK(((decision='approved' AND amount_jpy>0 AND reason IN ('duplicate_confirmed','unprovided_period_confirmed','statutory_right_confirmed')
 AND balance IS NOT NULL AND jsonb_typeof(balance)='object' AND balance->'qualified'='true'::jsonb
 AND balance->>'statusBasis'='provider_api_live' AND jsonb_typeof(balance->'checkedAt')='string'
 AND jsonb_typeof(balance->'availableRefundJpy')='number' AND (balance->>'availableRefundJpy')::numeric>=amount_jpy
 AND jsonb_typeof(balance->'otherApprovedJpy')='number' AND (balance->>'otherApprovedJpy')::numeric>=0
 AND (balance->>'otherApprovedJpy')::numeric+amount_jpy<=(balance->>'availableRefundJpy')::numeric) OR
 (decision='declined' AND amount_jpy=0 AND reason IN ('insufficient_evidence','self_cancellation_no_proration') AND balance IS NULL)) IS TRUE));
`;
export const migrateRefundReviews=pool=>applySchemaWithAdvisoryLock(pool,4820136,REFUND_REVIEW_SCHEMA);
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const conflict=message=>authHttpError(409,'PS015',message);
const denied=()=>authHttpError(403,'PS024','Refund review is not authorized');
const out=row=>({id:row.id,requestId:row.request_id,decision:row.decision,approvedAmountJpy:row.decision==='approved'?Number(row.amount_jpy):null,reason:row.reason,revision:row.revision,reviewedAt:row.created_at,balance:row.balance,refundExecuted:false,executionAuthorized:false,meaning:'merchant_review_record_not_refund_execution_authority'});

// Reviewer IDs are deployment configuration. No request can enroll a reviewer,
// and this record never calls a provider mutation or grants payment/key rights.
export function registerRefundReviewRoutes(router,{pool,lookup,reviewerIds=[]}){
 const reviewers=new Set(reviewerIds.filter(uuid).map(id=>id.toLowerCase()));
 const transaction=async(req,work)=>{
  if(!reviewers.has(req.auth.userId))throw denied();
  if(!pool)throw authHttpError(503,'PS019','Persistent refund review unavailable');
  const c=await pool.connect();
  try{
   await c.query('BEGIN');
   const preliminary=(await c.query('SELECT r.contract_id,k.user_id FROM commercial_refund_requests r JOIN commercial_contracts k ON k.id=r.contract_id WHERE r.id=$1',[req.params.request])).rows[0];
   if(!preliminary)throw authHttpError(404,'PS022','Refund request not found');
   const ids=[...new Set([req.auth.userId,preliminary.user_id])].sort();
   const users=await c.query('SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',[ids]);
   if(users.rowCount!==ids.length)throw authHttpError(404,'PS022','Refund request not found');
   if(!(await c.query('SELECT id FROM sessions WHERE id=$1 AND user_id=$2 FOR SHARE',[req.auth.sessionId,req.auth.userId])).rowCount)throw authHttpError(401,'PS024','Session expired');
   const contract=(await c.query('SELECT id,user_id,quote_hash FROM commercial_contracts WHERE id=$1 AND user_id=$2 FOR UPDATE',[preliminary.contract_id,preliminary.user_id])).rows[0];
   const request=(await c.query('SELECT * FROM commercial_refund_requests WHERE id=$1 AND contract_id=$2 FOR UPDATE',[req.params.request,preliminary.contract_id])).rows[0];
   if(!contract||!request)throw authHttpError(404,'PS022','Refund request not found');
   const assertCurrent=async()=>{if(!(await c.query('SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND expires_at>clock_timestamp()',[req.auth.sessionId,req.auth.userId])).rowCount)throw authHttpError(401,'PS024','Session expired')};
   await assertCurrent();const result=await work(c,contract,request,assertCurrent);await assertCurrent();
   await c.query('COMMIT');return result;
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e}finally{c.release()}
 };
 router.get('/refund-review/:request',async(req,res)=>{try{
  if(!uuid(req.params.request))throw authHttpError(404,'PS022','Refund request not found');
  const result=await transaction(req,async(c,_contract,request)=>{const review=(await c.query('SELECT * FROM commercial_refund_reviews WHERE request_id=$1 ORDER BY revision DESC LIMIT 1',[request.id])).rows[0];return {request:publicRefundRequest({...request,review}),reviewRevision:review?.revision??0,review:review?out(review):null,refundExecuted:false}});res.json(result);
 }catch(e){sendAuthError(res,e)}});
 router.post('/refund-review/:request/decisions',requireCsrf,async(req,res)=>{try{
  const b=req.body;
  if(!uuid(req.params.request)||!exact(b,['operationId','expectedRevision','decision','amountJpy','reason'])||!uuid(b.operationId)||!Number.isSafeInteger(b.expectedRevision)||b.expectedRevision<0||b.expectedRevision>=2147483647||!Number.isSafeInteger(b.amountJpy)||b.amountJpy<0||!((b.decision==='approved'&&b.amountJpy>0&&['duplicate_confirmed','unprovided_period_confirmed','statutory_right_confirmed'].includes(b.reason))||(b.decision==='declined'&&b.amountJpy===0&&['insufficient_evidence','self_cancellation_no_proration'].includes(b.reason))))throw authHttpError(400,'PS018','Invalid refund review');
  const operation=b.operationId.toLowerCase(),fingerprint=createHash('sha256').update(JSON.stringify({request:req.params.request.toLowerCase(),reviewer:req.auth.userId,operationId:operation,expectedRevision:b.expectedRevision,decision:b.decision,amountJpy:b.amountJpy,reason:b.reason})).digest('hex');
  const result=await transaction(req,async(c,contract,request,assertCurrent)=>{
   const old=(await c.query('SELECT * FROM commercial_refund_reviews WHERE request_id=$1 AND operation_id=$2',[request.id,operation])).rows[0];
   if(old){if(old.decision_fingerprint!==fingerprint)throw conflict('Refund review operation changed');return out(old)}
   const latest=(await c.query('SELECT revision FROM commercial_refund_reviews WHERE request_id=$1 ORDER BY revision DESC LIMIT 1',[request.id])).rows[0];
   if((latest?.revision??0)!==b.expectedRevision)throw conflict('Refund review revision changed');
   if(b.amountJpy>Number(request.requested_amount_jpy))throw authHttpError(400,'PS018','Review amount exceeds this request');
   let balance=null;
   if(b.decision==='approved'){
    const binding=await refundPaymentBinding(c,request,contract,contract.user_id);let current=null;
    await assertCurrent();try{if(typeof lookup==='function')current=await lookup({account:request.account_id,paymentIntentId:request.provider_object_id})}catch{}
    balance=liveRefundBalance(binding,current);await assertCurrent();
    if(!balance.qualified||b.amountJpy>balance.availableRefundJpy)throw conflict('Current refund balance does not qualify this review');
    // All claims for this contract serialize on its row. Count only each
    // other request's latest decision, never historical superseded approvals.
    const allocated=BigInt((await c.query(`SELECT COALESCE(sum(v.amount_jpy),0)::text AS amount FROM
     (SELECT DISTINCT ON (request_id) request_id,decision,amount_jpy FROM commercial_refund_reviews
      WHERE contract_id=$1 ORDER BY request_id,revision DESC) v
     JOIN commercial_refund_requests r ON r.id=v.request_id
     WHERE r.account_id=$2 AND r.provider_object_id=$3 AND r.id<>$4 AND v.decision='approved'`,[contract.id,request.account_id,request.provider_object_id,request.id])).rows[0].amount);
    if(allocated+BigInt(b.amountJpy)>BigInt(balance.availableRefundJpy))throw conflict('Other approvals use this payment balance');
    balance={...balance,otherApprovedJpy:Number(allocated),checkedAt:(await c.query('SELECT clock_timestamp() AS now')).rows[0].now};
   }
   const row=(await c.query('INSERT INTO commercial_refund_reviews(id,request_id,contract_id,request_fingerprint,requested_amount_jpy,operation_id,decision_fingerprint,reviewer_id,revision,decision,amount_jpy,reason,balance) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) RETURNING *',[randomUUID(),request.id,contract.id,request.request_fingerprint,request.requested_amount_jpy,operation,fingerprint,req.auth.userId,b.expectedRevision+1,b.decision,b.amountJpy,b.reason,balance?JSON.stringify(balance):null])).rows[0];return out(row);
  });res.status(201).json(result);
 }catch(e){sendAuthError(res,e)}});
}
