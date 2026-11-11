import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('offline deletion CLI applies canonical DB transport to target and current source before connecting',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'passshare-deletion-transport-')),configPath=path.join(dir,'config.json'),journalPath=path.join(dir,'journal.json');
 const cli=fileURLToPath(new URL('../scripts/deletion-recovery.mjs',import.meta.url)),fixture=new URL('./fixtures/deletion-recovery-transport.mjs',import.meta.url).href;
 fs.writeFileSync(journalPath,'{}');
 const keys=['DATABASE_CA_CERT','DATABASE_SSL_ALLOW_INSECURE','DATABASE_TRUSTED_PRIVATE_HOSTS','PGSSLMODE','PGSSLNEGOTIATION'];
 const probe=(url,extra={},source=false)=>{
  const env={...process.env};for(const key of keys)delete env[key];Object.assign(env,extra,{PASSSHARE_RECOVERY_TARGET_DATABASE_URL:source?'postgresql://fixture:synthetic-secret@127.0.0.1/isolated_target':url,PASSSHARE_RECOVERY_SOURCE_DATABASE_URL:url,PASSSHARE_RECOVERY_TRANSPORT_SOURCE:String(source)});
  fs.writeFileSync(configPath,JSON.stringify({format:'passshare-deletion-recovery-v1',databaseUrlEnv:'PASSSHARE_RECOVERY_TARGET_DATABASE_URL',currentSourceDatabaseUrlEnv:'PASSSHARE_RECOVERY_SOURCE_DATABASE_URL',outputPath:path.join(dir,'unused.json'),journalPath}));
  const r=spawnSync(process.execPath,['--import',fixture,cli,source?'reapply':'export',configPath],{env,encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(r.error,undefined);assert.equal(r.signal,null);assert.equal(r.status,1,'Only fixture transport aborts; no real DB is contacted');
  assert(!r.stdout.includes('synthetic-secret')&&!r.stderr.includes('synthetic-secret'),'No database credentials may reach diagnostics');
  assert.match(r.stderr,/"error":"deletion_recovery_failed"/);
  return r.stdout.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)).filter(row=>row.fixtureTransport);
 };
 try{
  for(const source of [false,true]){
   for(const query of ['sslmode=disable','sslmode=no-verify','ssl=no-verify','sslmode=disable&sslmode=no-verify']){
    const p=probe('postgresql://fixture:synthetic-secret@external.example/db?'+query,{},source).at(-1);
    assert.equal(p.host,'external.example');assert.deepEqual(p.ssl,{rejectUnauthorized:true});assert.equal(p.applicationName,source?'passshare-current-deletion-journal':'passshare-offline-deletion-recovery');
   }
   const pinned=probe('postgresql://fixture:synthetic-secret@external.example/db?sslmode=no-verify&sslrootcert=missing-fixture&sslcert=missing-fixture&sslkey=missing-fixture',{DATABASE_CA_CERT:'fixture-ca',DATABASE_SSL_ALLOW_INSECURE:'true'},source).at(-1);assert.deepEqual(pinned.ssl,{ca:'fixture-ca',rejectUnauthorized:true});
   for(const host of ['127.0.0.1','postgres.railway.internal'])assert.equal(probe('postgresql://fixture:synthetic-secret@'+host+'/db',{},source).at(-1).ssl,false);
   assert.equal(probe('postgresql://fixture:synthetic-secret@owned-private/db',{DATABASE_TRUSTED_PRIVATE_HOSTS:'owned-private'},source).at(-1).ssl,false);
   const invalid=probe('postgresql://fixture:synthetic-secret@127.0.0.1/db?host=external.example',{},source);assert.equal(invalid.length,source?1:0,'Host override is rejected before connecting the affected client');
  }
 }finally{for(const file of [configPath,journalPath])fs.unlinkSync(file);fs.rmdirSync(dir);}
});
