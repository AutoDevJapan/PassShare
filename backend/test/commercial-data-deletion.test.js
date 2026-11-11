import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import Stripe from 'stripe';
import {trackPoolShutdown} from './helpers/pg-fixture-lifecycle.js';
import {createMemoryLoginGuardStore} from '../src/auth/login-guard-store.js';

test('explicit ended-contract deletion is durable cancelable and deletes only the unchanged solely-owned box after30days',{skip:process.env.PASSSHARE_RECEIPTS_PG!=='true'},async()=>{
 const url=new URL(process.env.DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.username,'passshare');assert.equal(url.pathname,'/passshare');
 const admin=new pg.Pool({connectionString:url.href}),name='ps_data_deletion_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+name);url.pathname='/'+name;
 const pool=new pg.Pool({connectionString:url.href}),close=trackPoolShutdown(pool),secret='whsec_deletion_fixture',account='acct_deletionfixture',password='fixture-password-4431!';
 const keys=['PASSSHARE_COMMERCIAL_LIVE_ENABLED','PASSSHARE_STRIPE_LIVE_WEBHOOK_SECRET','PASSSHARE_STRIPE_LIVE_ACCOUNT'],saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));Object.assign(process.env,{PASSSHARE_COMMERCIAL_LIVE_ENABLED:'true',PASSSHARE_STRIPE_LIVE_WEBHOOK_SECRET:secret,PASSSHARE_STRIPE_LIVE_ACCOUNT:account});
 let server,base,failFailureCleanup=false;
 const loginGuardStore=createMemoryLoginGuardStore(),originalClear=loginGuardStore.clearEmailFailures.bind(loginGuardStore);
 loginGuardStore.clearEmailFailures=async email=>{if(failFailureCleanup)throw Error('Synthetic login counter cleanup failure');return originalClear(email);};
 const start=async()=>{const {createApp}=await import('../src/app.js'),{app}=await createApp({pool,loginGuardStore});server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base='http://127.0.0.1:'+server.address().port;};
 const stop=async()=>{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));server=null;}};
 const call=async(path,actor,body,method=body===undefined?'GET':'POST')=>{const response=await fetch(base+path,{method,signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json','x-passshare-client':'mobile',...(actor?{authorization:'Bearer '+actor.refreshToken}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json().catch(()=>null),cache:response.headers.get('cache-control')};};
 try{
  await start();const actors=[];for(let i=0;i<2;i++){const email=randomUUID()+'@example.test',reply=await call('/api/auth/signup',null,{email,password});assert.equal(reply.status,201);actors.push({...reply.body,email});}
  const [owner,other]=actors,quote=await call('/api/commercial-contracts',owner,{requestId:randomUUID(),currency:'JPY',plan:{type:'personal',users:1},setup:{installationCompanies:0,supportHours:0,maintenanceMonthlyJpy:null}});assert.equal(quote.status,201);const contract=quote.body;
  assert.equal((await call('/api/commercial-contracts/'+contract.id+'/accept',owner,{quoteHash:contract.quoteHash})).status,200);
  const boxId=(await call('/v1/vaults',{refreshToken:owner.connectAccessToken})).body[0].id;
  const itemId='a'.repeat(26);await pool.query('INSERT INTO connect_items(id,vault_id,document) VALUES($1,$2,$3::jsonb)',[itemId,boxId,JSON.stringify({id:itemId,title:'owned deletion fixture',version:1})]);
  const route='/api/commercial-contracts/'+contract.id+'/data-deletion-requests',request={requestId:randomUUID(),boxId,quoteHash:contract.quoteHash,expectedContentVersion:1,expectedAttributeVersion:1,expectedStateRevision:null,expectedKeyEpoch:null,confirmationBoxId:boxId,currentPassword:password};
  assert.equal((await call(route,owner,request)).status,409,'Unpaid acceptance alone cannot authorize post-contract deletion');
  const event={id:'evt_'+randomUUID().replaceAll('-',''),account,type:'payment_intent.succeeded',livemode:true,created:Math.floor((Date.now()-65*86400000)/1000),data:{object:{id:'pi_'+randomUUID().replaceAll('-',''),object:'payment_intent',status:'succeeded',currency:'jpy',amount:980,amount_received:980,livemode:true,metadata:{contractId:contract.id,ownerId:owner.user.id,quoteHash:contract.quoteHash,cycle:'1'}}}},payload=JSON.stringify(event);
  assert.equal((await fetch(base+'/api/commercial-events/stripe-live',{method:'POST',headers:{'content-type':'application/json','stripe-signature':Stripe.webhooks.generateTestHeaderString({payload,secret})},body:payload})).status,200);
  assert.equal((await call('/api/commercial-contracts/'+contract.id+'/cancel-at-period-end',owner,{quoteHash:contract.quoteHash})).status,200);
  assert.equal((await call(route,other,request)).status,404);assert.equal((await call(route,null,request)).status,401);
  assert.equal((await call(route,owner,{...request,deleted:true})).status,400);
  assert.equal((await call(route,owner,{...request,currentPassword:'wrong-password'})).status,401);
  const accepted=await call(route,owner,request);assert.equal(accepted.status,201);assert.equal(accepted.body.state,'pending');assert.equal(accepted.body.dataDeleted,false);assert.equal(accepted.cache,'no-store');
  assert(!JSON.stringify(accepted.body).includes(password));assert(!JSON.stringify(accepted.body).includes('owned deletion fixture'));
  const id=accepted.body.id,path=route+'/'+id;assert.deepEqual((await call(route,owner,request)).body,accepted.body);
  assert.equal((await call(route,owner,{...request,expectedContentVersion:2})).status,409);
  assert.equal((await call(path,other)).status,404);assert.equal((await call(path,owner)).status,200);
  await stop();await start();assert.deepEqual((await call(path,owner)).body,accepted.body);
  const cancel={revision:0},canceled=await call(path+'/cancel',owner,cancel);assert.equal(canceled.status,200);assert.equal(canceled.body.state,'canceled');assert.equal(canceled.body.dataDeleted,false);
  assert.deepEqual((await call(path+'/cancel',owner,cancel)).body,canceled.body);
  assert.equal((await call(path+'/execute',owner,{revision:0,currentPassword:password,confirmationBoxId:boxId})).status,409);
  assert.equal((await pool.query('SELECT count(*)::int n FROM connect_items WHERE id=$1',[itemId])).rows[0].n,1);
  const next=await call(route,owner,{...request,requestId:randomUUID()});assert.equal(next.status,201);const second=route+'/'+next.body.id;
  const execute=()=>call(second+'/execute',owner,{revision:0,currentPassword:password,confirmationBoxId:boxId});
  async function blockedBox(change,want){
   const blocker=await pool.connect();let pending;
   try{
    await blocker.query('BEGIN');await blocker.query('SELECT id FROM connect_vaults WHERE id=$1 FOR UPDATE',[boxId]);pending=execute();
    let reached=false;const deadline=Date.now()+5000;
    while(Date.now()<deadline){if((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM connect_vaults%'")).rowCount){reached=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
    assert(reached,'Deletion must actually wait at the Box lock');await change(blocker);await blocker.query('COMMIT');const reply=await pending;pending=null;assert.equal(reply.status,want);
   }finally{await blocker.query('ROLLBACK').catch(()=>{});blocker.release();if(pending)await pending;}
   assert.equal((await pool.query('SELECT count(*)::int n FROM connect_items WHERE id=$1',[itemId])).rows[0].n,1,'Rejected operation preserves the item');
   assert.equal((await pool.query('SELECT state FROM commercial_data_deletion_requests WHERE id=$1',[next.body.id])).rows[0].state,'pending');
  }
  await blockedBox(client=>client.query('INSERT INTO vault_memberships(user_id,vault_id,role,confirmed_at) VALUES($1,$2,$3,clock_timestamp())',[other.user.id,boxId,'member']),409);
  await pool.query('DELETE FROM vault_memberships WHERE user_id=$1 AND vault_id=$2',[other.user.id,boxId]);
  await blockedBox(client=>client.query("UPDATE vault_memberships SET user_id=$2 WHERE user_id=$1 AND vault_id=$3",[owner.user.id,other.user.id,boxId]),403);
  await pool.query('UPDATE vault_memberships SET user_id=$1 WHERE user_id=$2 AND vault_id=$3',[owner.user.id,other.user.id,boxId]);
  const period=(await pool.query('SELECT period_start::text s,period_end::text e FROM commercial_live_periods WHERE contract_id=$1',[contract.id])).rows[0];
  await blockedBox(client=>client.query("UPDATE commercial_live_periods SET period_end=(clock_timestamp() AT TIME ZONE 'Asia/Tokyo')::date+1 WHERE contract_id=$1",[contract.id]),409);
  await pool.query('UPDATE commercial_live_periods SET period_start=$2::date,period_end=$3::date WHERE contract_id=$1',[contract.id,period.s,period.e]);
  await blockedBox(client=>client.query('DELETE FROM sessions WHERE user_id=$1',[owner.user.id]),401);
  owner.refreshToken=(await call('/api/auth/login',null,{email:owner.email,password})).body.refreshToken;
  await blockedBox(client=>client.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1",[owner.user.id]),401);
  owner.refreshToken=(await call('/api/auth/login',null,{email:owner.email,password})).body.refreshToken;
  const credential=(await pool.query('SELECT password_hash FROM users WHERE id=$1',[owner.user.id])).rows[0].password_hash;
  await blockedBox(client=>client.query('UPDATE users SET password_hash=(SELECT password_hash FROM users WHERE id=$2) WHERE id=$1',[owner.user.id,other.user.id]),401);
  await pool.query('UPDATE users SET password_hash=$2 WHERE id=$1',[owner.user.id,credential]);
  await pool.query('INSERT INTO vault_memberships(user_id,vault_id,role,confirmed_at) VALUES($1,$2,$3,clock_timestamp())',[other.user.id,boxId,'member']);
  assert.equal((await call(second+'/execute',owner,{revision:0,currentPassword:password,confirmationBoxId:boxId})).status,409,'A newly shared box must survive');
  await pool.query('DELETE FROM vault_memberships WHERE user_id=$1 AND vault_id=$2',[other.user.id,boxId]);
  await pool.query('UPDATE connect_vaults SET content_version=2 WHERE id=$1',[boxId]);
  assert.equal((await call(second+'/execute',owner,{revision:0,currentPassword:password,confirmationBoxId:boxId})).status,409,'Unreviewed new data cannot be deleted');
  await pool.query('UPDATE connect_vaults SET content_version=1 WHERE id=$1',[boxId]);
  const originalDocument=(await pool.query('SELECT document FROM connect_items WHERE id=$1',[itemId])).rows[0].document;
  await pool.query("UPDATE connect_items SET document=document||'{\"title\":\"changed after request\"}'::jsonb WHERE id=$1",[itemId]);
  assert.equal((await execute()).status,409,'Legacy writes without a public version bump must still invalidate consent');
  await pool.query('UPDATE connect_items SET document=$2::jsonb WHERE id=$1',[itemId,JSON.stringify(originalDocument)]);
  // Cancellation wins while execution is waiting before its identity/contract
  // locks. The canceled response must never coexist with deleted data.
  const blocker=await pool.connect();let waiting;
  try{
   await blocker.query('BEGIN');await blocker.query('SELECT id FROM connect_vaults WHERE id=$1 FOR UPDATE',[boxId]);waiting=execute();
   let reached=false;for(let i=0;i<250;i++){if((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM connect_vaults%'")).rowCount){reached=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}assert(reached);
   const canceledPending=await call(second+'/cancel',owner,{revision:0});assert.equal(canceledPending.status,200);assert.equal(canceledPending.body.state,'canceled');await blocker.query('COMMIT');assert.equal((await waiting).status,409);waiting=null;
  }finally{await blocker.query('ROLLBACK').catch(()=>{});blocker.release();if(waiting)await waiting;}
  const finalRequest=await call(route,owner,{...request,requestId:randomUUID()});assert.equal(finalRequest.status,201);
  const finalPath=route+'/'+finalRequest.body.id;
  failFailureCleanup=true;
  try{assert.equal((await call(finalPath+'/execute',owner,{revision:0,currentPassword:password,confirmationBoxId:boxId})).status,500);}
  finally{failFailureCleanup=false;}
  assert.equal((await pool.query('SELECT count(*)::int n FROM connect_vaults WHERE id=$1',[boxId])).rows[0].n,1,'Auxiliary login cleanup failure must happen before irreversible deletion');
  assert.equal((await call(finalPath,owner)).body.state,'pending');
  const simultaneous=await Promise.all([call(finalPath+'/execute',owner,{revision:0,currentPassword:password,confirmationBoxId:boxId}),call(finalPath+'/cancel',owner,{revision:0})]);
  // Whichever operation reaches the contract/request lock first wins. Accept
  // either valid outcome without claiming which scheduler was used by the OS.
  const finalState=(await call(finalPath,owner)).body;
  if(finalState.state==='canceled'){
   assert.equal(simultaneous[1].status,200);assert.equal(simultaneous[0].status,409);assert.equal((await pool.query('SELECT count(*)::int n FROM connect_vaults WHERE id=$1',[boxId])).rows[0].n,1);
  }else{assert.equal(finalState.state,'completed');assert.equal(simultaneous[0].status,200);assert.equal(simultaneous[1].status,409);}
  const last=finalState.state==='canceled'?await call(route,owner,{...request,requestId:randomUUID()}):finalRequest;
  const completionPath=route+'/'+last.body.id;
  const completed=finalState.state==='completed'?simultaneous[0]:await call(completionPath+'/execute',owner,{revision:0,currentPassword:password,confirmationBoxId:boxId});assert.equal(completed.status,200);assert.equal(completed.body.state,'completed');assert.equal(completed.body.dataDeleted,true);
  assert.equal((await pool.query('SELECT count(*)::int n FROM connect_vaults WHERE id=$1',[boxId])).rows[0].n,0);assert.equal((await pool.query('SELECT count(*)::int n FROM connect_items WHERE id=$1',[itemId])).rows[0].n,0);
  assert.deepEqual((await call(completionPath+'/execute',owner,{revision:0,currentPassword:password,confirmationBoxId:boxId})).body,completed.body);
  assert.equal((await call(completionPath+'/cancel',owner,{revision:0})).status,409);assert.deepEqual((await call(completionPath,owner)).body,completed.body);
  assert.equal((await pool.query('SELECT count(*)::int n FROM commercial_contracts WHERE id=$1',[contract.id])).rows[0].n,1,'Financial contract retained independently of box deletion');
  assert.equal((await call('/v1/vaults',{refreshToken:other.connectAccessToken})).body.length,1,'Unrelated owner data remains');
  for(const actor of [owner,other])assert.equal((await call('/api/auth/account',actor,{currentPassword:password,confirmationEmail:actor.email},'DELETE')).status,204);
 }finally{await stop();await close();await admin.query('DROP DATABASE '+name+' WITH (FORCE)');await admin.end();for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
