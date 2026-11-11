import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {trackPoolShutdown} from './helpers/pg-fixture-lifecycle.js';
import {createMemoryLoginGuardStore} from '../src/auth/login-guard-store.js';

test('only a reauthenticated explicitly scheduled Box is deleted by the due worker', {skip:process.env.PASSSHARE_RECEIPTS_PG!=='true'},async()=>{
 const url=new URL(process.env.DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.username,'passshare');assert.equal(url.pathname,'/passshare');
 const admin=new pg.Pool({connectionString:url.href}),name='ps_deletion_due_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+name);url.pathname='/'+name;
 const pool=new pg.Pool({connectionString:url.href}),close=trackPoolShutdown(pool);let server;
 try{
  const{createApp}=await import('../src/app.js'),{app}=await createApp({pool,loginGuardStore:createMemoryLoginGuardStore()});server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port,password='scheduled-deletion-fixture4431!',email=randomUUID()+'@example.test';
  const call=async(route,actor,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(base+route,{method,signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json','x-passshare-client':'mobile',...(actor?{authorization:'Bearer '+actor.refreshToken}:{} )},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,body:await r.json().catch(()=>null)};};
  const signed=await call('/api/auth/signup',null,{email,password});assert.equal(signed.status,201);const actor=signed.body;
  const quote=await call('/api/commercial-contracts',actor,{requestId:randomUUID(),currency:'JPY',plan:{type:'personal',users:1},setup:{installationCompanies:0,supportHours:0,maintenanceMonthlyJpy:null}});assert.equal(quote.status,201);const c=quote.body;assert.equal((await call('/api/commercial-contracts/'+c.id+'/accept',actor,{quoteHash:c.quoteHash})).status,200);
  const created=await call('/api/auth/vaults',actor,{name:'explicit automatic due target'});assert.equal(created.status,201);const box=created.body.vaultId;
  await pool.query('INSERT INTO commercial_live_contracts(contract_id,contract_start,cancel_after_cycle,cancel_requested_at) VALUES($1,CURRENT_DATE-40,1,clock_timestamp())',[c.id]);
  await pool.query("INSERT INTO commercial_live_periods(account_id,event_id,contract_id,cycle,period_start,period_end,amount_jpy,provider_object_id,event_hash,evidence) VALUES('acct_due_fixture','evt_due_fixture',$1,1,CURRENT_DATE-40,CURRENT_DATE-10,980,'pi_due_fixture','synthetic_due_only','provider_live')",[c.id]);
  const request={requestId:randomUUID(),boxId:box,quoteHash:c.quoteHash,expectedContentVersion:1,expectedAttributeVersion:1,expectedStateRevision:null,expectedKeyEpoch:null,confirmationBoxId:box,currentPassword:password};
  const root='/api/commercial-contracts/'+c.id+'/data-deletion-requests',scheduled=await call(root+'/schedule-due',actor,request);assert.equal(scheduled.status,201,'The current owner can explicitly authorize due execution without ending the30day export window');assert.equal(scheduled.body.executionMode,'due');assert.equal(scheduled.body.dataDeleted,false);
  const{runDueDeletions}=await import('../src/commercial-data-deletion.js');assert.deepEqual(await runDueDeletions(pool,{limit:5}),{examined:0,completed:0,retained:0,nextAfter:null});
  assert.equal((await pool.query('SELECT count(*)::int n FROM connect_vaults WHERE id=$1',[box])).rows[0].n,1);
  assert.equal((await call(root+'/'+scheduled.body.id+'/cancel',actor,{revision:0})).status,200);
  await pool.query('UPDATE commercial_live_periods SET period_start=CURRENT_DATE-70,period_end=CURRENT_DATE-40 WHERE contract_id=$1',[c.id]);
  const ready=await call(root+'/schedule-due',actor,{...request,requestId:randomUUID()});assert.equal(ready.status,201);
  const retainedBox=await call('/api/auth/vaults',actor,{name:'not scheduled'});assert.equal(retainedBox.status,201);
  const due=await runDueDeletions(pool,{limit:5});assert.deepEqual(due,{examined:1,completed:1,retained:0,nextAfter:ready.body.id});
  assert.equal((await call(root+'/'+ready.body.id,actor)).body.state,'completed');
  assert.equal((await pool.query('SELECT count(*)::int n FROM connect_vaults WHERE id=$1',[box])).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM connect_vaults WHERE id=$1',[retainedBox.body.vaultId])).rows[0].n,1);
  assert.deepEqual(await runDueDeletions(pool,{limit:5}),{examined:0,completed:0,retained:0,nextAfter:null});
  const changedRequest=await call(root+'/schedule-due',actor,{...request,requestId:randomUUID(),boxId:retainedBox.body.vaultId,confirmationBoxId:retainedBox.body.vaultId});assert.equal(changedRequest.status,201);
  await pool.query("UPDATE connect_vaults SET name='changed after explicit consent' WHERE id=$1",[retainedBox.body.vaultId]);
  assert.deepEqual(await runDueDeletions(pool,{limit:5}),{examined:1,completed:0,retained:1,nextAfter:changedRequest.body.id});
  await pool.query('UPDATE connect_vaults SET name=$2 WHERE id=$1',[retainedBox.body.vaultId,'not scheduled']);
  const other=await call('/api/auth/signup',null,{email:randomUUID()+'@example.test',password});assert.equal(other.status,201);
  await pool.query("INSERT INTO vault_memberships(user_id,vault_id,role,confirmed_at) VALUES($1,$2,'reader',clock_timestamp())",[other.body.user.id,retainedBox.body.vaultId]);
  assert.equal((await runDueDeletions(pool,{limit:5})).retained,1,'A previously sole-owned target that became shared is preserved');
  await pool.query('DELETE FROM vault_memberships WHERE user_id=$1 AND vault_id=$2',[other.body.user.id,retainedBox.body.vaultId]);
  const hash=(await pool.query('SELECT password_hash FROM users WHERE id=$1',[actor.user.id])).rows[0].password_hash;
  await pool.query("UPDATE users SET password_hash=password_hash||'changed' WHERE id=$1",[actor.user.id]);assert.equal((await runDueDeletions(pool,{limit:5})).retained,1,'Password/recovery change invalidates old automatic consent');await pool.query('UPDATE users SET password_hash=$2 WHERE id=$1',[actor.user.id,hash]);
  assert.equal((await call(root+'/'+changedRequest.body.id+'/cancel',actor,{revision:0})).status,200);
  assert.equal((await pool.query('SELECT count(*)::int n FROM connect_vaults WHERE id=$1',[retainedBox.body.vaultId])).rows[0].n,1);
  const schedule=async()=>{const r=await call(root+'/schedule-due',actor,{...request,requestId:randomUUID(),boxId:retainedBox.body.vaultId,confirmationBoxId:retainedBox.body.vaultId});assert.equal(r.status,201);return r.body;};
  const period=(await pool.query('SELECT period_start::text s,period_end::text e FROM commercial_live_periods WHERE contract_id=$1',[c.id])).rows[0];
  for(const cancel of [true,false]){
   const consent=await schedule(),blocker=await pool.connect();let pending;
   try{
    await blocker.query('BEGIN');await blocker.query('SELECT id FROM connect_vaults WHERE id=$1 FOR UPDATE',[retainedBox.body.vaultId]);pending=runDueDeletions(pool,{limit:5});
    let waiting=false;for(let i=0;i<200;i++){if((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM connect_vaults WHERE id=%'")).rowCount){waiting=true;break;}await new Promise(r=>setTimeout(r,10));}assert(waiting,'Due execution must reach the real Box lock before changing its consent basis');
    if(cancel)assert.equal((await call(root+'/'+consent.id+'/cancel',actor,{revision:0})).status,200);
    else await blocker.query('UPDATE commercial_live_periods SET period_start=CURRENT_DATE-20,period_end=CURRENT_DATE+10 WHERE contract_id=$1',[c.id]);
    await blocker.query('COMMIT');const result=await pending;pending=null;assert.equal(result.completed,0);assert.equal(result.retained,1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM connect_vaults WHERE id=$1',[retainedBox.body.vaultId])).rows[0].n,1,'Cancellation or extended current paid period preserves the explicit target');
   }finally{await blocker.query('ROLLBACK').catch(()=>{});blocker.release();if(pending)await pending;}
   if(!cancel){await pool.query('UPDATE commercial_live_periods SET period_start=$2::date,period_end=$3::date WHERE contract_id=$1',[c.id,period.s,period.e]);assert.equal((await call(root+'/'+consent.id+'/cancel',actor,{revision:0})).status,200);}
  }
  const recoveryConsent=await schedule();
  assert.equal((await call('/api/auth/recovery-key',actor,{currentPassword:password})).status,201);
  assert.equal((await call(root+'/'+recoveryConsent.id,actor)).body.requiresNewConsent,true,'The current owner can distinguish invalidated consent before a worker examines it');
  assert.equal((await runDueDeletions(pool,{limit:5})).retained,1,'Recovery key reissue invalidates the old automatic deletion consent');
  assert.equal((await pool.query('SELECT count(*)::int n FROM connect_vaults WHERE id=$1',[retainedBox.body.vaultId])).rows[0].n,1);
  assert.equal((await call(root+'/'+recoveryConsent.id+'/cancel',actor,{revision:0})).status,200);
  const sharedConsent=await schedule();
  const invitedEmail=randomUUID()+'@example.test';const invitation=await call('/api/auth/vaults/'+retainedBox.body.vaultId+'/invitations',actor,{email:invitedEmail,role:'member'});assert.equal(invitation.status,201);
  const invitationId=invitation.body.id??invitation.body.invitation?.id;assert(invitationId);
  assert.equal((await call('/api/auth/vaults/'+retainedBox.body.vaultId+'/invitations/'+invitationId,actor,undefined,'DELETE')).status,204);
  assert.equal((await call(root+'/'+sharedConsent.id,actor)).body.requiresNewConsent,true);
  assert.equal((await runDueDeletions(pool,{limit:5})).retained,1,'A sharing/invitation change permanently invalidates the original automatic consent even after cancellation');
  assert.equal((await pool.query('SELECT count(*)::int n FROM connect_vaults WHERE id=$1',[retainedBox.body.vaultId])).rows[0].n,1);
  const {startDueDeletionWorker}=await import('../src/commercial-deletion-worker.js');let observed,release;const reached=new Promise(r=>{observed=r;}),resume=new Promise(r=>{release=r;}),worker=startDueDeletionWorker(pool,{intervalMs:10,run:async()=>{observed();await resume;return{nextAfter:null};}});
  await reached;let drained=false;const stopping=worker.stop().then(()=>{drained=true;});await new Promise(r=>setTimeout(r,20));assert.equal(drained,false,'Stopping must await the owned in-flight batch');release();await stopping;assert.equal(drained,true);
  let advanced;const progressed=new Promise(r=>{advanced=r;}),positions=[];const failingId=randomUUID(),faultWorker=startDueDeletionWorker(pool,{intervalMs:10,run:async(_p,{after})=>{positions.push(after);if(positions.length===1){const error=Error('synthetic row failure');error.deletionNextAfter=failingId;throw error;}advanced();return{nextAfter:null};}});
  const keepalive=setTimeout(()=>{throw Error('Faulted request prevented later batch progress');},5000);try{await progressed;}finally{clearTimeout(keepalive);await faultWorker.stop();}assert.deepEqual(positions.slice(0,2),[null,failingId],'A failed target is retried on the next full sweep without starving subsequent targets');
  assert.equal((await call('/api/auth/account',other.body,{currentPassword:password,confirmationEmail:other.body.user.email},'DELETE')).status,204);
  assert.equal((await call('/api/auth/account',actor,{currentPassword:password,confirmationEmail:email},'DELETE')).status,204);
 }finally{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await close();await admin.query('DROP DATABASE '+name+' WITH(FORCE)');await admin.end();}
});
