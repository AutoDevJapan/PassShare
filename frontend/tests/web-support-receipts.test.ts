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
 let calls=0,posts=0,csrf=0;let stripCsrf=false,failPost=false,switchOnCsrf=false;
 const load=(token:string,ownerId:string)=>{
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
    if(switchOnCsrf&&url.endsWith('/csrf'))cookies.set('passshare_session',b.sessionToken);
    return response;
   },createSupportReceiptApi});
  vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+';globalThis.authFetch=authFetch',context);
  const adapter=fs.readFileSync(new URL('../src/lib/support-receipts-api.ts',import.meta.url),'utf8').replace(/^import .*$/gm,'').replace(/export /g,'');
  vm.runInContext(stripTypeScriptTypes(adapter)+';globalThis.make=createWebSupportReceiptApi',context);
  return context.make(ownerId);
 };
 try{
  const api=load(a.sessionToken,owner.id),signal=new AbortController().signal;
  const input={requestId:'33333333-3333-4333-8333-333333333333',kind:'technical',version:'0.1.0',platform:'web',errorCode:''};
  const row=await api.create(input,signal);assert.equal((await api.create(input,signal)).id,row.id);assert.equal((await api.get(row.id,signal)).id,row.id);
  const preflight=await fetch(base+'/api/support-receipts',{method:'OPTIONS',headers:{Origin:base,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'X-PassShare-Receipt-Owner'}});
  assert.equal(preflight.status,204);assert.match(preflight.headers.get('Access-Control-Allow-Headers')??'',/X-PassShare-Receipt-Owner/i);
  assert.equal(posts,2);assert.equal(csrf,2);
  const cookie='passshare_session='+encodeURIComponent(a.sessionToken);
  const tokens=await Promise.all([fetch(base+'/api/auth/csrf',{headers:{Cookie:cookie}}),fetch(base+'/api/auth/csrf',{headers:{Cookie:cookie}})]);
  const t1=(await tokens[0].json()).csrfToken,t2=(await tokens[1].json()).csrfToken;
  assert.equal(t1,t2);
  const receipts=await Promise.all(['66666666-6666-4666-8666-666666666666','77777777-7777-4777-8777-777777777777'].map(requestId=>fetch(base+'/api/support-receipts',{method:'POST',headers:{Cookie:cookie+'; passshare_csrf='+t2,'X-CSRF-Token':t1,'content-type':'application/json'},body:JSON.stringify({...input,requestId})})));
  assert.equal(receipts.every(r=>r.status===201),true);
  await assert.rejects(load(b.sessionToken,other.id).get(row.id,signal),e=>(e as any).status===404);
  stripCsrf=true;await assert.rejects(api.create({...input,requestId:'44444444-4444-4444-8444-444444444444'},signal),e=>(e as any).status===403);stripCsrf=false;
  const abort=new AbortController();abort.abort();const before=calls;await assert.rejects(api.get(row.id,abort.signal));assert.equal(calls,before);
  failPost=true;const count=posts;await assert.rejects(api.create(input,signal));assert.equal(posts,count+1);failPost=false;
  switchOnCsrf=true;
  const switchedId='55555555-5555-4555-8555-555555555555';
  await assert.rejects(api.create({...input,requestId:switchedId},signal),e=>(e as any).status===401);
  switchOnCsrf=false;
  const freshB=load(b.sessionToken,other.id);
  const correct=await freshB.create({...input,requestId:switchedId},signal);
  assert.equal(correct.status,'received');
  assert.equal(correct.request.requestId,switchedId);
  await authStore.deleteSession(a.sessionId);await assert.rejects(api.get(row.id,signal),e=>(e as any).status===401);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
