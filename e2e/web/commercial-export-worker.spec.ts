import {test,expect} from '@playwright/test';

test('shared commercial export client passes nonempty ciphertext to the actual worker',async({page})=>{
 // A same-origin static document isolates this worker acceptance from the app's
 // unauthenticated-session logout effect, without disabling worker lock policy.
 await page.goto('/cloud-crypto/boot.mjs');
 const result=await page.evaluate(async()=>{
  const {CloudWorker}=await import('/src/lib/cloud-worker.ts');
  const {createCloudApi}=await import('/src/lib/cloud-api.ts');
  const boxId='a'.repeat(26),itemId='b'.repeat(26),ownerAccountId='11111111-1111-4111-8111-111111111111',contractId='22222222-2222-4222-8222-222222222222';
  const worker=new CloudWorker();
  try{
   await worker.ready;await worker.generate({passwordBoxId:boxId,ownerAccountId,keyEpoch:1});
   const context={passwordBoxId:boxId,itemId,itemVersion:1,keyEpoch:1};
   const plain={id:itemId,version:1,vault:{id:boxId},title:'架空export項目',fields:[{type:'CONCEALED',value:'synthetic-only'}],attachments:[]};
   const encrypted=await worker.encrypt(JSON.stringify(plain),context);
   const api=createCloudApi(async()=>Response.json({format:'passshare-encrypted-export-v1',receiptId:'33333333-3333-4333-8333-333333333333',boxId,keyEpoch:1,snapshotRevision:2,ciphertextOnly:true,restoresIdentityMembershipOrKeys:false,data:{envelopes:[JSON.parse(encrypted)],nextCursor:null,attachmentsIncluded:false}}));
   const page=await api.getCommercialExportPage(contractId,boxId,{keyEpoch:1,snapshotRevision:2},null,new AbortController().signal);
   const decrypted=JSON.parse(await worker.decrypt(JSON.stringify(page.envelopes[0]),context));
   let wrongContextRejected=false;
   try{await worker.decrypt(JSON.stringify(page.envelopes[0]),{...context,itemId:'c'.repeat(26)});}catch{wrongContextRejected=true;}
   const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
   return {matches:JSON.stringify(canonical(decrypted))===JSON.stringify(canonical(plain)),items:page.envelopes.length,wrongContextRejected};
  }finally{worker.dispose();await worker.closed;}
 });
 expect(result).toEqual({matches:true,items:1,wrongContextRejected:true});
});
