import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTestRefundLookup} from '../src/commercial-refund-provider.js';
import {refundProviderFixture} from './helpers/refund-provider-fixture.js';

test('test-only provider lookup uses authenticated reads, exact account and complete pagination',async()=>{
 const account='acct_readerfixture',f=await refundProviderFixture(account);
 try{
  f.payments.set('pi_reader',{id:'pi_reader',object:'payment_intent',livemode:false,status:'succeeded',currency:'jpy',amount:980,amount_received:980});
  for(let i=0;i<3;i++)f.refunds.set('pyr_reader'+i,{id:'pyr_reader'+i,object:'refund',payment_intent:'pi_reader',status:'succeeded',amount:100,currency:'jpy',created:1});f.control.pageSize=2;
  const result=await f.lookup({account,paymentIntentId:'pi_reader'});assert.equal(result.account,account);assert.equal(result.refunds.length,3);assert.ok(f.requests.every(r=>r.method==='GET'&&r.account===account));assert.equal(f.requests.filter(r=>r.path==='/v1/refunds').length,2);
  const before=f.requests.length;assert.equal(await f.lookup({account:'acct_wrong',paymentIntentId:'pi_reader'}),null);assert.equal(f.requests.length,before);
  for(const key of ['sk_live_forbidden','rk_live_forbidden','pk_test_public',''])assert.equal(createTestRefundLookup({key,account,fetchImpl:()=>{throw Error('Must not send a request')}}),null);
  f.control.fail=true;assert.equal(await f.lookup({account,paymentIntentId:'pi_reader'}),null);f.control.fail=false;
  f.payments.get('pi_reader').livemode=true;assert.equal(await f.lookup({account,paymentIntentId:'pi_reader'}),null);
 }finally{await f.close()}
});

test('direct event format still binds provider reads to the configured account',async()=>{
 const account='acct_directreader',f=await refundProviderFixture(account,'direct');
 try{f.payments.set('pi_direct',{id:'pi_direct',object:'payment_intent',livemode:false,status:'succeeded',currency:'jpy',amount:980,amount_received:980});const r=await f.lookup({account,paymentIntentId:'pi_direct'});assert.deepEqual(r.refunds,[]);assert.ok(f.requests.every(r=>r.account===account))}finally{await f.close()}
});

test('restore-only private fixture seeds current truth independently of webhook delivery',async()=>{
 const account='acct_restorefixture',f=await refundProviderFixture(account,'connect',{stateControl:true});
 try{
  const payment={id:'pi_restore',object:'payment_intent',livemode:false,status:'succeeded',currency:'jpy',amount:980,amount_received:980};
  const refunds=[{id:'re_restore',object:'refund',payment_intent:payment.id,status:'failed',currency:'jpy',amount:400,created:1}];
  const response=await f.fetchImpl('https://api.stripe.com/fixture/state',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer rk_test_refund_http_fixture','stripe-account':account},body:JSON.stringify({payment,refunds})});assert.equal(response.status,200);
  const current=await f.lookup({account,paymentIntentId:payment.id});assert.equal(current.refunds[0].status,'failed');assert.equal(current.payment.amount_received,980);
 }finally{await f.close()}
});
