import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createVerifiedExportSink,type VerifiedExportStore} from '../cloud/commercial-export-file-sink.ts';

async function fixture(run:(store:VerifiedExportStore,root:string)=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'passshare-export-sink-'));
 const {createAtomicExportStore}=await import('../../scripts/atomic-export-store.mjs');
 const store:VerifiedExportStore=createAtomicExportStore(root);
 try{await run(store,root);}finally{await rm(root,{recursive:true});}
}
const context={passwordBoxId:'a'.repeat(26),itemId:'b'.repeat(26),itemVersion:1,keyEpoch:1};
const attachment={passwordBoxId:context.passwordBoxId,itemId:context.itemId,attachmentId:'c'.repeat(26),attachmentVersion:1,keyEpoch:1};

test('actual atomic file store persists and reads back Unicode metadata and all binary bytes',()=>fixture(async(store,root)=>{
 const sink=createVerifiedExportSink(store),s=new AbortController().signal;
 await sink.item('{"title":"架空"}',context,s);await sink.attachment({name:'日本語.bin',bytes:new Uint8Array([0,255,7])},attachment,s);
 await createVerifiedExportSink(store).attachment({name:'日本語.bin',bytes:new Uint8Array([0,255,7])},attachment,s);
 assert.equal(await readFile(join(root,`item-${context.itemId}-v1.json`),'utf8'),'{"title":"架空"}');
 assert.deepEqual([...await readFile(join(root,`attachment-${context.itemId}-${attachment.attachmentId}-v1.bin`))],[0,255,7]);
 await assert.rejects(sink.attachment({name:'日本語.bin',bytes:new Uint8Array([9])},attachment,s));
}));

test('concurrent external zero-byte output is never replaced',()=>fixture(async(store,root)=>{
 const publish=store.publishNew;store.publishNew=async(name,b,s)=>{await writeFile(join(root,name),new Uint8Array(),{flag:'wx'});await publish(name,b,s);};
 await assert.rejects(createVerifiedExportSink(store).item('{}',context,new AbortController().signal));
 assert.equal((await readFile(join(root,`item-${context.itemId}-v1.json`))).length,0);
}));

test('cancelled unpublished output can resume through a new sink without placeholders',()=>fixture(async(store)=>{
 const c=new AbortController();c.abort();await assert.rejects(createVerifiedExportSink(store).item('{}',context,c.signal));
 assert.equal(await store.read(`item-${context.itemId}-v1.json`),null);
 await createVerifiedExportSink(store).item('{}',context,new AbortController().signal);
 assert.equal(new TextDecoder().decode((await store.read(`item-${context.itemId}-v1.json`))!), '{}');
}));

test('committed close-time cancellation is reconciled by exact bytes',()=>fixture(async(store)=>{
 const c=new AbortController(),publish=store.publishNew;store.publishNew=async(n,b,s)=>{await publish(n,b,s);c.abort();throw c.signal.reason;};
 await createVerifiedExportSink(store).item('{}',context,c.signal);
 assert.equal(new TextDecoder().decode((await store.read(`item-${context.itemId}-v1.json`))!), '{}');
}));

test('host entry consumes items and attachment into real files and resumes without replacing external output',()=>fixture(async(store,root)=>{
 const {saveCommercialExport}=await import('../../scripts/save-commercial-export.ts');const {createCommercialExportProgress}=await import('../cloud/commercial-attachment-export.ts');
 const progress=createCommercialExportProgress();const body=new Uint8Array([0,255,7]);
 const api={getCommercialExportPage:async()=>({envelopes:[{context}],nextCursor:null,attachmentsIncluded:false}),getCommercialAttachmentItemSnapshot:async()=> 'parent',getCommercialEncryptedAttachment:async()=> 'body'};
 const worker={decrypt:async()=>JSON.stringify({id:context.itemId,attachments:[{attachmentId:attachment.attachmentId,attachmentVersion:1,keyEpoch:1}]}),decryptAttachment:async()=>({name:'日本語.bin',bytes:body.slice()}),releaseAttachment:(f:any)=>f.bytes.fill(0)};
 const result=await saveCommercialExport(root,api as any,worker as any,'contract',context.passwordBoxId,{keyEpoch:1,snapshotRevision:4},new AbortController().signal,progress);
 assert.deepEqual(result,{saved:true,snapshotRevision:4,items:1,attachments:1});
 assert.deepEqual([...await readFile(join(root,`attachment-${context.itemId}-${attachment.attachmentId}-v1.bin`))],[0,255,7]);
 await saveCommercialExport(root,api as any,worker as any,'contract',context.passwordBoxId,{keyEpoch:1,snapshotRevision:4},new AbortController().signal);
 const out=`item-${context.itemId}-v1.json`;await writeFile(join(root,out),new Uint8Array());
 await assert.rejects(saveCommercialExport(root,api as any,worker as any,'contract',context.passwordBoxId,{keyEpoch:1,snapshotRevision:4},new AbortController().signal));assert.equal((await store.read(out))!.length,0);
}));

test('cancelled host run resumes through a new store and new sink with the same snapshot',()=>fixture(async(_store,root)=>{
 const {saveCommercialExport}=await import('../../scripts/save-commercial-export.ts');const {createCommercialExportProgress}=await import('../cloud/commercial-attachment-export.ts');const progress=createCommercialExportProgress(),c=new AbortController();let stop=true;
 const api={getCommercialExportPage:async()=>({envelopes:[{context}],nextCursor:null,attachmentsIncluded:false}),getCommercialAttachmentItemSnapshot:async()=> 'parent',getCommercialEncryptedAttachment:async()=>{if(stop)c.abort();return 'body';}};
 const worker={decrypt:async()=>JSON.stringify({id:context.itemId,attachments:[{attachmentId:attachment.attachmentId,attachmentVersion:1,keyEpoch:1}]}),decryptAttachment:async()=>({name:'x',bytes:new Uint8Array([1,0,255])}),releaseAttachment:(f:any)=>f.bytes.fill(0)};
 await assert.rejects(saveCommercialExport(root,api as any,worker as any,'contract',context.passwordBoxId,{keyEpoch:1,snapshotRevision:4},c.signal,progress));stop=false;
 const done=await saveCommercialExport(root,api as any,worker as any,'contract',context.passwordBoxId,{keyEpoch:1,snapshotRevision:4},new AbortController().signal,progress);assert.equal(done.saved,true);assert.equal(done.attachments,1);assert.deepEqual([...await readFile(join(root,`attachment-${context.itemId}-${attachment.attachmentId}-v1.bin`))],[1,0,255]);
}));

test('published bytes do not hide a non-cancellation cleanup failure',()=>fixture(async(store)=>{
 const publish=store.publishNew;store.publishNew=async(n,b,s)=>{await publish(n,b,s);throw Object.assign(new Error('cleanup failed'),{code:'EACCES'});};
 await assert.rejects(createVerifiedExportSink(store).item('{}',context,new AbortController().signal),(e:any)=>e.code==='EACCES');
}));

test('create-new temp collision leaves the foreign temporary entry unchanged',()=>fixture(async(store,root)=>{
 const crypto=await import('node:crypto');const {syncBuiltinESMExports}=await import('node:module');const original=crypto.default.randomUUID;
 const fixed='11111111-1111-4111-8111-111111111111',temp=join(root,'.passshare-export-'+fixed+'.tmp');await writeFile(temp,'foreign');
 try{crypto.default.randomUUID=(()=>fixed) as any;syncBuiltinESMExports();const publish=store.publishNew(`item-${context.itemId}-v1.json`,new Uint8Array([1]),new AbortController().signal);if(process.platform==='win32')await publish;else await assert.rejects(publish);assert.equal(await readFile(temp,'utf8'),'foreign');}
 finally{crypto.default.randomUUID=original;syncBuiltinESMExports();}
}));
