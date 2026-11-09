import assert from 'node:assert/strict';
import {test} from 'node:test';
import pg from 'pg';
import Stripe from 'stripe';
import {randomUUID} from 'node:crypto';
import {trackPoolShutdown} from './helpers/pg-fixture-lifecycle.js';
import express from 'express';
import {commercialEventHandler} from '../src/commercial-events.js';

test('signed sandbox refunds bind the original payment, count once and stay owner-private',{skip:process.env.PASSSHARE_RECEIPTS_PG!=='true'},async()=>{
 const url=new URL(process.env.DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.username,'passshare');assert.equal(url.pathname,'/passshare');
 const admin=new pg.Pool({connectionString:url.href}),db='ps_refunds_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+db);url.pathname='/'+db;
 const pool=new pg.Pool({connectionString:url.href}),close=trackPoolShutdown(pool),secret='whsec_synthetic_refund_fixture',account='acct_refundfixture';
 Object.assign(process.env,{PASSSHARE_STRIPE_TEST_WEBHOOK_SECRET:secret,PASSSHARE_STRIPE_TEST_ACCOUNT:account,PASSSHARE_COMMERCIAL_LIVE_ENABLED:'false'});
 const {createApp}=await import('../src/app.js');let server;const actors=[];const password='synthetic-refund-password';
 try{
  const {app}=await createApp({pool});server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
  const call=async(path,token,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(base+path,{method,headers:{'content-type':'application/json','x-passshare-client':'mobile',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,cache:r.headers.get('cache-control'),body:await r.json().catch(()=>null)}};
  const send=async(event,key=secret)=>{const payload=JSON.stringify(event);const r=await fetch(base+'/api/commercial-events/stripe-test',{method:'POST',headers:{'content-type':'application/json','stripe-signature':Stripe.webhooks.generateTestHeaderString({payload,secret:key})},body:payload});return {status:r.status,body:await r.json()}};
  const id=prefix=>prefix+randomUUID().replaceAll('-','');
  for(let i=0;i<2;i++){const email=id('refund-')+'@example.test';const r=await call('/api/auth/signup',null,{email,password});assert.equal(r.status,201);actors.push({...r.body,email})}
  const [owner,other]=actors,root='/api/commercial-contracts';
  const q=await call(root,owner.refreshToken,{requestId:randomUUID(),currency:'JPY',plan:{type:'personal',users:1},setup:{installationCompanies:0,supportHours:0,maintenanceMonthlyJpy:null}});assert.equal(q.status,201);
  assert.equal((await call(root+'/'+q.body.id+'/accept',owner.refreshToken,{quoteHash:q.body.quoteHash})).status,200);
  const payment={id:id('evt_'),account,livemode:false,created:Math.floor(Date.now()/1000),type:'payment_intent.succeeded',data:{object:{id:id('pi_'),object:'payment_intent',status:'succeeded',currency:'jpy',amount:980,amount_received:980,livemode:false,metadata:{contractId:q.body.id,ownerId:owner.user.id,quoteHash:q.body.quoteHash}}}};
  const refund={id:id('evt_'),account,livemode:false,created:payment.created,type:'refund.created',data:{object:{id:id('re_'),object:'refund',payment_intent:payment.data.object.id,amount:400,currency:'jpy',created:payment.created,status:'succeeded',metadata:{}}}};
  assert.equal((await send(refund)).status,409,'Refund before the canonical payment must be retryable, never rebound');
  assert.equal((await send(payment)).status,200);
  assert.equal((await send(refund)).status,200,'A verified official-shape refund must be persisted');
  assert.equal((await send(refund)).body.duplicate,true);
  const updated=structuredClone(refund);updated.id=id('evt_');updated.type='refund.updated';assert.equal((await send(updated)).status,200);
  const directApp=express();directApp.use('/events',commercialEventHandler({pool,secret,account,scope:'direct'}));const directServer=directApp.listen(0,'127.0.0.1');await new Promise(r=>directServer.once('listening',r));
  try{const value=structuredClone(updated);value.id=id('evt_');delete value.account;const payload=JSON.stringify(value);const response=await fetch('http://127.0.0.1:'+directServer.address().port+'/events',{method:'POST',headers:{'content-type':'application/json','stripe-signature':Stripe.webhooks.generateTestHeaderString({payload,secret})},body:payload});assert.equal(response.status,200);}finally{directServer.closeAllConnections();await new Promise(r=>directServer.close(r));}
  const history=root+'/'+q.body.id+'/test-refunds';const own=await call(history,owner.refreshToken);assert.equal(own.status,200);assert.equal(own.cache,'no-store');assert.equal(own.body.refunds.length,1);assert.equal(own.body.refunds[0].amountJpy,400);assert.equal(own.body.liveRefundExecuted,false);assert.equal(own.body.entitlementsGranted,false);assert.equal(own.body.nextCursor,null);
  assert.equal((await call(history+'?after=invalid',owner.refreshToken)).status,400);assert.deepEqual((await call(history+'?after='+own.body.refunds[0].id,owner.refreshToken)).body.refunds,[]);
  assert.equal((await call(history,other.refreshToken)).status,404);assert.equal((await call(history,null)).status,401);
  const race=Array.from({length:2},()=>{const value=structuredClone(refund);value.id=id('evt_');value.data.object.id=id('re_');value.data.object.amount=500;return value});assert.deepEqual((await Promise.all(race.map(value=>send(value)))).map(r=>r.status).sort(),[200,409]);
  const final=structuredClone(refund);final.id=id('evt_');final.data.object.id=id('re_');final.data.object.amount=80;
  assert.deepEqual((await Promise.all([send(final),send(final)])).map(r=>r.status),[200,200]);
  const over=structuredClone(final);over.id=id('evt_');over.data.object.id=id('re_');over.data.object.amount=1;assert.equal((await send(over)).status,409);
  for(const change of [{livemode:true},{account:'acct_other'}]){const bad={...refund,...change,id:id('evt_')};assert.equal((await send(bad)).status,400)}
  for(const change of [{currency:'usd'},{amount:0},{status:'pending'},{payment_intent:id('pi_')}]){const bad=structuredClone(refund);bad.id=id('evt_');Object.assign(bad.data.object,change);assert.equal((await send(bad)).status,change.payment_intent?409:400)}
  assert.equal((await send(refund,'whsec_wrong_fixture')).status,400);
  const altered=structuredClone(refund);altered.created--;assert.equal((await send(altered)).status,409);
  const changed=structuredClone(updated);changed.id=id('evt_');changed.data.object.amount=399;assert.equal((await send(changed)).status,409);
  const rows=await pool.query('SELECT r.amount_jpy::text FROM commercial_test_refunds r WHERE contract_id=$1 ORDER BY r.amount_jpy',[q.body.id]);assert.deepEqual(rows.rows.map(r=>r.amount_jpy),['80','400','500']);
  assert.equal((await pool.query('SELECT count(*)::int n FROM commercial_test_refund_events WHERE contract_id=$1',[q.body.id])).rows[0].n,5);
  const q2=await call(root,other.refreshToken,{requestId:randomUUID(),currency:'JPY',plan:{type:'personal',users:1},setup:{installationCompanies:0,supportHours:0,maintenanceMonthlyJpy:null}});assert.equal(q2.status,201);assert.equal((await call(root+'/'+q2.body.id+'/accept',other.refreshToken,{quoteHash:q2.body.quoteHash})).status,200);
  const p2=structuredClone(payment);p2.id=id('evt_');p2.data.object.id=id('pi_');p2.data.object.metadata={contractId:q2.body.id,ownerId:other.user.id,quoteHash:q2.body.quoteHash};assert.equal((await send(p2)).status,200);
  const r2=structuredClone(refund);r2.id=id('evt_');r2.data.object.payment_intent=p2.data.object.id;assert.equal((await send(r2)).status,409,'A provider refund ID cannot move to another contract');r2.data.object.id=id('re_');assert.equal((await send(r2)).status,200);
  const reused=structuredClone(r2);reused.id=refund.id;assert.equal((await send(reused)).status,409,'An existing event cannot move to another contract');
  await assert.rejects(pool.query('INSERT INTO commercial_test_refunds(id,account_id,refund_id,payment_event_id,contract_id,provider_object_id,amount_jpy,refund_created,evidence) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8)',[randomUUID(),account,id('re_'),payment.id,q2.body.id,payment.data.object.id,payment.created,'provider_test_sandbox']),e=>e.code==='23503');
  const unchanged=await call(root+'/'+q.body.id,owner.refreshToken);assert.equal(unchanged.body.paid,false);assert.equal(unchanged.body.entitlement.effective,false);assert.equal(unchanged.body.seatRevision,0);
  assert.equal((await call('/api/auth/logout',owner.refreshToken,{})).status,204);assert.equal((await call(history,owner.refreshToken)).status,401);
  owner.refreshToken=(await call('/api/auth/login',null,{email:owner.email,password})).body.refreshToken;
  assert.equal((await call('/api/auth/account',owner.refreshToken,{currentPassword:password,confirmationEmail:owner.email},'DELETE')).status,204);owner.retired=true;
  assert.equal((await pool.query('SELECT count(*)::int n FROM commercial_test_refunds WHERE contract_id=$1',[q.body.id])).rows[0].n,0);assert.equal((await pool.query('SELECT count(*)::int n FROM commercial_test_refund_events WHERE contract_id=$1',[q.body.id])).rows[0].n,0);assert.equal((await send(refund)).status,409);
  assert.equal((await pool.query('SELECT count(*)::int n FROM commercial_test_refunds WHERE contract_id=$1',[q2.body.id])).rows[0].n,1);assert.equal((await call(root+'/'+q2.body.id+'/test-refunds',other.refreshToken)).body.refunds.length,1);
 }finally{
  if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}
  await close();await admin.query('DROP DATABASE '+db+' WITH (FORCE)');await admin.end();
  for(const key of ['PASSSHARE_STRIPE_TEST_WEBHOOK_SECRET','PASSSHARE_STRIPE_TEST_ACCOUNT','PASSSHARE_COMMERCIAL_LIVE_ENABLED'])delete process.env[key];
 }
});
