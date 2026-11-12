import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createSupportReceiptApi} from '../cloud/support-receipts-api.ts';
import {createApp} from '../../backend/src/app.js';
import {createMemoryAuthStore} from '../../backend/src/auth/index.js';
import {createMemoryStore} from '../../backend/src/store/memory-store.js';

const input={requestId:'11111111-1111-4111-8111-111111111111',kind:'technical' as const,version:'0.1.0',platform:'windows' as const,errorCode:'PS019'};
const id='22222222-2222-4222-8222-222222222222';
const row=()=>({id,status:'received',revision:0,history:[],createdAt:'2026-11-13T00:00:00Z',request:{...input},meaning:'request_received_not_contract_or_payment_confirmation'});

test('client reaches the actual authenticated receipt HTTP route and isolates owners',async()=>{
 const authStore=createMemoryAuthStore();
 const owner=await authStore.createUser({email:'receipt-client@example.test',passwordHash:'$argon2id$'+'x'.repeat(80)});
 const other=await authStore.createUser({email:'receipt-other@example.test',passwordHash:'$argon2id$'+'y'.repeat(80)});
 const session=await authStore.createSession(owner.id,owner.password_hash);
 const second=await authStore.createSession(other.id,other.password_hash);
 const {app}=await createApp({pool:null,authStore,store:createMemoryStore()});
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 const base='http://127.0.0.1:'+server.address().port;
 const client=(token:string)=>createSupportReceiptApi((path,init)=>fetch(base+path,{...init,headers:{authorization:'Bearer '+token,'content-type':'application/json'}}));
 try{
  const api=client(session.sessionToken),signal=new AbortController().signal;
  const a=await api.create(input,signal),b=await api.create(input,signal);
  assert.equal(a.id,b.id);assert.equal((await api.get(a.id,signal)).status,'received');
  await assert.rejects(client(second.sessionToken).get(a.id,signal),e=>(e as any).status===404);
  await authStore.deleteSession(session.sessionId);
  await assert.rejects(api.get(a.id,signal),e=>(e as any).status===401);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('intake and owner read validate receipt identity and retain the signal',async()=>{
 const signal=new AbortController().signal;const calls:RequestInit[]=[];
 const api=createSupportReceiptApi(async(_path,init)=>{calls.push(init!);return Response.json(row(),{status:init?.method==='POST'?201:200});});
 assert.equal((await api.create(input,signal)).id,id);
 assert.equal((await api.get(id,signal)).request.requestId,input.requestId);
 assert.equal(calls.every(call=>call.signal===signal&&call.cache==='no-store'&&call.redirect==='error'),true);
});

test('secret or extra input fields and pre-abort produce no requests',async()=>{
 let calls=0;const api=createSupportReceiptApi(async()=>{calls++;return Response.json(row());});
 for(const bad of [{...input,body:'secret'},{...input,errorCode:'token-value'},{...input,requestId:'../other'}])await assert.rejects(api.create(bad as any,new AbortController().signal));
 const controller=new AbortController();controller.abort();await assert.rejects(api.create(input,controller.signal));
 assert.equal(calls,0);
});

test('wrong identity, extra response secrets and HTTP failures never return a receipt',async()=>{
 for(const value of [{...row(),id:input.requestId},{...row(),secret:'not-returned'},{...row(),request:{...input,kind:'refund'}}]){
  const api=createSupportReceiptApi(async()=>Response.json(value,{status:value.id===input.requestId?200:201}));
  if(value.id===input.requestId)await assert.rejects(api.get(id,new AbortController().signal));
  else await assert.rejects(api.create(input,new AbortController().signal));
 }
 const api=createSupportReceiptApi(async()=>new Response('private diagnostic',{status:403}));
 await assert.rejects(api.get(id,new AbortController().signal),e=>e instanceof Error&&!e.message.includes('private'));
});

test('support intake uses the caller request identity and never auto-retries uncertain writes', async () => {
  const calls: {path: string; init?: RequestInit}[] = [];
  const api = createSupportReceiptApi(async (path, init) => {calls.push({path,init});throw Error('response lost');});
  const request = {requestId:'11111111-1111-4111-8111-111111111111',kind:'technical' as const,version:'0.1.0',platform:'windows' as const,errorCode:'PS019'};
  await assert.rejects(api.create(request, new AbortController().signal));
  assert.equal(calls.length,1);
  assert.equal(calls[0].path,'/api/support-receipts');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)),request);
});
