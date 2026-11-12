import type {AttachmentContext,AttachmentPlaintext,ItemContext} from './cloud-worker.ts';

// The caller supplies the user-selected directory; this module never opens a picker.
// Stable ID names avoid traversal and filename collisions. Original names are saved as metadata.
export function createVerifiedExportSink(directory:FileSystemDirectoryHandle){
 const active=new Set<string>();
 const pending=new Map<string,FileSystemFileHandle>();
 const check=(signal:AbortSignal)=>{if(signal.aborted)throw signal.reason;};
 const same=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
 async function save(name:string,bytes:Uint8Array,signal:AbortSignal){
  check(signal);if(active.has(name))throw new Error('Export output is busy');active.add(name);
  const expected=bytes.slice();
  try{
   let existing:FileSystemFileHandle|undefined;
   try{existing=await directory.getFileHandle(name);}catch(error){if((error as DOMException).name!=='NotFoundError'&&(error as {code?:string}).code!=='ENOENT')throw error;}
   check(signal);
   if(existing){const prior=new Uint8Array(await (await existing.getFile()).arrayBuffer());try{if(same(prior,expected)){check(signal);pending.delete(name);return;}const owned=pending.get(name);if(prior.length!==0||!owned||!await existing.isSameEntry(owned))throw new Error('Export output differs');}finally{prior.fill(0);}}
   const file=existing??await directory.getFileHandle(name,{create:true});if(!existing)pending.set(name,file);check(signal);
   const writer=await file.createWritable({keepExistingData:true,mode:"exclusive"} as FileSystemCreateWritableOptions);let closed=false;
   try{check(signal);const current=new Uint8Array(await (await file.getFile()).arrayBuffer());try{if(current.length>0){if(!same(current,expected))throw new Error("Export output differs");await writer.abort();closed=true;return;}}finally{current.fill(0);}await writer.write(new Uint8Array(expected));check(signal);await writer.close();closed=true;}finally{if(!closed)await writer.abort().catch(()=>{});}
   const readback=new Uint8Array(await (await file.getFile()).arrayBuffer());
   try{if(!same(readback,expected))throw new Error('Export output verification failed');}finally{readback.fill(0);}
   pending.delete(name);
   // Close plus readback is a committed save even if abort arrived during close.
  }finally{expected.fill(0);active.delete(name);}
 }
 const id=(value:string)=>{if(!/^[a-z0-9]{26}$/.test(value))throw new Error('Invalid export identity');return value;};
 const version=(value:number)=>{if(!Number.isSafeInteger(value)||value<1)throw new Error('Invalid export version');return value;};
 return {
  item:async(text:string,context:ItemContext,signal:AbortSignal)=>{
   const bytes=new TextEncoder().encode(text);try{await save(`item-${id(context.itemId)}-v${version(context.itemVersion)}.json`,bytes,signal);}finally{bytes.fill(0);}
  },
  attachment:async(file:AttachmentPlaintext,context:AttachmentContext,signal:AbortSignal)=>{
   const stem=`attachment-${id(context.itemId)}-${id(context.attachmentId)}-v${version(context.attachmentVersion)}`;
   const metadata=new TextEncoder().encode(JSON.stringify({name:file.name}));
   try{await save(`${stem}.name.json`,metadata,signal);await save(`${stem}.bin`,file.bytes,signal);}finally{metadata.fill(0);}
  },
 };
}
