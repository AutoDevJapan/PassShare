import {trackPoolShutdown} from './helpers/pg-fixture-lifecycle.js';
import assert from 'node:assert/strict';import {test} from 'node:test';import pg from 'pg';import {randomUUID} from 'node:crypto';
import {CONTRACT_SCHEMA} from '../src/commercial-contracts.js';import {migrateCommercialEvents} from '../src/commercial-events.js';
test('ledger migration rejects pre-existing duplicate PaymentIntents atomically in an isolated database',{skip:process.env.PASSSHARE_RECEIPTS_PG!=='true'},async()=>{
 assert.match(process.env.DATABASE_URL,/^postgresql:\/\/passshare:passshare@127\.0\.0\.1:(5432|15431)\/passshare$/);
 const name='passshare_migr_'+randomUUID().replaceAll('-','');const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
 await admin.query('CREATE DATABASE '+name);const url=new URL(process.env.DATABASE_URL);url.pathname='/'+name;const pool=new pg.Pool({connectionString:url.href});const closePool=trackPoolShutdown(pool);
 try{
  await pool.query('CREATE TABLE users(id UUID PRIMARY KEY)');await pool.query(CONTRACT_SCHEMA);
  await pool.query('CREATE TABLE commercial_payment_events (account_id TEXT NOT NULL, event_id TEXT NOT NULL, contract_id UUID NOT NULL REFERENCES commercial_contracts(id) ON DELETE CASCADE, event_hash TEXT NOT NULL, event_type TEXT NOT NULL, provider_object_id TEXT NOT NULL, amount_jpy BIGINT NOT NULL, provider_created BIGINT NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(account_id,event_id))');
  const user=randomUUID(),contract=randomUUID();await pool.query('INSERT INTO users(id) VALUES($1)',[user]);
  await pool.query("INSERT INTO commercial_contracts(id,user_id,request_id,quote,quote_hash) VALUES($1,$2,$3,'{}'::jsonb,$4)",[contract,user,randomUUID(),'a'.repeat(64)]);
  for(const e of ['evt_one','evt_two'])await pool.query("INSERT INTO commercial_payment_events(account_id,event_id,contract_id,event_hash,event_type,provider_object_id,amount_jpy,provider_created) VALUES('acct_x',$1,$2,'h','payment_intent.succeeded','pi_same',980,1)",[e,contract]);
  await assert.rejects(migrateCommercialEvents(pool),{code:'23505'});
  const left=(await pool.query("SELECT to_regclass('commercial_paid_periods') p, to_regclass('commercial_payment_events_provider_object') i")).rows[0];
  assert.equal(left.p,null);assert.equal(left.i,null);
  await pool.query("DELETE FROM commercial_payment_events WHERE event_id='evt_two'");await migrateCommercialEvents(pool);
  assert.notEqual((await pool.query("SELECT to_regclass('commercial_paid_periods') p")).rows[0].p,null);
 }finally{await closePool();await admin.query('DROP DATABASE IF EXISTS '+name);await admin.end();}
});