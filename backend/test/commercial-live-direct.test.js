import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import Stripe from 'stripe';
import {trackPoolShutdown} from './helpers/pg-fixture-lifecycle.js';

test('live account scopes are explicit, keep Connect compatibility and reject test mode',{skip:process.env.PASSSHARE_RECEIPTS_PG!=='true'},async()=>{
 const url=new URL(process.env.DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.username,'passshare');assert.equal(url.pathname,'/passshare');
 const admin=new pg.Pool({connectionString:url.href}),db='ps_live_direct_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+db);url.pathname='/'+db;
 const pool=new pg.Pool({connectionString:url.href}),close=trackPoolShutdown(pool),servers=[],account='acct_livedirect',secret='whsec_live_direct_synthetic';
 const keys=['PASSSHARE_COMMERCIAL_LIVE_ENABLED','PASSSHARE_STRIPE_LIVE_ACCOUNT','PASSSHARE_STRIPE_LIVE_WEBHOOK_SECRET','PASSSHARE_STRIPE_LIVE_ENDPOINT_SCOPE'],old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 try{
  const {createApp}=await import('../src/app.js');
  const start=async(scope,enabled=true)=>{Object.assign(process.env,{PASSSHARE_COMMERCIAL_LIVE_ENABLED:String(enabled),PASSSHARE_STRIPE_LIVE_ACCOUNT:account,PASSSHARE_STRIPE_LIVE_WEBHOOK_SECRET:secret});if(scope===undefined)delete process.env.PASSSHARE_STRIPE_LIVE_ENDPOINT_SCOPE;else process.env.PASSSHARE_STRIPE_LIVE_ENDPOINT_SCOPE=scope;const {app}=await createApp({pool}),server=app.listen(0,'127.0.0.1');servers.push(server);await new Promise(r=>server.once('listening',r));return 'http://127.0.0.1:'+server.address().port};
  const direct=await start('direct');
  const call=async(base,path,token,body)=>{const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-passshare-client':'mobile',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json().catch(()=>null)}};
  const id=p=>p+randomUUID().replaceAll('-',''),signup=await call(direct,'/api/auth/signup',null,{email:id('direct-')+'@example.test',password:'synthetic-live-direct-password'});assert.equal(signup.status,201);const actor=signup.body;
  const quote=async base=>{const q=await call(base,'/api/commercial-contracts',actor.refreshToken,{requestId:randomUUID(),currency:'JPY',plan:{type:'personal',users:1},setup:{installationCompanies:0,supportHours:0,maintenanceMonthlyJpy:null}});assert.equal(q.status,201);assert.equal((await call(base,'/api/commercial-contracts/'+q.body.id+'/accept',actor.refreshToken,{quoteHash:q.body.quoteHash})).status,200);return q.body};
  const event=q=>({id:id('evt_'),livemode:true,type:'payment_intent.succeeded',created:Math.floor(Date.now()/1000),data:{object:{id:id('pi_'),object:'payment_intent',status:'succeeded',currency:'jpy',amount:980,amount_received:980,livemode:true,metadata:{contractId:q.id,ownerId:actor.user.id,quoteHash:q.quoteHash,cycle:'1'}}}});
  const send=async(base,e,key=secret)=>{const payload=JSON.stringify(e),r=await fetch(base+'/api/commercial-events/stripe-live',{method:'POST',headers:{'content-type':'application/json','stripe-signature':Stripe.webhooks.generateTestHeaderString({payload,secret:key})},body:payload});return {status:r.status,body:await r.json().catch(()=>null)}};
  const q=await quote(direct),own=event(q);
  assert.equal((await send(direct,own,'whsec_other')).status,400);
  const sandbox=structuredClone(own);sandbox.livemode=false;sandbox.data.object.livemode=false;assert.equal((await send(direct,sandbox)).status,400);
  const contradictory=structuredClone(own);contradictory.data.object.livemode=false;assert.equal((await send(direct,contradictory)).status,400);
  const received=await send(direct,own);assert.equal(received.status,200,'A signed own-account event has no connected account field');assert.equal(received.body.duplicate,false);assert.equal((await send(direct,own)).body.duplicate,true);
  assert.equal((await send(direct,{...event(q),account})).status,400,'A Connect-shaped event cannot enter the own-account scope');
  assert.equal((await send(direct,{...event(q),account:'acct_other'})).status,400);
  const qNull=await quote(direct);assert.equal((await send(direct,{...event(qNull),account:null})).status,200,'The optional account attribute may also be null');
  const rows=(await pool.query('SELECT account_id,contract_id FROM commercial_live_periods ORDER BY contract_id')).rows;assert.equal(rows.length,2);assert.ok(rows.every(r=>r.account_id===account));
  const connect=await start('connect'),qConnect=await quote(connect),connected={...event(qConnect),account};
  assert.equal((await send(connect,{...event(qConnect),scope:'direct'})).status,400,'A caller scope claim cannot change the configured scope');
  assert.equal((await send(connect,{...connected,account:'acct_other'})).status,400);assert.equal((await send(connect,connected)).status,200);
  const legacy=await start(undefined),qLegacy=await quote(legacy);assert.equal((await send(legacy,{...event(qLegacy),account})).status,200,'Omitted configuration preserves the existing Connect behavior');
  const disabled=await start('direct',false);assert.equal((await send(disabled,own)).status,503);
  const invalid=await start('invalid');assert.equal((await send(invalid,own)).status,503);
  assert.equal((await pool.query('SELECT count(*)::int n FROM commercial_live_periods')).rows[0].n,4);
 }finally{
  for(const server of servers){server.closeAllConnections();await new Promise(r=>server.close(r))}await close();await admin.query('DROP DATABASE '+db+' WITH (FORCE)');await admin.end();for(const [key,value]of Object.entries(old)){if(value===undefined)delete process.env[key];else process.env[key]=value}
 }
});
