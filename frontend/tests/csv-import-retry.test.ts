import fs from 'node:fs';import vm from 'node:vm';import {test} from 'node:test';import assert from 'node:assert/strict';import {stripTypeScriptTypes} from 'node:module';import {importAttempt,importFingerprint,saveImportAttempt,finishImportAttempt} from '../src/lib/import-attempt.ts';
for(const ambiguous of [false,true])test('real CSV handler retries writes: response lost='+ambiguous,async()=>{
 const source=fs.readFileSync(new URL('../src/pages/app/ItemsPage.tsx',import.meta.url),'utf8');const body=source.slice(source.indexOf('  async function handleCsvImport('),source.indexOf('  async function handle1puxImport('));const records=new Map();let calls=0;const keys=[];const c={connectClient:{createItem:async(_v,_body,key)=>{calls++;keys.push(key);if(calls===2){if(ambiguous)records.set(key,{});throw Error('failure');}records.set(key,{});}},itemsReady:true,busyRef:{current:false},activeScope:{current:'owner:box'},vaultId:'box',ensureCompatibility:async()=>{},parseOnepasswordCsv:()=>[{},{}],connectItemToCreateBody:x=>x,setError:()=>{},setImportMessage:()=>{},setBusy:()=>{},labels:{importSuccess:'{count}'},loadGeneration:{current:0},loadItems:async()=>{c.loadGeneration.current++;},t:()=>'{count}',csvAttempt:{current:null},importAttempt,importFingerprint,saveImportAttempt,finishImportAttempt};vm.createContext(c);vm.runInContext(stripTypeScriptTypes(body)+';globalThis.run=handleCsvImport',c);const file={text:async()=> 'synthetic'};await c.run(file);await c.run(file);assert.equal(records.size,2);assert.equal(calls,3);assert.equal(keys[1],keys[2]);await c.run(file);assert.equal(records.size,4);
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
test('unfinished file retains row keys across other files and remount',async()=>{
 const first=importAttempt(null,'retry-owner:box',await importFingerprint('first file'),2);
 first.completed.add(0);saveImportAttempt(first);
 const other=importAttempt(null,'retry-owner:box',await importFingerprint('second file'),2);
 assert.notEqual(other.keys[0],first.keys[0]);
 const remounted=importAttempt(null,'retry-owner:box',await importFingerprint('first file'),2);
 assert.equal(remounted.keys[0],first.keys[0]);assert.equal(remounted.completed.has(0),true);
 finishImportAttempt(first);
 const next=importAttempt(null,'retry-owner:box',await importFingerprint('first file'),2);
 assert.notEqual(next.keys[0],first.keys[0]);assert.equal(next.completed.size,0);
 finishImportAttempt(next);finishImportAttempt(other);
});
test('unavailable or corrupt session storage never silently creates a fresh retry',()=>{
 const readError=new Error('storage read unavailable');
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:()=>{throw readError;}}});
 try{assert.throws(()=>importAttempt(null,'storage-read:box','digest',2),e=>e===readError);}finally{delete (globalThis as any).sessionStorage;}
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:()=>'{"keys":[],"completed":[9]}'}});
 try{assert.throws(()=>importAttempt(null,'storage-corrupt:box','digest',2),/Invalid saved import retry/);}finally{delete (globalThis as any).sessionStorage;}
 const writeError=new Error('storage write unavailable');
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:()=>null,setItem:()=>{throw writeError;}}});
 try{for(let n=0;n<2;n++)assert.throws(()=>importAttempt(null,'storage-write:box','digest',2),e=>e===writeError);}finally{delete (globalThis as any).sessionStorage;}
});
