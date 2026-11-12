import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('the same deleted operation is hidden from expired sessions and conflicts for current sessions',async()=>{
 const source=await fs.readFile(new URL('../src/store/mutation-store.js',import.meta.url),'utf8');
 const withoutImports=source.replace(/^import .*;\r?\n/gm,'').replace('export async function','async function');
 const nativeMutation=async()=>({parts:['actor','box','item','operation'],lock:'scope'});
 const connectHttpError=(status,message)=>Object.assign(Error(message),{status});
 const factory=Function('nativeMutation','createPgStore','generateConnectId','normalizeItemBody','connectHttpError','applySchemaWithAdvisoryLock',withoutImports+';return createMutationStore;')(nativeMutation,()=>({}),()=>'',x=>x,connectHttpError,async()=>{});
 let current=false,readCount=0;
 const client={release(){},async query(sql){
  if(sql.startsWith('SELECT request_hash')){readCount++;return {rows:[{request_hash:'fixed',result:{deleted:true}}]};}
  if(sql.includes('FROM sessions'))return {rowCount:current?1:0,rows:[]};
  if(sql.includes('FROM vault_memberships'))return {rowCount:1,rows:[]};
  return {rows:[],rowCount:0};
 }};
 const run=await factory({store:{},authStore:{},pool:{connect:async()=>client}});
 const input={actor:'actor',resource:'box',operation:'item',key:'operation',request:{title:'synthetic'},sessionId:'session'};
 await assert.rejects(run(input),error=>error.status===401);
 current=true;
 await assert.rejects(run(input),error=>error.status===409&&error.reason==='creation_result_changed');
 assert.equal(readCount,2);
});
test('memory attachment failure retains rollback ownership until deletion is confirmed',async()=>{
 const source=await fs.readFile(new URL('../src/store/mutation-store.js',import.meta.url),'utf8');
 const text=source.replace(/^import .*;\r?\n/gm,'').replace('export async function','async function');
 const native=async input=>input.command==='scope'?{parts:[],lock:'same-scope'}:input.command==='create'?{action:'create'}:{request_hash:'same',result:input.result};
 const factory=Function('nativeMutation','createPgStore','generateConnectId','normalizeItemBody','connectHttpError','applySchemaWithAdvisoryLock',text+';return createMutationStore;')(native,()=>{},()=>'',x=>x,(status,message)=>Object.assign(Error(message),{status}),async()=>{});
 let created=0,deleteFails=true,fileFails=true;const items=new Set();
 const store={async createItem(){const item={id:String(++created)};items.add(item.id);return item;},async createFile(){if(fileFails)throw Error('file failed');},async deleteItem(_box,id){if(deleteFails)throw Error('delete failed');items.delete(id);}};
 const run=await factory({store,authStore:{},pool:null});const input={actor:'legacy',operation:'item',resource:'box',key:'same-key',request:{title:'synthetic'},importFiles:[{id:'file',content:Buffer.from([1])}]};
 await assert.rejects(run(input),AggregateError);assert.equal(created,1);assert.equal(items.size,1);
 await assert.rejects(run(input),/delete failed/);assert.equal(created,1,'unconfirmed rollback must prevent another creation');
 deleteFails=false;fileFails=false;await run(input);assert.equal(created,2);assert.deepEqual([...items],['2']);
});
