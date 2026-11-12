import {test} from 'node:test';
import assert from 'node:assert/strict';import express from 'express';import {createVaultRoutes} from '../src/connect/router.js';
test('changed prefix remains partial while remaining rows complete under their original operations',async()=>{
 let calls=0,created=0,changed=false;const records=new Map();let first;
 const mutateOnce=async input=>{
  first??=input.key;
  if(changed&&input.key===first)throw Object.assign(Error('changed'),{status:409,reason:'creation_result_changed'});
  if(records.has(input.key))return records.get(input.key);
  if(++calls===2)throw Error('partial');
  const result={id:'synthetic-'+(++created)};records.set(input.key,result);return result;
 };
 const app=express();app.use(express.json());app.use('/v1/vaults',createVaultRoutes({}, {mutateOnce}));app.use((_e,_q,r,_n)=>r.status(503).json({message:'synthetic failure'}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{const run=()=>fetch('http://127.0.0.1:'+server.address().port+'/v1/vaults/'+ 'a'.repeat(26)+'/imports/1pux',{method:'POST',headers:{'content-type':'application/json','idempotency-key':'synthetic-operation-0001'},body:JSON.stringify({base64:Buffer.from(JSON.stringify({items:[{title:'first'},{title:'second'}]})).toString('base64')})});
  assert.equal((await run()).status,503);changed=true;
  const result=await run();assert.equal(result.status,201);const body=await result.json();assert.equal(body.partial,true);assert.equal(body.changed,1);assert.equal(body.imported,1);assert.equal(created,2);
  assert.equal((await (await run()).json()).partial,true);assert.equal(created,2);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('1PUX partial storage failure retries with the same row operation identity',async()=>{let calls=0,created=0;const store={createItem:async()=>{calls++;if(calls===2)throw Error('synthetic write failure');created++;return {id:'x'+calls};}};const records=new Map();const mutateOnce=async input=>{if(records.has(input.key))return records.get(input.key);const item=await store.createItem(input.resource,input.request);records.set(input.key,item);return item;};const app=express();app.use(express.json());app.use('/v1/vaults',createVaultRoutes(store,{mutateOnce}));app.use((_e,_q,r,_n)=>r.status(503).json({message:'synthetic failure'}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));try{const base='http://127.0.0.1:'+server.address().port;const body={base64:Buffer.from(JSON.stringify({items:[{title:'a',fields:[{label:'password',type:'CONCEALED',value:'synthetic-a'}]},{title:'b',fields:[{label:'username',type:'STRING',value:'synthetic-b'}]}]})).toString('base64')};const run=()=>fetch(base+'/v1/vaults/'+ 'a'.repeat(26)+'/imports/1pux',{method:'POST',headers:{'content-type':'application/json','idempotency-key':'synthetic-import-operation-0001'},body:JSON.stringify(body)});assert.equal((await run()).status,503);assert.equal((await run()).status,201);assert.equal(created,2,'same archive retry must not duplicate successful prefix');}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}});
