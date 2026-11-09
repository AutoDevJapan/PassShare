import assert from 'node:assert/strict';import {test} from 'node:test';import pg from 'pg';import {randomUUID} from 'node:crypto';
import {trackPoolShutdown} from './helpers/pg-fixture-lifecycle.js';
import {recordExport} from '../src/commercial-export-audit.js';
test('private audit reads serialize revocation and reject expiry after query waits',{skip:process.env.PASSSHARE_RECEIPTS_PG!=='true'},async()=>{
 assert.match(process.env.DATABASE_URL,/^postgresql:\/\/passshare:passshare@127\.0\.0\.1:(5432|15431)\/passshare$/);
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL}),name='ps_audit_read_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+name);
 const url=new URL(process.env.DATABASE_URL);url.pathname='/'+name;const pool=new pg.Pool({connectionString:url.href}),close=trackPoolShutdown(pool);
 const {createApp}=await import('../src/app.js');const {app}=await createApp({pool});const s=app.listen(0,'127.0.0.1');await new Promise(r=>s.once('listening',r));const base='http://127.0.0.1:'+s.address().port;
 const call=async(p,t,b)=>{const r=await fetch(base+p,{method:b===undefined?'GET':'POST',headers:{'content-type':'application/json','x-passshare-client':'mobile',...(t?{authorization:'Bearer '+t}:{})},body:b===undefined?undefined:JSON.stringify(b)});return {status:r.status,body:await r.json()};};
 const email='audit-read-'+randomUUID()+'@example.test',password='synthetic-password123';
 async function waitFor(predicate,label){for(let i=0;i<1000;i++){if(await predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error(label);}
 let blocker,pending;
 try{
  const signup=await call('/api/auth/signup',null,{email,password});assert.equal(signup.status,201);const a=signup.body;
  const q=await call('/api/commercial-contracts',a.refreshToken,{requestId:randomUUID(),currency:'JPY',plan:{type:'personal',users:1},setup:{installationCompanies:0,supportHours:0,maintenanceMonthlyJpy:null}});assert.equal(q.status,201);
  // Synthetic metadata fixture: actual ciphertext-export authorization is tested elsewhere.
  await recordExport(pool,{contractId:q.body.id,actorId:a.user.id,boxId:'a'.repeat(26),kind:'state',epoch:1,revision:1});
  const path='/api/commercial-contracts/'+q.body.id+'/export-events';
  assert.equal((await call(path,a.refreshToken)).body.events.length,1);
  const waitRead=()=>waitFor(async()=>!!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM commercial_export_events%'")).rowCount,'audit query did not reach the table lock');
  // Expire by the database clock while history is blocked. Never report empty success.
  await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '5 seconds' WHERE user_id=$1",[a.user.id]);
  blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query('LOCK TABLE commercial_export_events IN ACCESS EXCLUSIVE MODE');
  pending=call(path,a.refreshToken);await waitRead();
  await waitFor(async()=>!!(await pool.query('SELECT 1 FROM sessions WHERE user_id=$1 AND expires_at<=clock_timestamp()',[a.user.id])).rowCount,'session did not expire');
  await blocker.query('COMMIT');blocker.release();blocker=null;
  const expired=await pending;pending=null;assert.equal(expired.status,401);assert.equal(expired.body.events,undefined);
  // Block inside SQL after its statement snapshot exists, not merely at the
  // relation lock. This reproduces the stale-snapshot metadata exposure class.
  const login=await call('/api/auth/login',null,{email,password});assert.equal(login.status,200);
  await pool.query(`ALTER TABLE commercial_export_events RENAME TO fixture_audit_rows;
   CREATE FUNCTION fixture_audit_barrier() RETURNS boolean LANGUAGE plpgsql AS $$
   BEGIN PERFORM pg_advisory_xact_lock(4431737); RETURN true; END $$;
   CREATE VIEW commercial_export_events WITH (security_barrier=true) AS
   SELECT * FROM fixture_audit_rows WHERE fixture_audit_barrier();`);
  blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(4431737)');
  pending=call(path,login.body.refreshToken);await waitRead();
  let revoked=false;
  const revoke=pool.query('DELETE FROM sessions WHERE user_id=$1',[a.user.id]).then(()=>{revoked=true;});
  try{
   await waitFor(async()=>revoked||!!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'DELETE FROM sessions%'")).rowCount,'revocation did not settle or block');
   assert.equal(revoked,false,'session deletion must serialize with authorized audit read');
  }finally{await blocker.query('COMMIT');blocker.release();blocker=null;await revoke;}
  const read=await pending;pending=null;assert.equal(read.status,200);assert.equal(read.body.events.length,1);
  assert.equal((await call(path,login.body.refreshToken)).status,401);
 }finally{
  if(blocker){await blocker.query('ROLLBACK').catch(()=>{});blocker.release();}
  if(pending)await pending.catch(()=>{});
  s.closeAllConnections();await new Promise(r=>s.close(r));await close();await admin.query('DROP DATABASE '+name);await admin.end();
 }
});
