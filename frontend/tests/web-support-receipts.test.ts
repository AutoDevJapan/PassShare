import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {createSupportReceiptApi} from '../../shared/cloud/support-receipts-api.ts';
import {createApp} from '../../backend/src/app.js';
import {createMemoryAuthStore} from '../../backend/src/auth/index.js';
import {createMemoryStore} from '../../backend/src/store/memory-store.js';

test('Web receipt adapter uses real cookie/CSRF transport with owner isolation and explicit replay',async()=>{
 const authStore=createMemoryAuthStore();
 const owner=await authStore.createUser({email:'web-receipt@example.test',passwordHash:'$argon2id$'+'x'.repeat(80)});
 const other=await authStore.createUser({email:'web-receipt-other@example.test',passwordHash:'$argon2id$'+'y'.repeat(80)});
 const a=await authStore.createSession(owner.id,owner.password_hash),b=await authStore.createSession(other.id,other.password_hash);
 const {app}=await createApp({pool:null,authStore,store:createMemoryStore()});
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 const base='http://127.0.0.1:'+server.address().port;
 let calls=0,posts=0,csrf=0;let stripCsrf=false,failPost=false;
 const load=(token:string)=>{
  const cookies=new Map([['passshare_session',token]]);
  const source=fs.readFileSync(new URL('../src/lib/auth-api.ts',import.meta.url),'utf8').replace('import.meta.env.VITE_API_BASE_URL ?? ""',JSON.stringify(base)).replace(/export /g,'');
  const context=vm.createContext({Headers,Response,AbortController,setTimeout,clearTimeout,
   fetch:async(url:string,init:RequestInit)=>{
    calls++;assert.equal(init.credentials,'include');
    const headers=new Headers(init.headers);assert.equal(headers.has('Authorization'),false);
    if(url.endsWith('/csrf'))csrf++;
    if(init.method==='POST'){posts++;if(failPost)throw Error('uncertain response');if(stripCsrf)headers.delete('X-CSRF-Token');}
    headers.set('Cookie',[...cookies].map(([k,v])=>k+'='+encodeURIComponent(v)).join('; '));
    const response=await fetch(url,{...init,headers});
    for(const value of response.headers.getSetCookie()){const pair=value.split(';')[0],at=pair.indexOf('=');cookies.set(pair.slice(0,at),decodeURIComponent(pair.slice(at+1)));}
    return response;
   },createSupportReceiptApi});
  vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+';globalThis.authFetch=authFetch',context);
  const adapter=fs.readFileSync(new URL('../src/lib/support-receipts-api.ts',import.meta.url),'utf8').replace(/^import .*$/gm,'').replace(/export /g,'');
  vm.runInContext(stripTypeScriptTypes(adapter)+';globalThis.api=webSupportReceiptApi',context);
  return context.api;
 };
 try{
  const api=load(a.sessionToken),signal=new AbortController().signal;
  const input={requestId:'33333333-3333-4333-8333-333333333333',kind:'technical',version:'0.1.0',platform:'web',errorCode:''};
  const row=await api.create(input,signal);assert.equal((await api.create(input,signal)).id,row.id);assert.equal((await api.get(row.id,signal)).id,row.id);
  assert.equal(posts,2);assert.equal(csrf,2);
  await assert.rejects(load(b.sessionToken).get(row.id,signal),e=>(e as any).status===404);
  stripCsrf=true;await assert.rejects(api.create({...input,requestId:'44444444-4444-4444-8444-444444444444'},signal),e=>(e as any).status===403);stripCsrf=false;
  const abort=new AbortController();abort.abort();const before=calls;await assert.rejects(api.get(row.id,abort.signal));assert.equal(calls,before);
  failPost=true;const count=posts;await assert.rejects(api.create(input,signal));assert.equal(posts,count+1);failPost=false;
  await authStore.deleteSession(a.sessionId);await assert.rejects(api.get(row.id,signal),e=>(e as any).status===401);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
