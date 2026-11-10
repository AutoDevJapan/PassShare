import Stripe from 'stripe';

// Read-only, test-mode credential. No live key or caller-selected API origin is
// accepted. Current state comes from authenticated provider reads, never from
// webhook timestamps or a client-provided assertion.
export function createTestRefundLookup({key=process.env.PASSSHARE_STRIPE_TEST_READ_KEY,account=process.env.PASSSHARE_STRIPE_TEST_ACCOUNT,scope=process.env.PASSSHARE_STRIPE_TEST_ENDPOINT_SCOPE??'connect',fetchImpl=globalThis.fetch}={}){
 if(typeof key!=='string'||!/^(sk|rk)_test_[A-Za-z0-9_]+$/.test(key)||!/^acct_[A-Za-z0-9]+$/.test(account??'')||!['direct','connect'].includes(scope))return null;
 return async binding=>{
  if(binding.account!==account)return null;
  const abort=new AbortController();let timer;
  const timeout=new Promise(resolve=>{timer=setTimeout(()=>{abort.abort();resolve(null)},5000)});
  const work=async()=>{
   try{
    const httpClient=Stripe.createFetchHttpClient((url,options)=>fetchImpl(url,{...options,signal:AbortSignal.any([abort.signal,...(options?.signal?[options.signal]:[])])}));
    const client=new Stripe(key,{httpClient,timeout:5000,maxNetworkRetries:0});
    // Bind the authenticated read to the configured account in both event
    // formats. A direct webhook omits event.account; that is not API authority.
    const options={stripeAccount:account};
    const payment=await client.paymentIntents.retrieve(binding.paymentIntentId,{},options);
    if(payment.livemode!==false)return null;
    const refunds=[],seen=new Set();let after;
    for(let pageIndex=0;pageIndex<10;pageIndex++){
     const page=await client.refunds.list({payment_intent:binding.paymentIntentId,limit:100,...(after?{starting_after:after}:{})},options);
     if(!Array.isArray(page.data)||page.data.length>100||typeof page.has_more!=='boolean')return null;
     for(const refund of page.data){if(typeof refund.id!=='string'||seen.has(refund.id))return null;seen.add(refund.id);refunds.push(refund)}
     if(!page.has_more)return {account,payment,refunds};
     if(page.data.length===0)return null;
     after=page.data.at(-1).id;
    }
    return null; // A truncated provider inventory never qualifies a balance.
   }catch{return null;}
  };
  try{return await Promise.race([work(),timeout])}finally{clearTimeout(timer);abort.abort()}
 };
}
