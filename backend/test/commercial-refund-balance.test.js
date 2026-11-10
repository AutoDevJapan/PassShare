import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import Stripe from 'stripe';
import {trackPoolShutdown} from './helpers/pg-fixture-lifecycle.js';
import {liveRefundProviderFixture} from './helpers/refund-provider-fixture.js';
import {createLiveRefundLookup} from '../src/commercial-refund-provider.js';
import {liveRefundBalance} from '../src/commercial-refund-requests.js';

test('a malformed current inventory cannot reuse a previously qualified balance',()=>{
 const binding={account:'acct_unitbalance',paymentIntentId:'pi_unitbalance',amountJpy:980,contractId:randomUUID(),ownerId:randomUUID(),quoteHash:'a'.repeat(64),requestedAmountJpy:400};
 const payment={id:binding.paymentIntentId,object:'payment_intent',livemode:true,status:'succeeded',currency:'jpy',amount:980,amount_received:980,metadata:{ownerId:binding.ownerId,contractId:binding.contractId,quoteHash:binding.quoteHash}};
 const refund={id:'re_unitbalance',object:'refund',payment_intent:payment.id,status:'succeeded',amount:200,currency:'jpy'},good={account:binding.account,payment,inventoryComplete:true,refunds:[refund]};
 assert.equal(liveRefundBalance(binding,good).availableRefundJpy,780);
 for(const bad of [null,{...good,inventoryComplete:false},{...good,payment:{...payment,id:'pi_other'}},{...good,payment:{...payment,currency:'usd'}},{...good,payment:{...payment,metadata:{...payment.metadata,quoteHash:'b'.repeat(64)}}},{...good,payment:{...payment,metadata:{...payment.metadata,contractId:randomUUID()}}},{...good,refunds:[refund,refund]},{...good,refunds:[{...refund,status:'failed',amount:981}]},{...good,refunds:[{...refund,status:'pending',amount:700},{...refund,id:'re_second',status:'requires_action',amount:400}]},{...good,refunds:[{...refund,amount:Number.MAX_SAFE_INTEGER+1}]},{...good,refunds:[{...refund,status:null}]}]){
  const r=liveRefundBalance(binding,bad);assert.equal(r.qualified,false);assert.equal(r.availableRefundJpy,0);assert.equal(r.confirmedRefundedJpy,0);assert.equal(r.reservedRefundJpy,0);assert.equal(r.requestAmountAvailable,false);
 }
 assert.equal(liveRefundBalance(binding,{...good,refunds:[{...refund,status:'failed'},{...refund,id:'re_canceled',status:'canceled'}]}).availableRefundJpy,980);
});

test('refund balance uses current provider truth without approving, reserving or changing paid rights',{skip:process.env.PASSSHARE_RECEIPTS_PG!=='true'},async()=>{
 const url=new URL(process.env.DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.username,'passshare');assert.equal(url.pathname,'/passshare');
 const admin=new pg.Pool({connectionString:url.href}),db='ps_refund_balance_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+db);url.pathname='/'+db;
 const pool=new pg.Pool({connectionString:url.href}),close=trackPoolShutdown(pool),secret='whsec_balance_fixture',account='acct_balancefixture',password='synthetic-balance-password';let server,current=null,reads=0,blocker,pending;
 const keys=['PASSSHARE_COMMERCIAL_LIVE_ENABLED','PASSSHARE_STRIPE_LIVE_WEBHOOK_SECRET','PASSSHARE_STRIPE_LIVE_ACCOUNT','PASSSHARE_STRIPE_LIVE_ENDPOINT_SCOPE'],saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 Object.assign(process.env,{PASSSHARE_COMMERCIAL_LIVE_ENABLED:'true',PASSSHARE_STRIPE_LIVE_WEBHOOK_SECRET:secret,PASSSHARE_STRIPE_LIVE_ACCOUNT:account,PASSSHARE_STRIPE_LIVE_ENDPOINT_SCOPE:'connect'});
 try{
  const {createApp}=await import('../src/app.js');const {app}=await createApp({pool,liveRefundLookup:async binding=>{reads++;assert.equal(binding.account,account);return current}});server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
  const call=async(path,token,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(base+path,{method,headers:{'content-type':'application/json','x-passshare-client':'mobile',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,cache:r.headers.get('cache-control'),body:await r.json().catch(()=>null)}};
  const owner=(await call('/api/auth/signup',null,{email:randomUUID()+'@example.test',password})).body,other=(await call('/api/auth/signup',null,{email:randomUUID()+'@example.test',password})).body;
  const q=(await call('/api/commercial-contracts',owner.refreshToken,{requestId:randomUUID(),currency:'JPY',plan:{type:'personal',users:1},setup:{installationCompanies:0,supportHours:0,maintenanceMonthlyJpy:null}})).body;
  assert.equal((await call('/api/commercial-contracts/'+q.id+'/accept',owner.refreshToken,{quoteHash:q.quoteHash})).status,200);
  const payment={id:'pi_'+randomUUID().replaceAll('-',''),object:'payment_intent',livemode:true,status:'succeeded',currency:'jpy',amount:980,amount_received:980,metadata:{contractId:q.id,ownerId:owner.user.id,quoteHash:q.quoteHash,cycle:'1'}};
  const event={id:'evt_'+randomUUID().replaceAll('-',''),account,type:'payment_intent.succeeded',livemode:true,created:Math.floor(Date.now()/1000),data:{object:payment}},payload=JSON.stringify(event);
  const delivery=await fetch(base+'/api/commercial-events/stripe-live',{method:'POST',headers:{'content-type':'application/json','stripe-signature':Stripe.webhooks.generateTestHeaderString({payload,secret})},body:payload});assert.equal(delivery.status,200);
  const path='/api/commercial-contracts/'+q.id+'/refund-requests',receipt=await call(path,owner.refreshToken,{requestId:randomUUID(),paymentIntentId:payment.id,amountJpy:400,reason:'service_unprovided'});assert.equal(receipt.status,201);
  const reconcile=path+'/'+receipt.body.id+'/reconcile',before=(await pool.query('SELECT * FROM commercial_live_periods WHERE contract_id=$1',[q.id])).rows;
  current={account,payment,inventoryComplete:true,refunds:[{id:'re_succeeded',object:'refund',payment_intent:payment.id,currency:'jpy',amount:200,status:'succeeded'},{id:'re_pending',object:'refund',payment_intent:payment.id,currency:'jpy',amount:300,status:'pending'},{id:'re_failed',object:'refund',payment_intent:payment.id,currency:'jpy',amount:400,status:'failed'}]};
  const first=await call(reconcile,owner.refreshToken,{});assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.cache,'no-store');assert.equal(first.body.balance.qualified,true);assert.equal(first.body.balance.confirmedRefundedJpy,200);assert.equal(first.body.balance.reservedRefundJpy,500);assert.equal(first.body.balance.availableRefundJpy,480);assert.equal(first.body.balance.statusBasis,'provider_api_live');assert.equal(first.body.balance.requestAmountAvailable,true);assert.ok(first.body.balance.checkedAt);assert.equal(first.body.approvalGranted,false);assert.equal(first.body.refundExecuted,false);
  const readCount=reads;assert.equal((await call(reconcile,other.refreshToken,{})).status,404);assert.equal((await call(reconcile,null,{})).status,401);assert.equal((await call(reconcile,owner.refreshToken,{paid:true})).status,400);assert.equal(reads,readCount,'Unauthorized/spoofed requests must not query provider');
  current.refunds[1].status='succeeded';current.refunds.push({id:'re_action',object:'refund',payment_intent:payment.id,currency:'jpy',amount:200,status:'requires_action'});
  const newer=await call(reconcile,owner.refreshToken,{});assert.equal(newer.body.balance.confirmedRefundedJpy,500);assert.equal(newer.body.balance.availableRefundJpy,280);assert.equal(newer.body.balance.requestAmountAvailable,false);
  for(const bad of [null,{...current,account:'acct_other'},{...current,payment:{...payment,livemode:false}},{...current,payment:{...payment,amount_received:979}},{...current,payment:{...payment,metadata:{...payment.metadata,ownerId:other.user.id}}},{...current,refunds:[{...current.refunds[0],payment_intent:'pi_other'}]},{...current,refunds:[{...current.refunds[0],status:'unknown'}]},{...current,refunds:[{...current.refunds[0],amount:981}]}]){current=bad;const r=await call(reconcile,owner.refreshToken,{});assert.equal(r.status,200);assert.equal(r.body.balance.qualified,false);assert.equal(r.body.balance.availableRefundJpy,0);assert.equal(r.body.balance.confirmedRefundedJpy,0);assert.equal(r.body.balance.checkedAt,null);assert.equal(r.body.balance.statusBasis,'status_review');}
  assert.deepEqual((await call(path+'/'+receipt.body.id,owner.refreshToken)).body,receipt.body,'Historical request stays received, not financial authorization');assert.deepEqual((await pool.query('SELECT * FROM commercial_live_periods WHERE contract_id=$1',[q.id])).rows,before);
  const expiry=(await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE user_id=$1 RETURNING expires_at",[owner.user.id])).rows[0].expires_at;
  blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query('SELECT id FROM commercial_contracts WHERE id=$1 FOR UPDATE',[q.id]);const readsBeforeWait=reads;pending=call(reconcile,owner.refreshToken,{});
  let blocked=false;for(let i=0;i<1000;i++){if((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM commercial_contracts%FOR UPDATE%'")).rowCount){blocked=true;break}await new Promise(r=>setTimeout(r,10))}assert.equal(blocked,true,'Request must actually reach its contract row lock');
  await pool.query('SELECT pg_sleep(GREATEST(EXTRACT(EPOCH FROM($1::timestamptz-clock_timestamp())),0))',[expiry]);await blocker.query('COMMIT');blocker.release();blocker=null;const afterWait=await pending;pending=null;assert.equal(afterWait.status,401);assert.equal(reads,readsBeforeWait,'Expiry during row-lock wait must stop before external provider access');
  owner.refreshToken=(await call('/api/auth/login',null,{email:owner.user.email,password})).body.refreshToken;
  assert.equal((await call('/api/auth/logout',owner.refreshToken,{})).status,204);const beforeRevoked=reads;assert.equal((await call(reconcile,owner.refreshToken,{})).status,401);assert.equal(reads,beforeRevoked);
  assert.equal((await call('/api/auth/account',other.refreshToken,{currentPassword:password,confirmationEmail:other.user.email},'DELETE')).status,204);
 }finally{
  if(blocker){await blocker.query('ROLLBACK').catch(()=>{});blocker.release()}if(pending)await pending.catch(()=>{});if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}await close();await admin.query('DROP DATABASE '+db+' WITH (FORCE)');await admin.end();for(const [k,v]of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v}
 }
});

test('current balance composes live-scoped provider HTTP, signed evidence, all request sources and session expiry',{skip:process.env.PASSSHARE_RECEIPTS_PG!=='true'},async()=>{
 const url=new URL(process.env.DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.username,'passshare');assert.equal(url.pathname,'/passshare');
 const admin=new pg.Pool({connectionString:url.href}),db='ps_live_balance_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+db);url.pathname='/'+db;
 const pool=new pg.Pool({connectionString:url.href}),close=trackPoolShutdown(pool),account='acct_httpbalance',secret='whsec_http_balance_fixture',provider=await liveRefundProviderFixture(account),password='synthetic-http-balance-password';
 const keys=['PASSSHARE_COMMERCIAL_LIVE_ENABLED','PASSSHARE_STRIPE_LIVE_WEBHOOK_SECRET','PASSSHARE_STRIPE_LIVE_ACCOUNT','PASSSHARE_STRIPE_LIVE_ENDPOINT_SCOPE','PASSSHARE_STRIPE_LIVE_READ_KEY'],saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 Object.assign(process.env,{PASSSHARE_COMMERCIAL_LIVE_ENABLED:'true',PASSSHARE_STRIPE_LIVE_WEBHOOK_SECRET:secret,PASSSHARE_STRIPE_LIVE_ACCOUNT:account,PASSSHARE_STRIPE_LIVE_ENDPOINT_SCOPE:'connect'});delete process.env.PASSSHARE_STRIPE_LIVE_READ_KEY;
 let server,barrier,entered,release,timeout;
 try{
  const lookup=createLiveRefundLookup({key:'rk_live_refund_http_fixture',account,fetchImpl:async(target,options)=>{if(barrier&&new URL(target).pathname==='/v1/refunds'){entered();await barrier}return provider.fetchImpl(target,options)}});
  const {createApp}=await import('../src/app.js');const {app}=await createApp({pool,liveRefundLookup:lookup});server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));let base='http://127.0.0.1:'+server.address().port;
  const call=async(path,token,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(base+path,{method,headers:{'content-type':'application/json','x-passshare-client':'mobile',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json().catch(()=>null)}};
  const email=randomUUID()+'@example.test',owner=(await call('/api/auth/signup',null,{email,password})).body;
  const q=(await call('/api/commercial-contracts',owner.refreshToken,{requestId:randomUUID(),currency:'JPY',plan:{type:'personal',users:1},setup:{installationCompanies:0,supportHours:0,maintenanceMonthlyJpy:null}})).body;assert.equal((await call('/api/commercial-contracts/'+q.id+'/accept',owner.refreshToken,{quoteHash:q.quoteHash})).status,200);
  const path='/api/commercial-contracts/'+q.id;
  const payment=async(amount,metadata)=>{const p={id:'pi_'+randomUUID().replaceAll('-',''),object:'payment_intent',livemode:true,status:'succeeded',currency:'jpy',amount,amount_received:amount,metadata:{contractId:q.id,ownerId:owner.user.id,...metadata}},event={id:'evt_'+randomUUID().replaceAll('-',''),type:'payment_intent.succeeded',account,livemode:true,created:Math.floor(Date.now()/1000),data:{object:p}},payload=JSON.stringify(event);provider.payments.set(p.id,p);const r=await fetch(base+'/api/commercial-events/stripe-live',{method:'POST',headers:{'content-type':'application/json','stripe-signature':Stripe.webhooks.generateTestHeaderString({payload,secret})},body:payload});const b=await r.json();assert.equal(r.status,200,JSON.stringify(b));return {p,result:b}};
  const period=await payment(980,{quoteHash:q.quoteHash,cycle:'1'});
  const seat=async users=>{const r=await call(path+'/seat-quotes',owner.refreshToken,{requestId:randomUUID(),requestedPlan:{type:'personal',users},roundingPolicy:'ceil-jpy'});assert.equal(r.status,201);assert.equal((await call(path+'/seat-quotes/'+r.body.id+'/accept',owner.refreshToken,{quoteHash:r.body.quoteHash})).status,200);return r.body};
  const firstSeat=await seat(2),staleSeat=await seat(3),applied=await payment(firstSeat.quote.proposedRoundedJpy,{quoteHash:firstSeat.quoteHash,cycle:'1',seatChangeId:firstSeat.id}),review=await payment(staleSeat.quote.proposedRoundedJpy,{quoteHash:staleSeat.quoteHash,cycle:'1',seatChangeId:staleSeat.id});assert.equal(applied.result.seatChangeApplied,true);assert.equal(review.result.refundReviewRequired,true);
  const decrease=await call(path+'/seat-decrease-quotes',owner.refreshToken,{requestId:randomUUID(),requestedPlan:{type:'personal',users:1}});assert.equal(decrease.status,201);assert.equal((await call(path+'/seat-decrease-quotes/'+decrease.body.id+'/accept',owner.refreshToken,{quoteHash:decrease.body.quoteHash})).status,200);
  const exception=await payment(979,{quoteHash:q.quoteHash,cycle:'2',seatDecreaseId:decrease.body.id,seatDecreaseQuoteHash:decrease.body.quoteHash});assert.equal(exception.result.refundReviewRequired,true);
  const tables=['commercial_live_periods','commercial_seat_changes','commercial_plan_payment_exceptions'];
  const financialRows=async()=>Promise.all(tables.map(async t=>(await pool.query('SELECT to_jsonb(t) AS row FROM '+t+' t WHERE contract_id=$1 ORDER BY to_jsonb(t)::text',[q.id])).rows));
  const before=await financialRows(),receipts=[];
  for(const [item,source]of [[period,'period'],[applied,'seat_change'],[review,'seat_change'],[exception,'payment_exception']]){const r=await call(path+'/refund-requests',owner.refreshToken,{requestId:randomUUID(),paymentIntentId:item.p.id,amountJpy:100,reason:'service_unprovided'});assert.equal(r.status,201);assert.equal(r.body.paymentSource,source);const balance=await call(path+'/refund-requests/'+r.body.id+'/reconcile',owner.refreshToken,{});assert.equal(balance.status,200,JSON.stringify(balance.body));assert.equal(balance.body.balance.qualified,true);assert.equal(balance.body.balance.availableRefundJpy,item.p.amount_received);assert.equal(balance.body.approvalGranted,false);assert.equal(balance.body.refundExecuted,false);receipts.push(r.body)}
  assert.ok(provider.requests.every(r=>r.method==='GET'&&r.account===account));
  const reconcile=path+'/refund-requests/'+receipts[0].id+'/reconcile';
  provider.refunds.set('re_httppending',{id:'re_httppending',object:'refund',payment_intent:period.p.id,status:'pending',currency:'jpy',amount:300});const changed=await call(reconcile,owner.refreshToken,{});assert.equal(changed.body.balance.availableRefundJpy,680);assert.equal(changed.body.balance.confirmedRefundedJpy,0);
  provider.control.fail=true;const unavailable=await call(reconcile,owner.refreshToken,{});assert.equal(unavailable.body.balance.qualified,false);assert.equal(unavailable.body.balance.availableRefundJpy,0);assert.equal(unavailable.body.balance.checkedAt,null);provider.control.fail=false;
  assert.deepEqual(await financialRows(),before,'Observations cannot mutate paid periods, plan state or exceptions');
  const expiry=(await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE user_id=$1 RETURNING expires_at",[owner.user.id])).rows[0].expires_at;
  const reached=new Promise(r=>{entered=r});barrier=new Promise(r=>{release=r});const waiting=call(reconcile,owner.refreshToken,{});
  await Promise.race([reached,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Provider barrier was not reached')),3000)})]);clearTimeout(timeout);
  await pool.query('SELECT pg_sleep(GREATEST(EXTRACT(EPOCH FROM($1::timestamptz-clock_timestamp())),0))',[expiry]);release();barrier=null;assert.equal((await waiting).status,401,'Expiry while provider is pending must prevent financial disclosure');
  owner.refreshToken=(await call('/api/auth/login',null,{email,password})).body.refreshToken;
  server.closeAllConnections();await new Promise(r=>server.close(r));server=null;const restarted=await createApp({pool});server=restarted.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;
  const missingCredential=await call(reconcile,owner.refreshToken,{});assert.equal(missingCredential.status,200);assert.equal(missingCredential.body.balance.qualified,false);assert.equal(missingCredential.body.balance.availableRefundJpy,0);
  assert.equal((await call('/api/auth/account',owner.refreshToken,{currentPassword:password,confirmationEmail:email},'DELETE')).status,204);assert.equal((await pool.query('SELECT count(*)::int n FROM commercial_refund_requests')).rows[0].n,0);
 }finally{
  clearTimeout(timeout);release?.();if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}await close();await admin.query('DROP DATABASE '+db+' WITH (FORCE)');await admin.end();await provider.close();for(const [k,v]of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v}
 }
});
