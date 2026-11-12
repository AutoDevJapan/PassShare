import fs from 'node:fs';import vm from 'node:vm';import {test} from 'node:test';import assert from 'node:assert/strict';import {stripTypeScriptTypes} from 'node:module';import {importAttempt,importFingerprint} from '../src/lib/import-attempt.ts';
test('real CSV handler retries partial and ambiguous writes with stable row keys',async()=>{
 const source=fs.readFileSync(new URL('../src/pages/app/ItemsPage.tsx',import.meta.url),'utf8');const body=source.slice(source.indexOf('  async function handleCsvImport('),source.indexOf('  async function handle1puxImport('));const records=new Map();let calls=0;const keys=[];const c={connectClient:{createItem:async(_v,_body,key)=>{calls++;keys.push(key);if(calls===2)throw Error('failure');records.set(key,{});}},itemsReady:true,busyRef:{current:false},activeScope:{current:'owner:box'},vaultId:'box',ensureCompatibility:async()=>{},parseOnepasswordCsv:()=>[{},{}],connectItemToCreateBody:x=>x,setError:()=>{},setImportMessage:()=>{},setBusy:()=>{},labels:{importSuccess:'{count}'},loadGeneration:{current:0},loadItems:async()=>{c.loadGeneration.current++;},t:()=>'{count}',csvAttempt:{current:null},importAttempt,importFingerprint};vm.createContext(c);vm.runInContext(stripTypeScriptTypes(body)+';globalThis.run=handleCsvImport',c);const file={text:async()=> 'synthetic'};await c.run(file);await c.run(file);assert.equal(records.size,2);assert.equal(calls,3);assert.equal(keys[1],keys[2]);await c.run(file);assert.equal(records.size,4);
});
test('row identity is per attempt and position, not item content',async()=>{
 const fingerprint=await importFingerprint('same\nsame');
 const attempt=importAttempt(null,'owner:box',fingerprint,2);
 assert.notEqual(attempt.keys[0],attempt.keys[1]);
 assert.equal(importAttempt(attempt,'owner:box',fingerprint,2),attempt);
 assert.notEqual(importAttempt(attempt,'other:box',fingerprint,2).keys[0],attempt.keys[0]);
 assert.notEqual(await importFingerprint('same\r\nsame'),fingerprint);
 assert.notEqual(await importFingerprint('second\nfirst'),await importFingerprint('first\nsecond'));
});
