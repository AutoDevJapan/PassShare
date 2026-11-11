import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {trackPoolShutdown} from './helpers/pg-fixture-lifecycle.js';
import {createMemoryLoginGuardStore} from '../src/auth/login-guard-store.js';

test('an older real archive cannot revive a completed explicitly selected Box deletion', {skip:process.env.PASSSHARE_DELETION_RECOVERY_PG!=='true'},async()=>{
 const url=new URL(process.env.DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.username,'passshare');assert.equal(url.pathname,'/passshare');
 const container=process.env.PASSSHARE_DELETION_RECOVERY_CONTAINER;assert.match(container??'',/^[a-f0-9]{64}$/);
 const label=execFileSync('docker',['inspect','--format','{{index .Config.Labels "passshare.fixture"}}',container],{encoding:'utf8',windowsHide:true}).trim();assert(['deletion-reconciliation','deletion-due'].includes(label));
 const admin=new pg.Pool({connectionString:url.href}),sourceName='ps_delete_source_'+randomUUID().replaceAll('-',''),targetName='ps_delete_target_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE DATABASE '+sourceName);await admin.query('CREATE DATABASE '+targetName);url.pathname='/'+sourceName;
 const source=new pg.Pool({connectionString:url.href}),closeSource=trackPoolShutdown(source);url.pathname='/'+targetName;const target=new pg.Pool({connectionString:url.href}),closeTarget=trackPoolShutdown(target);
 let server,currentSource;const sourceId=randomUUID(),restoreOperationId=randomUUID(),scratch=fs.mkdtempSync(path.join(os.tmpdir(),'passshare-deletion-recovery-')),archive=path.join(scratch,'old-private-fixture.dump');
 try{
  const {createApp}=await import('../src/app.js'),{app}=await createApp({pool:source,loginGuardStore:createMemoryLoginGuardStore()});server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base='http://127.0.0.1:'+server.address().port,password='deletion-recovery-fixture4431!',actors=[];
  const call=async(route,actor,body,method=body===undefined?'GET':'POST',extra={})=>{const r=await fetch(base+route,{method,signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json','x-passshare-client':'mobile',...(actor?{authorization:'Bearer '+actor.refreshToken}:{}),...extra},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,body:await r.json().catch(()=>null)};};
  for(let i=0;i<2;i++){const email=randomUUID()+'@example.test',r=await call('/api/auth/signup',null,{email,password});assert.equal(r.status,201);actors.push({...r.body,email});}
  const [owner,other]=actors,quote=await call('/api/commercial-contracts',owner,{requestId:randomUUID(),currency:'JPY',plan:{type:'personal',users:1},setup:{installationCompanies:0,supportHours:0,maintenanceMonthlyJpy:null}});assert.equal(quote.status,201);const contract=quote.body;
  assert.equal((await call('/api/commercial-contracts/'+contract.id+'/accept',owner,{quoteHash:contract.quoteHash})).status,200);
  const creationKey=randomUUID(),created=await call('/api/auth/vaults',owner,{name:'exact disposable deletion target'},'POST',{'idempotency-key':creationKey});assert.equal(created.status,201);const boxId=created.body.vaultId;
  const itemId='z'.repeat(26);await source.query('INSERT INTO connect_items(id,vault_id,document) VALUES($1,$2,$3::jsonb)',[itemId,boxId,JSON.stringify({id:itemId,title:'discarded-secret-fixture',version:1,fields:[{value:'never-journal-this'}]})]);
  // Explicit isolated billing fixture. No provider request or Prd authority.
  await source.query('INSERT INTO commercial_live_contracts(contract_id,contract_start,cancel_after_cycle,cancel_requested_at) VALUES($1,CURRENT_DATE-65,1,clock_timestamp())',[contract.id]);
  await source.query("INSERT INTO commercial_live_periods(account_id,event_id,contract_id,cycle,period_start,period_end,amount_jpy,provider_object_id,event_hash,evidence) VALUES('acct_redelete','evt_redelete',$1,1,CURRENT_DATE-65,CURRENT_DATE-35,980,'pi_redelete','synthetic-redelete','provider_live')",[contract.id]);
  const route='/api/commercial-contracts/'+contract.id+'/data-deletion-requests',request=await call(route,owner,{requestId:randomUUID(),boxId,quoteHash:contract.quoteHash,expectedContentVersion:1,expectedAttributeVersion:1,expectedStateRevision:null,expectedKeyEpoch:null,confirmationBoxId:boxId,currentPassword:password});assert.equal(request.status,201);
  const oldDue=await call(route+'/schedule-due',owner,{requestId:randomUUID(),boxId,quoteHash:contract.quoteHash,expectedContentVersion:1,expectedAttributeVersion:1,expectedStateRevision:null,expectedKeyEpoch:null,confirmationBoxId:boxId,currentPassword:password});assert.equal(oldDue.status,201);
  // Capture the real pre-journal schema, not a new archive whose journal table
  // is merely removed afterwards. Only this owned fixture is changed here.
  await source.query('DROP TABLE commercial_deletion_journal');
  const dump=execFileSync('docker',['exec',container,'pg_dump','-U','passshare','-d',sourceName,'-Fc','--no-owner','--no-acl'],{windowsHide:true,maxBuffer:16*1024*1024});assert.equal(dump.subarray(0,5).toString(),'PGDMP');fs.writeFileSync(archive,dump,{flag:'wx',mode:0o600});
  const {migrateDeletionJournal}=await import('../src/commercial-deletion-journal.js');await migrateDeletionJournal(source);
  assert.equal((await call(route+'/'+oldDue.body.id+'/cancel',owner,{revision:0})).status,200);
  const completed=await call(route+'/'+request.body.id+'/execute',owner,{revision:0,currentPassword:password,confirmationBoxId:boxId});assert.equal(completed.status,200);assert.equal(completed.body.dataDeleted,true);
  assert.equal((await source.query('SELECT count(*)::int n FROM connect_vaults WHERE id=$1',[boxId])).rows[0].n,0);
  assert.equal((await call('/api/auth/account',owner,{currentPassword:password,confirmationEmail:owner.email},'DELETE')).status,204);
  const {parseDeletionJournal,reconcileCompletedDeletions,completedDeletionGate}=await import('../src/commercial-deletion-journal.js');
  const journalFile=path.join(scratch,'current-deletions.private.json'),sourceConfig=path.join(scratch,'source.private.json'),targetConfig=path.join(scratch,'target.private.json'),cli=path.resolve('backend/scripts/deletion-recovery.mjs');
  const sourceUrl=new URL(url.href);sourceUrl.pathname='/'+sourceName;
  fs.writeFileSync(sourceConfig,JSON.stringify({format:'passshare-deletion-recovery-v1',databaseUrlEnv:'PASSSHARE_RECOVERY_SOURCE_DATABASE_URL',outputPath:journalFile,sourceId}),{flag:'wx'});
  const cliEnv={...process.env,PASSSHARE_RECOVERY_SOURCE_DATABASE_URL:sourceUrl.href,PASSSHARE_RECOVERY_TARGET_DATABASE_URL:url.href};
  const exported=JSON.parse(execFileSync(process.execPath,[cli,'export',sourceConfig],{encoding:'utf8',env:cliEnv,windowsHide:true,timeout:20000}));assert.equal(exported.ok,true);
  const journal=fs.readFileSync(journalFile),expectedSha256=createHash('sha256').update(journal).digest('hex'),expectedSourceId=sourceId;assert.equal(exported.sha256,expectedSha256);
  const parsed=parseDeletionJournal(journal,{expectedSha256,expectedSourceId});assert.equal(parsed.entries.length,1,'Completed deletion journal survives owner/contract/receipt retirement');
  assert.deepEqual(Object.keys(parsed.entries[0]),['deletionId','boxId','completedAt']);assert(!journal.includes('never-journal-this'));assert(!journal.includes('discarded-secret'));assert(!journal.includes(owner.user.id));assert(!journal.includes(contract.id));
  execFileSync('docker',['exec','-i',container,'pg_restore','-U','passshare','-d',targetName,'--no-owner','--no-acl','--exit-on-error'],{input:dump,windowsHide:true,maxBuffer:16*1024*1024});
  assert.equal((await target.query('SELECT count(*)::int n FROM connect_items WHERE id=$1',[itemId])).rows[0].n,1,'The actual old archive really contained the deleted secret fixture');
  const unrelated=async()=>JSON.stringify((await target.query('SELECT to_jsonb(v) r,v.xmin::text x FROM connect_vaults v WHERE id<>$1 ORDER BY id',[boxId])).rows);
  const unaffected=await unrelated();
  currentSource=new pg.Client({connectionString:sourceUrl.href});await currentSource.connect();
  const identity=(await currentSource.query('SELECT (pg_control_system()).system_identifier::text system_id,(SELECT oid::text FROM pg_database WHERE datname=current_database()) database_oid')).rows[0];
  const options={bytes:journal,expectedSha256,expectedSourceId,expectedTargetDatabase:targetName,restoreOperationId,currentSource,expectedSourceDatabase:sourceName,expectedSourceSystemIdentifier:identity.system_id,expectedSourceDatabaseOid:identity.database_oid};
  await assert.rejects(reconcileCompletedDeletions(source,options),/Wrong restore database/);
  const tampered=Buffer.from(journal);tampered[tampered.length-2]^=1;await assert.rejects(reconcileCompletedDeletions(target,{...options,bytes:tampered}),/trusted current digest/);
  assert.equal((await target.query("SELECT to_regclass('public.commercial_deletion_journal') IS NULL missing")).rows[0].missing,true,'The old real archive has no journal table');
  fs.writeFileSync(targetConfig,JSON.stringify({format:'passshare-deletion-recovery-v1',databaseUrlEnv:'PASSSHARE_RECOVERY_TARGET_DATABASE_URL',currentSourceDatabaseUrlEnv:'PASSSHARE_RECOVERY_SOURCE_DATABASE_URL',currentSourceDatabase:sourceName,currentSourceSystemIdentifier:identity.system_id,currentSourceDatabaseOid:identity.database_oid,journalPath:journalFile,trustedJournalSha256:expectedSha256,sourceId,targetDatabase:targetName,restoreOperationId}),{flag:'wx'});
  const fresh=await target.connect();fresh.release();await closeTarget();
  const prepared=JSON.parse(execFileSync(process.execPath,[cli,'prepare-closed',targetConfig],{encoding:'utf8',env:cliEnv,windowsHide:true,timeout:20000}));assert.equal(prepared.closed,true);
  const transientTarget=new pg.Pool({connectionString:url.href});try{await assert.rejects(createApp({pool:transientTarget,loginGuardStore:createMemoryLoginGuardStore()}),/RESTORE_TARGET_CLOSED/);assert.equal(await completedDeletionGate(transientTarget,options),false,'Old archive cannot qualify itself as current');}finally{await transientTarget.end();}
  const oldConsentPool=new pg.Pool({connectionString:url.href});try{const row=(await oldConsentPool.query('SELECT state,consent_invalidated_at FROM commercial_data_deletion_requests WHERE id=$1',[oldDue.body.id])).rows[0];assert.equal(row.state,'pending','The actual old archive really revived a later canceled automatic request');assert(row.consent_invalidated_at,'Closed restore preparation invalidates archive-era automatic approval');const{runDueDeletions}=await import('../src/commercial-data-deletion.js');await assert.rejects(runDueDeletions(oldConsentPool),/RESTORE_TARGET_CLOSED/);}finally{await oldConsentPool.end();}
  const replayed=JSON.parse(execFileSync(process.execPath,[cli,'reapply',targetConfig],{encoding:'utf8',env:cliEnv,windowsHide:true,timeout:20000}));assert.equal(replayed.ok,true);assert.equal(replayed.APIStillClosed,true);assert.equal(replayed.identityMembershipKeyQualification,false);
  const client=new pg.Client({connectionString:url.href});await client.connect();
  try{
   assert.equal(await completedDeletionGate(client,options),true,'Actual offline caller persisted the deletion gate without reopening API');
   assert.equal(await completedDeletionGate(client,{...options,expectedSourceSystemIdentifier:String(BigInt(identity.system_id)+1n)}),false,'A same-named source on a different cluster does not match the trusted current source identity');
   assert.equal(await completedDeletionGate(client,{...options,expectedSourceDatabaseOid:String(Number(identity.database_oid)+1)}),false,'A replaced same-name database does not inherit the trusted DB OID');
   await assert.rejects(reconcileCompletedDeletions(client,{...options,expectedSourceSystemIdentifier:'1'}),/identity does not match/);
   assert.deepEqual(await reconcileCompletedDeletions(client,options),{reconciledEntries:1,closed:true,journalSha256:expectedSha256});
   assert.equal((await client.query('SELECT count(*)::int n FROM connect_vaults WHERE id=$1',[boxId])).rows[0].n,0,'A restored API must not revive the completed Box deletion');
   assert.equal((await client.query('SELECT count(*)::int n FROM connect_items WHERE id=$1',[itemId])).rows[0].n,0);
   assert.equal(JSON.stringify((await client.query('SELECT to_jsonb(v) r,v.xmin::text x FROM connect_vaults v WHERE id<>$1 ORDER BY id',[boxId])).rows),unaffected,'Unrelated full Box rows and xmin remain unchanged');
   assert.deepEqual((await client.query("SELECT request_hash,result FROM mutation_operations WHERE actor=$1 AND operation='box' AND request_key=$2",[owner.user.id,creationKey])).rows[0],{request_hash:'',result:{deleted:true}});
   assert.equal(await completedDeletionGate(client,options),true);
   assert.match(parsed.entries[0].completedAt,/\.\d{6}Z$/);
   await client.query("UPDATE commercial_deletion_journal SET completed_at=completed_at+interval '1 microsecond'");
   assert.equal(await completedDeletionGate(client,options),false,'A one-microsecond target timestamp mismatch is not lost by the JS pg parser');
   await client.query('UPDATE commercial_deletion_journal SET completed_at=$1',[parsed.entries[0].completedAt]);
   const extraId=randomUUID();await client.query('INSERT INTO commercial_deletion_journal(deletion_id,box_id) VALUES($1,$2)',[extraId,'x'.repeat(26)]);
   assert.equal(await completedDeletionGate(client,options),false,'Gate rejects a target journal entry not present in the trusted current source');
   await client.query('DELETE FROM commercial_deletion_journal WHERE deletion_id=$1',[extraId]);
   const originalQuery=client.query.bind(client);let reached,release,gate,write,writer;
   const atRead=new Promise(r=>{reached=r;}),resume=new Promise(r=>{release=r;});
   client.query=async(sql,params)=>{const result=await originalQuery(sql,params);if(sql==='SELECT 1 FROM connect_vaults WHERE id=$1'&&params[0]===boxId){reached();await resume;}return result;};
   try{
    gate=completedDeletionGate(client,options);let timer;try{await Promise.race([atRead,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Deletion gate did not reach its real target read')),5000);})]);}finally{clearTimeout(timer);}
    writer=new pg.Client({connectionString:url.href});await writer.connect();write=writer.query('INSERT INTO connect_vaults(id,name) VALUES($1,$2)',[boxId,'synthetic concurrent resurrection']);
    let waited=false;for(let i=0;i<100;i++){if((await source.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE 'INSERT INTO connect_vaults%'",[targetName])).rowCount){waited=true;break;}await new Promise(r=>setTimeout(r,10));}
    assert(waited,'A target writer must actually wait on the gate snapshot lock');release();assert.equal(await gate,false,'A concurrent target writer cannot receive a successful deletion qualification');gate=null;await write;write=null;await writer.end();writer=null;
   }finally{release();if(gate)await gate;if(write)await write;if(writer)await writer.end();client.query=originalQuery;}
   assert.equal(await completedDeletionGate(client,options),false,'A later target resurrection must also fail the gate');await reconcileCompletedDeletions(client,options);assert.equal(await completedDeletionGate(client,options),true);
   const once=JSON.stringify((await client.query('SELECT to_jsonb(j) r,j.xmin::text x FROM commercial_deletion_journal j ORDER BY box_id')).rows);
   await reconcileCompletedDeletions(client,options);assert.equal(JSON.stringify((await client.query('SELECT to_jsonb(j) r,j.xmin::text x FROM commercial_deletion_journal j ORDER BY box_id')).rows),once,'Reapply preserves barrier row/xmin and cannot repeat the deletion');
   const later=randomUUID();await source.query('INSERT INTO commercial_deletion_journal(deletion_id,box_id) VALUES($1,$2)',[later,'y'.repeat(26)]);
   try{await assert.rejects(reconcileCompletedDeletions(client,options),/no longer current/,'An authentic historical export cannot qualify after the authoritative journal advances');assert.equal(await completedDeletionGate(client,options),false,'The partial deletion gate also rejects an authentic but no longer current journal');}
   finally{await source.query('DELETE FROM commercial_deletion_journal WHERE deletion_id=$1',[later]);}
   assert.equal((await client.query('SELECT phase FROM passshare_restore_control.recovery')).rows[0].phase,'closed','Deletion qualification alone never opens API or revives old credentials');
  }finally{await client.end();}
  assert.equal((await call('/api/auth/account',other,{currentPassword:password,confirmationEmail:other.email},'DELETE')).status,204);
 }finally{
  if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}if(currentSource)await currentSource.end();await closeSource();await closeTarget();await admin.query('DROP DATABASE '+targetName+' WITH (FORCE)');await admin.query('DROP DATABASE '+sourceName+' WITH (FORCE)');await admin.end();for(const name of ['old-private-fixture.dump','current-deletions.private.json','source.private.json','target.private.json']){const file=path.join(scratch,name);if(fs.existsSync(file))fs.unlinkSync(file);}fs.rmdirSync(scratch);
 }
});
