import fs from 'node:fs';import vm from 'node:vm';import {test} from 'node:test';import assert from 'node:assert/strict';import {stripTypeScriptTypes} from 'node:module';import {importAttempt,importFingerprint,saveImportAttempt,finishImportAttempt,acquireImportAttempt,releaseImportAttempt} from '../src/lib/import-attempt.ts';
import {exportOnepasswordCsv} from '../../shared/lib/csv-export.ts';

function realParser(){
 const source=fs.readFileSync(new URL('../src/lib/csv-import.ts',import.meta.url),'utf8').replace(/^import .*$/gm,'').replace('export function parseOnepasswordCsv','function parseOnepasswordCsv');
 const types=fs.readFileSync(new URL('../../shared/types/item.ts',import.meta.url),'utf8');
 const empty=types.slice(types.indexOf('export function emptyFormValues'),types.indexOf('export function formValuesFromItem')).replace('export function','function');
 const c=vm.createContext({});vm.runInContext(stripTypeScriptTypes(empty+source)+';globalThis.parse=parseOnepasswordCsv',c);return c.parse;
}

test('blank-only required cells remain skipped without trimming valid secrets',()=>{
 const rows=realParser()('Title,Password\r   ,secret\rValid,   \rKept, value \r');
 assert.equal(rows.length,1);assert.equal(rows[0].title,'Kept');assert.equal(rows[0].password,' value ');
});

test('real parser and create-body conversion deliver full multiline values through the handler',async()=>{
 const source=fs.readFileSync(new URL('../src/pages/app/ItemsPage.tsx',import.meta.url),'utf8');
 const body=source.slice(source.indexOf('  async function handleCsvImport('),source.indexOf('  async function handle1puxImport('));
 const conversion=fs.readFileSync(new URL('../../shared/cloud/connect-items.ts',import.meta.url),'utf8').replace(/^import .*$/gm,'').replace(/export function/g,'function');
 const types=fs.readFileSync(new URL('../../shared/types/item.ts',import.meta.url),'utf8');
 const tags=types.slice(types.indexOf('export function parseTagsInput')).replace('export function','function');
 const saved:any[]=[];
 const c=vm.createContext({connectClient:{createItem:async(_v,payload)=>saved.push(payload)},itemsReady:true,busyRef:{current:false},activeScope:{current:'real-parser-body:box'},vaultId:'box',ensureCompatibility:async()=>{},parseOnepasswordCsv:realParser(),setError:()=>{},setImportMessage:()=>{},setBusy:()=>{},labels:{importSuccess:'{count}'},loadGeneration:{current:0},loadItems:async()=>{},t:()=>'{count}',csvAttempt:{current:null},importAttempt,importFingerprint,saveImportAttempt,finishImportAttempt,acquireImportAttempt,releaseImportAttempt});
 vm.runInContext(stripTypeScriptTypes(tags+conversion+body)+';globalThis.run=handleCsvImport',c);
 const notes='first\r\n"second", third';
 await c.run({text:async()=>exportOnepasswordCsv([{id:'fixture',category:'LOGIN',favorite:false,title:'Synthetic',username:' user ',password:' value ',url:' https://example.test/path?q=a%20b ',notes,tags:[' first ','second']}])});
 assert.equal(saved.length,1);
 assert.equal(saved[0].fields.find(field=>field.purpose==='PASSWORD').value,' value ');
 assert.equal(saved[0].fields.find(field=>field.purpose==='USERNAME').value,' user ');
 assert.equal(saved[0].fields.find(field=>field.label==='notes').value,notes);
 assert.equal(saved[0].urls[0].href,'https://example.test/path?q=a%20b');
 assert.equal(JSON.stringify(saved[0].tags),JSON.stringify(['first','second']));
});

test('existing exporter roundtrip retains quoted values and intentional duplicate rows',()=>{
 const item={id:'synthetic',category:'LOGIN' as const,favorite:false,title:'Unicode 日本語, "title"',username:' user ',password:' synthetic ',url:'',notes:'line1\r\nline "2",\nlast',tags:[]};
 const rows=realParser()(exportOnepasswordCsv([item,item]));
 assert.equal(rows.length,2);
 for(const row of rows)for(const key of ['title','username','password','notes','url'])assert.equal(row[key],item[key]);
});

test('malformed later record prevents every real handler create',async()=>{
 const source=fs.readFileSync(new URL('../src/pages/app/ItemsPage.tsx',import.meta.url),'utf8');
 const body=source.slice(source.indexOf('  async function handleCsvImport('),source.indexOf('  async function handle1puxImport('));
 let writes=0,errors=0;
 const c=vm.createContext({connectClient:{createItem:async()=>{writes++;}},itemsReady:true,busyRef:{current:false},activeScope:{current:'malformed:box'},vaultId:'box',ensureCompatibility:async()=>{},parseOnepasswordCsv:realParser(),connectItemToCreateBody:x=>x,setError:()=>{errors++;},setImportMessage:()=>{},setBusy:()=>{},labels:{importSuccess:'{count}'},loadGeneration:{current:0},loadItems:async()=>{},t:()=>'{count}',csvAttempt:{current:null},importAttempt,importFingerprint,saveImportAttempt,finishImportAttempt,acquireImportAttempt,releaseImportAttempt});
 vm.runInContext(stripTypeScriptTypes(body)+';globalThis.run=handleCsvImport',c);
 await c.run({text:async()=> 'Title,Password,Notes\nValid,synthetic,ok\nBroken,synthetic,"unterminated'});
 assert.equal(writes,0);assert.ok(errors>0);
 for(const bad of ['Title,Password\n"bad"tail,synthetic','Title,Password\nbad"quote,synthetic'])assert.throws(()=>realParser()(bad),/CSV/);
});

test('real CSV parser retains quoted multiline notes, doubled quotes and record order', () => {
 const source=fs.readFileSync(new URL('../src/lib/csv-import.ts',import.meta.url),'utf8').replace(/^import .*$/gm,'').replace('export function parseOnepasswordCsv','function parseOnepasswordCsv');
 const c=vm.createContext({emptyFormValues:()=>({})});vm.runInContext(stripTypeScriptTypes(source)+';globalThis.parse=parseOnepasswordCsv',c);
 const csv='Title,Username,Password,Notes\r\nFirst,user,synthetic,"line one\r\nline ""two"", kept"\r\nSecond,user,synthetic,final\r\n';
 const rows=c.parse(csv);
 assert.equal(rows.length,2);
 assert.equal(rows[0].notes,'line one\r\nline "two", kept');
 assert.equal(rows[1].title,'Second');
});
for(const ambiguous of [false,true])test('real CSV handler retries writes: response lost='+ambiguous,async()=>{
 const source=fs.readFileSync(new URL('../src/pages/app/ItemsPage.tsx',import.meta.url),'utf8');const body=source.slice(source.indexOf('  async function handleCsvImport('),source.indexOf('  async function handle1puxImport('));const records=new Map();let calls=0;const keys=[];const c={connectClient:{createItem:async(_v,_body,key)=>{calls++;keys.push(key);if(calls===2){if(ambiguous)records.set(key,{});throw Error('failure');}records.set(key,{});}},itemsReady:true,busyRef:{current:false},activeScope:{current:'owner:box'},vaultId:'box',ensureCompatibility:async()=>{},parseOnepasswordCsv:()=>[{},{}],connectItemToCreateBody:x=>x,setError:()=>{},setImportMessage:()=>{},setBusy:()=>{},labels:{importSuccess:'{count}'},loadGeneration:{current:0},loadItems:async()=>{c.loadGeneration.current++;},t:()=>'{count}',csvAttempt:{current:null},importAttempt,importFingerprint,saveImportAttempt,finishImportAttempt,acquireImportAttempt,releaseImportAttempt};vm.createContext(c);vm.runInContext(stripTypeScriptTypes(body)+';globalThis.run=handleCsvImport',c);const file={text:async()=> 'synthetic'};await c.run(file);await c.run(file);assert.equal(records.size,2);assert.equal(calls,4);assert.equal(keys[0],keys[2]);assert.equal(keys[1],keys[3]);await c.run(file);assert.equal(records.size,4);
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
test('a delayed old checkpoint cannot resurrect a finished attempt or remove its successor',()=>{
 const old=importAttempt(null,'flight-owner:box','fingerprint',2);
 acquireImportAttempt(old);
 const remount=importAttempt(null,'flight-owner:box','fingerprint',2);
 assert.equal(remount,old);assert.throws(()=>acquireImportAttempt(remount),/active/);
 old.completed.add(0);saveImportAttempt(old);finishImportAttempt(old);releaseImportAttempt(old);
 const next=importAttempt(null,'flight-owner:box','fingerprint',2);
 assert.notEqual(next.keys[0],old.keys[0]);acquireImportAttempt(next);
 assert.throws(()=>saveImportAttempt(old),/completed/);
 assert.throws(()=>finishImportAttempt(old),/completed/);
 assert.equal(importAttempt(null,'flight-owner:box','fingerprint',2),next);
 releaseImportAttempt(next);finishImportAttempt(next);
});
for(const code of ['PS015','PS055',undefined])test('real handler distinguishes replay conflict code='+code,async()=>{
 const source=fs.readFileSync(new URL('../src/pages/app/ItemsPage.tsx',import.meta.url),'utf8');const body=source.slice(source.indexOf('  async function handleCsvImport('),source.indexOf('  async function handle1puxImport('));let calls=0,created=0,success=0,deleted=false;const keys=[];
 const c={connectClient:{createItem:async(_v,_body,key)=>{keys.push(key);calls++;if(calls===2)throw Error('partial');if(deleted&&key===keys[0])throw Object.assign(Error('changed or deleted'),{status:409,code});created++;}},itemsReady:true,busyRef:{current:false},activeScope:{current:'deleted-owner-'+code+':box'},vaultId:'box',ensureCompatibility:async()=>{},parseOnepasswordCsv:()=>[{},{}],connectItemToCreateBody:x=>x,setError:()=>{},setImportMessage:value=>{if(value)success++;},setBusy:()=>{},labels:{importSuccess:'{count}'},loadGeneration:{current:0},loadItems:async()=>{c.loadGeneration.current++;},t:()=>'{count}',csvAttempt:{current:null},importAttempt,importFingerprint,saveImportAttempt,finishImportAttempt,acquireImportAttempt,releaseImportAttempt};vm.createContext(c);vm.runInContext(stripTypeScriptTypes(body)+';globalThis.run=handleCsvImport',c);
 const file={text:async()=> 'deleted fixture'};await c.run(file);deleted=true;await c.run(file);assert.equal(created,code==='PS015'?2:1);assert.equal(success,0);assert.equal(keys[0],keys[2]);if(code==='PS015')assert.equal(keys[1],keys[3]);assert.equal(calls,code==='PS015'?4:3);
});
test('duplicate stored row UUIDs are rejected and failed completion remains retryable',()=>{
 const id=crypto.randomUUID();
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:()=>JSON.stringify({keys:[id,id],completed:[]})}});
 try{assert.throws(()=>importAttempt(null,'duplicate-owner:box','digest',2),/Invalid saved/);}finally{delete (globalThis as any).sessionStorage;}
 const a=importAttempt(null,'finish-owner:box','digest',2);let fail=true;
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{removeItem:()=>{if(fail)throw Error('remove unavailable');}}});
 try{assert.throws(()=>finishImportAttempt(a),/remove unavailable/);assert.equal(importAttempt(null,a.scope,a.fingerprint,2),a);fail=false;finishImportAttempt(a);}finally{delete (globalThis as any).sessionStorage;}
 const b=importAttempt(null,a.scope,a.fingerprint,2);assert.notEqual(b.keys[0],a.keys[0]);finishImportAttempt(b);
});
test('a new module instance restores the saved row keys without source data',async()=>{
 const values=new Map<string,string>();
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)}});
 try{
  const a=importAttempt(null,'reload-owner:box','synthetic-digest',2);a.completed.add(0);saveImportAttempt(a);
  const module=await import('../src/lib/import-attempt.ts?reload-fixture');
  const b=module.importAttempt(null,a.scope,a.fingerprint,2);
  assert.deepEqual(b.keys,a.keys);assert.equal(b.completed.has(0),true);assert.equal(values.size,1);
  assert.equal([...values.values()][0].includes('password'),false);
  module.finishImportAttempt(b);
 }finally{delete (globalThis as any).sessionStorage;}
});
test('a valid UUID character corruption is rejected before retry restore',async()=>{
 const values=new Map<string,string>();
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)}});
 try{
  const a=importAttempt(null,'checksum-owner:box','fixture-digest',2);
  const entry=[...values.keys()][0],saved=JSON.parse(values.get(entry)!);
  saved.keys[0]=(saved.keys[0][0]==='a'?'b':'a')+saved.keys[0].slice(1);values.set(entry,JSON.stringify(saved));
  const module=await import('../src/lib/import-attempt.ts?corruption-fixture');
  assert.throws(()=>module.importAttempt(null,a.scope,a.fingerprint,2),/checksum mismatch/);
 }finally{delete (globalThis as any).sessionStorage;}
});
