import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,writeFile,rm,link,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {createVerifiedExportSink,type VerifiedExportStore} from '../cloud/commercial-export-file-sink.ts';

async function fixture(run:(store:VerifiedExportStore,root:string)=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'passshare-export-sink-'));
 const store:VerifiedExportStore={read:async name=>{try{return new Uint8Array(await readFile(join(root,name)));}catch(e){if((e as any).code==='ENOENT')return null;throw e;}},publishNew:async(name,b,signal)=>{
  const temp=join(root,'.export-'+randomUUID());
  try{await writeFile(temp,b,{flag:'wx',mode:0o600});if(signal.aborted)throw signal.reason;await link(temp,join(root,name));}finally{await unlink(temp).catch((e:any)=>{if(e.code!=='ENOENT')throw e;});}
 }};
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
