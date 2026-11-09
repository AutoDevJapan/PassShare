import assert from 'node:assert/strict';
import {test} from 'node:test';
import pg from 'pg';
import Stripe from 'stripe';
import {randomUUID} from 'node:crypto';
import {trackPoolShutdown} from './helpers/pg-fixture-lifecycle.js';
test('unpaid increase consent does not invalidate a decrease payment completed before the increase payment',{skip:process.env.PASSSHARE_RECEIPTS_PG!=='true'},async()=>{
 const parent=new URL(process.env.DATABASE_URL);assert.equal(parent.hostname,'127.0.0.1');assert.equal(parent.username,'passshare');assert.equal(parent.pathname,'/passshare');
 const admin=new pg.Pool({connectionString:parent.href}),name='ps_decrease_order_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+name);parent.pathname='/'+name;
 const pool=new pg.Pool({connectionString:parent.href}),close=trackPoolShutdown(pool),secret='whsec_decrease_order_fixture',account='acct_decreaseorder';
 Object.assign(process.env,{PASSSHARE_STRIPE_LIVE_WEBHOOK_SECRET:secret,PASSSHARE_STRIPE_LIVE_ACCOUNT:account,PASSSHARE_COMMERCIAL_LIVE_ENABLED:'true'});
 const {createApp}=await import('../src/app.js');const {app}=await createApp({pool}),server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const host='http://127.0.0.1:'+server.address().port;
 const call=async(path,token,body)=>{const r=await fetch(host+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-passshare-client':'mobile',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 const send=async(event)=>{const payload=JSON.stringify(event),r=await fetch(host+'/api/commercial-events/stripe-live',{method:'POST',headers:{'content-type':'application/json','stripe-signature':Stripe.webhooks.generateTestHeaderString({payload,secret})},body:payload});return {status:r.status,body:await r.json()};};
 const id=p=>p+randomUUID().replaceAll('-','');let owner,q;
 const event=(cycle,amount,created,extra={})=>({id:id('evt_'),account,type:'payment_intent.succeeded',livemode:true,created,data:{object:{id:id('pi_'),object:'payment_intent',status:'succeeded',currency:'jpy',amount,amount_received:amount,livemode:true,metadata:{contractId:q.id,ownerId:owner.user.id,quoteHash:q.quoteHash,cycle:String(cycle),...extra}}}});
 try{
  owner=(await call('/api/auth/signup',null,{email:randomUUID()+'@example.test',password:'synthetic-order-password'})).body;
  const root='/api/commercial-contracts';q=(await call(root,owner.refreshToken,{requestId:randomUUID(),currency:'JPY',plan:{type:'personal',users:3},setup:{installationCompanies:0,supportHours:0,maintenanceMonthlyJpy:null}})).body;
  await call(root+'/'+q.id+'/accept',owner.refreshToken,{quoteHash:q.quoteHash});
  const now=Number((await pool.query('SELECT floor(extract(epoch FROM clock_timestamp()))::bigint t')).rows[0].t);
  assert.equal((await send(event(1,2940,now-70))).status,200);
  const d=(await call(root+'/'+q.id+'/seat-decrease-quotes',owner.refreshToken,{requestId:randomUUID(),requestedPlan:{type:'personal',users:1}})).body;
  await call(root+'/'+q.id+'/seat-decrease-quotes/'+d.id+'/accept',owner.refreshToken,{quoteHash:d.quoteHash});
  const i=(await call(root+'/'+q.id+'/seat-quotes',owner.refreshToken,{requestId:randomUUID(),requestedPlan:{type:'personal',users:4},roundingPolicy:'ceil-jpy'})).body;
  await call(root+'/'+q.id+'/seat-quotes/'+i.id+'/accept',owner.refreshToken,{quoteHash:i.quoteHash});
  // Controlled isolated-DB dates, not production clock changes or real charges.
  await pool.query('UPDATE commercial_seat_decreases SET accepted_at=to_timestamp($2) WHERE id=$1',[d.id,now-40]);
  await pool.query('UPDATE commercial_seat_changes SET accepted_at=to_timestamp($2) WHERE id=$1',[i.id,now-30]);
  const increase=event(1,i.quote.proposedRoundedJpy,now-10,{quoteHash:i.quoteHash,seatChangeId:i.id});
  assert.equal((await send(increase)).status,200); // later success delivered first
  const invalidated=await call(root+'/'+q.id+'/seat-decrease-quotes/'+d.id,owner.refreshToken);assert.equal(invalidated.status,200);assert.equal(invalidated.body.state,'stale');assert.equal(invalidated.body.schedulePersisted,false);
  // Legacy rows may still carry their old stored status. The effective view
  // must not advertise that obsolete reservation or rewrite its old facts.
  await pool.query("UPDATE commercial_seat_decreases SET state='scheduled' WHERE id=$1",[d.id]);
  const legacyView=await call(root+'/'+q.id+'/seat-decrease-quotes/'+d.id,owner.refreshToken);assert.equal(legacyView.body.state,'stale');assert.equal(legacyView.body.storedState,'scheduled');assert.equal(legacyView.body.schedulePersisted,false);
  assert.equal((await call(root+'/'+q.id+'/seat-decrease-quotes/'+d.id+'/accept',owner.refreshToken,{quoteHash:d.quoteHash})).status,409);
  const reduction=event(2,980,now-20,{seatDecreaseId:d.id,seatDecreaseQuoteHash:d.quoteHash});
  const received=await send(reduction);assert.equal(received.status,200);
  assert.equal(received.body.seatDecreaseFunded,true);assert.equal(received.body.billingAdjustmentReviewRequired,true);
  assert.equal((await pool.query('SELECT count(*)::int n FROM commercial_live_periods WHERE contract_id=$1 AND cycle=2 AND disposition=\'effective\' AND amount_jpy=980',[q.id])).rows[0].n,1);
  assert.equal(Number((await pool.query('SELECT provider_event_created FROM commercial_seat_changes WHERE id=$1',[i.id])).rows[0].provider_event_created),now-10);
  const before=JSON.stringify((await pool.query('SELECT * FROM commercial_live_periods ORDER BY cycle')).rows);
  assert.equal((await send(reduction)).body.duplicate,true);
  assert.equal(JSON.stringify((await pool.query('SELECT * FROM commercial_live_periods ORDER BY cycle')).rows),before);
  for(const legacy of [false,true]){
   q=(await call(root,owner.refreshToken,{requestId:randomUUID(),currency:'JPY',plan:{type:'personal',users:3},setup:{installationCompanies:0,supportHours:0,maintenanceMonthlyJpy:null}})).body;
   await call(root+'/'+q.id+'/accept',owner.refreshToken,{quoteHash:q.quoteHash});await send(event(1,2940,now-70));
   const dec=(await call(root+'/'+q.id+'/seat-decrease-quotes',owner.refreshToken,{requestId:randomUUID(),requestedPlan:{type:'personal',users:1}})).body;
   await call(root+'/'+q.id+'/seat-decrease-quotes/'+dec.id+'/accept',owner.refreshToken,{quoteHash:dec.quoteHash});
   const inc=(await call(root+'/'+q.id+'/seat-quotes',owner.refreshToken,{requestId:randomUUID(),requestedPlan:{type:'personal',users:4},roundingPolicy:'ceil-jpy'})).body;
   await call(root+'/'+q.id+'/seat-quotes/'+inc.id+'/accept',owner.refreshToken,{quoteHash:inc.quoteHash});
   await pool.query('UPDATE commercial_seat_decreases SET accepted_at=to_timestamp($2) WHERE id=$1',[dec.id,now-40]);
   await pool.query('UPDATE commercial_seat_changes SET accepted_at=to_timestamp($2) WHERE id=$1',[inc.id,now-30]);
   const addition=event(1,inc.quote.proposedRoundedJpy,now-10,{quoteHash:inc.quoteHash,seatChangeId:inc.id});assert.equal((await send(addition)).status,200);
   if(legacy){
    const facts=JSON.stringify((await pool.query("SELECT to_jsonb(s)-'provider_event_created' row FROM commercial_seat_changes s ORDER BY id")).rows);
    await pool.query('ALTER TABLE commercial_seat_changes DROP COLUMN provider_event_created');
    const {migrateCommercialSeats}=await import('../src/commercial-seats.js');await migrateCommercialSeats(pool);await migrateCommercialSeats(pool);
    assert.equal(JSON.stringify((await pool.query("SELECT to_jsonb(s)-'provider_event_created' row FROM commercial_seat_changes s ORDER BY id")).rows),facts);
    assert.equal((await pool.query('SELECT count(*)::int n FROM commercial_seat_changes WHERE provider_event_created IS NOT NULL')).rows[0].n,0);
   }
   const after=event(2,980,legacy?now-20:now-5,{seatDecreaseId:dec.id,seatDecreaseQuoteHash:dec.quoteHash});
   const rejected=await send(after);assert.equal(rejected.status,200);assert.equal(rejected.body.refundReviewRequired,true);assert.equal(rejected.body.seatDecreaseFunded,false);
   assert.equal((await pool.query('SELECT count(*)::int n FROM commercial_live_periods WHERE contract_id=$1 AND cycle=2',[q.id])).rows[0].n,0);
   if(!legacy){const boundary=event(2,980,now-10,{seatDecreaseId:dec.id,seatDecreaseQuoteHash:dec.quoteHash});assert.equal((await send(boundary)).body.refundReviewRequired,true);}
   else {
    // Even with unknown success time, a payment clearly before the consent
    // lower bound is provably before the addition could take effect.
    const earlier=event(2,980,now-35,{seatDecreaseId:dec.id,seatDecreaseQuoteHash:dec.quoteHash});assert.equal((await send(earlier)).body.seatDecreaseFunded,true);
    assert.equal((await send(addition)).body.duplicate,true);
    assert.equal((await pool.query('SELECT provider_event_created FROM commercial_seat_changes WHERE id=$1',[inc.id])).rows[0].provider_event_created,null);
   }
  }
 }finally{
  server.closeAllConnections();await new Promise(r=>server.close(r));await close();await admin.query('DROP DATABASE '+name);await admin.end();
  for(const k of ['PASSSHARE_STRIPE_LIVE_WEBHOOK_SECRET','PASSSHARE_STRIPE_LIVE_ACCOUNT','PASSSHARE_COMMERCIAL_LIVE_ENABLED'])delete process.env[k];
 }
});
