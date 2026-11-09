import assert from 'node:assert/strict';
import {test} from 'node:test';
import pg from 'pg';
import Stripe from 'stripe';
import {randomUUID} from 'node:crypto';
import {trackPoolShutdown} from './helpers/pg-fixture-lifecycle.js';
import {currentBillingPlan} from '../src/commercial-plan.js';
test('signed renewal binds a decrease while preserving current seats and stale paid evidence',{skip:process.env.PASSSHARE_RECEIPTS_PG!=='true'},async()=>{
 const baseUrl=new URL(process.env.DATABASE_URL);assert.equal(baseUrl.hostname,'127.0.0.1');assert.equal(baseUrl.username,'passshare');assert.equal(baseUrl.pathname,'/passshare');
 const admin=new pg.Pool({connectionString:baseUrl.href}),db='ps_decrease_pay_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+db);
 baseUrl.pathname='/'+db;const pool=new pg.Pool({connectionString:baseUrl.href}),close=trackPoolShutdown(pool);
 const secret='whsec_decrease_payment_fixture',account='acct_decreasepayments';
 Object.assign(process.env,{PASSSHARE_STRIPE_LIVE_WEBHOOK_SECRET:secret,PASSSHARE_STRIPE_LIVE_ACCOUNT:account,PASSSHARE_COMMERCIAL_LIVE_ENABLED:'true'});
 const {createApp}=await import('../src/app.js');const {app}=await createApp({pool});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const host='http://127.0.0.1:'+server.address().port;
 const call=async(path,token,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(host+path,{method,headers:{'content-type':'application/json','x-passshare-client':'mobile',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json().catch(()=>null)};};
 const send=async(event)=>{const payload=JSON.stringify(event);const r=await fetch(host+'/api/commercial-events/stripe-live',{method:'POST',headers:{'content-type':'application/json','stripe-signature':Stripe.webhooks.generateTestHeaderString({payload,secret})},body:payload});return {status:r.status,body:await r.json()};};
 const id=prefix=>prefix+randomUUID().replaceAll('-','');let owner,quote;
 const payment=(cycle,amount,decrease)=>({id:id('evt_'),account,type:'payment_intent.succeeded',livemode:true,created:Math.floor(Date.now()/1000),data:{object:{id:id('pi_'),object:'payment_intent',status:'succeeded',currency:'jpy',amount,amount_received:amount,livemode:true,metadata:{contractId:quote.id,ownerId:owner.user.id,quoteHash:quote.quoteHash,cycle:String(cycle),...(decrease?{seatDecreaseId:decrease.id,seatDecreaseQuoteHash:decrease.quoteHash}:{})}}}});
 try{
  const email=randomUUID()+'@example.test',password='synthetic-decrease-payment-password';
  owner=(await call('/api/auth/signup',null,{email,password})).body;
  const root='/api/commercial-contracts';quote=(await call(root,owner.refreshToken,{requestId:randomUUID(),currency:'JPY',plan:{type:'personal',users:3},setup:{installationCompanies:0,supportHours:0,maintenanceMonthlyJpy:null}})).body;
  assert.equal((await call(root+'/'+quote.id+'/accept',owner.refreshToken,{quoteHash:quote.quoteHash})).status,200);
  const initial=payment(1,2940);assert.equal((await send(initial)).status,200);
  const path=root+'/'+quote.id+'/seat-decrease-quotes';
  const make=async users=>{const r=await call(path,owner.refreshToken,{requestId:randomUUID(),requestedPlan:{type:'personal',users}});assert.equal(r.status,201);assert.equal((await call(path+'/'+r.body.id+'/accept',owner.refreshToken,{quoteHash:r.body.quoteHash})).status,200);return r.body;};
  const old=await make(1),next=await make(2);
  assert.equal(next.quote.renewalQuote.monthlyTotalJpy,1960);
  const stale=payment(2,980,old);stale.created=Math.floor(new Date((await pool.query('SELECT superseded_at t FROM commercial_seat_decreases WHERE id=$1',[old.id])).rows[0].t).getTime()/1000)+1;
  const staleResult=await send(stale);assert.equal(staleResult.status,200);assert.equal(staleResult.body.refundReviewRequired,true);assert.equal(staleResult.body.seatDecreaseFunded,false);
  const staleRows=JSON.stringify((await pool.query('SELECT * FROM commercial_plan_payment_exceptions')).rows);
  const staleAgain=await send(stale);assert.equal(staleAgain.status,200);assert.equal(staleAgain.body.duplicate,true);
  assert.equal(JSON.stringify((await pool.query('SELECT * FROM commercial_plan_payment_exceptions')).rows),staleRows);
  const colliding=payment(2,1960,next);colliding.id=stale.id;colliding.data.object.id=stale.data.object.id;assert.equal((await send(colliding)).status,409);
  const wrong=payment(2,1960,next);wrong.data.object.currency='usd';assert.equal((await send(wrong)).status,400);
  const wrongAmount=payment(2,1959,next);assert.equal((await send(wrongAmount)).status,409);
  const wrongHash=payment(2,1960,next);wrongHash.data.object.metadata.seatDecreaseQuoteHash='0'.repeat(64);assert.equal((await send(wrongHash)).status,409);
  const sandbox=payment(2,1960,next);sandbox.livemode=false;sandbox.data.object.livemode=false;assert.equal((await send(sandbox)).status,400);
  const pay=payment(2,1960,next),funded=await send(pay);assert.equal(funded.status,200);assert.equal(funded.body.seatDecreaseFunded,true);
  const periods=(await pool.query('SELECT *,period_start::text s,period_end::text e FROM commercial_live_periods WHERE contract_id=$1 ORDER BY cycle',[quote.id])).rows;
  assert.equal(periods.length,2);assert.equal(Number(periods[1].amount_jpy),1960);assert.equal(periods[1].billing_plan.users,2);assert.equal(periods[1].seat_decrease_id,next.id);
  assert.equal((await pool.query('SELECT state FROM commercial_seat_decreases WHERE id=$1',[next.id])).rows[0].state,'funded');
  const displayed=await call(root+'/'+quote.id,owner.refreshToken);assert.equal(displayed.status,200);assert.equal(displayed.body.currentPlan.users,3);assert.equal(displayed.body.seatRevision,0);
  // Explicit server-clock adapter unit check, not a production clock change:
  // the stored paid-cycle plan becomes current at its existing JST anchor.
  const row=(await pool.query('SELECT * FROM commercial_contracts WHERE id=$1',[quote.id])).rows[0];
  const future=await currentBillingPlan(pool,row,Date.parse(periods[1].s+'T00:00:00+09:00'));assert.equal(future.users,2);
  const saved=JSON.stringify((await pool.query('SELECT * FROM commercial_live_periods ORDER BY cycle')).rows);
  const replay=await send(pay);assert.equal(replay.status,200);assert.equal(replay.body.duplicate,true);
  assert.equal(JSON.stringify((await pool.query('SELECT * FROM commercial_live_periods ORDER BY cycle')).rows),saved);
  const sameIntent=payment(2,1960,next);sameIntent.data.object.id=pay.data.object.id;assert.equal((await send(sameIntent)).status,409);
  const exceptions=await call(root+'/'+quote.id+'/payment-exceptions',owner.refreshToken);assert.equal(exceptions.status,200);assert.equal(exceptions.body.refundExecuted,false);assert.equal(exceptions.body.payments.length,1);assert.equal(exceptions.body.payments[0].amountJpy,980);
  assert.equal((await call(path,owner.refreshToken,{requestId:randomUUID(),requestedPlan:{type:'personal',users:1}})).status,409);
  // A later, paid in-cycle increase invalidates an older pending decrease.
  // Its captured money is retained for refund review, never silently applied.
  quote=(await call(root,owner.refreshToken,{requestId:randomUUID(),currency:'JPY',plan:{type:'personal',users:3},setup:{installationCompanies:0,supportHours:0,maintenanceMonthlyJpy:null}})).body;
  assert.equal((await call(root+'/'+quote.id+'/accept',owner.refreshToken,{quoteHash:quote.quoteHash})).status,200);
  assert.equal((await send(payment(1,2940))).status,200);
  const nextPath=root+'/'+quote.id+'/seat-decrease-quotes';
  const candidate=(await call(nextPath,owner.refreshToken,{requestId:randomUUID(),requestedPlan:{type:'personal',users:1}})).body;
  assert.equal((await call(nextPath+'/'+candidate.id+'/accept',owner.refreshToken,{quoteHash:candidate.quoteHash})).status,200);
  const increase=(await call(root+'/'+quote.id+'/seat-quotes',owner.refreshToken,{requestId:randomUUID(),requestedPlan:{type:'personal',users:4},roundingPolicy:'ceil-jpy'})).body;
  assert.equal((await call(root+'/'+quote.id+'/seat-quotes/'+increase.id+'/accept',owner.refreshToken,{quoteHash:increase.quoteHash})).status,200);
  const add=payment(1,increase.quote.proposedRoundedJpy);add.data.object.metadata.seatChangeId=increase.id;add.data.object.metadata.quoteHash=increase.quoteHash;
  assert.equal((await send(add)).status,200);
  const obsolete=payment(2,980,candidate);obsolete.created=Math.floor(new Date((await pool.query('SELECT accepted_at t FROM commercial_seat_changes WHERE id=$1',[increase.id])).rows[0].t).getTime()/1000)+1;
  const outdated=await send(obsolete);assert.equal(outdated.status,200);assert.equal(outdated.body.refundReviewRequired,true);assert.equal(outdated.body.seatDecreaseFunded,false);
  const unchanged=await call(root+'/'+quote.id,owner.refreshToken);assert.equal(unchanged.body.currentPlan.users,4);assert.equal(unchanged.body.seatRevision,1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM commercial_live_periods WHERE contract_id=$1 AND cycle=2',[quote.id])).rows[0].n,0);
  const raceQuote=(await call(root+'/'+quote.id+'/seat-quotes',owner.refreshToken,{requestId:randomUUID(),requestedPlan:{type:'personal',users:5},roundingPolicy:'ceil-jpy'})).body;
  assert.equal((await call(root+'/'+quote.id+'/seat-quotes/'+raceQuote.id+'/accept',owner.refreshToken,{quoteHash:raceQuote.quoteHash})).status,200);
  const seatRace=payment(1,raceQuote.quote.proposedRoundedJpy);seatRace.data.object.metadata.seatChangeId=raceQuote.id;seatRace.data.object.metadata.quoteHash=raceQuote.quoteHash;
  const reductionRace=payment(2,980,candidate);reductionRace.created=obsolete.created;reductionRace.id=seatRace.id;reductionRace.data.object.id=seatRace.data.object.id;
  const racing=await Promise.all([send(seatRace),send(reductionRace)]);assert.deepEqual(racing.map(x=>x.status).sort(),[200,409]);
  const unique=(await pool.query('SELECT (SELECT count(*) FROM commercial_seat_changes WHERE account_id=$1 AND event_id=$2)+(SELECT count(*) FROM commercial_plan_payment_exceptions WHERE account_id=$1 AND event_id=$2) n',[account,seatRace.id])).rows[0];assert.equal(Number(unique.n),1);
  const oldInvoice=payment(2,2940);oldInvoice.created=obsolete.created-2;
  const earlierPlan=await send(oldInvoice);assert.equal(earlierPlan.status,200);assert.equal(earlierPlan.body.billingAdjustmentReviewRequired,true);
  assert.equal((await pool.query("SELECT count(*)::int n FROM commercial_live_periods WHERE contract_id=$1 AND cycle=2 AND billing_plan->>'users'='3' AND plan_adjustment_review",[quote.id])).rows[0].n,1);
  // A payment completed under the old reservation BEFORE replacement cannot
  // lose its paid period merely because its signed delivery was delayed.
  quote=(await call(root,owner.refreshToken,{requestId:randomUUID(),currency:'JPY',plan:{type:'personal',users:3},setup:{installationCompanies:0,supportHours:0,maintenanceMonthlyJpy:null}})).body;
  await call(root+'/'+quote.id+'/accept',owner.refreshToken,{quoteHash:quote.quoteHash});await send(payment(1,2940));
  const historicalPath=root+'/'+quote.id+'/seat-decrease-quotes';
  const makeHistorical=async users=>{const r=await call(historicalPath,owner.refreshToken,{requestId:randomUUID(),requestedPlan:{type:'personal',users}});assert.equal(r.status,201);assert.equal((await call(historicalPath+'/'+r.body.id+'/accept',owner.refreshToken,{quoteHash:r.body.quoteHash})).status,200);return r.body;};
  const prior=await makeHistorical(1),latest=await makeHistorical(2);
  // Explicit isolated-DB timestamp adapter; no production clock is changed.
  await pool.query("UPDATE commercial_seat_decreases SET accepted_at=clock_timestamp()-interval '20 seconds',superseded_at=clock_timestamp()-interval '10 seconds' WHERE id=$1",[prior.id]);
  const delayed=payment(2,980,prior);delayed.created=Math.floor(Date.now()/1000)-15;
  const oldPaid=await send(delayed);assert.equal(oldPaid.status,200);assert.equal(oldPaid.body.seatDecreaseFunded,true);assert.equal(oldPaid.body.billingAdjustmentReviewRequired,true);
  assert.equal((await pool.query('SELECT state FROM commercial_seat_decreases WHERE id=$1',[prior.id])).rows[0].state,'historical_funded');
  assert.equal((await pool.query('SELECT state FROM commercial_seat_decreases WHERE id=$1',[latest.id])).rows[0].state,'settlement_review');
  assert.equal((await call(historicalPath+'/'+prior.id+'/accept',owner.refreshToken,{quoteHash:prior.quoteHash})).status,409);
  assert.equal((await pool.query('SELECT count(*)::int n FROM commercial_live_periods WHERE contract_id=$1 AND cycle=2 AND disposition=\'effective\' AND plan_adjustment_review',[quote.id])).rows[0].n,1);
  const lateCopy=await send(delayed);assert.equal(lateCopy.status,200);assert.equal(lateCopy.body.duplicate,true);
  // An original-plan payment captured before a decrease request and delivered
  // later keeps the paid dates. The new quantity needs adjustment review.
  quote=(await call(root,owner.refreshToken,{requestId:randomUUID(),currency:'JPY',plan:{type:'personal',users:3},setup:{installationCompanies:0,supportHours:0,maintenanceMonthlyJpy:null}})).body;
  await call(root+'/'+quote.id+'/accept',owner.refreshToken,{quoteHash:quote.quoteHash});await send(payment(1,2940));
  const unboundPath=root+'/'+quote.id+'/seat-decrease-quotes';
  const requested=(await call(unboundPath,owner.refreshToken,{requestId:randomUUID(),requestedPlan:{type:'personal',users:2}})).body;
  assert.equal((await call(unboundPath+'/'+requested.id+'/accept',owner.refreshToken,{quoteHash:requested.quoteHash})).status,200);
  const original=payment(2,2940);original.created=Math.floor(new Date((await pool.query('SELECT accepted_at t FROM commercial_seat_decreases WHERE id=$1',[requested.id])).rows[0].t).getTime()/1000)-1;
  const originalPaid=await send(original);assert.equal(originalPaid.status,200);assert.equal(originalPaid.body.billingAdjustmentReviewRequired,true);
  assert.equal((await pool.query('SELECT state FROM commercial_seat_decreases WHERE id=$1',[requested.id])).rows[0].state,'settlement_review');
  assert.equal((await pool.query("SELECT count(*)::int n FROM commercial_live_periods WHERE contract_id=$1 AND cycle=2 AND disposition='effective' AND billing_plan->>'users'='3' AND plan_adjustment_review",[quote.id])).rows[0].n,1);
  await assert.rejects(pool.query('UPDATE commercial_live_periods SET seat_decrease_id=$2 WHERE seat_decrease_id=$1',[next.id,candidate.id]),e=>e.code==='23503');
  await assert.rejects(pool.query('UPDATE commercial_plan_payment_exceptions SET seat_decrease_id=$2 WHERE seat_decrease_id=$1',[old.id,candidate.id]),e=>e.code==='23503');
  const beforeMigration=JSON.stringify((await pool.query('SELECT * FROM commercial_seat_decreases ORDER BY id')).rows);
  const beforeMoney=JSON.stringify((await pool.query('SELECT * FROM commercial_plan_payment_exceptions ORDER BY account_id,event_id')).rows);
  const beforePeriods=JSON.stringify((await pool.query('SELECT * FROM commercial_live_periods ORDER BY account_id,event_id')).rows);
  const {migrateSeatDecreases}=await import('../src/commercial-seat-decreases.js');await migrateSeatDecreases(pool);await migrateSeatDecreases(pool);
  assert.equal(JSON.stringify((await pool.query('SELECT * FROM commercial_seat_decreases ORDER BY id')).rows),beforeMigration);
  assert.equal(JSON.stringify((await pool.query('SELECT * FROM commercial_plan_payment_exceptions ORDER BY account_id,event_id')).rows),beforeMoney);
  assert.equal(JSON.stringify((await pool.query('SELECT * FROM commercial_live_periods ORDER BY account_id,event_id')).rows),beforePeriods);
  assert.equal((await call('/api/auth/account',owner.refreshToken,{currentPassword:password,confirmationEmail:email},'DELETE')).status,204);
  for(const table of ['commercial_contracts','commercial_seat_decreases','commercial_plan_payment_exceptions','commercial_live_periods','commercial_seat_changes'])assert.equal((await pool.query('SELECT count(*)::int n FROM '+table)).rows[0].n,0);
  assert.equal((await send(pay)).status,409);
 }finally{
  server.closeAllConnections();await new Promise(r=>server.close(r));await close();await admin.query('DROP DATABASE '+db);await admin.end();
  for(const k of ['PASSSHARE_STRIPE_LIVE_WEBHOOK_SECRET','PASSSHARE_STRIPE_LIVE_ACCOUNT','PASSSHARE_COMMERCIAL_LIVE_ENABLED'])delete process.env[k];
 }
});
