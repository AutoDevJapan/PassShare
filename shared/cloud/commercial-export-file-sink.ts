import type {AttachmentContext,AttachmentPlaintext,ItemContext} from './cloud-worker.ts';

// Implemented by a native/host adapter with atomic no-replace publication.
// A generic FileSystemDirectoryHandle cannot provide this ownership guarantee.
export interface VerifiedExportStore {
 read(name:string):Promise<Uint8Array|null>;
 publishNew(name:string,bytes:Uint8Array,signal:AbortSignal):Promise<void>;
 verified?(name:string,bytes:Uint8Array):void;
}
export function createVerifiedExportSink(store:VerifiedExportStore){
 const active=new Set<string>();
 const check=(signal:AbortSignal)=>{if(signal.aborted)throw signal.reason;};
 const same=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
 async function save(name:string,bytes:Uint8Array,signal:AbortSignal){
  check(signal);if(active.has(name))throw new Error('Export output is busy');active.add(name);
  const expected=bytes.slice();
  try{
   const prior=await store.read(name);
   if(prior!==null){try{check(signal);if(!same(prior,expected))throw new Error('Export output differs');store.verified?.(name,expected);return;}finally{prior.fill(0);}}
   check(signal);
   try{await store.publishNew(name,expected,signal);}catch(error){
    if((error as {code?:string})?.code!=='EEXIST'&&!(signal.aborted&&error===signal.reason))throw error;
    // Another writer may have committed the same deterministic output. Reconcile
    // by full bytes, never infer ownership from an empty file or erase its data.
    const actual=await store.read(name);
    if(actual===null)throw error;
    try{if(!same(actual,expected))throw error;}finally{actual.fill(0);}
   }
   const readback=await store.read(name);
   try{if(readback===null||!same(readback,expected))throw new Error('Export output verification failed');}
   finally{readback?.fill(0);}
   store.verified?.(name,expected);
  }finally{expected.fill(0);active.delete(name);}
 }
 const id=(v:string)=>{if(!/^[a-z0-9]{26}$/.test(v))throw new Error('Invalid export identity');return v;};
 const version=(v:number)=>{if(!Number.isSafeInteger(v)||v<1)throw new Error('Invalid export version');return v;};
 return {
  item:async(text:string,c:ItemContext,signal:AbortSignal)=>{const b=new TextEncoder().encode(text);try{await save(`item-${id(c.itemId)}-v${version(c.itemVersion)}.json`,b,signal);}finally{b.fill(0);}},
  attachment:async(file:AttachmentPlaintext,c:AttachmentContext,signal:AbortSignal)=>{
   const stem=`attachment-${id(c.itemId)}-${id(c.attachmentId)}-v${version(c.attachmentVersion)}`;
   const b=new TextEncoder().encode(JSON.stringify({name:file.name}));
   try{await save(`${stem}.name.json`,b,signal);await save(`${stem}.bin`,file.bytes,signal);}finally{b.fill(0);}
  },
 };
}
