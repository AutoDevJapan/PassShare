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
