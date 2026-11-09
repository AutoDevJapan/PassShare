import {trackPoolShutdown} from './helpers/pg-fixture-lifecycle.js';
import assert from 'node:assert/strict';import {test} from 'node:test';import pg from 'pg';import Stripe from 'stripe';import {randomUUID} from 'node:crypto';
import {classifyPayment} from '../src/commercial-live.js';
import {entitlementState} from '../src/commercial-entitlement.js';
test('paid end includes a prepaid next cycle while current access remains date-bound',()=>{
 const periods=[{periodStart:'2026-11-01',periodEnd:'2026-12-01',evidence:'provider_live'},{periodStart:'2026-12-01',periodEnd:'2027-01-01',evidence:'provider_live'}];
 const s=entitlementState({periods,cancelAtPeriodEnd:true,nowMs:Date.parse('2026-11-10T12:00:00+09:00')});
 assert.equal(s.currentPeriodEnd,'2026-12-01');assert.equal(s.paidThrough,'2027-01-01');assert.equal(s.effective,true);assert.equal(s.cancelScheduled,true);
 assert.equal(entitlementState({periods,cancelAtPeriodEnd:true,nowMs:Date.parse('2027-01-04T12:00:00+09:00')}).exportWindow.open,true);
});
test('trusted event second and cancellation boundary remain distinct from delivery time',()=>{
 const c={cancel_after_cycle:1,cancel_requested_at:new Date('2026-11-10T00:00:00.750Z')},second=Math.floor(c.cancel_requested_at.getTime()/1000);
 assert.equal(classifyPayment(c,2,second-1).disposition,'effective');
 assert.equal(classifyPayment(c,2,second).reason,'payment_time_boundary_review');
 assert.equal(classifyPayment(c,2,second+1).reason,'payment_after_cancellation');
 assert.equal(classifyPayment(c,2,second-1,false).reason,'payment_sequence_review');
 assert.equal(classifyPayment({...c,cancel_requested_at:null},2,second-1).reason,'cancellation_time_unavailable');
});
test('pre-cancellation paid renewals reconcile after delayed delivery without reviving post-cancel charges',{skip:process.env.PASSSHARE_RECEIPTS_PG!=='true'},async()=>{
 assert.match(process.env.DATABASE_URL,/^postgresql:\/\/passshare:passshare@127\.0\.0\.1:(5432|15431)\/passshare$/);
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL}),name='ps_reconcile_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+name);
 const url=new URL(process.env.DATABASE_URL);url.pathname='/'+name;const pool=new pg.Pool({connectionString:url.href});const closePool=trackPoolShutdown(pool);
 const secret='whsec_reconcile_fixture',account='acct_reconcilefixture';
 Object.assign(process.env,{PASSSHARE_COMMERCIAL_LIVE_ENABLED:'true',PASSSHARE_STRIPE_LIVE_WEBHOOK_SECRET:secret,PASSSHARE_STRIPE_LIVE_ACCOUNT:account});
 const {createApp}=await import('../src/app.js');const {loadEntitlement}=await import('../src/commercial-live.js');const {app}=await createApp({pool});const s=app.listen(0,'127.0.0.1');await new Promise(r=>s.once('listening',r));const base='http://127.0.0.1:'+s.address().port;
 const call=async(p,t,b)=>{const r=await fetch(base+p,{method:b===undefined?'GET':'POST',headers:{'content-type':'application/json','x-passshare-client':'mobile',...(t?{authorization:'Bearer '+t}:{})},body:b===undefined?undefined:JSON.stringify(b)});return {status:r.status,body:await r.json()};};
 let owner;const event=(q,cycle,created)=>({id:'evt_'+randomUUID().replaceAll('-',''),account,type:'payment_intent.succeeded',livemode:true,created,data:{object:{id:'pi_'+randomUUID().replaceAll('-',''),object:'payment_intent',status:'succeeded',currency:'jpy',amount:980,amount_received:980,livemode:true,metadata:{contractId:q.id,ownerId:owner.user.id,quoteHash:q.quoteHash,cycle:String(cycle)}}}});
 const send=async e=>{const payload=JSON.stringify(e);const r=await fetch(base+'/api/commercial-events/stripe-live',{method:'POST',headers:{'content-type':'application/json','stripe-signature':Stripe.webhooks.generateTestHeaderString({payload,secret})},body:payload});return {status:r.status,body:await r.json()};};
 const make=async()=>{const r=await call('/api/commercial-contracts',owner.refreshToken,{requestId:randomUUID(),currency:'JPY',plan:{type:'personal',users:1},setup:{installationCompanies:0,supportHours:0,maintenanceMonthlyJpy:null}});assert.equal(r.status,201);const q=r.body;assert.equal((await call('/api/commercial-contracts/'+q.id+'/accept',owner.refreshToken,{quoteHash:q.quoteHash})).status,200);assert.equal((await send(event(q,1,Math.floor(Date.now()/1000)-35*86400))).status,200);return q;};
 const cancel=q=>call('/api/commercial-contracts/'+q.id+'/cancel-at-period-end',owner.refreshToken,{quoteHash:q.quoteHash});
 const row=async q=>(await pool.query('SELECT * FROM commercial_live_contracts WHERE contract_id=$1',[q.id])).rows[0];
 try{
  const signup=await call('/api/auth/signup',null,{email:'reconcile-'+randomUUID()+'@example.test',password:'synthetic-password123'});assert.equal(signup.status,201);owner=signup.body;
  const q=await make(),pre=event(q,2,Math.floor(Date.now()/1000)-60);assert.equal((await cancel(q)).status,200);const canceled=await row(q);
  assert.equal((await send(pre)).status,200);
  let period=(await pool.query('SELECT * FROM commercial_live_periods WHERE contract_id=$1 AND cycle=2',[q.id])).rows[0];
  assert.equal(period.disposition,'effective');assert.equal((await row(q)).cancel_after_cycle,2);assert.deepEqual((await row(q)).cancel_requested_at,canceled.cancel_requested_at);
  const end=(await pool.query('SELECT period_end::text e FROM commercial_live_periods WHERE contract_id=$1 AND cycle=2',[q.id])).rows[0].e;
  const now=await loadEntitlement(pool,q.id,Date.now());assert.equal(now.state,'active_cancel_scheduled');assert.equal(now.effective,true);assert.equal(now.paidThrough,end);
  const endAt=Date.parse(end+'T00:00:00+09:00'),grace=await loadEntitlement(pool,q.id,endAt+29*86400000),closed=await loadEntitlement(pool,q.id,endAt+30*86400000);assert.equal(grace.exportWindow.open,true);assert.equal(closed.exportWindow.open,false);
  const cutoff=Math.floor(canceled.cancel_requested_at.getTime()/1000),after=event(q,3,cutoff+1);assert.equal((await send(after)).status,200);
  assert.equal((await pool.query('SELECT disposition FROM commercial_live_periods WHERE event_id=$1',[after.id])).rows[0].disposition,'refund_review');assert.equal((await row(q)).cancel_after_cycle,2);
  const snapshot=(await pool.query('SELECT to_jsonb(p) v FROM commercial_live_periods p WHERE event_id=$1',[pre.id])).rows[0].v;assert.equal((await send(pre)).body.duplicate,true);assert.deepEqual((await pool.query('SELECT to_jsonb(p) v FROM commercial_live_periods p WHERE event_id=$1',[pre.id])).rows[0].v,snapshot);
  // Reconcile a pre-fix refund_review row only when the original signed body is replayed.
  await pool.query("UPDATE commercial_live_periods SET disposition='refund_review' WHERE event_id=$1",[pre.id]);assert.equal((await send(pre)).status,200);assert.equal((await pool.query('SELECT disposition FROM commercial_live_periods WHERE event_id=$1',[pre.id])).rows[0].disposition,'effective');
  const bad=structuredClone(pre);bad.created--;assert.equal((await send(bad)).status,409);
  // Both orderings and actual row-lock competition converge to the same paid end.
  const early=await make(),earlyPaid=event(early,2,Math.floor(Date.now()/1000)-60);assert.equal((await send(earlyPaid)).status,200);assert.equal((await cancel(early)).status,200);assert.equal((await row(early)).cancel_after_cycle,2);
  const race=await make(),racePaid=event(race,2,Math.floor(Date.now()/1000)-60);const pair=await Promise.all([cancel(race),send(racePaid)]);assert.deepEqual(pair.map(r=>r.status),[200,200]);assert.equal((await row(race)).cancel_after_cycle,2);assert.equal((await loadEntitlement(pool,race.id,Date.now())).effective,true);
  const boundary=await make();assert.equal((await cancel(boundary)).status,200);const boundarySecond=Math.floor((await row(boundary)).cancel_requested_at.getTime()/1000);const sameSecond=event(boundary,2,boundarySecond);assert.equal((await send(sameSecond)).status,200);
  const boundaryRow=(await pool.query('SELECT disposition,disposition_reason FROM commercial_live_periods WHERE event_id=$1',[sameSecond.id])).rows[0];assert.deepEqual(boundaryRow,{disposition:'refund_review',disposition_reason:'payment_time_boundary_review'});assert.equal((await row(boundary)).cancel_after_cycle,1);
 }finally{s.closeAllConnections();await new Promise(r=>s.close(r));await closePool();await admin.query('DROP DATABASE '+name);await admin.end();for(const k of ['PASSSHARE_COMMERCIAL_LIVE_ENABLED','PASSSHARE_STRIPE_LIVE_WEBHOOK_SECRET','PASSSHARE_STRIPE_LIVE_ACCOUNT'])delete process.env[k];}
});
