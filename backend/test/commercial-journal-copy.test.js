import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('independent journal copy survives original loss and refuses overwrite or altered binding',async()=>{
 const {preserveJournalCopy}=await import('../src/commercial-journal-copy.js');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'passshare-journal-copy-')),target=path.join(dir,'current.json'),original=path.join(dir,'export.json');
 const sourceId='11111111-1111-4111-8111-111111111111',bytes=Buffer.from(JSON.stringify({format:'passshare-deletion-journal-v1',sourceId,entries:[{deletionId:'22222222-2222-4222-8222-222222222222',boxId:'a'.repeat(26),completedAt:'2026-11-11T00:00:00.123456Z'}]})),sha=createHash('sha256').update(bytes).digest('hex');
 try{fs.writeFileSync(original,bytes);const r=preserveJournalCopy(fs.readFileSync(original),{expectedSha256:sha,expectedSourceId:sourceId,target});assert.equal(r.sha256,sha);fs.unlinkSync(original);assert.equal(fs.existsSync(original),false);assert.deepEqual(fs.readFileSync(target),bytes);assert.equal(createHash('sha256').update(fs.readFileSync(target)).digest('hex'),sha,'Independent copy remains verified after original export loss');assert.throws(()=>preserveJournalCopy(bytes,{expectedSha256:sha,expectedSourceId:sourceId,target}),/EEXIST/);assert.throws(()=>preserveJournalCopy(Buffer.from('{}'),{expectedSha256:sha,expectedSourceId:sourceId,target:path.join(dir,'bad.json')}));assert.equal(fs.existsSync(path.join(dir,'bad.json')),false);}finally{for(const f of[target,original])if(fs.existsSync(f))fs.unlinkSync(f);fs.rmdirSync(dir);}
});
test('formal preserve-copy CLI needs no database credentials and verifies copy after original loss',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'passshare-copy-cli-')),original=path.join(dir,'original.json'),copy=path.join(dir,'copy.json'),config=path.join(dir,'config.json');
 const sourceId='11111111-1111-4111-8111-111111111111',bytes=Buffer.from(JSON.stringify({format:'passshare-deletion-journal-v1',sourceId,entries:[]})),sha=createHash('sha256').update(bytes).digest('hex'),cli=fileURLToPath(new URL('../scripts/deletion-recovery.mjs',import.meta.url));
 try{fs.writeFileSync(original,bytes);fs.writeFileSync(config,JSON.stringify({format:'passshare-deletion-copy-v1',sourceId,journalPath:original,copyPath:copy,trustedJournalSha256:sha}));const r=JSON.parse(execFileSync(process.execPath,[cli,'preserve-copy',config],{encoding:'utf8',windowsHide:true,timeout:10000}));assert.equal(r.ok,true);assert.equal(r.offHostRetentionProven,false);fs.unlinkSync(original);assert.deepEqual(fs.readFileSync(copy),bytes);assert.throws(()=>execFileSync(process.execPath,[cli,'preserve-copy',config],{windowsHide:true,timeout:10000,stdio:'pipe'}));}finally{for(const f of[original,copy,config])if(fs.existsSync(f))fs.unlinkSync(f);fs.rmdirSync(dir);}
});
