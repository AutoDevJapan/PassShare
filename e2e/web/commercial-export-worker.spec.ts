import {test,expect} from '@playwright/test';

test('shared commercial export client passes nonempty ciphertext to the actual worker',async({page})=>{
 // A same-origin static document isolates this worker acceptance from the app's
 // unauthenticated-session logout effect, without disabling worker lock policy.
 await page.goto('/cloud-crypto/boot.mjs');
 const result=await page.evaluate(async()=>{
  const {CloudWorker,CloudWorkerError}=await import('/src/lib/cloud-worker.ts');
  const {createCloudApi,consumeCommercialBox}=await import('/src/lib/cloud-api.ts');
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
   const liveBefore=!worker.isClosed;let wrongContextRejected=false;
   try{await worker.decrypt(JSON.stringify(page.envelopes[0]),{...context,itemId:'c'.repeat(26)});}catch(error){if(!(error instanceof CloudWorkerError))throw error;wrongContextRejected=true;}
   const liveAfter=!worker.isClosed;
   const after=JSON.parse(await worker.decrypt(JSON.stringify(page.envelopes[0]),context));
   const attachmentContext={passwordBoxId:boxId,itemId,attachmentId:'d'.repeat(26),attachmentVersion:1,keyEpoch:1};
   const originalBytes=new Uint8Array([0,1,254,255,7,0]);
   const attachment=await worker.encryptAttachment('添付.bin',originalBytes.slice(),attachmentContext);
   const parent={...plain,attachments:[{attachmentId:attachmentContext.attachmentId,attachmentVersion:1,keyEpoch:1}]};
   const parentEnvelope=await worker.encrypt(JSON.stringify(parent),context);
   const attachmentApi=createCloudApi(async path=>Response.json({format:'passshare-encrypted-export-v1',receiptId:'33333333-3333-4333-8333-333333333333',boxId,keyEpoch:1,snapshotRevision:2,ciphertextOnly:true,restoresIdentityMembershipOrKeys:false,data:JSON.parse(path.includes('attachment-snapshot')?parentEnvelope:attachment)}));
   const fetchedParent=await attachmentApi.getCommercialAttachmentItemSnapshot(contractId,context,2,new AbortController().signal);
   const fetchedAttachment=await attachmentApi.getCommercialEncryptedAttachment(contractId,attachmentContext,2,new AbortController().signal);
   const source={itemEnvelope:fetchedParent,expectedItemContext:context,itemSnapshotRevision:2,attachmentSnapshotRevision:2};
   const file=await worker.decryptAttachment(fetchedAttachment,attachmentContext,source);
   const attachmentMatches=file.name==='添付.bin'&&file.bytes.length===originalBytes.length&&file.bytes.every((b,i)=>b===originalBytes[i]);
   worker.releaseAttachment(file);
   let consumedItems=0,consumedAttachments=0;
   const bulkApi=createCloudApi(async path=>Response.json({format:'passshare-encrypted-export-v1',receiptId:'33333333-3333-4333-8333-333333333333',boxId,keyEpoch:1,snapshotRevision:2,ciphertextOnly:true,restoresIdentityMembershipOrKeys:false,data:path.includes('/attachments/')?JSON.parse(attachment):path.includes('attachment-snapshot')?JSON.parse(parentEnvelope):{envelopes:[JSON.parse(parentEnvelope)],nextCursor:null,attachmentsIncluded:false}}));
   await consumeCommercialBox(bulkApi,worker,contractId,boxId,{keyEpoch:1,snapshotRevision:2},new AbortController().signal,async text=>{if(JSON.parse(text).id!==itemId)throw new Error('item mismatch');consumedItems++;},async value=>{if(value.name!=='添付.bin'||!value.bytes.every((b,i)=>b===originalBytes[i])||value.bytes.length!==originalBytes.length)throw new Error('attachment mismatch');consumedAttachments++;});
   if(consumedItems!==1||consumedAttachments!==1||worker.isClosed)throw new Error('consumer incomplete');
   const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
   return {matches:JSON.stringify(canonical(decrypted))===JSON.stringify(canonical(plain)),afterMatches:JSON.stringify(canonical(after))===JSON.stringify(canonical(plain)),attachmentMatches,items:page.envelopes.length,wrongContextRejected,liveBefore,liveAfter};
  }finally{worker.dispose();await worker.closed;}
 });
 expect(result).toEqual({matches:true,afterMatches:true,attachmentMatches:true,items:1,wrongContextRejected:true,liveBefore:true,liveAfter:true});
});
