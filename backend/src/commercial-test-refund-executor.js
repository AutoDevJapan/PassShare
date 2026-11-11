import {createHash} from 'node:crypto';
import Stripe from 'stripe';

const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const rejected=()=>({state:'rejected',refund:null,meaning:'sandbox_refund_not_issued'});
const uncertain=()=>({state:'uncertain',refund:null,meaning:'provider_result_unknown_reconcile_same_operation'});
function resultFor(refund,o){
 const pi=typeof refund?.payment_intent==='string'?refund.payment_intent:refund?.payment_intent?.id;
 if(refund?.object!=='refund'||!/^((re|pyr)_[A-Za-z0-9]+)$/.test(refund.id??'')||pi!==o.paymentIntentId||refund.amount!==o.approvedAmountJpy||refund.currency!=='jpy'||!['succeeded','pending','requires_action','failed','canceled'].includes(refund.status)||refund.metadata?.operationId!==o.operationId.toLowerCase()||refund.metadata?.decisionFingerprint!==o.decisionFingerprint)return uncertain();
 return {state:refund.status,refund:{id:refund.id,paymentIntentId:pi,amountJpy:refund.amount,currency:refund.currency},meaning:'sandbox_provider_result_not_live_refund'};
}

// This adapter has no Live credential path. The caller must persist and
// authorize one immutable sandbox operation before crossing this boundary.
export function createTestRefundExecutor({key=process.env.PASSSHARE_STRIPE_TEST_REFUND_EXECUTION_KEY,account=process.env.PASSSHARE_STRIPE_TEST_ACCOUNT,scope=process.env.PASSSHARE_STRIPE_TEST_ENDPOINT_SCOPE??'connect',fetchImpl=globalThis.fetch}={}){
 if(typeof key!=='string'||!/^(sk|rk)_test_[A-Za-z0-9_]+$/.test(key)||!/^acct_[A-Za-z0-9]+$/.test(account??'')||!['direct','connect'].includes(scope))return null;
 return async (operation,authorize)=>{
  const o=operation;
  if(!o||o.account!==account||!/^pi_[A-Za-z0-9]+$/.test(o.paymentIntentId??'')||!uuid(o.contractId)||!uuid(o.ownerId)||!uuid(o.operationId)||!hash(o.quoteHash)||!hash(o.decisionFingerprint)||!Number.isSafeInteger(o.paymentAmountJpy)||o.paymentAmountJpy<1||!Number.isSafeInteger(o.approvedAmountJpy)||o.approvedAmountJpy<1||o.approvedAmountJpy>o.paymentAmountJpy)return rejected();
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
  try{
   const client=new Stripe(key,{timeout:5000,maxNetworkRetries:0,httpClient:Stripe.createFetchHttpClient((url,options)=>fetchImpl(url,{...options,signal:AbortSignal.any([controller.signal,...(options?.signal?[options.signal]:[])])}))});
   const payment=await client.paymentIntents.retrieve(o.paymentIntentId,{}, {stripeAccount:account}),m=payment.metadata;
   if(payment.object!=='payment_intent'||payment.id!==o.paymentIntentId||payment.livemode!==false||payment.status!=='succeeded'||payment.currency!=='jpy'||payment.amount!==o.paymentAmountJpy||payment.amount_received!==o.paymentAmountJpy||m?.contractId!==o.contractId||m?.ownerId!==o.ownerId||m?.quoteHash!==o.quoteHash)return rejected();
   const refunds=[],seen=new Set();let after,complete=false;
   for(let pageIndex=0;pageIndex<10;pageIndex++){
    const page=await client.refunds.list({payment_intent:o.paymentIntentId,limit:100,...(after?{starting_after:after}:{})},{stripeAccount:account});
    if(!Array.isArray(page.data)||page.data.length>100||typeof page.has_more!=='boolean')return uncertain();
    for(const r of page.data){const pi=typeof r?.payment_intent==='string'?r.payment_intent:r?.payment_intent?.id;if(r?.object!=='refund'||typeof r.id!=='string'||seen.has(r.id)||pi!==o.paymentIntentId||r.currency!=='jpy'||r.livemode===true||!Number.isSafeInteger(r.amount)||r.amount<1||!['succeeded','pending','requires_action','failed','canceled'].includes(r.status))return uncertain();seen.add(r.id);refunds.push(r)}
    if(!page.has_more){complete=true;break}if(page.data.length===0)return uncertain();after=page.data.at(-1).id;
   }
   if(!complete)return uncertain();
   const existing=refunds.filter(r=>r.metadata?.operationId===o.operationId.toLowerCase());
   if(existing.length>0)return existing.length===1?resultFor(existing[0],o):uncertain();
   const reserved=refunds.filter(r=>['succeeded','pending','requires_action'].includes(r.status)).reduce((n,r)=>n+BigInt(r.amount),0n);
   if(reserved+BigInt(o.approvedAmountJpy)>BigInt(o.paymentAmountJpy))return rejected();
   if(typeof authorize!=='function'||await authorize()!==true)return rejected();
   const identity=JSON.stringify({account,paymentIntent:o.paymentIntentId,contract:o.contractId,owner:o.ownerId,quote:o.quoteHash,operation:o.operationId.toLowerCase(),decision:o.decisionFingerprint,amount:o.approvedAmountJpy});
   const idempotencyKey='passshare-test-refund-'+createHash('sha256').update(identity).digest('hex');
   const refund=await client.refunds.create({payment_intent:o.paymentIntentId,amount:o.approvedAmountJpy,metadata:{operationId:o.operationId.toLowerCase(),decisionFingerprint:o.decisionFingerprint}},{stripeAccount:account,idempotencyKey});
   return resultFor(refund,o);
  }catch{return uncertain()}
  finally{clearTimeout(timer);controller.abort()}
 };
}
