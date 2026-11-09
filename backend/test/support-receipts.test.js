import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createApp} from '../src/app.js';
import {createMemoryAuthStore} from '../src/auth/index.js';
import {createMemoryStore} from '../src/store/memory-store.js';
for(const persistent of [false,...(process.env.PASSSHARE_RECEIPTS_PG==='true'?[true]:[])]) test('support receipts are idempotent, actor-bound and reject secret bodies '+(persistent?'PostgreSQL':'memory'),async()=>{
 if(persistent)assert.match(process.env.DATABASE_URL,/^postgresql:\/\/passshare:passshare@127\.0\.0\.1:(5432|15431)\/passshare$/);
 const pool=persistent?new pg.Pool({connectionString:process.env.DATABASE_URL}):null;
 const create=()=>createApp(persistent?{pool}:{pool:null,authStore:createMemoryAuthStore(),store:createMemoryStore()});
 const {app}=await create();
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base='http://127.0.0.1:'+server.address().port;
 const signup=async(email)=>{const r=await fetch(base+'/api/auth/signup',{method:'POST',headers:{'content-type':'application/json','x-passshare-client':'mobile'},body:JSON.stringify({email,password:'synthetic-password123'})});assert.equal(r.status,201);return (await r.json()).refreshToken;};
 try{
  const run=randomUUID();const a=await signup('receipt-a-'+run+'@example.test'),b=await signup('receipt-b-'+run+'@example.test');
  const body={requestId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',kind:'technical',version:'0.1.0',platform:'windows',errorCode:'PS019'};
  const post=async(value)=>fetch(base+'/api/support-receipts',{method:'POST',headers:{authorization:'Bearer '+a,'content-type':'application/json'},body:JSON.stringify(value)});
  const firstPair=await Promise.all([post(body),post(body)]);assert.equal(firstPair[0].status,201);const row=await firstPair[0].json();assert.equal((await firstPair[1].json()).id,row.id);
  const reordered={errorCode:body.errorCode,platform:body.platform,version:body.version,kind:body.kind,requestId:body.requestId.toUpperCase()};assert.equal((await (await post(reordered)).json()).id,row.id);
  assert.equal((await fetch(base+'/api/support-receipts/'+('-'.repeat(36)),{headers:{authorization:'Bearer '+a}})).status,404);
  const retries=await Promise.all([post(body),post(body)]);for(const retry of retries)assert.equal((await retry.json()).id,row.id);
  if(persistent){const {app:second}=await create();const restarted=second.listen(0,'127.0.0.1');await new Promise(r=>restarted.once('listening',r));try{const response=await fetch('http://127.0.0.1:'+restarted.address().port+'/api/support-receipts/'+row.id,{headers:{authorization:'Bearer '+a}});assert.equal(response.status,200);assert.equal((await response.json()).id,row.id);}finally{restarted.closeAllConnections();await new Promise(r=>restarted.close(r));}}
  assert.equal((await post({...body,kind:'refund'})).status,409);
  assert.equal((await post({...body,message:'secret'})).status,400);
  for(const value of [{nested:'never-store-secret'},['never-store-secret'],null,42,false]){const requestId=crypto.randomUUID();const rejected=await post({...body,requestId,errorCode:value});assert.equal(rejected.status,400);assert.equal((await rejected.text()).includes('never-store-secret'),false);if(persistent){const result=await pool.query('SELECT count(*)::int AS n FROM support_receipts WHERE request_id=\u00241',[requestId]);assert.equal(result.rows[0].n,0);}const corrected=await post({...body,requestId});assert.equal(corrected.status,201);if(persistent){const result=await pool.query('SELECT count(*)::int AS n FROM support_receipts WHERE request_id=\u00241',[requestId]);assert.equal(result.rows[0].n,1);}}
  assert.equal((await fetch(base+'/api/support-receipts/'+row.id,{headers:{authorization:'Bearer '+a}})).status,200);
  assert.equal((await fetch(base+'/api/support-receipts/'+row.id,{headers:{authorization:'Bearer '+b}})).status,404);
  // A claimed email identity or known receipt ID is not ownership proof.
  const forged=await fetch(base+'/api/support-receipts/'+row.id,{headers:{authorization:'Bearer '+b,'x-user-id':'receipt-a@example.test','x-forwarded-email':'receipt-a@example.test'}});
  assert.equal(forged.status,404);
  assert.equal((await forged.text()).includes(row.id),false);
  for(const claim of [{userId:'receipt-a@example.test'},{email:'receipt-a@example.test'},{receiptId:row.id},{status:'resolved'}]){
   const rejected=await fetch(base+'/api/support-receipts',{method:'POST',headers:{authorization:'Bearer '+b,'content-type':'application/json'},body:JSON.stringify({...body,...claim})});
   assert.equal(rejected.status,400);
  }
  const own=await fetch(base+'/api/support-receipts',{method:'POST',headers:{authorization:'Bearer '+b,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal(own.status,201);assert.notEqual((await own.json()).id,row.id);
  assert.equal((await fetch(base+'/api/support-receipts/'+row.id)).status,401);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));if(pool)await pool.end();}
});

test('memory receipt commit rechecks session and retirement purges receipts',async()=>{
 const store=createMemoryAuthStore();const user=await store.createUser({email:'receipt-race@example.test',passwordHash:'$argon2id$'+'a'.repeat(80)});
 const session=await store.createSession(user.id,user.password_hash);
 const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 store.supportReceipt(user.id,session.sessionId,id,()=>({id,userId:user.id}));
 await store.deleteSession(session.sessionId);
 assert.throws(()=>store.supportReceipt(user.id,session.sessionId,'late',()=>({id:'late'})),/Session/);
 const fresh=await store.createSession(user.id,user.password_hash);
 await store.retireAccount(user.id,fresh.sessionId,user.password_hash,user.email,{purgePrivateBoxes(){}});
 assert.throws(()=>store.findSupportReceipt(user.id,fresh.sessionId,id),/Session/);
});

test('logout after an awaited authentication snapshot cannot save a receipt',async()=>{
 const store=createMemoryAuthStore();const user=await store.createUser({email:'receipt-overlap@example.test',passwordHash:'$argon2id$'+'b'.repeat(80)});
 const session=await store.createSession(user.id,user.password_hash);
 let entered,release;const seen=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 const original=store.findSessionByToken.bind(store);
 store.findSessionByToken=async token=>{const snapshot=await original(token);entered();await gate;return snapshot;};
 const {app}=await createApp({pool:null,authStore:store,store:createMemoryStore()});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{
  const pending=fetch('http://127.0.0.1:'+server.address().port+'/api/support-receipts',{method:'POST',headers:{authorization:'Bearer '+session.sessionToken,'content-type':'application/json'},body:JSON.stringify({requestId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',kind:'technical',version:'0.1.0',platform:'web',errorCode:''})});
  await seen;await store.deleteSession(session.sessionId);release();assert.equal((await pending).status,401);
 }finally{release();server.closeAllConnections();await new Promise(r=>server.close(r));}
});

