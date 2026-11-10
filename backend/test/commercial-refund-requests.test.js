import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import Stripe from 'stripe';
import {trackPoolShutdown} from './helpers/pg-fixture-lifecycle.js';

test('refund requests bind signed paid evidence, remain private and never execute a refund',{skip:process.env.PASSSHARE_RECEIPTS_PG!=='true'},async()=>{
 const url=new URL(process.env.DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.username,'passshare');assert.equal(url.pathname,'/passshare');
 const admin=new pg.Pool({connectionString:url.href}),db='ps_refund_requests_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+db);url.pathname='/'+db;
 const pool=new pg.Pool({connectionString:url.href}),close=trackPoolShutdown(pool),secret='whsec_refund_request_fixture',account='acct_refundrequests',password='synthetic-refund-request-password';let server;
 const envKeys=['PASSSHARE_COMMERCIAL_LIVE_ENABLED','PASSSHARE_STRIPE_LIVE_WEBHOOK_SECRET','PASSSHARE_STRIPE_LIVE_ACCOUNT','PASSSHARE_STRIPE_TEST_WEBHOOK_SECRET','PASSSHARE_STRIPE_TEST_ACCOUNT','PASSSHARE_STRIPE_TEST_ENDPOINT_SCOPE'],oldEnv=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));
 Object.assign(process.env,{PASSSHARE_COMMERCIAL_LIVE_ENABLED:'true',PASSSHARE_STRIPE_LIVE_WEBHOOK_SECRET:secret,PASSSHARE_STRIPE_LIVE_ACCOUNT:account,PASSSHARE_STRIPE_TEST_WEBHOOK_SECRET:'whsec_refund_request_test',PASSSHARE_STRIPE_TEST_ACCOUNT:account,PASSSHARE_STRIPE_TEST_ENDPOINT_SCOPE:'connect'});
 try{
  const {createApp}=await import('../src/app.js');const {app}=await createApp({pool});server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));let base='http://127.0.0.1:'+server.address().port;
  const call=async(path,token,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(base+path,{method,headers:{'content-type':'application/json','x-passshare-client':'mobile',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,cache:r.headers.get('cache-control'),body:await r.json().catch(()=>null)}};
  const id=p=>p+randomUUID().replaceAll('-',''),actors=[];
  for(let i=0;i<2;i++){const email=id('request-')+'@example.test',r=await call('/api/auth/signup',null,{email,password});assert.equal(r.status,201);actors.push({...r.body,email})}
  const [owner,other]=actors;
  const quote=async actor=>{const q=await call('/api/commercial-contracts',actor.refreshToken,{requestId:randomUUID(),currency:'JPY',plan:{type:'personal',users:1},setup:{installationCompanies:0,supportHours:0,maintenanceMonthlyJpy:null}});assert.equal(q.status,201);assert.equal((await call('/api/commercial-contracts/'+q.body.id+'/accept',actor.refreshToken,{quoteHash:q.body.quoteHash})).status,200);return q.body};
  const send=async(q,actor,sandbox=false)=>{const event={id:id('evt_'),account,type:'payment_intent.succeeded',livemode:!sandbox,created:Math.floor(Date.now()/1000),data:{object:{id:id('pi_'),object:'payment_intent',status:'succeeded',currency:'jpy',amount:980,amount_received:980,livemode:!sandbox,metadata:{contractId:q.id,ownerId:actor.user.id,quoteHash:q.quoteHash,cycle:'1'}}}};const payload=JSON.stringify(event),r=await fetch(base+'/api/commercial-events/stripe-'+(sandbox?'test':'live'),{method:'POST',headers:{'content-type':'application/json','stripe-signature':Stripe.webhooks.generateTestHeaderString({payload,secret:sandbox?'whsec_refund_request_test':secret})},body:payload});assert.equal(r.status,200,JSON.stringify(await r.json()));return event};
  const q=await quote(owner),otherQuote=await quote(other),payment=await send(q,owner),otherPayment=await send(otherQuote,other);
  const path='/api/commercial-contracts/'+q.id+'/refund-requests',request={requestId:randomUUID(),paymentIntentId:payment.data.object.id,amountJpy:400,reason:'service_unprovided'};
  const before=(await pool.query('SELECT * FROM commercial_live_periods WHERE contract_id=$1',[q.id])).rows;
  const first=await call(path,owner.refreshToken,request);assert.equal(first.status,201,JSON.stringify(first.body));
  assert.equal(first.cache,'no-store');assert.equal(first.body.requestedAmountJpy,400);assert.equal(first.body.paymentAmountJpy,980);assert.equal(first.body.paymentEvidence,'provider_live');assert.equal(first.body.status,'received');assert.equal(first.body.refundExecuted,false);assert.equal(first.body.approvalGranted,false);assert.equal(first.body.approvedAmountJpy,null);
  const retries=await Promise.all([call(path,owner.refreshToken,request),call(path,owner.refreshToken,request)]);for(const r of retries){assert.equal(r.status,201);assert.deepEqual(r.body,first.body)}
  assert.equal((await call(path,owner.refreshToken,{...request,amountJpy:401})).status,409);
  for(const bad of [{...request,requestId:randomUUID(),amountJpy:981},{...request,requestId:randomUUID(),amountJpy:0},{...request,requestId:randomUUID(),amountJpy:0.5},{...request,requestId:randomUUID(),reason:'automatic_approval'},{...request,requestId:randomUUID(),paid:true},{...request,requestId:randomUUID(),ownerId:owner.user.id}])assert.equal((await call(path,owner.refreshToken,bad)).status,400);
  assert.equal((await call(path,other.refreshToken,request)).status,404);assert.equal((await call(path,null,request)).status,401);
  assert.equal((await call(path,owner.refreshToken,{...request,requestId:randomUUID(),paymentIntentId:otherPayment.data.object.id})).status,409);
  const unpaid=await quote(owner);assert.equal((await call('/api/commercial-contracts/'+unpaid.id+'/refund-requests',owner.refreshToken,{...request,requestId:randomUUID()})).status,409);
  const sandbox=await quote(owner),testPayment=await send(sandbox,owner,true);assert.equal((await call('/api/commercial-contracts/'+sandbox.id+'/refund-requests',owner.refreshToken,{...request,requestId:randomUUID(),paymentIntentId:testPayment.data.object.id})).status,409,'Sandbox evidence cannot establish a paid refund claim');
  const get=path+'/'+first.body.id;assert.deepEqual((await call(get,owner.refreshToken)).body,first.body);assert.equal((await call(get,other.refreshToken)).status,404);assert.equal((await call(get)).status,401);
  assert.equal((await call('/api/commercial-contracts/'+otherQuote.id+'/refund-requests/'+first.body.id,other.refreshToken)).status,404);
  const legal=await call(path,owner.refreshToken,{...request,requestId:randomUUID(),reason:'statutory_right'});assert.equal(legal.status,201,'Intake must not decide away legal rights');
  const otherRequest=await call('/api/commercial-contracts/'+otherQuote.id+'/refund-requests',other.refreshToken,{...request,requestId:randomUUID(),paymentIntentId:otherPayment.data.object.id,reason:'duplicate_charge'});assert.equal(otherRequest.status,201);
  const stored=(await pool.query('SELECT * FROM commercial_refund_requests WHERE id=$1',[first.body.id])).rows[0];assert.equal(stored.quote_hash,q.quoteHash);assert.equal(stored.payment_event_hash,before[0].event_hash);assert.equal(stored.payment_amount_jpy,'980');assert.ok(stored.requested_at instanceof Date);
  await assert.rejects(pool.query('UPDATE commercial_refund_requests SET contract_id=$2 WHERE id=$1',[first.body.id,otherQuote.id]),e=>e.code==='23503');
  await assert.rejects(pool.query('UPDATE commercial_refund_requests SET requested_amount_jpy=981 WHERE id=$1',[first.body.id]),e=>e.code==='23514');
  assert.deepEqual((await pool.query('SELECT * FROM commercial_live_periods WHERE contract_id=$1',[q.id])).rows,before,'Intake cannot mutate paid periods');
  // Recreate the HTTP application to verify durable receipts, then use its
  // normal request budget for the independent session-revocation lifecycle.
  server.closeAllConnections();await new Promise(r=>server.close(r));const restarted=await createApp({pool});server=restarted.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;
  assert.deepEqual((await call(get,owner.refreshToken)).body,first.body);
  const competing={...request,requestId:randomUUID()};const race=await Promise.all([call(path,owner.refreshToken,competing),call(path,owner.refreshToken,{...competing,amountJpy:401})]);assert.deepEqual(race.map(r=>r.status).sort(),[201,409]);
  assert.deepEqual((await call(path,owner.refreshToken,{...request,requestId:request.requestId.toUpperCase()})).body,first.body);
  assert.equal((await call('/api/auth/logout',owner.refreshToken,{})).status,204);assert.equal((await call(get,owner.refreshToken)).status,401);assert.equal((await call(path,owner.refreshToken,request)).status,401);
  owner.refreshToken=(await call('/api/auth/login',null,{email:owner.email,password})).body.refreshToken;assert.deepEqual((await call(get,owner.refreshToken)).body,first.body);
  assert.equal((await call('/api/auth/account',owner.refreshToken,{currentPassword:password,confirmationEmail:owner.email},'DELETE')).status,204);assert.equal((await pool.query('SELECT count(*)::int n FROM commercial_refund_requests WHERE contract_id=$1',[q.id])).rows[0].n,0);assert.equal((await pool.query('SELECT count(*)::int n FROM commercial_refund_requests WHERE contract_id=$1',[otherQuote.id])).rows[0].n,1);assert.equal((await call(get,owner.refreshToken)).status,401);
 }finally{
  if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}await close();await admin.query('DROP DATABASE '+db+' WITH (FORCE)');await admin.end();for(const [key,value]of Object.entries(oldEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value}
 }
});
