import assert from 'node:assert/strict';import {test} from 'node:test';import pg from 'pg';import Stripe from 'stripe';import {randomUUID} from 'node:crypto';
test('owner seat quote, explicit consent and verified payment apply one revision in isolated PostgreSQL',{skip:process.env.PASSSHARE_RECEIPTS_PG!=='true'},async()=>{
 assert.match(process.env.DATABASE_URL,/^postgresql:\/\/passshare:passshare@127\.0\.0\.1:(5432|15431)\/passshare$/);
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL}),db='ps_seats_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+db);
 const url=new URL(process.env.DATABASE_URL);url.pathname='/'+db;const pool=new pg.Pool({connectionString:url.href});
 const secret='whsec_seats_fixture',account='acct_seatsfixture';
 Object.assign(process.env,{PASSSHARE_STRIPE_LIVE_WEBHOOK_SECRET:secret,PASSSHARE_STRIPE_LIVE_ACCOUNT:account,PASSSHARE_COMMERCIAL_LIVE_ENABLED:'true'});
 const {createApp}=await import('../src/app.js');const {app}=await createApp({pool});const s=app.listen(0,'127.0.0.1');await new Promise(r=>s.once('listening',r));const base='http://127.0.0.1:'+s.address().port;
 const call=async(p,t,b)=>{const r=await fetch(base+p,{method:b===undefined?'GET':'POST',headers:{'content-type':'application/json','x-passshare-client':'mobile',...(t?{authorization:'Bearer '+t}:{})},body:b===undefined?undefined:JSON.stringify(b)});return {status:r.status,body:await r.json().catch(()=>null)}};
 const send=async(e)=>{const payload=JSON.stringify(e),r=await fetch(base+'/api/commercial-events/stripe-live',{method:'POST',headers:{'content-type':'application/json','stripe-signature':Stripe.webhooks.generateTestHeaderString({payload,secret})},body:payload});return {status:r.status,body:await r.json()}};
 const id=p=>p+randomUUID().replaceAll('-','');
 let owner,other,q;
 const payment=(change,amount)=>({id:id('evt_'),account,type:'payment_intent.succeeded',livemode:true,created:Math.floor(Date.now()/1000),data:{object:{id:id('pi_'),object:'payment_intent',status:'succeeded',currency:'jpy',amount,amount_received:amount,livemode:true,metadata:{contractId:q.id,ownerId:owner.user.id,quoteHash:change?.quoteHash??q.quoteHash,cycle:'1',...(change?{seatChangeId:change.id}:{})}}}});
 try{
  for(const role of ['owner','other']){const r=await call('/api/auth/signup',null,{email:role+randomUUID()+'@example.test',password:'synthetic-password123'});assert.equal(r.status,201);if(role==='owner')owner=r.body;else other=r.body;}
  const root='/api/commercial-contracts';
  const qr=await call(root,owner.refreshToken,{requestId:randomUUID(),currency:'JPY',plan:{type:'personal',users:1},setup:{installationCompanies:0,supportHours:0,maintenanceMonthlyJpy:null}});assert.equal(qr.status,201);q=qr.body;
  await call(root+'/'+q.id+'/accept',owner.refreshToken,{quoteHash:q.quoteHash});
  const path=root+'/'+q.id+'/seat-quotes',input={requestId:randomUUID(),requestedPlan:{type:'personal',users:2},roundingPolicy:'ceil-jpy'};
  assert.equal((await call(path,owner.refreshToken,input)).status,409); // no live paid period
  const initialPaid=payment(null,980);assert.equal((await send(initialPaid)).status,200);
  assert.equal((await call(path,null,input)).status,401);
  assert.equal((await call(path,other.refreshToken,input)).status,404);
  assert.equal((await call(path,owner.refreshToken,{...input,periodEnd:'2099-01-01'})).status,400);
  const pair=await Promise.all([call(path,owner.refreshToken,input),call(path,owner.refreshToken,input)]);
  assert.deepEqual(pair.map(r=>r.status),[201,201]);const a=pair[0].body;assert.equal(a.id,pair[1].body.id);
  assert.equal(a.quote.currentPlan.users,1);assert.equal(a.quote.requestedPlan.users,2);assert.ok(a.quote.proposedRoundedJpy>0);
  assert.equal((await pool.query('SELECT current_plan FROM commercial_contracts WHERE id=$1',[q.id])).rows[0].current_plan,null);
  assert.equal((await call(path,owner.refreshToken,{...input,requestedPlan:{type:'personal',users:3}})).status,409);
  assert.equal((await send(payment(a,a.quote.proposedRoundedJpy))).status,409); // no consent
  assert.equal((await call(path+'/'+a.id+'/accept',owner.refreshToken,{quoteHash:'0'.repeat(64)})).status,409);
  const old=(await call(path,owner.refreshToken,{...input,requestId:randomUUID()})).body;
  const accepted=await call(path+'/'+a.id+'/accept',owner.refreshToken,{quoteHash:a.quoteHash});assert.equal(accepted.status,200);assert.equal(accepted.body.state,'accepted_unpaid');assert.equal(accepted.body.paymentRequired,true);
  assert.equal((await call(path+'/'+old.id+'/accept',owner.refreshToken,{quoteHash:old.quoteHash})).status,200);
  assert.equal((await send(payment(a,a.quote.proposedRoundedJpy+1))).status,409);
  const pay=payment(a,a.quote.proposedRoundedJpy);
  // Distinguish quote creation from actual payment receipt.
  await pool.query("UPDATE commercial_seat_changes SET created_at=clock_timestamp()-interval '1 day' WHERE contract_id=$1",[q.id]);
  const receiptNotBefore=Date.now()-1000;
  const competingPay=payment(old,old.quote.proposedRoundedJpy);
  const paid=await Promise.all([send(pay),send(pay),send(competingPay)]);assert.deepEqual(paid.map(r=>r.status),[200,200,200]);assert.equal(paid.filter(r=>r.body.duplicate).length,1);
  const states=(await pool.query('SELECT id,state FROM commercial_seat_changes WHERE contract_id=$1',[q.id])).rows;
  assert.equal(states.filter(r=>r.state==='applied').length,1);assert.equal(states.filter(r=>r.state==='refund_review').length,1);
  const winner=states.find(r=>r.state==='applied').id===a.id?a:old;
  const losingPay=winner.id===a.id?competingPay:pay;
  const stored=(await pool.query('SELECT current_plan,seat_revision FROM commercial_contracts WHERE id=$1',[q.id])).rows[0];assert.equal(stored.current_plan.users,2);assert.equal(stored.seat_revision,1);
  const displayed=await call(root+'/'+q.id,owner.refreshToken);assert.equal(displayed.body.currentPlan.users,2);assert.equal(displayed.body.seatRevision,1);
  assert.equal((await call(path+'/'+winner.id,owner.refreshToken)).body.state,'applied');
  assert.equal((await call(path+'/'+a.id,other.refreshToken)).status,404);
  const stalePaid=await send(losingPay);assert.equal(stalePaid.status,200);assert.equal(stalePaid.body.seatChangeApplied,false);assert.equal(stalePaid.body.refundReviewRequired,true);
  const loser=winner.id===a.id?old:a;assert.equal((await call(path+'/'+loser.id+'/accept',owner.refreshToken,{quoteHash:loser.quoteHash})).status,409);
  const next=await call(path,owner.refreshToken,{...input,requestId:randomUUID(),requestedPlan:{type:'personal',users:3}});assert.equal(next.status,201);assert.equal(next.body.quote.currentPlan.users,2);
  assert.equal((await send(initialPaid)).status,200); // old period replay remains valid after plan change
  assert.equal((await call(path,owner.refreshToken,{...input,requestId:randomUUID(),requestedPlan:{type:'personal',users:1}})).status,400); // decreases use the separate next-renewal story
  await call(path+'/'+next.body.id+'/accept',owner.refreshToken,{quoteHash:next.body.quoteHash});
  const wrongOwner=payment(next.body,next.body.quote.proposedRoundedJpy);wrongOwner.data.object.metadata.ownerId=other.user.id;assert.equal((await send(wrongOwner)).status,404);
  const wrongCurrency=payment(next.body,next.body.quote.proposedRoundedJpy);wrongCurrency.data.object.currency='usd';assert.equal((await send(wrongCurrency)).status,400);
  const reusedPeriod=payment(next.body,next.body.quote.proposedRoundedJpy);reusedPeriod.data.object.id=initialPaid.data.object.id;assert.equal((await send(reusedPeriod)).status,409);
  const reusedSeat=payment(null,1960);reusedSeat.data.object.metadata.cycle='2';reusedSeat.data.object.id=pay.data.object.id;assert.equal((await send(reusedSeat)).status,409);
  const wrongCycle=payment(next.body,next.body.quote.proposedRoundedJpy);wrongCycle.data.object.metadata.cycle='2';assert.equal((await send(wrongCycle)).status,409);
  // Crossing the stored period boundary invalidates the quote, even on the same server date.
  const period=(await pool.query('SELECT period_start::text s,period_end::text e FROM commercial_live_periods WHERE contract_id=$1',[q.id])).rows[0];
  await pool.query("UPDATE commercial_live_periods SET period_start=CURRENT_DATE-2,period_end=CURRENT_DATE-1 WHERE contract_id=$1",[q.id]);
  const expiredPaid=await send(payment(next.body,next.body.quote.proposedRoundedJpy));assert.equal(expiredPaid.status,200);assert.equal(expiredPaid.body.refundReviewRequired,true);assert.equal(expiredPaid.body.seatChangeApplied,false);
  await pool.query('UPDATE commercial_live_periods SET period_start=$2::date,period_end=$3::date WHERE contract_id=$1',[q.id,period.s,period.e]);
  // Expire the saved quote (the caller cannot supply its own clock).
  const dated=await call(path,owner.refreshToken,{...input,requestId:randomUUID(),requestedPlan:{type:'personal',users:3}});assert.equal(dated.status,201);
  await call(path+'/'+dated.body.id+'/accept',owner.refreshToken,{quoteHash:dated.body.quoteHash});
  await pool.query("UPDATE commercial_seat_changes SET quote=jsonb_set(quote,'{changeDate}','\"2000-01-01\"') WHERE id=$1",[dated.body.id]);
  const datedPaid=await send(payment(dated.body,dated.body.quote.proposedRoundedJpy));assert.equal(datedPaid.status,200);assert.equal(datedPaid.body.refundReviewRequired,true);
  const exceptions=await call(root+'/'+q.id+'/payment-exceptions',owner.refreshToken);assert.equal(exceptions.status,200);assert.equal(exceptions.body.payments.length,3);assert.equal(exceptions.body.refundExecuted,false);assert.ok(exceptions.body.payments.every(p=>p.reason==='seat_quote_no_longer_applicable'));
  assert.ok(exceptions.body.payments.every(p=>Date.parse(p.receivedAt)>=receiptNotBefore));
  assert.equal((await pool.query('SELECT seat_revision FROM commercial_contracts WHERE id=$1',[q.id])).rows[0].seat_revision,1);
  const renewal=payment(null,1960);renewal.data.object.metadata.cycle='2';assert.equal((await send(renewal)).status,200);
  const raceQuote=(await call(path,owner.refreshToken,{...input,requestId:randomUUID(),requestedPlan:{type:'personal',users:3}})).body;
  assert.equal((await call(path+'/'+raceQuote.id+'/accept',owner.refreshToken,{quoteHash:raceQuote.quoteHash})).status,200);
  const seatRace=payment(raceQuote,raceQuote.quote.proposedRoundedJpy),periodRace=payment(null,1960);periodRace.data.object.metadata.cycle='3';
  periodRace.id=seatRace.id;periodRace.data.object.id=seatRace.data.object.id;
  const cross=await Promise.all([send(seatRace),send(periodRace)]);assert.deepEqual(cross.map(r=>r.status).sort(),[200,409]);
  const identityCount=await pool.query('SELECT (SELECT count(*) FROM commercial_seat_changes WHERE account_id=$1 AND event_id=$2)+(SELECT count(*) FROM commercial_live_periods WHERE account_id=$1 AND event_id=$2) n',[account,seatRace.id]);assert.equal(Number(identityCount.rows[0].n),1);
  // Removing the session must invalidate saved-quote access without granting any Box scope.
  await pool.query('DELETE FROM sessions WHERE user_id=$1',[owner.user.id]);
  assert.equal((await call(path+'/'+a.id,owner.refreshToken)).status,401);
  // A pre-receipt-column candidate can upgrade without fabricating historical timestamps.
  const before=(await pool.query('SELECT count(*)::int n FROM commercial_seat_changes')).rows[0].n;
  await pool.query('ALTER TABLE commercial_seat_changes DROP COLUMN payment_received_at');
  const {migrateCommercialSeats}=await import('../src/commercial-seats.js');
  await migrateCommercialSeats(pool);await migrateCommercialSeats(pool);
  assert.equal((await pool.query('SELECT count(*)::int n FROM commercial_seat_changes WHERE payment_received_at IS NULL')).rows[0].n,before);
 }finally{s.closeAllConnections();await new Promise(r=>s.close(r));await pool.end();await admin.query('DROP DATABASE '+db+' WITH (FORCE)');await admin.end();for(const k of ['PASSSHARE_STRIPE_LIVE_WEBHOOK_SECRET','PASSSHARE_STRIPE_LIVE_ACCOUNT','PASSSHARE_COMMERCIAL_LIVE_ENABLED'])delete process.env[k];}
});
