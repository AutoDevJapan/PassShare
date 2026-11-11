import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';

const account='acct_sandboxexecutor',key='rk_test_refund_execution_fixture';
const operation=()=>({account,paymentIntentId:'pi_sandboxexecutor',contractId:randomUUID(),ownerId:randomUUID(),quoteHash:'a'.repeat(64),paymentAmountJpy:980,approvedAmountJpy:400,operationId:randomUUID(),decisionFingerprint:'b'.repeat(64)});

async function fixture(){
 const requests=[],payments=new Map(),replies=new Map();let refundCount=0,dropFirst=false,externalRefunds=[],hideCreated=false;
 const server=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=new URLSearchParams(Buffer.concat(chunks).toString()),url=new URL(req.url,'http://127.0.0.1');
  requests.push({method:req.method,path:url.pathname,account:req.headers['stripe-account'],key:req.headers['idempotency-key'],body:Object.fromEntries(body)});
  const json=(code,value)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(value))};
  if(req.headers.authorization!=='Bearer '+key||req.headers['stripe-account']!==account)return json(401,{error:{type:'authentication_error',message:'Fixture account mismatch'}});
  if(req.method==='GET'&&url.pathname.startsWith('/v1/payment_intents/'))return json(200,payments.get(url.pathname.split('/').at(-1)));
  if(req.method==='GET'&&url.pathname==='/v1/refunds')return json(200,{object:'list',has_more:false,data:[...(hideCreated?[]:replies.values()),...externalRefunds]});
  if(req.method==='POST'&&url.pathname==='/v1/refunds'){
   const idempotency=req.headers['idempotency-key'];
   if(!replies.has(idempotency))replies.set(idempotency,{id:'re_execution'+(++refundCount),object:'refund',payment_intent:body.get('payment_intent'),amount:Number(body.get('amount')),currency:'jpy',status:'succeeded',metadata:{operationId:body.get('metadata[operationId]'),decisionFingerprint:body.get('metadata[decisionFingerprint]')}});
   if(dropFirst){dropFirst=false;req.socket.destroy();return}
   return json(200,replies.get(idempotency));
  }
  return json(404,{error:{type:'invalid_request_error',message:'Unexpected fixture request'}});
 });
 server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 return {requests,payments,replies,get refundCount(){return refundCount},set dropFirst(v){dropFirst=v},set hideCreated(v){hideCreated=v},set externalRefunds(v){externalRefunds=v},fetchImpl:(url,options)=>{const u=new URL(url);assert.equal(u.origin,'https://api.stripe.com');return fetch(base+u.pathname+u.search,options)},async close(){server.closeAllConnections();await new Promise(r=>server.close(r))}};
}

test('sandbox executor rejects live/unconfigured authority before any provider mutation',async()=>{
 const {createTestRefundExecutor}=await import('../src/commercial-test-refund-executor.js');
 for(const candidate of [undefined,'sk_live_forbidden','rk_live_forbidden','pk_test_public',''])assert.equal(createTestRefundExecutor({key:candidate,account,fetchImpl:()=>{throw Error('No network permitted')}}),null);
 for(const candidate of ['', 'invalid'])assert.equal(createTestRefundExecutor({key,account:candidate}),null);
 assert.equal(createTestRefundExecutor({key,account,scope:'unknown'}),null);
});

test('sandbox executor binds current test payment and uses one stable provider idempotency key',async()=>{
 const {createTestRefundExecutor}=await import('../src/commercial-test-refund-executor.js'),f=await fixture(),op=operation();
 try{
  f.payments.set(op.paymentIntentId,{id:op.paymentIntentId,object:'payment_intent',livemode:false,status:'succeeded',amount:980,amount_received:980,currency:'jpy',metadata:{contractId:op.contractId,ownerId:op.ownerId,quoteHash:op.quoteHash}});
  const execute=createTestRefundExecutor({key,account,scope:'direct',fetchImpl:f.fetchImpl});
  let authorizations=0;const authorize=async()=>{authorizations++;return true};const first=await execute(op,authorize),retry=await execute(op,authorize);assert.equal(first.state,'succeeded');assert.equal(first.refund.amountJpy,400);assert.equal(first.refund.paymentIntentId,op.paymentIntentId);assert.deepEqual(retry,first);assert.equal(f.refundCount,1);assert.equal(authorizations,1,'Fresh authority required before every POST; readback does not mutate');
  const mutations=f.requests.filter(r=>r.method==='POST');assert.equal(mutations.length,1);assert.match(mutations[0].key,/^passshare-test-refund-[a-f0-9]{64}$/);assert.equal(mutations[0].body.amount,'400');assert.equal(mutations[0].body.payment_intent,op.paymentIntentId);assert.equal(mutations[0].body['metadata[operationId]'],op.operationId);assert.equal(mutations[0].body['metadata[decisionFingerprint]'],op.decisionFingerprint);assert.ok(f.requests.every(r=>r.account===account));
 }finally{await f.close()}
});

test('sandbox executor refuses mode/owner/hash/amount mismatch and malformed operation before POST',async()=>{
 const {createTestRefundExecutor}=await import('../src/commercial-test-refund-executor.js'),f=await fixture(),op=operation();
 try{
  const payment={id:op.paymentIntentId,object:'payment_intent',livemode:false,status:'succeeded',amount:980,amount_received:980,currency:'jpy',metadata:{contractId:op.contractId,ownerId:op.ownerId,quoteHash:op.quoteHash}};
  const execute=createTestRefundExecutor({key,account,fetchImpl:f.fetchImpl});
  for(const patch of [{livemode:true},{currency:'usd'},{status:'processing'},{amount_received:979},{metadata:{...payment.metadata,ownerId:randomUUID()}},{metadata:{...payment.metadata,quoteHash:'c'.repeat(64)}}]){f.payments.set(op.paymentIntentId,{...payment,...patch});assert.equal((await execute(op)).state,'rejected')}
  f.payments.set(op.paymentIntentId,payment);
  for(const patch of [{account:'acct_other'},{approvedAmountJpy:981},{approvedAmountJpy:0},{approvedAmountJpy:1.1},{operationId:'not-uuid'},{decisionFingerprint:'not-a-hash'}])assert.equal((await execute({...op,...patch})).state,'rejected');
  f.externalRefunds=[{id:'re_reserved',object:'refund',payment_intent:op.paymentIntentId,currency:'jpy',amount:600,status:'pending'}];assert.equal((await execute(op)).state,'rejected','Fresh provider reservations reduce dispatch balance');
  f.externalRefunds=[{id:'re_unknown',object:'refund',payment_intent:op.paymentIntentId,currency:'jpy',amount:100,status:'unknown'}];assert.equal((await execute(op)).state,'uncertain','Unknown provider status cannot qualify a mutation');
  f.externalRefunds=[];assert.equal((await execute(op)).state,'rejected','Missing final authority cannot authorize dispatch');assert.equal((await execute(op,async()=>false)).state,'rejected','Revoked authority after provider reads cannot authorize dispatch');
  assert.equal(f.requests.filter(r=>r.method==='POST').length,0);
 }finally{await f.close()}
});

test('lost sandbox provider response stays uncertain and retry preserves operation identity',async()=>{
 const {createTestRefundExecutor}=await import('../src/commercial-test-refund-executor.js'),f=await fixture(),op=operation();
 try{
  f.payments.set(op.paymentIntentId,{id:op.paymentIntentId,object:'payment_intent',livemode:false,status:'succeeded',amount:980,amount_received:980,currency:'jpy',metadata:{contractId:op.contractId,ownerId:op.ownerId,quoteHash:op.quoteHash}});f.dropFirst=true;
  const execute=createTestRefundExecutor({key,account,fetchImpl:f.fetchImpl});const lost=await execute(op,async()=>true);assert.equal(lost.state,'uncertain');assert.equal(lost.refund,null);assert.equal(f.refundCount,1);
  const retry=await execute(op);assert.equal(retry.state,'succeeded');assert.equal(f.refundCount,1);const sent=f.requests.filter(r=>r.method==='POST');assert.equal(sent.length,1,'Matching provider metadata reconciles a lost response without another POST');
 }finally{await f.close()}
});

test('uncertain retry reuses the identical provider key when current inventory has not exposed the first refund',async()=>{
 const {createTestRefundExecutor}=await import('../src/commercial-test-refund-executor.js'),f=await fixture(),op=operation();
 try{
  f.payments.set(op.paymentIntentId,{id:op.paymentIntentId,object:'payment_intent',livemode:false,status:'succeeded',amount:980,amount_received:980,currency:'jpy',metadata:{contractId:op.contractId,ownerId:op.ownerId,quoteHash:op.quoteHash}});f.dropFirst=true;f.hideCreated=true;
  const execute=createTestRefundExecutor({key,account,fetchImpl:f.fetchImpl});assert.equal((await execute(op,async()=>true)).state,'uncertain');assert.equal((await execute(op,async()=>true)).state,'succeeded');
  const posts=f.requests.filter(r=>r.method==='POST');assert.equal(posts.length,2);assert.equal(posts[0].key,posts[1].key);assert.deepEqual(posts[0].body,posts[1].body);assert.equal(f.refundCount,1,'Repeated dispatch cannot create a second refund when the result was lost');
 }finally{await f.close()}
});
