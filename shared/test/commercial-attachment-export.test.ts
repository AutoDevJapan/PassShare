import assert from 'node:assert/strict';
import {test} from 'node:test';
import {consumeCommercialAttachment} from '../cloud/commercial-attachment-export.ts';

test('contract attachment caller pins scope and releases plaintext after consumer failure',async()=>{
 const item={passwordBoxId:'a'.repeat(26),itemId:'b'.repeat(26),itemVersion:1,keyEpoch:2};
 const attachment={passwordBoxId:item.passwordBoxId,itemId:item.itemId,attachmentId:'c'.repeat(26),attachmentVersion:1,keyEpoch:2};
 const file={name:'添付.bin',bytes:new Uint8Array([0,255,7])};let released=0;const calls:string[]=[];
 const api={getCommercialAttachmentItemSnapshot:async()=>{calls.push('parent');return 'parent';},getCommercialEncryptedAttachment:async()=>{calls.push('body');return 'body';}};
 const worker={decryptAttachment:async(envelope:any,context:any,source:any)=>{assert.equal(envelope,'body');assert.deepEqual(context,attachment);assert.equal(source.itemEnvelope,'parent');assert.equal(source.itemSnapshotRevision,4);assert.equal(source.attachmentSnapshotRevision,4);return file;},releaseAttachment:(value:any)=>{released++;value.bytes.fill(0);value.name='';}};
 await assert.rejects(consumeCommercialAttachment(api as any,worker as any,'11111111-1111-4111-8111-111111111111',item,attachment,4,new AbortController().signal,async value=>{assert.equal(value.name,'添付.bin');assert.deepEqual([...value.bytes],[0,255,7]);throw new Error('sink failed');}));
 assert.deepEqual(calls,['parent','body']);assert.equal(released,1);assert.deepEqual([...file.bytes],[0,0,0]);assert.equal(file.name,'');
});

test('attachment caller refuses cross-item scope before transport',async()=>{
 let calls=0;const api={getCommercialAttachmentItemSnapshot:async()=>{calls++;return '';},getCommercialEncryptedAttachment:async()=>{calls++;return '';}};
 const item={passwordBoxId:'a'.repeat(26),itemId:'b'.repeat(26),itemVersion:1,keyEpoch:2};
 await assert.rejects(consumeCommercialAttachment(api as any,{} as any,'contract',item,{passwordBoxId:item.passwordBoxId,itemId:'c'.repeat(26),attachmentId:'d'.repeat(26),attachmentVersion:1,keyEpoch:2},4,new AbortController().signal,async()=>{}),(e:any)=>e.status===400);
 assert.equal(calls,0);
});

test('cancellation while decrypting releases the returned file without delivering it',async()=>{
 const controller=new AbortController();let consumed=0,released=0;
 const item={passwordBoxId:'a'.repeat(26),itemId:'b'.repeat(26),itemVersion:1,keyEpoch:2};const attachment={passwordBoxId:item.passwordBoxId,itemId:item.itemId,attachmentId:'c'.repeat(26),attachmentVersion:1,keyEpoch:2};
 const file={name:'private',bytes:new Uint8Array([9])};
 const api={getCommercialAttachmentItemSnapshot:async()=>'',getCommercialEncryptedAttachment:async()=>''};
 const worker={decryptAttachment:async()=>{controller.abort();return file;},releaseAttachment:(v:any)=>{released++;v.bytes.fill(0);v.name='';}};
 await assert.rejects(consumeCommercialAttachment(api as any,worker as any,'contract',item,attachment,4,controller.signal,async()=>{consumed++;}));
 assert.equal(consumed,0);assert.equal(released,1);assert.equal(file.bytes[0],0);
});

test('attachment caller consumes a file successfully and then wipes it',async()=>{
 let consumed=0,released=0;const item={passwordBoxId:'a'.repeat(26),itemId:'b'.repeat(26),itemVersion:1,keyEpoch:2};const attachment={passwordBoxId:item.passwordBoxId,itemId:item.itemId,attachmentId:'c'.repeat(26),attachmentVersion:1,keyEpoch:2};const file={name:'a',bytes:new Uint8Array([9])};
 const api={getCommercialAttachmentItemSnapshot:async()=>'',getCommercialEncryptedAttachment:async()=>''};
 const worker={decryptAttachment:async()=>file,releaseAttachment:(v:any)=>{released++;v.bytes.fill(0);v.name='';}};
 await consumeCommercialAttachment(api as any,worker as any,'contract',item,attachment,4,new AbortController().signal,async v=>{assert.equal(v.bytes[0],9);consumed++;});
 assert.equal(consumed,1);assert.equal(released,1);assert.equal(file.bytes[0],0);
});

test('box consumer walks multiple pages and delivers item plus attachment under one snapshot',async()=>{
 const {consumeCommercialBox}=await import('../cloud/commercial-attachment-export.ts');
 const box='a'.repeat(26),ids=['b'.repeat(26),'c'.repeat(26)];const contexts=ids.map(itemId=>({passwordBoxId:box,itemId,itemVersion:1,keyEpoch:2}));
 const files:any[]=[],items:string[]=[],pins:number[]=[];let released=0;
 const api={getCommercialExportPage:async(_c:any,_b:any,p:any,after:any)=>{pins.push(p.snapshotRevision);const i=after===null?0:1;return {envelopes:[{context:contexts[i]}],nextCursor:i===0?ids[0]:null,attachmentsIncluded:false};},getCommercialAttachmentItemSnapshot:async()=> 'parent',getCommercialEncryptedAttachment:async()=> 'body'};
 const worker={decrypt:async(_e:any,c:any)=>JSON.stringify({id:c.itemId,attachments:c.itemId===ids[0]?[{attachmentId:'d'.repeat(26),attachmentVersion:1,keyEpoch:2}]:[]}),decryptAttachment:async()=>({name:'添付',bytes:new Uint8Array([0,255])}),releaseAttachment:(v:any)=>{released++;v.bytes.fill(0);}};
 await consumeCommercialBox(api as any,worker as any,'contract',box,{keyEpoch:2,snapshotRevision:4},new AbortController().signal,async text=>{items.push(JSON.parse(text).id);},async file=>{files.push([...file.bytes]);});
 assert.deepEqual(items,ids);assert.deepEqual(files,[[0,255]]);assert.deepEqual(pins,[4,4]);assert.equal(released,1);
});

test('rate-limited GET retries without repeating already delivered items',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const {consumeCommercialBox}=await import('../cloud/commercial-attachment-export.ts');const {CloudApiError}=await import('../cloud/cloud-api.ts');
 const item={passwordBoxId:'a'.repeat(26),itemId:'b'.repeat(26),itemVersion:1,keyEpoch:2};let bodyCalls=0,items=0,files=0;let limited!:()=>void;const reached=new Promise<void>(r=>{limited=r;});
 const api={getCommercialExportPage:async()=>({envelopes:[{context:item}],nextCursor:null,attachmentsIncluded:false}),getCommercialAttachmentItemSnapshot:async()=>'',getCommercialEncryptedAttachment:async()=>{bodyCalls++;if(bodyCalls===1){limited();throw new CloudApiError(429);}return '';}};
 const worker={decrypt:async()=>JSON.stringify({attachments:[{attachmentId:'c'.repeat(26),attachmentVersion:1,keyEpoch:2}]}),decryptAttachment:async()=>({name:'x',bytes:new Uint8Array([1])}),releaseAttachment:(v:any)=>v.bytes.fill(0)};
 const pending=consumeCommercialBox(api as any,worker as any,'contract',item.passwordBoxId,{keyEpoch:2,snapshotRevision:4},new AbortController().signal,async()=>{items++;},async()=>{files++;});
 await reached;await Promise.resolve();await Promise.resolve();t.mock.timers.tick(61000);await pending;
 assert.equal(bodyCalls,2);assert.equal(items,1);assert.equal(files,1);
});

test('rate limit wait is cancellable and never retries after abort',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const {consumeCommercialBox}=await import('../cloud/commercial-attachment-export.ts');const {CloudApiError}=await import('../cloud/cloud-api.ts');const controller=new AbortController();let calls=0,limited!:()=>void;const reached=new Promise<void>(r=>{limited=r;});
 const api={getCommercialExportPage:async()=>{calls++;limited();throw new CloudApiError(429);}};
 const pending=consumeCommercialBox(api as any,{} as any,'contract','a'.repeat(26),{keyEpoch:2,snapshotRevision:4},controller.signal,async()=>{},async()=>{});
 await reached;await Promise.resolve();controller.abort();await assert.rejects(pending);t.mock.timers.tick(61000);assert.equal(calls,1);
});

test('abort wipes plaintext immediately but waits for outstanding sink completion',async()=>{
 const controller=new AbortController();let started!:()=>void,finish!:()=>void;const sinkStarted=new Promise<void>(r=>{started=r;});const sinkFinished=new Promise<void>(r=>{finish=r;});let releases=0,settled=false;const file={name:'private',bytes:new Uint8Array([7])};const item={passwordBoxId:'a'.repeat(26),itemId:'b'.repeat(26),itemVersion:1,keyEpoch:2};const attachment={passwordBoxId:item.passwordBoxId,itemId:item.itemId,attachmentId:'c'.repeat(26),attachmentVersion:1,keyEpoch:2};
 const api={getCommercialAttachmentItemSnapshot:async()=>'',getCommercialEncryptedAttachment:async()=>''};const worker={decryptAttachment:async()=>file,releaseAttachment:(v:any)=>{releases++;v.name='';v.bytes.fill(0);}};
 const pending=consumeCommercialAttachment(api as any,worker as any,'contract',item,attachment,4,controller.signal,async(_file,signal)=>{assert.equal(signal,controller.signal);started();await sinkFinished;});
 void pending.then(()=>{settled=true;},()=>{settled=true;});await sinkStarted;controller.abort();await Promise.resolve();assert.equal(file.bytes[0],0);assert.equal(settled,false);finish();await assert.rejects(pending);assert.equal(releases,1);assert.equal(settled,true);
});
test('same-snapshot progress resumes after worker lock without redelivering completed sinks',async()=>{
 const {consumeCommercialBox,createCommercialExportProgress}=await import('../cloud/commercial-attachment-export.ts');const progress=createCommercialExportProgress();const box='a'.repeat(26),id='b'.repeat(26),refs=[{attachmentId:'c'.repeat(26),attachmentVersion:1,keyEpoch:2},{attachmentId:'d'.repeat(26),attachmentVersion:1,keyEpoch:2}];let locked=true,items=0;const files:string[]=[];
 const api={getCommercialExportPage:async()=>({envelopes:[{context:{passwordBoxId:box,itemId:id,itemVersion:1,keyEpoch:2}}],nextCursor:null,attachmentsIncluded:false}),getCommercialAttachmentItemSnapshot:async()=>'',getCommercialEncryptedAttachment:async()=>''};
 const worker={decrypt:async()=>JSON.stringify({attachments:refs}),decryptAttachment:async(_e:any,c:any)=>{if(locked&&c.attachmentId===refs[1].attachmentId)throw new Error('worker locked');return {name:c.attachmentId,bytes:new Uint8Array([1])};},releaseAttachment:(f:any)=>f.bytes.fill(0)};
 const run=(revision=4)=>consumeCommercialBox(api as any,worker as any,'contract',box,{keyEpoch:2,snapshotRevision:revision},new AbortController().signal,async()=>{items++;},async file=>{files.push(file.name);},progress);
 await assert.rejects(run());assert.equal(items,1);assert.deepEqual(files,[refs[0].attachmentId]);locked=false;await run();assert.equal(items,1);assert.deepEqual(files,refs.map(r=>r.attachmentId));await assert.rejects(run(5),(e:any)=>e.status===409);
});

test('successful sink is checkpointed even if it aborts before returning',async()=>{
 const {consumeCommercialBox,createCommercialExportProgress}=await import('../cloud/commercial-attachment-export.ts');const progress=createCommercialExportProgress();const c=new AbortController(),box='a'.repeat(26),itemId='b'.repeat(26);let calls=0;
 const api={getCommercialExportPage:async()=>({envelopes:[{context:{passwordBoxId:box,itemId,itemVersion:1,keyEpoch:2}}],nextCursor:null,attachmentsIncluded:false})};const worker={decrypt:async()=>JSON.stringify({attachments:[]})};
 await assert.rejects(consumeCommercialBox(api as any,worker as any,'contract',box,{keyEpoch:2,snapshotRevision:4},c.signal,async()=>{calls++;c.abort();},async()=>{},progress));
 await consumeCommercialBox(api as any,worker as any,'contract',box,{keyEpoch:2,snapshotRevision:4},new AbortController().signal,async()=>{calls++;},async()=>{},progress);assert.equal(calls,1);
});
