import type {AttachmentContext,AttachmentPlaintext,ItemContext} from './cloud-worker.ts';

// The caller supplies the user-selected directory; this module never opens a picker.
// Stable ID names avoid traversal and filename collisions. Original names are saved as metadata.
export function createVerifiedExportSink(directory:FileSystemDirectoryHandle){
 const active=new Set<string>();
 const check=(signal:AbortSignal)=>{if(signal.aborted)throw signal.reason;};
 const same=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
 async function save(name:string,bytes:Uint8Array,signal:AbortSignal){
  check(signal);if(active.has(name))throw new Error('Export output is busy');active.add(name);
  try{
   let existing:FileSystemFileHandle|undefined;
   try{existing=await directory.getFileHandle(name);}catch(error){if((error as DOMException).name!=='NotFoundError'&&(error as {code?:string}).code!=='ENOENT')throw error;}
   check(signal);
   if(existing){const prior=new Uint8Array(await (await existing.getFile()).arrayBuffer());try{if(!same(prior,bytes))throw new Error('Export output differs');check(signal);return;}finally{prior.fill(0);}}
   const file=await directory.getFileHandle(name,{create:true});check(signal);
   const writer=await file.createWritable();let closed=false;
   try{check(signal);await writer.write(new Uint8Array(bytes));check(signal);await writer.close();closed=true;}finally{if(!closed)await writer.abort().catch(()=>{});}
   const readback=new Uint8Array(await (await file.getFile()).arrayBuffer());
   try{if(!same(readback,bytes))throw new Error('Export output verification failed');}finally{readback.fill(0);}
   // Close plus readback is a committed save even if abort arrived during close.
  }finally{active.delete(name);}
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
