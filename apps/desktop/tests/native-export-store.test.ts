import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createNativeExportStore} from '../src/lib/native-export-store.ts';
test('native output session binds destination and preserves existing-file classification',async()=>{
 const calls:Array<{command:string;args:any}>=[];const invoke=async(command:string,args:any)=>{calls.push({command,args});if(command==='commercial_export_open')return 'owned-session';if(command==='commercial_export_read')return [0,255,1];if(command==='commercial_export_publish')throw 'EXPORT_EXISTS';};
 const store=await createNativeExportStore(invoke,'C:/selected',new AbortController().signal);
 assert.deepEqual([...(await store.read('item-a-v1.json'))!],[0,255,1]);
 await assert.rejects(store.publishNew('item-a-v1.json',new Uint8Array([9]),new AbortController().signal),(e:any)=>e.code==='EEXIST');
 assert.equal(calls[1].args.sessionId,'owned-session');assert.equal('directory' in calls[1].args,false);await store.close();
});
test('cancelled native export never opens a destination',async()=>{let calls=0;const c=new AbortController();c.abort('cancel');await assert.rejects(createNativeExportStore(async()=>{calls++;},'C:/selected',c.signal));assert.equal(calls,0);});

test('close waits for an owned in-flight publish before releasing its session',async()=>{
 let release!:()=>void;const wait=new Promise<void>(r=>release=r);let publishing=false,closed=false;
 const store=await createNativeExportStore(async(command)=>{if(command==='commercial_export_open')return 'owned';if(command==='commercial_export_publish'){publishing=true;await wait;publishing=false;return;}if(command==='commercial_export_close'){assert.equal(publishing,false);closed=true;}},'C:/selected',new AbortController().signal);
 const writing=store.publishNew('item-a-v1.json',new Uint8Array([1]),new AbortController().signal);await Promise.resolve();const closing=store.close();await Promise.resolve();assert.equal(closed,false);release();await writing;await closing;assert.equal(closed,true);
});

test('committed native publish remains readable for success reconciliation after cancel',async()=>{
 const c=new AbortController();let stored:number[]|null=null;
 const store=await createNativeExportStore(async(command,args)=>{if(command==='commercial_export_open')return 'owned';if(command==='commercial_export_publish'){stored=args.bytes as number[];c.abort('cancel-after-commit');return;}if(command==='commercial_export_read')return stored;},'C:/selected',c.signal);
 await store.publishNew('item-a-v1.json',new Uint8Array([0,255]),c.signal);assert.deepEqual([...(await store.read('item-a-v1.json'))!],[0,255]);await store.close();
});
import {saveNativeCommercialExport} from '../src/lib/save-native-commercial-export.ts';
import {createCommercialExportProgress} from '../../../shared/cloud/commercial-attachment-export.ts';
test('native consumer delivers item and attachment once and verifies completed output on resume',async()=>{
 const files=new Map<string,number[]>();let sends=0,closed=0;const invoke=async(command:string,args:any)=>{if(command==='commercial_export_open')return 'session';if(command==='commercial_export_identity')return 'volume:fileA';if(command==='commercial_export_close'){closed++;return;}if(command==='commercial_export_read')return files.get(args.name)??null;if(command==='commercial_export_publish'){sends++;files.set(args.name,[...args.bytes]);}};
 const box='a'.repeat(26),item='b'.repeat(26),attachment='c'.repeat(26);const api={getCommercialExportPage:async()=>({envelopes:[{context:{passwordBoxId:box,itemId:item,itemVersion:1,keyEpoch:1}}],nextCursor:null}),getCommercialAttachmentItemSnapshot:async()=> 'parent',getCommercialEncryptedAttachment:async()=> 'encrypted'};const worker={decrypt:async()=>JSON.stringify({id:item,attachments:[{attachmentId:attachment,attachmentVersion:1,keyEpoch:1}]}),decryptAttachment:async()=>({name:'日本語.bin',bytes:new Uint8Array([0,255])}),releaseAttachment:(file:any)=>file.bytes.fill(0)};
 const progress=createCommercialExportProgress();await saveNativeCommercialExport(invoke,'C:/selected',api as any,worker as any,'contract',box,{keyEpoch:1,snapshotRevision:2},new AbortController().signal,progress);assert.equal(sends,3);assert.equal(closed,1);assert.deepEqual(files.get(`attachment-${item}-${attachment}-v1.bin`),[0,255]);
 await saveNativeCommercialExport(invoke,'C:/selected',api as any,worker as any,'contract',box,{keyEpoch:1,snapshotRevision:2},new AbortController().signal,progress);assert.equal(sends,3);files.delete(`item-${item}-v1.json`);await assert.rejects(saveNativeCommercialExport(invoke,'C:/selected',api as any,worker as any,'contract',box,{keyEpoch:1,snapshotRevision:2},new AbortController().signal,progress));
});

test('expired native session after commit does not report saved success or retry the publisher',async()=>{
 let sends=0;const store=await createNativeExportStore(async(command)=>{if(command==='commercial_export_open')return 'session';if(command==='commercial_export_identity')return 'volume:fileA';if(command==='commercial_export_publish'){sends++;throw 'EXPORT_COMMITTED_SESSION_EXPIRED';}},'C:/selected',new AbortController().signal);
 await assert.rejects(store.publishNew('item-a-v1.json',new Uint8Array([1]),new AbortController().signal));assert.equal(sends,1);await store.close();
});

test('same directory path with another native identity cannot receive resumed output',async()=>{
 let identity='volume:A',sends=0;const files=new Map<string,number[]>();const invoke=async(command:string,args:any)=>{if(command==='commercial_export_open')return 'session';if(command==='commercial_export_identity')return identity;if(command==='commercial_export_read')return files.get(args.name)??null;if(command==='commercial_export_publish'){sends++;files.set(args.name,[...args.bytes]);}};
 const box='a'.repeat(26),item='b'.repeat(26),progress=createCommercialExportProgress();const api={getCommercialExportPage:async()=>({envelopes:[{context:{passwordBoxId:box,itemId:item,itemVersion:1,keyEpoch:1}}],nextCursor:null})};const worker={decrypt:async()=>JSON.stringify({id:item,attachments:[]})};
 await saveNativeCommercialExport(invoke,'C:/selected',api as any,worker as any,'contract',box,{keyEpoch:1,snapshotRevision:2},new AbortController().signal,progress);assert.equal(sends,1);identity='volume:B';await assert.rejects(saveNativeCommercialExport(invoke,'C:/selected',api as any,worker as any,'contract',box,{keyEpoch:1,snapshotRevision:2},new AbortController().signal,progress),/identity changed/);assert.equal(sends,1);
});

test('unconfirmed native drain retains session and prevents retry on the same progress',async()=>{
 let sends=0,closes=0;const invoke=async(command:string)=>{if(command==='commercial_export_open')return 'session';if(command==='commercial_export_identity')return 'volume:A';if(command==='commercial_export_read')return null;if(command==='commercial_export_publish'){sends++;throw 'EXPORT_DRAIN_UNCONFIRMED';}if(command==='commercial_export_close'){closes++;}};
 const box='a'.repeat(26),item='b'.repeat(26),progress=createCommercialExportProgress();const api={getCommercialExportPage:async()=>({envelopes:[{context:{passwordBoxId:box,itemId:item,itemVersion:1,keyEpoch:1}}],nextCursor:null})};const worker={decrypt:async()=>JSON.stringify({id:item,attachments:[]})};
 for(let n=0;n<2;n++)await assert.rejects(saveNativeCommercialExport(invoke,'C:/selected',api as any,worker as any,'contract',box,{keyEpoch:1,snapshotRevision:2},new AbortController().signal,progress));assert.equal(sends,1);assert.equal(closes,0);
});

test('owned uncertain session recovers before normal same-progress resume',async()=>{
 let recovered=false,sends=0,closes=0;const files=new Map<string,number[]>();const invoke=async(command:string,args:any)=>{if(command==='commercial_export_open')return 'session';if(command==='commercial_export_identity')return 'volume:A';if(command==='commercial_export_recover'){recovered=true;return true;}if(command==='commercial_export_close'){closes++;return;}if(command==='commercial_export_read')return files.get(args.name)??null;if(command==='commercial_export_publish'){sends++;if(!recovered)throw 'EXPORT_DRAIN_UNCONFIRMED';files.set(args.name,[...args.bytes]);}};
 const box='a'.repeat(26),item='b'.repeat(26),progress=createCommercialExportProgress();const api={getCommercialExportPage:async()=>({envelopes:[{context:{passwordBoxId:box,itemId:item,itemVersion:1,keyEpoch:1}}],nextCursor:null})};const worker={decrypt:async()=>JSON.stringify({id:item,attachments:[]})};
 await assert.rejects(saveNativeCommercialExport(invoke,'C:/selected',api as any,worker as any,'contract',box,{keyEpoch:1,snapshotRevision:2},new AbortController().signal,progress));assert.equal(closes,0);const result=await saveNativeCommercialExport(invoke,'C:/selected',api as any,worker as any,'contract',box,{keyEpoch:1,snapshotRevision:2},new AbortController().signal,progress);assert.equal(result.saved,true);assert.equal(sends,2);assert.equal(recovered,true);assert.equal(closes,2);
});

test('completed progress cannot report success after cancellation during identity read',async()=>{const c=new AbortController(),progress=createCommercialExportProgress();progress.completed=true;const invoke=async(command:string)=>{if(command==='commercial_export_open')return 's';if(command==='commercial_export_identity'){c.abort('cancel');return 'volume:A';}};await assert.rejects(saveNativeCommercialExport(invoke,'C:/selected',{} as any,{} as any,'contract','a'.repeat(26),{keyEpoch:1,snapshotRevision:2},c.signal,progress));});

test('abort while native open is pending still sends cancel and closes after response',async()=>{let release!:(v:string)=>void;const wait=new Promise<string>(r=>release=r),calls:string[]=[];const c=new AbortController();const opening=createNativeExportStore(async command=>{calls.push(command);if(command==='commercial_export_open')return await wait;},'C:/selected',c.signal);c.abort('cancel');release('owned');await assert.rejects(opening);assert.deepEqual(calls,['commercial_export_open','commercial_export_cancel','commercial_export_close']);});
test('cancel IPC rejection does not prevent close or replace original cancellation',async()=>{const c=new AbortController(),calls:string[]=[];const store=await createNativeExportStore(async command=>{calls.push(command);if(command==='commercial_export_open')return 'owned';if(command==='commercial_export_cancel')throw 'CANCEL_TRANSPORT';},'C:/selected',c.signal);c.abort('original');await store.close();assert.equal(calls.at(-1),'commercial_export_close');});
