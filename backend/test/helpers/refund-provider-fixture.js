import {createServer} from 'node:http';
import {createTestRefundLookup} from '../../src/commercial-refund-provider.js';

// Independent HTTP provider simulator. Its current state is controlled by the
// test separately from the signed webhook payload, and all credentials are fake.
export async function refundProviderFixture(account,scope='connect',options={}){
 const payments=new Map(),refunds=new Map(),requests=[],control={fail:false,pageSize:100};
 const server=createServer((req,res)=>{
  const u=new URL(req.url,'http://127.0.0.1');requests.push({method:req.method,path:u.pathname,account:req.headers['stripe-account']??null});
  const json=(status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data))};
  if(req.headers.authorization!=='Bearer rk_test_refund_http_fixture'||req.headers['stripe-account']!==account)return json(401,{error:{type:'authentication_error',message:'Fixture credentials required'}});
  if(control.fail)return json(503,{error:{type:'api_error',message:'Fixture unavailable'}});
  if(options.stateControl===true&&req.method==='POST'&&u.pathname==='/fixture/state'){
   const chunks=[];let size=0;
   req.on('data',chunk=>{size+=chunk.length;if(size<=65536)chunks.push(chunk)});
   req.on('end',()=>{try{if(size>65536)return json(413,{error:{message:'Fixture too large'}});const input=JSON.parse(Buffer.concat(chunks).toString());if(input.payment?.livemode!==false||input.payment?.currency!=='jpy'||!Array.isArray(input.refunds)||input.refunds.some(r=>r.payment_intent!==input.payment.id||r.currency!=='jpy'))return json(400,{error:{message:'Synthetic test scope required'}});payments.set(input.payment.id,input.payment);for(const r of input.refunds)refunds.set(r.id,r);return json(200,{fixtureStored:true})}catch{return json(400,{error:{message:'Invalid fixture'}})}});return;
  }
  if(req.method!=='GET')return json(405,{error:{message:'Read only fixture'}});
  if(u.pathname.startsWith('/v1/payment_intents/')){const p=payments.get(decodeURIComponent(u.pathname.slice('/v1/payment_intents/'.length)));return p?json(200,p):json(404,{error:{message:'Fixture payment not found'}})}
  if(u.pathname==='/v1/refunds'){
   const values=Array.from(refunds.values()).filter(r=>r.payment_intent===u.searchParams.get('payment_intent')).sort((a,b)=>a.id.localeCompare(b.id));
   const after=u.searchParams.get('starting_after'),index=after?values.findIndex(r=>r.id===after)+1:0;
   const count=Math.min(Number(u.searchParams.get('limit')),control.pageSize),data=values.slice(index,index+count);
   return json(200,{object:'list',data,has_more:index+data.length<values.length,url:'/v1/refunds'});
  }
  return json(404,{error:{message:'Unexpected fixture resource'}});
 });
 server.listen(options.port??0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 const fetchImpl=(target,options)=>{const u=new URL(target);if(u.origin!=='https://api.stripe.com')throw Error('Unexpected provider origin');return fetch(base+u.pathname+u.search,options)};
 return {payments,refunds,requests,control,lookup:createTestRefundLookup({key:'rk_test_refund_http_fixture',account,scope,fetchImpl}),fetchImpl,async close(){server.closeAllConnections();await new Promise(r=>server.close(r))}};
}
