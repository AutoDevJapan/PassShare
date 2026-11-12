import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createMemoryStore} from '../src/store/memory-store.js';
import {createMemoryAuthStore} from '../src/auth/memory-auth-store.js';
import {createItemRoutes} from '../src/connect/router.js';
import express from 'express';
test('normal item HTTP route carries current token into mutation recovery',async()=>{
 const auth=createMemoryAuthStore(),store=createMemoryStore();const user=await auth.createUser({email:'synthetic@example.test',passwordHash:'synthetic'});
 const box=await store.createVault({name:'synthetic'});await auth.addVaultMembership(user.id,box);
 const session=await auth.createSession(user.id,'synthetic');const token=await auth.createConnectToken(user.id,'test',session.sessionId);
 const source=await fs.readFile(new URL('../src/store/mutation-store.js',import.meta.url),'utf8');
 const text=source.replace(/^import .*;\r?\n/gm,'').replace('export async function','async function');
 let fail=true;const native=async input=>{if(input.command==='record'&&fail){await auth.deleteConnectTokensForUser(user.id);throw Error('record failed');}return input.command==='scope'?{parts:[],lock:'route-scope'}:input.command==='create'?{action:'create'}:{request_hash:'same',result:input.result};};
 const factory=Function('nativeMutation','createPgStore','generateConnectId','normalizeItemBody','connectHttpError','applySchemaWithAdvisoryLock',text+';return createMutationStore;')(native,()=>{},()=>'',x=>x,(status,message)=>Object.assign(Error(message),{status}),async()=>{});
 const mutateOnce=await factory({store,authStore:auth,pool:null});const app=express();app.use(express.json());app.use((req,_res,next)=>{req.connectAuth={userId:user.id,tokenHash:token.tokenHash};next();});app.use('/v1/vaults/:vaultUuid/items',createItemRoutes(store,{mutateOnce}));app.use((error,_req,res,_next)=>res.status(error.status??503).end());
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{const send=()=>fetch(`http://127.0.0.1:${server.address().port}/v1/vaults/${box}/items`,{method:'POST',headers:{'content-type':'application/json','idempotency-key':'synthetic-route-operation'},body:JSON.stringify({title:'synthetic'})});assert.equal((await send()).status,503);fail=false;assert.equal((await send()).status,401);assert.equal((await store.listItemOverviews(box)).length,1);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('memory rollback compare-delete preserves edits during the deletion await',async()=>{
 const store=createMemoryStore();const box=await store.createVault({name:'synthetic'});
 const item=await store.createItem(box,{title:'original'});
 const expected=JSON.stringify(item);
 const edit=store.replaceItem(box,item.id,{title:'edited',version:item.version});
 const remove=store.deleteItem(box,item.id,expected);
 await edit;await assert.rejects(remove,error=>error.status===409);
 assert.equal((await store.getItem(box,item.id)).title,'edited');
 const original=await store.getItem(box,item.id);
 const foreign=await store.createFile(box,item.id,{name:'foreign',content:Buffer.from([7])});
 await assert.rejects(store.deleteItem(box,item.id,JSON.stringify(original),[foreign.id],undefined,[{id:foreign.id,name:'foreign',content:Buffer.from([8])}]),error=>error.status===409);
 assert.deepEqual(await store.getFileContent(box,item.id,foreign.id),Buffer.from([7]));
 await assert.rejects(store.deleteItem(box,item.id,JSON.stringify(original),[]),error=>error.status===409);
 assert.deepEqual(await store.getFileContent(box,item.id,foreign.id),Buffer.from([7]));
 await assert.rejects(store.deleteItem(box,item.id,JSON.stringify(original),[foreign.id],()=>{throw Object.assign(Error('revoked'),{status:401});}),error=>error.status===401);
 assert.equal((await store.getItem(box,item.id)).title,'edited');
});
test('mutation rollback owns a copied snapshot through actual memory store',async()=>{
 const source=await fs.readFile(new URL('../src/store/mutation-store.js',import.meta.url),'utf8');const text=source.replace(/^import .*;\r?\n/gm,'').replace('export async function','async function');
 let recordFails=true;const native=async input=>{if(input.command==='record'&&recordFails)throw Error('record failed');return input.command==='scope'?{parts:[],lock:'snapshot-scope'}:input.command==='create'?{action:'create'}:{request_hash:'same',result:input.result};};
 const factory=Function('nativeMutation','createPgStore','generateConnectId','normalizeItemBody','connectHttpError','applySchemaWithAdvisoryLock',text+';return createMutationStore;')(native,()=>{},()=>'',x=>x,(status,message)=>Object.assign(Error(message),{status}),async()=>{});
 const store=createMemoryStore(),box=await store.createVault({name:'synthetic'}),content=Buffer.from([7]);const fileId='f'.repeat(26);
 const run=await factory({store,authStore:{},pool:null});const input={actor:'legacy',resource:box,operation:'item',key:'snapshot-key',request:{title:'synthetic'},importFiles:[{id:fileId,name:'synthetic',content}]};
 await assert.rejects(run(input),/record failed/);const [item]=await store.listItemOverviews(box);
 content.fill(0);await store.deleteFile(box,item.id,fileId);await store.createFile(box,item.id,{id:fileId,name:'synthetic',content:Buffer.from([0])});recordFails=false;
 await assert.rejects(run(input),error=>error.status===409);assert.equal((await store.listItemOverviews(box)).length,1);assert.deepEqual(await store.getFileContent(box,item.id,fileId),Buffer.from([0]));
});

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
 let recordFails=false;
 const native=async input=>{if(input.command==='record'&&recordFails)throw Error('record failed');return input.command==='scope'?{parts:[],lock:'same-scope'}:input.command==='create'?{action:'create'}:{request_hash:'same',result:input.result};};
 const factory=Function('nativeMutation','createPgStore','generateConnectId','normalizeItemBody','connectHttpError','applySchemaWithAdvisoryLock',text+';return createMutationStore;')(native,()=>{},()=>'',x=>x,(status,message)=>Object.assign(Error(message),{status}),async()=>{});
 let created=0,deleteFails=true,fileFails=true,tokenValid=true,edited=false;const items=new Set();
 const store={async getItem(_box,id){return edited?{id,edited:true}:{id};},async createItem(){const item={id:String(++created)};items.add(item.id);return item;},async createFile(){if(fileFails)throw Error('file failed');},async deleteItem(_box,id){if(deleteFails)throw Error('delete failed');items.delete(id);}};
 const authStore={findConnectTokenByHash:async()=>tokenValid};
 const run=await factory({store,authStore,pool:null});const input={actor:'legacy',connectTokenHash:'synthetic-token',operation:'item',resource:'box',key:'same-key',request:{title:'synthetic'},importFiles:[{id:'file',content:Buffer.from([1])}]};
 await assert.rejects(run(input),AggregateError);assert.equal(created,1);assert.equal(items.size,1);
 await assert.rejects(run(input),/delete failed/);assert.equal(created,1,'unconfirmed rollback must prevent another creation');
 deleteFails=false;fileFails=false;tokenValid=false;await assert.rejects(run(input),error=>error.status===401);assert.equal(items.size,1);
 tokenValid=true;edited=true;await assert.rejects(run(input),error=>error.status===409);assert.equal(items.size,1);
 edited=false;await run(input);assert.equal(created,2);assert.deepEqual([...items],['2']);
 recordFails=true;
 const next=await factory({store,authStore,pool:null});
 await assert.rejects(next(input),/record failed/);assert.equal(items.size,2);
 recordFails=false;await next(input);assert.equal(items.size,2,'failed record item must be recovered before retry creates replacement');
});
