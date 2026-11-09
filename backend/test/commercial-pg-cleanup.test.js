import assert from 'node:assert/strict';
import {once} from 'node:events';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import pg from 'pg';
import {trackPoolShutdown} from './helpers/pg-fixture-lifecycle.js';

test('fixture shutdown waits for actual connection termination before database drop', {skip:process.env.PASSSHARE_RECEIPTS_PG!=='true'}, async()=>{
 assert.match(process.env.DATABASE_URL,/^postgresql:\/\/passshare:passshare@127\.0\.0\.1:(5432|15431)\/passshare$/);
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL}),name='ps_cleanup_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE DATABASE '+name);
 const url=new URL(process.env.DATABASE_URL);url.pathname='/'+name;
 const pool=new pg.Pool({connectionString:url.href}),close=trackPoolShutdown(pool);
 let release,started,client,endDone,closing;
 const gate=new Promise(r=>{release=r;}),ending=new Promise(r=>{started=r;});
 try{
  client=await pool.connect();endDone=once(client,'end');
  const nativeEnd=client.end.bind(client);
  client.end=(...args)=>{started();return gate.then(()=>nativeEnd(...args));};
  const pid=(await client.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  client.release();
  let complete=false;closing=close().then(()=>{complete=true;});
  await ending;await nextTurn();
  assert.equal((await admin.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1',[pid])).rowCount,1,'transport is deliberately still connected');
  assert.equal(complete,false,'logical pool removal is not actual connection shutdown');
  release();await closing;await endDone;
  assert.equal((await admin.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1',[pid])).rowCount,0);
 }finally{
  release();await (closing??close());if(endDone)await endDone;
  await admin.query('DROP DATABASE '+name);await admin.end();
 }
});
