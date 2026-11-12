import type {CloudApi} from '../../../../shared/cloud/cloud-api.ts';
import type {CloudWorker} from '../../../../shared/cloud/cloud-worker.ts';
import {consumeCommercialBox,createCommercialExportProgress,type CommercialExportProgress} from '../../../../shared/cloud/commercial-attachment-export.ts';
import {createVerifiedExportSink} from '../../../../shared/cloud/commercial-export-file-sink.ts';
import {createNativeExportStore,type ExportInvoke} from './native-export-store.ts';
const destinations=new WeakMap<CommercialExportProgress,string>();
const identities=new WeakMap<CommercialExportProgress,string>();
const receipts=new WeakMap<CommercialExportProgress,Map<string,Promise<string>>>();
const digest=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new Uint8Array(bytes)))).map(b=>b.toString(16).padStart(2,"0")).join("");
export async function saveNativeCommercialExport(invoke:ExportInvoke,directory:string,api:CloudApi,worker:CloudWorker,contractId:string,boxId:string,pin:{keyEpoch:number;snapshotRevision:number},signal:AbortSignal,progress=createCommercialExportProgress()){
 const prior=destinations.get(progress);if(prior&&prior!==directory)throw new Error('Export progress belongs to another destination');destinations.set(progress,directory);
 const store=await createNativeExportStore(invoke,directory,signal);
 try{const identity=await store.identity();const priorIdentity=identities.get(progress);if(priorIdentity&&priorIdentity!==identity)throw new Error("Export destination identity changed");identities.set(progress,identity);const known=receipts.get(progress)??new Map<string,Promise<string>>();receipts.set(progress,known);for(const [name,hash] of known){const bytes=await store.read(name);try{if(bytes===null||await digest(bytes)!==await hash)throw new Error("Completed export output is missing or changed");}finally{bytes?.fill(0);}}const verifiedStore={...store,publishNew:async(name:string,bytes:Uint8Array,s:AbortSignal)=>{await store.publishNew(name,bytes,s);},verified:(name:string,bytes:Uint8Array)=>{known.set(name,digest(bytes));}};const sink=createVerifiedExportSink(verifiedStore);await consumeCommercialBox(api,worker,contractId,boxId,pin,signal,sink.item,sink.attachment,progress);await Promise.all(known.values());return {saved:true,items:progress.items.size,attachments:progress.attachments.size};}finally{await store.close();}
}
