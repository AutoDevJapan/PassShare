import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {resolveDbPoolConfig} from '../src/config/db-ssl.js';
import {exportDeletionJournal,reconcileCompletedDeletions,completedDeletionGate,prepareClosedDeletionRestore} from '../src/commercial-deletion-journal.js';

// An offline maintenance caller, never an HTTP endpoint. DB credentials stay in
// a named process environment variable; neither arguments nor results carry it.
const [operation,configPath]=process.argv.slice(2);
const fail=()=>{console.error(JSON.stringify({ok:false,error:'deletion_recovery_failed',reopenPerformed:false}));process.exitCode=1;};
const readBounded=(file,limit)=>{const fd=fs.openSync(file,'r');try{const bytes=Buffer.alloc(limit+1);let n=0;while(n<bytes.length){const count=fs.readSync(fd,bytes,n,bytes.length-n,null);if(!count)break;n+=count;}if(n>limit)throw Error();return bytes.subarray(0,n);}finally{fs.closeSync(fd);}};
let client,currentSource;
try{
 if(!['export','prepare-closed','reapply'].includes(operation)||!configPath||process.argv.length!==4||!path.isAbsolute(configPath))throw Error();
 const c=JSON.parse(readBounded(configPath,16384));
 if(c.format!=='passshare-deletion-recovery-v1'||!/^PASSSHARE_[A-Z0-9_]+_DATABASE_URL$/.test(c.databaseUrlEnv??'')||typeof process.env[c.databaseUrlEnv]!=='string')throw Error();
 client=new pg.Client({...resolveDbPoolConfig(process.env[c.databaseUrlEnv]),statement_timeout:15000,query_timeout:20000,application_name:'passshare-offline-deletion-recovery'});await client.connect();
 if(operation==='export'){
  if(!path.isAbsolute(c.outputPath??''))throw Error();const bytes=await exportDeletionJournal(client,c.sourceId);fs.writeFileSync(c.outputPath,bytes,{flag:'wx',mode:0o600});
  console.log(JSON.stringify({ok:true,operation:'export',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),scope:'private minimal deletion barriers; no content, credential or key',retention:'Keep while any restorable archive could revive these targets; independent durable retention still requires verified operator storage'}));
 }else if(operation==='prepare-closed'){
  const r=await prepareClosedDeletionRestore(client,{expectedTargetDatabase:c.targetDatabase,sourceId:c.sourceId,restoreOperationId:c.restoreOperationId});console.log(JSON.stringify({ok:true,operation,...r,externalNetworkStopMustBeVerified:true,automaticReopen:false}));
 }else{
  if(!path.isAbsolute(c.journalPath??''))throw Error();const bytes=readBounded(c.journalPath,16*1024*1024);
  if(!/^PASSSHARE_[A-Z0-9_]+_DATABASE_URL$/.test(c.currentSourceDatabaseUrlEnv??'')||typeof process.env[c.currentSourceDatabaseUrlEnv]!=='string'||c.currentSourceDatabaseUrlEnv===c.databaseUrlEnv)throw Error();
  currentSource=new pg.Client({...resolveDbPoolConfig(process.env[c.currentSourceDatabaseUrlEnv]),statement_timeout:15000,query_timeout:20000,application_name:'passshare-current-deletion-journal'});await currentSource.connect();
  const options={bytes,expectedSha256:c.trustedJournalSha256,expectedSourceId:c.sourceId,expectedTargetDatabase:c.targetDatabase,restoreOperationId:c.restoreOperationId,currentSource,expectedSourceDatabase:c.currentSourceDatabase,expectedSourceSystemIdentifier:c.currentSourceSystemIdentifier,expectedSourceDatabaseOid:c.currentSourceDatabaseOid};
  const r=await reconcileCompletedDeletions(client,options),qualified=await completedDeletionGate(client,options);if(!qualified)throw Error();
  console.log(JSON.stringify({ok:true,operation:'reapply',...r,deletionGateQualified:true,APIStillClosed:true,identityMembershipKeyQualification:false,automaticReopen:false}));
 }
}catch{fail();}finally{if(client)await client.end().catch(()=>{process.exitCode=1;});if(currentSource)await currentSource.end().catch(()=>{process.exitCode=1;});}
