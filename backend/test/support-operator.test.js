import assert from 'node:assert/strict';
import {test} from 'node:test';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/app.js';

test('authenticated owner consent and operator status are persistent and single use',{skip:process.env.PASSSHARE_RECEIPTS_PG!=='true'},async()=>{
 assert.match(process.env.DATABASE_URL,/^postgresql:\/\/passshare:passshare@127\.0\.0\.1:(5432|15431)\/passshare$/);
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
 const {app}=await createApp({pool});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base='http://127.0.0.1:'+server.address().port,actors=[];
 const call=async(path,token,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(base+path,{method,headers:{'content-type':'application/json','x-passshare-client':'mobile',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json().catch(()=>null)};};
 const signup=async()=>{const email='operator-fixture-'+randomUUID()+'@example.test';const r=await call('/api/auth/signup',null,{email,password:'synthetic-password123'});assert.equal(r.status,201);actors.push(r.body.user.id);return r.body;};
 try{
  const owner=await signup(),other=await signup(),operator=await signup();
  const token=owner.refreshToken,op=operator.refreshToken;
  const r=await call('/api/support-receipts',token,{requestId:randomUUID(),kind:'technical',version:'0.1.0',platform:'web',errorCode:''});assert.equal(r.status,201);const id=r.body.id;
  const auth='/api/support-receipts/'+id+'/authorization',consume='/api/support-receipts/'+id+'/operator-status';
  const grant={operatorId:operator.user.id,status:'in_progress',revision:0};
  assert.equal((await call(auth,token,grant)).status,403); // no operator enrolled
  // Restart with an explicit deployment operator ID; mailbox identity is irrelevant.
  process.env.PASSSHARE_SUPPORT_OPERATOR_IDS=operator.user.id;
  const {app:configured}=await createApp({pool});const nested=configured.listen(0,'127.0.0.1');await new Promise(r=>nested.once('listening',r));
  const run=async(path,t,b)=>{const response=await fetch('http://127.0.0.1:'+nested.address().port+path,{method:b===undefined?'GET':'POST',headers:{'content-type':'application/json','x-passshare-client':'mobile',...(t?{authorization:'Bearer '+t}:{})},body:b===undefined?undefined:JSON.stringify(b)});return {status:response.status,body:await response.json().catch(()=>null)};};
  try{
   assert.equal((await run(auth,null,grant)).status,401);
   assert.equal((await run(auth,other.refreshToken,grant)).status,403);
   const first=await run(auth,token,grant);assert.equal(first.status,201);
   assert.equal((await run(consume,op,{confirmation:'a'.repeat(43)})).status,403);
   assert.equal((await run(consume,op,{confirmation:first.body.confirmation,status:'resolved'})).status,400);
   assert.equal((await run(consume,other.refreshToken,{confirmation:first.body.confirmation})).status,403);
   await pool.query("UPDATE support_receipts SET operator_consent=jsonb_set(operator_consent,'{expiresAt}',to_jsonb((clock_timestamp()-interval '1 second')::text)) WHERE id=$1",[id]);
   assert.equal((await run(consume,op,{confirmation:first.body.confirmation})).status,403);
   const renewed=await run(auth,token,grant);assert.equal(renewed.status,201);
   assert.equal((await run(consume,op,{confirmation:first.body.confirmation})).status,403);
   const pair=await Promise.all([run(consume,op,{confirmation:renewed.body.confirmation}),run(consume,op,{confirmation:renewed.body.confirmation})]);assert.deepEqual(pair.map(r=>r.status).sort(),[200,403]);
   const read=await run('/api/support-receipts/'+id,token);assert.equal(read.body.status,'in_progress');assert.equal(read.body.revision,1);assert.equal(read.body.history.length,1);assert.equal(JSON.stringify(read.body).includes('operatorId'),false);
   assert.equal((await run(auth,token,grant)).status,409);
   const finalGrant=await run(auth,token,{...grant,status:'resolved',revision:1});assert.equal(finalGrant.status,201);
   await run('/api/auth/logout',op,{});
   assert.equal((await run(consume,op,{confirmation:finalGrant.body.confirmation})).status,401);
   const opLogin=await run('/api/auth/login',null,{email:operator.user.email,password:'synthetic-password123'});assert.equal(opLogin.status,200);
   await run('/api/auth/logout',token,{});
   assert.equal((await run(consume,opLogin.body.refreshToken,{confirmation:finalGrant.body.confirmation})).status,403);
   const login=await run('/api/auth/login',null,{email:owner.user.email,password:'synthetic-password123'});assert.equal(login.status,200);
   const final=await run(auth,login.body.refreshToken,{...grant,status:'resolved',revision:1});assert.equal(final.status,201);
   assert.equal((await run(consume,opLogin.body.refreshToken,{confirmation:final.body.confirmation})).status,200);
   assert.equal((await run(consume,opLogin.body.refreshToken,{confirmation:final.body.confirmation})).status,403);
   const durable=await call('/api/support-receipts/'+id,login.body.refreshToken);assert.equal(durable.body.history.length,2);assert.equal(durable.body.status,'resolved');
   const retired=await call('/api/auth/account',login.body.refreshToken,{currentPassword:'synthetic-password123',confirmationEmail:owner.user.email},'DELETE');assert.equal(retired.status,204);
   assert.equal((await pool.query('SELECT count(*)::int n FROM support_receipts WHERE id=$1',[id])).rows[0].n,0);
  }finally{nested.closeAllConnections();await new Promise(r=>nested.close(r));}
 }finally{delete process.env.PASSSHARE_SUPPORT_OPERATOR_IDS;server.closeAllConnections();await new Promise(r=>server.close(r));await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[actors]);await pool.end();}
});
