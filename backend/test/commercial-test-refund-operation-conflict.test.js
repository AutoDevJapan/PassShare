import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import Stripe from 'stripe';
import {trackPoolShutdown} from './helpers/pg-fixture-lifecycle.js';

test('simultaneous approvals with one operation id across contracts conflict without leaking or changing the winner',{skip:process.env.PASSSHARE_RECEIPTS_PG!=='true'},async()=>{
 const url=new URL(process.env.DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.username,'passshare');assert.equal(url.pathname,'/passshare');
 const admin=new pg.Pool({connectionString:url.href}),db='ps_test_operation_conflict_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+db);url.pathname='/'+db;
 const pool=new pg.Pool({connectionString:url.href,max:10}),close=trackPoolShutdown(pool);
 const keys=['PASSSHARE_COMMERCIAL_REFUND_REVIEWER_IDS','PASSSHARE_STRIPE_TEST_WEBHOOK_SECRET','PASSSHARE_STRIPE_TEST_ACCOUNT','PASSSHARE_STRIPE_TEST_ENDPOINT_SCOPE'],saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 const account='acct_operationconflict',secret='whsec_operationconflict',password='fixture-'+randomUUID();
 Object.assign(process.env,{PASSSHARE_STRIPE_TEST_WEBHOOK_SECRET:secret,PASSSHARE_STRIPE_TEST_ACCOUNT:account,PASSSHARE_STRIPE_TEST_ENDPOINT_SCOPE:'direct'});delete process.env.PASSSHARE_COMMERCIAL_REFUND_REVIEWER_IDS;
 let server,base,concurrent,armed=false,reads=0,releaseReads,arrived;
 const allReads=new Promise(resolve=>{arrived=resolve;}),readBarrier=new Promise(resolve=>{releaseReads=resolve;});
 let stopTimer;
 // Execute every statement against real PG. The wrapper only synchronizes the
 // two absent-operation SELECTs so both transactions reach the INSERT race.
 const originalConnect=pool.connect.bind(pool);
 pool.connect=function(callback){if(typeof callback==='function')return originalConnect(callback);return originalConnect().then(client=>{if(!armed)return client;const query=client.query,release=client.release;client.query=async(sql,args)=>{const result=await query.call(client,sql,args);if(armed&&typeof sql==='string'&&sql.startsWith('SELECT * FROM commercial_test_refund_operations WHERE operation_id=$1')&&result.rowCount===0){reads++;if(reads===2)arrived();await readBarrier;}return result;};client.release=(...args)=>{client.query=query;client.release=release;return release.apply(client,args);};return client;});};
 const stop=async()=>{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));server=null;}};
 const start=async()=>{const {createApp}=await import('../src/app.js'),{app}=await createApp({pool,testRefundLookup:null,testRefundExecutor:null});server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base='http://127.0.0.1:'+server.address().port;};
 const call=async(path,actor,body,method=body===undefined?'GET':'POST')=>{const response=await fetch(base+path,{method,signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json','x-passshare-client':'mobile',...(actor?{authorization:'Bearer '+actor.refreshToken}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json().catch(()=>null)};};
 try{
  await start();const actors=[];
  for(let index=0;index<3;index++){const email=randomUUID()+'@example.test',reply=await call('/api/auth/signup',null,{email,password});assert.equal(reply.status,201);actors.push({...reply.body,email});}
  const [owner,other,reviewer]=actors,contracts=[];
  for(const actor of [owner,other]){
   const reply=await call('/api/commercial-contracts',actor,{requestId:randomUUID(),currency:'JPY',plan:{type:'personal',users:1},setup:{installationCompanies:0,supportHours:0,maintenanceMonthlyJpy:null}});assert.equal(reply.status,201);const contract=reply.body;
   assert.equal((await call('/api/commercial-contracts/'+contract.id+'/accept',actor,{quoteHash:contract.quoteHash})).status,200);
   const payment={id:'pi_'+randomUUID().replaceAll('-',''),object:'payment_intent',livemode:false,status:'succeeded',currency:'jpy',amount:980,amount_received:980,metadata:{contractId:contract.id,ownerId:actor.user.id,quoteHash:contract.quoteHash}};
   const payload=JSON.stringify({id:'evt_'+randomUUID().replaceAll('-',''),type:'payment_intent.succeeded',livemode:false,created:Math.floor(Date.now()/1000),data:{object:payment}});
   assert.equal((await fetch(base+'/api/commercial-events/stripe-test',{method:'POST',headers:{'content-type':'application/json','stripe-signature':Stripe.webhooks.generateTestHeaderString({payload,secret})},body:payload})).status,200);contracts.push({...contract,paymentId:payment.id,actor});
  }
  process.env.PASSSHARE_COMMERCIAL_REFUND_REVIEWER_IDS=reviewer.user.id;await stop();await start();
  const operationId=randomUUID(),body=contract=>({operationId,paymentIntentId:contract.paymentId,quoteHash:contract.quoteHash,amountJpy:100,reason:'unprovided_period_confirmed'}),route=contract=>'/api/commercial-contracts/'+contract.id+'/test-refund-operations';
  armed=true;concurrent=Promise.all(contracts.map(contract=>call(route(contract),reviewer,body(contract))));
  await Promise.race([allReads,new Promise((_,reject)=>{stopTimer=setTimeout(()=>reject(Error('Both real PG absent reads must synchronize')),5000);})]);clearTimeout(stopTimer);assert.equal(reads,2);releaseReads();armed=false;
  const results=await concurrent;concurrent=null;assert.deepEqual(results.map(result=>result.status).sort((a,b)=>a-b),[201,409]);
  const winner=results[0].status===201?0:1,loser=1-winner,winnerContract=contracts[winner],loserContract=contracts[loser];
  const before=(await pool.query('SELECT * FROM commercial_test_refund_operations WHERE operation_id=$1',[operationId])).rows;assert.equal(before.length,1);assert.equal(before[0].contract_id,winnerContract.id);
  assert(!JSON.stringify(results[loser].body).includes(winnerContract.id));assert(!JSON.stringify(results[loser].body).includes(before[0].decision_fingerprint));
  assert.equal((await call(route(loserContract),reviewer,body(loserContract))).status,409);
  assert.equal((await call(route(winnerContract),reviewer,body(winnerContract))).status,201);
  assert.equal((await call(route(winnerContract)+'/'+operationId,loserContract.actor)).status,404);
  assert.equal((await call(route(loserContract)+'/'+operationId,loserContract.actor)).status,404);
  const after=(await pool.query('SELECT * FROM commercial_test_refund_operations WHERE operation_id=$1',[operationId])).rows;assert.deepEqual(after,before);
  assert.equal(after[0].first_dispatched_at,null);assert.equal(after[0].provider_refund_id,null);assert.equal(after[0].state,'approved');
  for(const actor of [reviewer,owner,other])assert.equal((await call('/api/auth/account',actor,{currentPassword:password,confirmationEmail:actor.email},'DELETE')).status,204);
  assert.equal((await pool.query('SELECT count(*)::int n FROM commercial_test_refund_operations')).rows[0].n,0);
 }finally{armed=false;releaseReads();clearTimeout(stopTimer);if(concurrent)await concurrent.catch(()=>{});await stop();await close();await admin.query('DROP DATABASE '+db+' WITH (FORCE)');await admin.end();for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
