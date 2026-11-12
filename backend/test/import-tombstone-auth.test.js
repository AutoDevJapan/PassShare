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
