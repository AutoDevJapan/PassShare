import assert from 'node:assert/strict';
import {test} from 'node:test';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {CONTRACT_SCHEMA} from '../src/commercial-contracts.js';
import {migrateCommercialLive} from '../src/commercial-live.js';

test('upgrade the populated pre-disposition live schema without losing evidence', {skip:process.env.PASSSHARE_RECEIPTS_PG!=='true'}, async()=>{
 assert.match(process.env.DATABASE_URL,/^postgresql:\/\/passshare:passshare@127\.0\.0\.1:(5432|15431)\/passshare$/);
 const name='passshare_live_migr_'+randomUUID().replaceAll('-','');
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
 await admin.query('CREATE DATABASE '+name);
 const url=new URL(process.env.DATABASE_URL);url.pathname='/'+name;
 const pool=new pg.Pool({connectionString:url.href});
 try {
  await pool.query('CREATE TABLE users(id UUID PRIMARY KEY)');
  await pool.query(CONTRACT_SCHEMA);
  // Independent fixture for the schema shipped in the first PR candidate.
  await pool.query(`CREATE TABLE commercial_live_contracts (
   contract_id UUID PRIMARY KEY REFERENCES commercial_contracts(id) ON DELETE CASCADE,
   contract_start DATE NOT NULL, cancel_after_cycle INTEGER CHECK(cancel_after_cycle>=1),
   cancel_requested_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE commercial_live_periods (
   account_id TEXT NOT NULL,event_id TEXT NOT NULL,
   contract_id UUID NOT NULL REFERENCES commercial_live_contracts(contract_id) ON DELETE CASCADE,
   cycle INTEGER NOT NULL CHECK(cycle BETWEEN 1 AND 120),period_start DATE NOT NULL,
   period_end DATE NOT NULL CHECK(period_end>period_start),amount_jpy BIGINT NOT NULL CHECK(amount_jpy>0),
   provider_object_id TEXT NOT NULL,event_hash TEXT NOT NULL,
   evidence TEXT NOT NULL CHECK(evidence='provider_live'),received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   PRIMARY KEY(account_id,event_id),UNIQUE(contract_id,cycle),UNIQUE(account_id,provider_object_id));`);
  const owner=randomUUID(),contract=randomUUID();
  await pool.query('INSERT INTO users VALUES($1)',[owner]);
  await pool.query("INSERT INTO commercial_contracts(id,user_id,request_id,quote,quote_hash) VALUES($1,$2,$3,'{}',$4)",[contract,owner,randomUUID(),'a'.repeat(64)]);
  await pool.query("INSERT INTO commercial_live_contracts(contract_id,contract_start) VALUES($1,'2026-01-31')",[contract]);
  await pool.query("INSERT INTO commercial_live_periods(account_id,event_id,contract_id,cycle,period_start,period_end,amount_jpy,provider_object_id,event_hash,evidence) VALUES('acct_fixture','evt_fixture',$1,1,'2026-01-31','2026-02-28',980,'pi_fixture','original-hash','provider_live')",[contract]);
  const before=(await pool.query('SELECT * FROM commercial_live_periods')).rows[0];
  await assert.rejects(pool.query('SELECT disposition FROM commercial_live_periods'),{code:'42703'});
  await migrateCommercialLive(pool);
  await migrateCommercialLive(pool); // idempotent with populated evidence
  const {disposition,provider_event_created,disposition_reason,reconciled_at,...after}=(await pool.query('SELECT * FROM commercial_live_periods')).rows[0];
  assert.equal(provider_event_created,null);assert.equal(disposition_reason,'legacy_unclassified');assert.equal(reconciled_at,null);
  assert.equal(disposition,'effective');assert.deepEqual(after,before);
  await assert.rejects(pool.query("UPDATE commercial_live_periods SET disposition='unknown'"),{code:'23514'});
  await assert.rejects(pool.query('UPDATE commercial_live_periods SET disposition=NULL'),{code:'23502'});
  await pool.query("UPDATE commercial_live_periods SET disposition='refund_review'");
  await migrateCommercialLive(pool);
  assert.equal((await pool.query('SELECT disposition FROM commercial_live_periods')).rows[0].disposition,'refund_review');
 } finally {
  await pool.end();
  await admin.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)');
  await admin.end();
 }
});
