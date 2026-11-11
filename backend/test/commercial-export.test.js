import {trackPoolShutdown} from './helpers/pg-fixture-lifecycle.js';
import assert from 'node:assert/strict';import {test} from 'node:test';import pg from 'pg';import Stripe from 'stripe';import {randomUUID} from 'node:crypto';import fs from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
test('contract-window export returns real ciphertext while rechecking current membership, session and key epoch',{skip:process.env.PASSSHARE_RECEIPTS_PG!=='true'},async()=>{
 assert.match(process.env.DATABASE_URL,/^postgresql:\/\/passshare:passshare@127\.0\.0\.1:(5432|15431)\/passshare$/);
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL}),name='ps_export_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+name);
 const url=new URL(process.env.DATABASE_URL);url.pathname='/'+name;const pool=new pg.Pool({connectionString:url.href});const closePool=trackPoolShutdown(pool);
 const secret='whsec_export_fixture',account='acct_exportfixture';Object.assign(process.env,{PASSSHARE_ENCRYPTED_STORAGE:'true',PASSSHARE_COMMERCIAL_LIVE_ENABLED:'true',PASSSHARE_STRIPE_LIVE_WEBHOOK_SECRET:secret,PASSSHARE_STRIPE_LIVE_ACCOUNT:account});
 const {createApp}=await import('../src/app.js');const {app}=await createApp({pool});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 const call=async(p,t,b,method=b===undefined?'GET':'POST')=>{const r=await fetch(base+p,{method,headers:{'content-type':'application/json','x-passshare-client':'mobile',...(t?{authorization:'Bearer '+t}:{})},body:b===undefined?undefined:JSON.stringify(b)});return {status:r.status,body:await r.json().catch(()=>null)}};
 const quote=async a=>{const q=await call('/api/commercial-contracts',a.refreshToken,{requestId:randomUUID(),currency:'JPY',plan:{type:'personal',users:1},setup:{installationCompanies:0,supportHours:0,maintenanceMonthlyJpy:null}});assert.equal(q.status,201);await call('/api/commercial-contracts/'+q.body.id+'/accept',a.refreshToken,{quoteHash:q.body.quoteHash});return q.body;};
 const pay=async(a,q)=>{const event={id:'evt_'+randomUUID().replaceAll('-',''),account,type:'payment_intent.succeeded',livemode:true,created:Math.floor((Date.now()-35*86400000)/1000),data:{object:{id:'pi_'+randomUUID().replaceAll('-',''),object:'payment_intent',status:'succeeded',currency:'jpy',amount:980,amount_received:980,livemode:true,metadata:{contractId:q.id,ownerId:a.user.id,quoteHash:q.quoteHash,cycle:'1'}}}},payload=JSON.stringify(event);const r=await fetch(base+'/api/commercial-events/stripe-live',{method:'POST',headers:{'content-type':'application/json','stripe-signature':Stripe.webhooks.generateTestHeaderString({payload,secret})},body:payload});assert.equal(r.status,200);};
 let box;
 try{
  const users=[];for(let i=0;i<2;i++){const r=await call('/api/auth/signup',null,{email:'export-'+randomUUID()+'@example.test',password:'synthetic-password123'});assert.equal(r.status,201);users.push(r.body);}
  const [a,b]=users,q=await quote(a),qb=await quote(b);
  const vaults=await call('/v1/vaults',a.connectAccessToken);const boxId=vaults.body[0].id;
  const wasm=await import('../../frontend/public/cloud-crypto/passshare_cloud_wasm.js');await wasm.default({module_or_path:await fs.readFile(new URL('../../frontend/public/cloud-crypto/passshare_cloud_wasm_bg.wasm',import.meta.url))});
  box=new wasm.CloudPasswordBox(JSON.stringify({passwordBoxId:boxId,ownerAccountId:a.user.id,keyEpoch:1}));
  const bundle=JSON.parse(box.wrap_for_owner('fixture-encryption-password'));
  assert.equal((await call('/api/encrypted/boxes/'+boxId+'/setup',a.refreshToken,{bundle})).status,200);
  const originals=new Map(),context=i=>({passwordBoxId:boxId,itemId:i,itemVersion:1,keyEpoch:1});
  for(let n=0;n<12;n++){const id=String.fromCharCode(97+n).repeat(26),plain={id,version:1,vault:{id:boxId},title:'Synthetic export '+n,fields:[{type:'CONCEALED',value:'synthetic-private-'+n}],attachments:[]},env=JSON.parse(box.encrypt_item(JSON.stringify(plain),JSON.stringify(context(id))));originals.set(id,{plain,env});assert.equal((await call('/api/encrypted/boxes/'+boxId+'/items/'+id,a.refreshToken,{expectedVersion:0,envelope:env},'PUT')).status,200);}
  const root='/api/commercial-contracts/'+q.id+'/export/boxes/'+boxId;
  // Load the actual shared client source, not a second implementation of its
  // selector/response checks. Type-only imports disappear during transformation.
  const sharedSource=await fs.readFile(new URL('../../shared/cloud/cloud-api.ts',import.meta.url),'utf8');
  const {createCloudApi}=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(sharedSource,{mode:'transform'})).toString('base64'));
  const clientFor=token=>createCloudApi((p,init)=>fetch(base+p,{...init,headers:{'x-passshare-client':'mobile',authorization:'Bearer '+token}}));
  const sharedClient=clientFor(a.refreshToken);
  const initialState=await call('/api/encrypted/boxes/'+boxId+'/attachment-state',a.refreshToken);
  let endpoint=root+'/items?epoch=1&revision='+initialState.body.stateRevision;
  assert.equal((await call(endpoint,a.refreshToken)).status,403); // no paid period: existing encrypted routes remain unchanged
  assert.equal((await pool.query('SELECT count(*)::int n FROM commercial_export_events')).rows[0].n,0);
  assert.equal((await call('/api/encrypted/boxes/'+boxId+'/items',a.refreshToken)).status,200);
  await pay(a,q);await pay(b,qb); // ended five days ago: actual export window
  const exportState=await call(root+'/state',a.refreshToken);assert.equal(exportState.status,200);assert.equal(exportState.body.snapshotRevision,initialState.body.stateRevision);
  const page=await call(endpoint,a.refreshToken);assert.equal(page.status,200);assert.equal(page.body.data.envelopes.length,10);assert.equal(page.body.ciphertextOnly,true);assert.equal(page.body.restoresIdentityMembershipOrKeys,false);
  assert.equal(JSON.stringify(page.body).includes('synthetic-private-'),false);assert.equal(JSON.stringify(page.body).includes('fixture-encryption-password'),false);
  const page2=await call(endpoint+'&after='+page.body.data.nextCursor,a.refreshToken);assert.equal(page2.status,200);assert.equal(page2.body.data.envelopes.length,2);assert.equal(page2.body.data.nextCursor,null);
  const pin={keyEpoch:1,snapshotRevision:initialState.body.stateRevision};
  const clientPage=await sharedClient.getCommercialExportPage(q.id,boxId,pin,null,new AbortController().signal);
  const clientPage2=await sharedClient.getCommercialExportPage(q.id,boxId,pin,clientPage.nextCursor,new AbortController().signal);
  assert.equal(clientPage.envelopes.length+clientPage2.envelopes.length,12);
  for(const envelope of [...clientPage.envelopes,...clientPage2.envelopes]){const expected=originals.get(envelope.context.itemId);assert.deepEqual(envelope,expected.env);const plain=box.decrypt_item(JSON.stringify(envelope),JSON.stringify(context(envelope.context.itemId)));assert.deepEqual(typeof plain==='string'?JSON.parse(plain):plain,expected.plain);}
  await assert.rejects(clientFor(b.refreshToken).getCommercialExportPage(q.id,boxId,pin,null,new AbortController().signal),e=>e.status===404);
  await assert.rejects(sharedClient.getCommercialExportPage(q.id,boxId,{...pin,snapshotRevision:pin.snapshotRevision+1},null,new AbortController().signal),e=>e.status===409);
  assert.match(page.body.receiptId,/^[a-f0-9-]{36}$/);
  const auditPath='/api/commercial-contracts/'+q.id+'/export-events';
  const audit=await call(auditPath,a.refreshToken);assert.equal(audit.status,200);assert.equal(audit.body.events.length,5);
  assert.ok(audit.body.events.some(e=>e.id===page.body.receiptId&&e.actor_id===a.user.id&&e.box_id===boxId));
  const serializedAudit=JSON.stringify(audit.body);
  assert.equal(serializedAudit.includes('ciphertext'),false);assert.equal(serializedAudit.includes('synthetic-private-'),false);assert.equal(serializedAudit.includes(a.refreshToken),false);
  assert.equal((await call(auditPath,b.refreshToken)).status,404);assert.equal((await call(auditPath)).status,401);
  const auditCount=(await pool.query('SELECT count(*)::int n FROM commercial_export_events')).rows[0].n;
  await pool.query('ALTER TABLE commercial_export_events ADD CONSTRAINT fixture_audit_failure CHECK(false) NOT VALID');
  try{const unavailable=await call(endpoint,a.refreshToken);assert.equal(unavailable.status,503);assert.equal(unavailable.body.data,undefined);}finally{await pool.query('ALTER TABLE commercial_export_events DROP CONSTRAINT fixture_audit_failure');}
  assert.equal((await pool.query('SELECT count(*)::int n FROM commercial_export_events')).rows[0].n,auditCount);
  const auditBefore=(await pool.query('SELECT * FROM commercial_export_events ORDER BY id')).rows;
  const {migrateExportAudit}=await import('../src/commercial-export-audit.js');await migrateExportAudit(pool);await migrateExportAudit(pool);
  assert.deepEqual((await pool.query('SELECT * FROM commercial_export_events ORDER BY id')).rows,auditBefore);
  for(const env of [...page.body.data.envelopes,...page2.body.data.envelopes]){const id=env.context.itemId;assert.deepEqual(env,originals.get(id).env);const plain=box.decrypt_item(JSON.stringify(env),JSON.stringify(context(id)));assert.deepEqual(typeof plain==='string'?JSON.parse(plain):plain,originals.get(id).plain);}
  const itemId='a'.repeat(26),attachmentId='z'.repeat(26),attachmentContext={passwordBoxId:boxId,itemId,attachmentId,attachmentVersion:1,keyEpoch:1};
  const fileBytes=new Uint8Array([0,1,254,255,7,0]),fileEnvelope=JSON.parse(box.encrypt_attachment('synthetic.bin',fileBytes,JSON.stringify(attachmentContext)));
  const updated={...originals.get(itemId).plain,version:2,attachments:[{attachmentId,attachmentVersion:1,keyEpoch:1}]},itemContext={...context(itemId),itemVersion:2};
  const updatedEnvelope=JSON.parse(box.encrypt_item(JSON.stringify(updated),JSON.stringify(itemContext)));
  const state=await call('/api/encrypted/boxes/'+boxId+'/attachment-state',a.refreshToken);
  const put=await call('/api/encrypted/boxes/'+boxId+'/items/'+itemId+'/attachments/'+attachmentId,a.refreshToken,{expectedStateRevision:state.body.stateRevision,item:{expectedVersion:1,envelope:updatedEnvelope},expectedVersion:0,envelope:fileEnvelope},'PUT');assert.equal(put.status,200);
  const revision=put.body.stateRevision;
  assert.equal((await call(endpoint,a.refreshToken)).status,409); // mutation invalidated previous page selector
  endpoint=root+'/items?epoch=1&revision='+revision;
  const itemExport=await call(root+'/items/'+itemId+'/attachment-snapshot?epoch=1&revision='+revision,a.refreshToken);assert.equal(itemExport.status,200);assert.deepEqual(itemExport.body.data,updatedEnvelope);
  const fileExport=await call(root+'/items/'+itemId+'/attachments/'+attachmentId+'?epoch=1&revision='+revision,a.refreshToken);assert.equal(fileExport.status,200);assert.deepEqual(fileExport.body.data,fileEnvelope);
  const decrypted=box.decrypt_attachment(JSON.stringify(fileExport.body.data),JSON.stringify(attachmentContext),JSON.stringify({itemEnvelope:JSON.stringify(itemExport.body.data),expectedItemContext:itemContext,itemSnapshotRevision:revision,attachmentSnapshotRevision:revision}));
  try{assert.deepEqual(decrypted.content(),fileBytes);assert.equal(decrypted.name(),'synthetic.bin');}finally{decrypted.free();}
  assert.equal((await call(root+'/items/'+itemId+'/attachments/'+attachmentId+'?epoch=1&revision='+(revision+1),a.refreshToken)).status,409);
  assert.equal((await call(root+'/items/'+'b'.repeat(26)+'/attachments/'+attachmentId+'?epoch=1&revision='+revision,a.refreshToken)).status,404);
  assert.equal((await call(endpoint)).status,401);assert.equal((await call(endpoint,b.refreshToken)).status,404);
  assert.equal((await call(endpoint+'&authorized=true',a.refreshToken)).status,400);
  assert.equal((await call(root+'/items?epoch=2&revision='+revision,a.refreshToken)).status,409);
  // Current membership and shared-key scope remain independent from a paid contract.
  await pool.query("UPDATE vault_memberships SET role='member' WHERE user_id=$1 AND vault_id=$2",[a.user.id,boxId]);
  assert.equal((await call(endpoint,a.refreshToken)).status,403); // no current shared key grant
  await pool.query("UPDATE vault_memberships SET role='owner' WHERE user_id=$1 AND vault_id=$2",[a.user.id,boxId]);
  await pool.query('DELETE FROM vault_memberships WHERE user_id=$1 AND vault_id=$2',[a.user.id,boxId]);
  assert.equal((await call(endpoint,a.refreshToken)).status,403);
  await pool.query("INSERT INTO vault_memberships(user_id,vault_id,role) VALUES($1,$2,'owner')",[a.user.id,boxId]);
  // Boundary is read from stored periods, never a client-supplied date.
  const saved=(await pool.query('SELECT period_start::text s,period_end::text e FROM commercial_live_periods WHERE contract_id=$1',[q.id])).rows[0];
  await pool.query("UPDATE commercial_live_periods SET period_start=CURRENT_DATE-100,period_end=CURRENT_DATE-31 WHERE contract_id=$1",[q.id]);assert.equal((await call(endpoint,a.refreshToken)).status,403);
  await pool.query('UPDATE commercial_live_periods SET period_start=$2::date,period_end=$3::date WHERE contract_id=$1',[q.id,saved.s,saved.e]);
  // Revoke while the export is demonstrably queued at the real box lock.
  async function blocked(change,status){
   const blocker=await pool.connect();let pending;
   try{
    await blocker.query('BEGIN');await blocker.query('SELECT id FROM connect_vaults WHERE id=$1 FOR UPDATE',[boxId]);
    pending=call(endpoint,a.refreshToken);
    let waiting=false;for(let i=0;i<100;i++){if((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM connect_vaults%'")).rowCount){waiting=true;break;}await new Promise(r=>setTimeout(r,10));}
    assert.equal(waiting,true);await change(blocker);await blocker.query('COMMIT');
   }finally{await blocker.query('ROLLBACK').catch(()=>{});blocker.release();}
   assert.equal((await pending).status,status);
  }
  await blocked(c=>c.query("UPDATE encrypted_box_state SET key_epoch=2 WHERE box_id=$1",[boxId]),409);
  await pool.query('UPDATE encrypted_box_state SET key_epoch=1 WHERE box_id=$1',[boxId]);
  await blocked(c=>c.query('DELETE FROM vault_memberships WHERE user_id=$1 AND vault_id=$2',[a.user.id,boxId]),403);
  await pool.query("INSERT INTO vault_memberships(user_id,vault_id,role) VALUES($1,$2,'owner')",[a.user.id,boxId]);
  await blocked(c=>c.query('DELETE FROM sessions WHERE user_id=$1',[a.user.id]),401);
  assert.equal((await call(auditPath,a.refreshToken)).status,401);
  const login=await call('/api/auth/login',null,{email:a.user.email,password:'synthetic-password123'});assert.equal(login.status,200);
  const retired=await call('/api/auth/account',login.body.refreshToken,{currentPassword:'synthetic-password123',confirmationEmail:a.user.email},'DELETE');assert.equal(retired.status,204);
  assert.equal((await call(endpoint,login.body.refreshToken)).status,401);
  assert.equal((await call(auditPath,login.body.refreshToken)).status,401);
  assert.equal((await pool.query('SELECT count(*)::int n FROM commercial_contracts WHERE id=$1',[q.id])).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM commercial_export_events WHERE contract_id=$1',[q.id])).rows[0].n,0);
 }finally{if(box){box.lock();box.free();}server.closeAllConnections();await new Promise(r=>server.close(r));await closePool();await admin.query('DROP DATABASE '+name);await admin.end();for(const k of ['PASSSHARE_ENCRYPTED_STORAGE','PASSSHARE_COMMERCIAL_LIVE_ENABLED','PASSSHARE_STRIPE_LIVE_WEBHOOK_SECRET','PASSSHARE_STRIPE_LIVE_ACCOUNT'])delete process.env[k];}
});
