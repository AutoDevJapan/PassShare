import assert from 'node:assert/strict';import {test} from 'node:test';import express from 'express';import Stripe from 'stripe';import {commercialEventHandler} from '../src/commercial-events.js';
test('raw signed test events reject forged stale live wrong-account payloads before DB access',async()=>{
 const secret='whsec_synthetic_fixture_only',account='acct_synthetic',pool={connect(){throw Error('DB must not be reached');}};
 const app=express();app.use('/events',commercialEventHandler({pool,secret,account}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const event={id:'evt_synthetic',type:'payment_intent.succeeded',account,livemode:false,created:Math.floor(Date.now()/1000),data:{object:{object:'payment_intent',id:'pi_synthetic',status:'succeeded',currency:'jpy',amount:980,amount_received:980,livemode:false,metadata:{contractId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ownerId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',quoteHash:'a'.repeat(64)}}}};
 const send=async(e,override)=>{const payload=JSON.stringify(e);const signature=override??Stripe.webhooks.generateTestHeaderString({payload,secret});const r=await fetch('http://127.0.0.1:'+server.address().port+'/events',{method:'POST',headers:{'content-type':'application/json','stripe-signature':signature},body:payload});return r.status;};
 try{
  assert.equal(await send(event,'t=1,v1=forged'),400);
  assert.equal(await send(event,Stripe.webhooks.generateTestHeaderString({payload:JSON.stringify(event),secret,timestamp:1})),400);
  assert.equal(await send({...event,livemode:true}),400);
  assert.equal(await send({...event,account:'acct_other'}),400);
  assert.equal(await send({...event,data:{object:{...event.data.object,currency:'usd'}}}),400);
  assert.equal(await send({...event,type:'charge.refunded'}),400);
  const directApp=express();let reached=false;
  directApp.use('/events',commercialEventHandler({pool:{async connect(){reached=true;throw Error('fixture reached binding DB');}},secret,account,scope:'direct'}));
  const directServer=directApp.listen(0,'127.0.0.1');await new Promise(r=>directServer.once('listening',r));
  try{
   const post=async(value)=>{const payload=JSON.stringify(value);return fetch('http://127.0.0.1:'+directServer.address().port+'/events',{method:'POST',headers:{'content-type':'application/json','stripe-signature':Stripe.webhooks.generateTestHeaderString({payload,secret})},body:payload});};
   assert.equal((await post(event)).status,400);assert.equal(reached,false);
   const direct=structuredClone(event);delete direct.account;
   assert.equal((await post(direct)).status,500);assert.equal(reached,true);
   // The synthetic DB sentinel proves signature/scope acceptance, not persistence.
  }finally{directServer.closeAllConnections();await new Promise(r=>directServer.close(r));}
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('signed fixture events persist once and bind the accepted quote in PostgreSQL',{skip:process.env.PASSSHARE_RECEIPTS_PG!=='true'},async()=>{
 const {default:pg}=await import('pg');const {randomUUID}=await import('node:crypto');const {createApp}=await import('../src/app.js');
 assert.match(process.env.DATABASE_URL,/^postgresql:\/\/passshare:passshare@127\.0\.0\.1:(5432|15431)\/passshare$/);
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL}),secret='whsec_synthetic_pg_fixture',account='acct_synthetic';
 process.env.PASSSHARE_STRIPE_TEST_WEBHOOK_SECRET=secret;process.env.PASSSHARE_STRIPE_TEST_ACCOUNT=account;
 const {app}=await createApp({pool});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;const actors=[];
 const call=async(path,token,body)=>{const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-passshare-client':'mobile',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 const send=async(event)=>{const payload=JSON.stringify(event),signature=Stripe.webhooks.generateTestHeaderString({payload,secret});const r=await fetch(base+'/api/commercial-events/stripe-test',{method:'POST',headers:{'content-type':'application/json','stripe-signature':signature},body:payload});return {status:r.status,body:await r.json()};};
 try{
  for(let i=0;i<2;i++){const r=await call('/api/auth/signup',null,{email:'event-'+randomUUID()+'@example.test',password:'synthetic-password123'});assert.equal(r.status,201);actors.push(r.body);}
  const [owner,other]=actors;const quote=await call('/api/commercial-contracts',owner.refreshToken,{requestId:randomUUID(),currency:'JPY',plan:{type:'personal',users:1},setup:{installationCompanies:0,supportHours:0,maintenanceMonthlyJpy:null}});assert.equal(quote.status,201);
  const event={id:'evt_'+randomUUID().replaceAll('-',''),account,type:'payment_intent.succeeded',livemode:false,created:Math.floor(Date.now()/1000),data:{object:{id:'pi_'+randomUUID().replaceAll('-',''),object:'payment_intent',status:'succeeded',currency:'jpy',amount:980,amount_received:980,livemode:false,metadata:{contractId:quote.body.id,ownerId:owner.user.id,quoteHash:quote.body.quoteHash}}}};
  assert.equal((await send(event)).status,409); // A draft is never payment authority.
  assert.equal((await call('/api/commercial-contracts/'+quote.body.id+'/accept',owner.refreshToken,{quoteHash:quote.body.quoteHash})).status,200);
  for(const change of [{ownerId:other.user.id},{quoteHash:'0'.repeat(64)}]){const wrong=structuredClone(event);wrong.data.object.metadata={...wrong.data.object.metadata,...change};assert.equal((await send(wrong)).status,409);}
  const amount=structuredClone(event);amount.data.object.amount=979;amount.data.object.amount_received=979;assert.equal((await send(amount)).status,409);
  const pair=await Promise.all([send(event),send(event)]);assert.deepEqual(pair.map(r=>r.status),[200,200]);assert.equal(pair.filter(r=>r.body.duplicate).length,1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM commercial_payment_events WHERE contract_id=$1',[quote.body.id])).rows[0].n,1);
  const altered=structuredClone(event);altered.created--;assert.equal((await send(altered)).status,409);
  const second=await call('/api/commercial-contracts',other.refreshToken,{requestId:randomUUID(),currency:'JPY',plan:{type:'personal',users:1},setup:{installationCompanies:0,supportHours:0,maintenanceMonthlyJpy:null}});assert.equal(second.status,201);
  assert.equal((await call('/api/commercial-contracts/'+second.body.id+'/accept',other.refreshToken,{quoteHash:second.body.quoteHash})).status,200);
  const raceId='evt_'+randomUUID().replaceAll('-','');const left=structuredClone(event);left.id=raceId;
  const right=structuredClone(left);right.data.object.metadata={contractId:second.body.id,ownerId:other.user.id,quoteHash:second.body.quoteHash};
  const conflict=await Promise.all([send(left),send(right)]);assert.deepEqual(conflict.map(r=>r.status).sort(),[200,409]);
  assert.equal((await pool.query('SELECT count(*)::int n FROM commercial_payment_events WHERE event_id=$1',[raceId])).rows[0].n,1);
  const earlier=structuredClone(event);earlier.id='evt_'+randomUUID().replaceAll('-','');earlier.created-=100;assert.equal((await send(earlier)).status,200);
  const read=await call('/api/commercial-contracts/'+quote.body.id,owner.refreshToken);assert.equal(read.body.state,'accepted_unpaid');assert.equal(read.body.paid,false);assert.equal(read.body.entitlementsGranted,false);
  await pool.query('DELETE FROM users WHERE id=$1',[owner.user.id]);assert.equal((await pool.query('SELECT count(*)::int n FROM commercial_payment_events WHERE contract_id=$1',[quote.body.id])).rows[0].n,0);assert.equal((await send(event)).status,409);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[actors.map(a=>a.user.id)]);await pool.end();delete process.env.PASSSHARE_STRIPE_TEST_WEBHOOK_SECRET;delete process.env.PASSSHARE_STRIPE_TEST_ACCOUNT;}
});
