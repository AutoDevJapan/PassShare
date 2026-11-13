import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createSupportReceiptApi} from '../cloud/support-receipts-api.ts';
import {createApp} from '../../backend/src/app.js';
import {createMemoryAuthStore} from '../../backend/src/auth/index.js';
import {createMemoryStore} from '../../backend/src/store/memory-store.js';
import pg from '../../backend/node_modules/pg/lib/index.js';
import {randomUUID} from 'node:crypto';

const input={requestId:'11111111-1111-4111-8111-111111111111',kind:'technical' as const,version:'0.1.0',platform:'windows' as const,errorCode:'PS019'};
const id='22222222-2222-4222-8222-222222222222';
const row=()=>({id,status:'received',revision:0,history:[],createdAt:'2026-11-13T00:00:00Z',request:{...input},meaning:'request_received_not_contract_or_payment_confirmation'});

test('owner consent and operator status use exact scoped responses without retrying uncertainty',async()=>{
 const operatorId='44444444-4444-4444-8444-444444444444',confirmation='a'.repeat(43),signal=new AbortController().signal,calls:any[]=[];
 const api=createSupportReceiptApi(async(path,init)=>{
  calls.push({path,init});
  return path.endsWith('/authorization')?Response.json({receiptId:id,status:'in_progress',revision:0,expiresAt:'2026-11-13T00:10:00Z',confirmation},{status:201}):Response.json({id,status:'in_progress',revision:1});
 });
 const grant=await api.authorize(id,{operatorId,status:'in_progress',revision:0},signal);
 assert.equal(grant.confirmation,confirmation);
 assert.deepEqual(JSON.parse(JSON.stringify(await api.applyStatus(id,{confirmation},signal))),{id,status:'in_progress',revision:1});
 assert.deepEqual(calls.map(c=>c.path),[`/api/support-receipts/${id}/authorization`,`/api/support-receipts/${id}/operator-status`]);
 assert.equal(calls.every(c=>c.init.signal===signal&&c.init.method==='POST'&&c.init.cache==='no-store'&&c.init.redirect==='error'),true);
 let sends=0;const uncertain=createSupportReceiptApi(async()=>{sends++;throw Error('private transport detail');});
 await assert.rejects(uncertain.applyStatus(id,{confirmation},signal));assert.equal(sends,1);
});

test('operator client rejects malformed inputs and mismatched or secret-bearing responses',async()=>{
 const signal=new AbortController().signal,confirmation='a'.repeat(43),operatorId='44444444-4444-4444-8444-444444444444';
 let sends=0;const api=createSupportReceiptApi(async()=>{sends++;return Response.json({});});
 for(const bad of [{operatorId,status:'in_progress',revision:-1},{operatorId,status:'resolved',revision:0,secret:'private'}])await assert.rejects(api.authorize(id,bad as any,signal),e=>(e as any).status===400);
 await assert.rejects(api.applyStatus(id,{confirmation:'private'} as any,signal),e=>(e as any).status===400);
 assert.equal(sends,0);
 const grant={receiptId:id,status:'in_progress',revision:0,expiresAt:'2026-11-13T00:10:00Z',confirmation};
 for(const bad of [{...grant,receiptId:operatorId},{...grant,revision:1},{...grant,status:'resolved'},{...grant,secret:'private'}]){
  const client=createSupportReceiptApi(async()=>Response.json(bad,{status:201}));
  await assert.rejects(client.authorize(id,{operatorId,status:'in_progress',revision:0},signal),e=>(e as any).status===502);
 }
 const wrong=createSupportReceiptApi(async()=>Response.json({id:operatorId,status:'resolved',revision:1}));
 await assert.rejects(wrong.applyStatus(id,{confirmation},signal),e=>(e as any).status===502);
});

test('shared client binds owner authorization to real PostgreSQL operator consumption',{skip:process.env.PASSSHARE_RECEIPTS_PG!=='true'},async()=>{
 assert.match(process.env.DATABASE_URL??'',/^postgresql:\/\/passshare:passshare@127\.0\.0\.1:(5432|15431)\/passshare$/);
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL}),actors:string[]=[];
 let server:any;const previous=process.env.PASSSHARE_SUPPORT_OPERATOR_IDS;
 try{
  const {app}=await createApp({pool});server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  let base='http://127.0.0.1:'+server.address().port;
  const signup=async()=>{const r=await fetch(base+'/api/auth/signup',{method:'POST',headers:{'content-type':'application/json','x-passshare-client':'mobile'},body:JSON.stringify({email:'receipt-client-'+randomUUID()+'@example.test',password:'synthetic-password123'})});assert.equal(r.status,201);const a=await r.json();actors.push(a.user.id);return a;};
  const owner=await signup(),operator=await signup(),other=await signup();
  process.env.PASSSHARE_SUPPORT_OPERATOR_IDS=operator.user.id;
  server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
  const configured=await createApp({pool});server=configured.app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;
  const client=(token:string)=>createSupportReceiptApi((path,init)=>fetch(base+path,{...init,headers:{...init?.headers,authorization:'Bearer '+token,'content-type':'application/json'}}));
  const a=client(owner.refreshToken),op=client(operator.refreshToken),outsider=client(other.refreshToken),signal=new AbortController().signal;
  const receipt=await a.create({...input,requestId:randomUUID()},signal);
  const consent=await a.authorize(receipt.id,{operatorId:operator.user.id,status:'in_progress',revision:0},signal);
  await assert.rejects(outsider.applyStatus(receipt.id,{confirmation:consent.confirmation},signal),e=>(e as any).status===403);
  assert.equal((await op.applyStatus(receipt.id,{confirmation:consent.confirmation},signal)).revision,1);
  await assert.rejects(op.applyStatus(receipt.id,{confirmation:consent.confirmation},signal),e=>(e as any).status===403);
  const read=await a.get(receipt.id,signal);assert.equal(read.status,'in_progress');assert.equal(read.history.length,1);
  assert.equal(JSON.stringify(read).includes(consent.confirmation),false);
  await assert.rejects(a.authorize(receipt.id,{operatorId:operator.user.id,status:'resolved',revision:0},signal),e=>(e as any).status===409);
 }finally{
  if(previous===undefined)delete process.env.PASSSHARE_SUPPORT_OPERATOR_IDS;else process.env.PASSSHARE_SUPPORT_OPERATOR_IDS=previous;
  if(server){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
  await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[actors]);
  assert.equal((await pool.query('SELECT count(*)::int n FROM support_receipts WHERE user_id=ANY($1::uuid[])',[actors])).rows[0].n,0);
  await pool.end();
 }
});

test('malformed successful responses are protocol errors and caller getter diagnostics stay private',async()=>{
 for(const response of [new Response('{'),new Response(new Uint8Array([0xff]))]){
  const api=createSupportReceiptApi(async()=>response);
  await assert.rejects(api.get(id,new AbortController().signal),e=>(e as any).status===502);
 }
 let calls=0;const api=createSupportReceiptApi(async()=>{calls++;return Response.json(row());});
 const bad={...input};Object.defineProperty(bad,'version',{get(){throw Error('private-value');},enumerable:true});
 await assert.rejects(api.create(bad,new AbortController().signal),e=>(e as any).status===400&&!(e as Error).message.includes('private'));
 assert.equal(calls,0);
});

test('validated input values are captured once before serialization',async()=>{
 let reads=0;let body='';
 const changing={...input};Object.defineProperty(changing,'errorCode',{enumerable:true,get(){return ++reads===1?'PS019':'private-value';}});
 const api=createSupportReceiptApi(async(_path,init)=>{body=String(init?.body);return Response.json(row(),{status:201});});
 await api.create(changing,new AbortController().signal);
 assert.equal(reads,1);assert.equal(JSON.parse(body).errorCode,'PS019');assert.equal(body.includes('private'),false);
});

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
