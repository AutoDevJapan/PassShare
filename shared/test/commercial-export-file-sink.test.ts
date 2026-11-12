import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createVerifiedExportSink} from '../cloud/commercial-export-file-sink.ts';

test('real file sink reads back item and arbitrary attachment bytes and refuses changed replay',async()=>{
 const root=await mkdtemp(join(tmpdir(),'passshare-export-sink-'));
 const directory={
  getFileHandle:async(name:string,options?:{create?:boolean})=>{
   const path=join(root,name);if(!options?.create)await readFile(path);else await writeFile(path,new Uint8Array(),{flag:"wx"}).catch((e:any)=>{if(e.code!=="EEXIST")throw e;});
   return {
    getFile:async()=>{const b=await readFile(path);return {arrayBuffer:async()=>b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)};},
    createWritable:async()=>{
     let bytes=new Uint8Array();
     return {write:async(b:Uint8Array)=>{bytes=b.slice();},close:async()=>{await writeFile(path,bytes);},abort:async()=>{bytes.fill(0);}};
    },
   };
  },
 };
 try{
  const sink=createVerifiedExportSink(directory as any),signal=new AbortController().signal;
  const item={passwordBoxId:'a'.repeat(26),itemId:'b'.repeat(26),itemVersion:1,keyEpoch:2};const attachment={passwordBoxId:item.passwordBoxId,itemId:item.itemId,attachmentId:'c'.repeat(26),attachmentVersion:1,keyEpoch:2};
  await sink.item('{"title":"架空"}',item,signal);await sink.attachment({name:'日本語.bin',bytes:new Uint8Array([0,255,7])},attachment,signal);
  await sink.attachment({name:'日本語.bin',bytes:new Uint8Array([0,255,7])},attachment,signal);
  assert.equal(await readFile(join(root,`item-${item.itemId}-v1.json`),'utf8'),'{"title":"架空"}');
  assert.deepEqual([...await readFile(join(root,`attachment-${item.itemId}-${attachment.attachmentId}-v1.bin`))],[0,255,7]);
  await assert.rejects(sink.attachment({name:'日本語.bin',bytes:new Uint8Array([9])},attachment,signal));
 }finally{await rm(root,{recursive:true});}
});

test('cancel before save never opens a file',async()=>{
 const c=new AbortController();c.abort();let opens=0;const sink=createVerifiedExportSink({getFileHandle:async()=>{opens++;throw new Error('unexpected');}} as any);
 await assert.rejects(sink.item('{}',{passwordBoxId:'a'.repeat(26),itemId:'b'.repeat(26),itemVersion:1,keyEpoch:1},c.signal));assert.equal(opens,0);
});

test('failed close is not reported as verified persistence',async()=>{
 let aborts=0;const sink=createVerifiedExportSink({getFileHandle:async(_n:string,o?:{create?:boolean})=>{if(!o?.create)throw new DOMException('missing','NotFoundError');return {getFile:async()=>({arrayBuffer:async()=>new ArrayBuffer(0)}),createWritable:async()=>({write:async()=>{},close:async()=>{throw new Error('disk failure');},abort:async()=>{aborts++;}})};}} as any);
 await assert.rejects(sink.item('{}',{passwordBoxId:'a'.repeat(26),itemId:'b'.repeat(26),itemVersion:1,keyEpoch:1},new AbortController().signal));assert.equal(aborts,1);
});

test('file created after absence probe is preserved under exclusive writer recheck',async()=>{
 let opens=0,writes=0,aborts=0;const original=new Uint8Array([9]);
 const directory={getFileHandle:async()=>{opens++;if(opens===1)throw new DOMException('missing','NotFoundError');return {getFile:async()=>({arrayBuffer:async()=>original.slice().buffer}),createWritable:async(options:any)=>{assert.equal(options.mode,'exclusive');assert.equal(options.keepExistingData,true);return {write:async()=>{writes++;},close:async()=>{},abort:async()=>{aborts++;}};}};}};
 const sink=createVerifiedExportSink(directory as any);await assert.rejects(sink.item('{}',{passwordBoxId:'a'.repeat(26),itemId:'b'.repeat(26),itemVersion:1,keyEpoch:1},new AbortController().signal));assert.equal(writes,0);assert.equal(aborts,1);assert.deepEqual([...original],[9]);
});
