import assert from 'node:assert/strict';import {test} from 'node:test';import pg from 'pg';import {randomUUID} from 'node:crypto';import {createApp} from '../src/app.js';
test('contract quotes are durable actor-bound and acceptance never grants paid access',{skip:process.env.PASSSHARE_RECEIPTS_PG!=='true'},async()=>{
 assert.match(process.env.DATABASE_URL,/^postgresql:\/\/passshare:passshare@127\.0\.0\.1:(5432|15431)\/passshare$/);
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});const actors=[],servers=[];
 const start=async()=>{const {app}=await createApp({pool});const s=app.listen(0,'127.0.0.1');await new Promise(r=>s.once('listening',r));servers.push(s);return 'http://127.0.0.1:'+s.address().port;};
 const base=await start();const call=async(path,token,body,url=base)=>{const r=await fetch(url+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-passshare-client':'mobile',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 try{
  for(let i=0;i<2;i++){const r=await call('/api/auth/signup',null,{email:'contract-'+randomUUID()+'@example.test',password:'synthetic-password123'});assert.equal(r.status,201);actors.push(r.body);}
  const [a,b]=actors,root='/api/commercial-contracts',input={requestId:randomUUID(),currency:'JPY',plan:{type:'personal',users:1},setup:{installationCompanies:0,supportHours:0,maintenanceMonthlyJpy:null}};
  assert.equal((await call(root,null,input)).status,401);
  assert.equal((await call(root,a.refreshToken,{...input,paid:true})).status,400);
  const pair=await Promise.all([call(root,a.refreshToken,input),call(root,a.refreshToken,input)]);assert.equal(pair[0].status,201);const row=pair[0].body;assert.equal(pair[1].body.id,row.id);assert.equal(row.state,'draft');
  assert.equal(row.quote.monthlyTotalJpy,980);
  for(const plan of [{type:'personal',users:0},{type:'personal',users:9007199254740991},{type:'team',administrators:0,members:1},{type:'personal',users:'1'}])assert.equal((await call(root,a.refreshToken,{...input,requestId:randomUUID(),plan})).status,400);
  assert.equal((await call(root+'/'+row.id,b.refreshToken)).status,404);
  assert.equal((await call(root,a.refreshToken,{...input,plan:{type:'personal',users:2}})).status,409);
  const accept=root+'/'+row.id+'/accept';assert.equal((await call(accept,b.refreshToken,{quoteHash:row.quoteHash})).status,404);
  assert.equal((await call(accept,a.refreshToken,{quoteHash:'0'.repeat(64)})).status,409);
  const accepted=await call(accept,a.refreshToken,{quoteHash:row.quoteHash});assert.equal(accepted.status,200);assert.equal(accepted.body.state,'accepted_unpaid');assert.equal(accepted.body.paid,false);assert.equal(accepted.body.entitlementsGranted,false);
  const retries=await Promise.all([call(accept,a.refreshToken,{quoteHash:row.quoteHash}),call(accept,a.refreshToken,{quoteHash:row.quoteHash})]);for(const retry of retries){assert.equal(retry.status,200);assert.equal(retry.body.acceptedAt,accepted.body.acceptedAt);}
  assert.equal((await call(accept,a.refreshToken,{quoteHash:row.quoteHash})).body.acceptedAt,accepted.body.acceptedAt);
  const restarted=await start();{const {providerTestPeriods,...again}=(await call(root+'/'+row.id,a.refreshToken,undefined,restarted)).body;assert.deepEqual(providerTestPeriods,[]);assert.deepEqual(again,accepted.body);}
  const pending=await call(root,a.refreshToken,{...input,requestId:randomUUID()});assert.equal(pending.status,201);
  await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE user_id=$1",[a.user.id]);
  const blocker=await pool.connect();let waitingRequest;
  try{
   await blocker.query('BEGIN');await blocker.query('SELECT id FROM commercial_contracts WHERE id=$1 FOR UPDATE',[pending.body.id]);
   waitingRequest=call(root+'/'+pending.body.id+'/accept',a.refreshToken,{quoteHash:pending.body.quoteHash});
   const deadline=Date.now()+5000;let waiting=false;
   while(Date.now()<deadline){const q=await pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM commercial_contracts WHERE id=%'");if(q.rows[0].n){waiting=true;break;}await new Promise(r=>setTimeout(r,10));}
   assert.equal(waiting,true,'acceptance must reach contract row lock before session expiry');
   await pool.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM (max(expires_at)-clock_timestamp())))+0.02) FROM sessions WHERE user_id=$1',[a.user.id]);
   await blocker.query('COMMIT');assert.equal((await waitingRequest).status,401);
   const unchanged=(await pool.query('SELECT state,accepted_at FROM commercial_contracts WHERE id=$1',[pending.body.id])).rows[0];assert.equal(unchanged.state,'draft');assert.equal(unchanged.accepted_at,null);
  }finally{await blocker.query('ROLLBACK');blocker.release();if(waitingRequest)await waitingRequest;await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '1 hour' WHERE user_id=$1",[a.user.id]);}
  const logout=await fetch(base+'/api/auth/logout',{method:'POST',headers:{authorization:'Bearer '+a.refreshToken,'x-passshare-client':'mobile'}});assert.equal(logout.status,204);
  assert.equal((await call(accept,a.refreshToken,{quoteHash:row.quoteHash})).status,401);
  await pool.query('DELETE FROM users WHERE id=$1',[a.user.id]);assert.equal((await pool.query('SELECT count(*)::int n FROM commercial_contracts WHERE id=$1',[row.id])).rows[0].n,0);
 }finally{for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[actors.map(a=>a.user.id)]);await pool.end();}
});

