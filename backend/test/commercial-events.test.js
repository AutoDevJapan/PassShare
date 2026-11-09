import assert from 'node:assert/strict';import {test} from 'node:test';import express from 'express';import Stripe from 'stripe';import {commercialEventHandler} from '../src/commercial-events.js';
test('raw signed test events reject forged stale live wrong-account payloads before DB access',async()=>{
 const secret='whsec_synthetic_fixture_only',account='acct_synthetic',pool={connect(){throw Error('DB must not be reached');}};
 const app=express();app.use('/events',commercialEventHandler({pool,secret,account}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const event={id:'evt_synthetic',type:'payment_intent.succeeded',account,livemode:false,created:Math.floor(Date.now()/1000),data:{object:{object:'payment_intent',id:'pi_synthetic',status:'succeeded',currency:'jpy',amount:980,amount_received:980,livemode:false,metadata:{contractId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ownerId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',quoteHash:'a'.repeat(64)}}}};
 const send=async(e,override)=>{const payload=JSON.stringify(e);const signature=override??Stripe.webhooks.generateTestHeaderString({payload,secret});const r=await fetch('http://127.0.0.1:'+server.address().port+'/events',{method:'POST',headers:{'content-type':'application/json','stripe-signature':signature},body:payload});return r.status;};
 try{
  assert.equal(await send(event,'t=1,v1=forged'),400);
  assert.equal(await send(event,Stripe.webhooks.generateTestHeaderString({payload:JSON.stringify(event),secret,timestamp:1})),400);
  assert.equal(await send({...event,livemode:true}),400);
  assert.equal(await send({...event,account:'acct_other'}),400);
  assert.equal(await send({...event,data:{object:{...event.data.object,currency:'usd'}}}),400);
  assert.equal(await send({...event,type:'charge.refunded'}),400);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});