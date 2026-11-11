import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createCloudApi} from '../cloud/cloud-api.ts';

const contract='11111111-1111-4111-8111-111111111111',box='a'.repeat(26);
const reply=(data:unknown)=>({format:'passshare-encrypted-export-v1',receiptId:'22222222-2222-4222-8222-222222222222',boxId:box,keyEpoch:2,snapshotRevision:3,ciphertextOnly:true,restoresIdentityMembershipOrKeys:false,data});
test('contract export uses authenticated transport and pins box, epoch and snapshot',async()=>{
 const calls:{path:string,init?:RequestInit}[]=[];
 const api=createCloudApi(async(path,init)=>{calls.push({path,init});return Response.json(reply({envelopes:[],nextCursor:null,attachmentsIncluded:false}));});
 const result=await api.getCommercialExportPage(contract,box,{keyEpoch:2,snapshotRevision:3},null,new AbortController().signal);
 assert.deepEqual(result,{envelopes:[],nextCursor:null,attachmentsIncluded:false});assert.equal(calls[0].path,`/api/commercial-contracts/${contract}/export/boxes/${box}/items?epoch=2&revision=3`);assert.equal(calls[0].init?.cache,'no-store');assert.equal(calls[0].init?.redirect,'error');
});
test('export refuses invalid selectors before send and denies remote failures without reflecting content',async()=>{
 let calls=0;const api=createCloudApi(async()=>{calls++;return Response.json({message:'private remote details'},{status:403});});
 await assert.rejects(api.getCommercialExportPage(contract,box,{keyEpoch:2,snapshotRevision:3},null,new AbortController().signal),(e:any)=>e.status===403&&!e.message.includes('private'));
 await assert.rejects(api.getCommercialExportPage('../wrong',box,{keyEpoch:2,snapshotRevision:3},null,new AbortController().signal));assert.equal(calls,1);
});
test('export rejects a different box or snapshot even when HTTP succeeds',async()=>{
 for(const changed of [{boxId:'b'.repeat(26)},{keyEpoch:4},{snapshotRevision:4},{ciphertextOnly:false},{restoresIdentityMembershipOrKeys:true}]){
  const api=createCloudApi(async()=>Response.json({...reply({envelopes:[],nextCursor:null,attachmentsIncluded:false}),...changed}));
  await assert.rejects(api.getCommercialExportPage(contract,box,{keyEpoch:2,snapshotRevision:3},null,new AbortController().signal));
 }
});
test('nonempty ciphertext pages preserve envelopes and reject duplicate or mismatched contexts',async()=>{
 const envelope={format:1,context:{passwordBoxId:box,itemId:'b'.repeat(26),itemVersion:1,keyEpoch:2},nonce:Buffer.alloc(24).toString('base64'),ciphertext:Buffer.alloc(16).toString('base64')};
 const api=createCloudApi(async()=>Response.json(reply({envelopes:[envelope],nextCursor:envelope.context.itemId,attachmentsIncluded:false})));
 assert.deepEqual((await api.getCommercialExportPage(contract,box,{keyEpoch:2,snapshotRevision:3},null,new AbortController().signal)).envelopes,[envelope]);
 for(const envelopes of [[envelope,envelope],[{...envelope,context:{...envelope.context,passwordBoxId:'c'.repeat(26)}}],[{...envelope,context:{...envelope.context,keyEpoch:3}}]]){
  const invalid=createCloudApi(async()=>Response.json(reply({envelopes,nextCursor:null,attachmentsIncluded:false})));
  await assert.rejects(invalid.getCommercialExportPage(contract,box,{keyEpoch:2,snapshotRevision:3},null,new AbortController().signal));
 }
});
test('an in-flight export keeps the snapshot selected when the request was sent',async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 const api=createCloudApi(async()=>{await gate;return Response.json(reply({envelopes:[],nextCursor:null,attachmentsIncluded:false}));});
 const pin={keyEpoch:2,snapshotRevision:3};const pending=api.getCommercialExportPage(contract,box,pin,null,new AbortController().signal);
 pin.keyEpoch=9;pin.snapshotRevision=10;release();assert.equal((await pending).nextCursor,null);
});
