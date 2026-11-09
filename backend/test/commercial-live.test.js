import assert from 'node:assert/strict';import {test} from 'node:test';import pg from 'pg';import Stripe from 'stripe';import {randomUUID} from 'node:crypto';
const pgOn=process.env.PASSSHARE_RECEIPTS_PG==='true';
test('live receiver is closed unless explicitly enabled and rejects sandbox-mode events',{skip:!pgOn},async()=>{
 const {createApp}=await import('../src/app.js');const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
 delete process.env.PASSSHARE_COMMERCIAL_LIVE_ENABLED;const {app}=await createApp({pool});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/commercial-events/stripe-live',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(r.status,503);}
 finally{server.closeAllConnections();await new Promise(r=>server.close(r));await pool.end();}
});
test('verified live payments become cycle-anchored periods and drive entitlement, cancel and export in an isolated database',{skip:!pgOn},async()=>{
 assert.match(process.env.DATABASE_URL,/^postgresql:\/\/passshare:passshare@127\.0\.0\.1:(5432|15431)\/passshare$/);
 const name='passshare_live_'+randomUUID().replaceAll('-','');const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});await admin.query('CREATE DATABASE '+name);
 const url=new URL(process.env.DATABASE_URL);url.pathname='/'+name;const pool=new pg.Pool({connectionString:url.href});
 const secret='whsec_synthetic_live_fixture',account='acct_syntheticlive';
 Object.assign(process.env,{PASSSHARE_STRIPE_LIVE_WEBHOOK_SECRET:secret,PASSSHARE_STRIPE_LIVE_ACCOUNT:account,PASSSHARE_COMMERCIAL_LIVE_ENABLED:'true'});
 const {createApp}=await import('../src/app.js');const {loadEntitlement}=await import('../src/commercial-live.js');const {exportDecision}=await import('../src/commercial-entitlement.js');
 const {app}=await createApp({pool});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 const call=async(path,token,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(base+path,{method,headers:{'content-type':'application/json','x-passshare-client':'mobile',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json().catch(()=>null)};};
 const send=async(event,sigSecret=secret,path='/api/commercial-events/stripe-live')=>{const payload=JSON.stringify(event);const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json','stripe-signature':Stripe.webhooks.generateTestHeaderString({payload,secret:sigSecret})},body:payload});return {status:r.status,body:await r.json().catch(()=>null)};};
 const id=p=>p+randomUUID().replaceAll('-','');
 const ev=(q,owner,cycle,createdIso,over={})=>({id:id('evt_'),account,type:'payment_intent.succeeded',livemode:true,created:Math.floor(Date.parse(createdIso)/1000),data:{object:{id:id('pi_'),object:'payment_intent',status:'succeeded',currency:'jpy',amount:980,amount_received:980,livemode:true,metadata:{contractId:q.id,ownerId:owner.user.id,quoteHash:q.quoteHash,cycle:String(cycle)},...over}}});
 const quote=async(owner)=>{const q=await call('/api/commercial-contracts',owner.refreshToken,{requestId:randomUUID(),currency:'JPY',plan:{type:'personal',users:1},setup:{installationCompanies:0,supportHours:0,maintenanceMonthlyJpy:null}});assert.equal(q.status,201);assert.equal((await call('/api/commercial-contracts/'+q.body.id+'/accept',owner.refreshToken,{quoteHash:q.body.quoteHash})).status,200);return q.body;};
 const periods=async cid=>(await pool.query('SELECT cycle,period_start::text s,period_end::text e FROM commercial_live_periods WHERE contract_id=$1 ORDER BY cycle',[cid])).rows.map(x=>[x.cycle,x.s,x.e]);
 try{
  const users=[];for(let i=0;i<3;i++){const r=await call('/api/auth/signup',null,{email:'live-'+randomUUID()+'@example.test',password:'synthetic-password123'});assert.equal(r.status,201);users.push(r.body);}
  const [owner,other,retiring]=users,q=await quote(owner);
  // Negatives: sandbox-mode, forged signature, wrong secret, wrong amount, wrong account, out of order, unaccepted draft.
  {const x=await send(ev(q,owner,1,'2026-01-31T00:00:00+09:00',{livemode:false}));assert.equal(x.status,400,JSON.stringify(x.body));}
  assert.equal((await send({...ev(q,owner,1,'2026-01-31T00:00:00+09:00'),livemode:false})).status,400);
  assert.equal((await send(ev(q,owner,1,'2026-01-31T00:00:00+09:00'),'whsec_other')).status,400);
  assert.equal((await send({...ev(q,owner,1,'2026-01-31T00:00:00+09:00'),account:'acct_other'})).status,400);
  assert.equal((await send(ev(q,owner,1,'2026-01-31T00:00:00+09:00',{amount:979,amount_received:979}))).status,409);
  assert.equal((await send(ev(q,owner,2,'2026-02-28T00:00:00+09:00'))).status,409); // cycle 2 before 1
  assert.equal((await send(ev(q,other,1,'2026-01-31T00:00:00+09:00'))).status,409); // wrong owner
  assert.equal((await pool.query('SELECT count(*)::int n FROM commercial_live_periods')).rows[0].n,0);
  // A sandbox test event must never reach the live ledger; a live event must not reach the test ledger.
  assert.equal((await send(ev(q,owner,1,'2026-01-31T00:00:00+09:00'),secret,'/api/commercial-events/stripe-test')).status,503);
  const c1=ev(q,owner,1,'2026-01-31T00:00:00+09:00');assert.equal((await send(c1)).status,200);
  const dup=await send(c1);assert.deepEqual([dup.status,dup.body.duplicate],[200,true]);
  assert.equal((await send(ev(q,owner,1,'2026-01-31T01:00:00+09:00'))).status,409); // same cycle, new payment
  // Late, out-of-order arrival: cycle 3 waits, cycle 2 arrives 20 days late, periods follow the anchor not arrival.
  assert.equal((await send(ev(q,owner,3,'2026-03-31T00:00:00+09:00'))).status,409);
  const c2=ev(q,owner,2,'2026-03-20T00:00:00+09:00');assert.equal((await send(c2)).status,200);
  const reuse=ev(q,owner,3,'2026-03-31T00:00:00+09:00');reuse.data.object.id=c2.data.object.id;assert.equal((await send(reuse)).status,409); // duplicate PaymentIntent
  assert.equal((await send(ev(q,owner,3,'2026-04-02T00:00:00+09:00'))).status,200);
  assert.deepEqual(await periods(q.id),[[1,'2026-01-31','2026-02-28'],[2,'2026-02-28','2026-03-31'],[3,'2026-03-31','2026-04-30']]);
  // Leap-year February keeps the original day.
  const leap=await quote(other);assert.equal((await send(ev(leap,other,1,'2028-01-31T10:00:00+09:00'))).status,200);assert.equal((await send(ev(leap,other,2,'2028-02-29T10:00:00+09:00'))).status,200);
  assert.deepEqual(await periods(leap.id),[[1,'2028-01-31','2028-02-29'],[2,'2028-02-29','2028-03-31']]);
  // Entitlement: only live periods are effective; cancel keeps access to the paid end; 30 day export window afterwards.
  const at=iso=>Date.parse(iso);
  const mid=await loadEntitlement(pool,q.id,at('2026-04-15T12:00:00+09:00'));assert.deepEqual([mid.state,mid.effective,mid.paidThrough],['active',true,'2026-04-30']);
  assert.equal((await call('/api/commercial-contracts/'+q.id+'/cancel-at-period-end',other.refreshToken,{quoteHash:q.quoteHash})).status,404);
  const cancel=await call('/api/commercial-contracts/'+q.id+'/cancel-at-period-end',owner.refreshToken,{quoteHash:q.quoteHash});assert.equal(cancel.status,200);
  assert.equal((await call('/api/commercial-contracts/'+q.id+'/cancel-at-period-end',owner.refreshToken,{quoteHash:q.quoteHash})).status,200);
  assert.equal((await pool.query('SELECT cancel_after_cycle FROM commercial_live_contracts WHERE contract_id=$1',[q.id])).rows[0].cancel_after_cycle,3);
  assert.equal((await send(ev(q,owner,4,'2026-04-30T00:00:00+09:00'))).status,409); // no renewal after the cancellation
  const sched=await loadEntitlement(pool,q.id,at('2026-04-29T12:00:00+09:00'));assert.deepEqual([sched.state,sched.effective],['active_cancel_scheduled',true]);
  const ended=await loadEntitlement(pool,q.id,at('2026-04-30T12:00:00+09:00'));assert.deepEqual([ended.state,ended.effective],['export_window',false]);
  const actor={sessionValid:true,accountRemoved:false,identityConfirmed:true,billingAdministrator:true,membershipActive:true,hasExportScope:true};
  assert.equal((await exportDecision({entitlement:ended,actor})).allowed,true);
  const closed=await loadEntitlement(pool,q.id,at('2026-05-30T12:00:00+09:00'));assert.deepEqual([closed.state,closed.exportWindow.open],['closed',false]);assert.equal((await exportDecision({entitlement:closed,actor})).allowed,false);
  // Real clock through the API: a period that ended five days ago is inside the export window.
  const past=new Date(Date.now()-35*86400000).toISOString();const old=await quote(retiring);
  assert.equal((await send(ev(old,retiring,1,past))).status,200);
  const auth=await call('/api/commercial-contracts/'+old.id+'/export-authorization',retiring.refreshToken);
  assert.equal(auth.status,200);assert.equal(auth.body.entitlement.effective,false);assert.equal(auth.body.export.allowed,true);assert.equal(auth.body.export.restoresIdentityMembershipOrKeys,false);
  assert.equal((await call('/api/commercial-contracts/'+old.id+'/export-authorization',other.refreshToken)).status,404);
  const fresh=await quote(owner);assert.equal((await send(ev(fresh,owner,1,new Date().toISOString()))).status,200);
  const active=await call('/api/commercial-contracts/'+fresh.id,owner.refreshToken);assert.deepEqual([active.body.entitlement.state,active.body.entitlement.effective],['active',true]);assert.equal(active.body.paid,false);
  assert.equal((await call('/api/commercial-contracts/'+fresh.id+'/export-authorization',owner.refreshToken)).body.export.allowed,false);
  // Retired owner: rows cascade away and later events are refused.
  const gone=await call('/api/auth/account',retiring.refreshToken,{currentPassword:'synthetic-password123',confirmationEmail:retiring.user.email},'DELETE');
  assert.equal(gone.status,204);assert.equal((await pool.query('SELECT count(*)::int n FROM commercial_live_periods WHERE contract_id=$1',[old.id])).rows[0].n,0);
  assert.equal((await send(ev(old,retiring,2,new Date().toISOString()))).status,409);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await pool.end();await admin.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)');await admin.end();
  for(const k of ['PASSSHARE_STRIPE_LIVE_WEBHOOK_SECRET','PASSSHARE_STRIPE_LIVE_ACCOUNT','PASSSHARE_COMMERCIAL_LIVE_ENABLED'])delete process.env[k];}
});