import type {CloudApi} from '../../../../shared/cloud/cloud-api.ts';
import type {CloudWorker} from '../../../../shared/cloud/cloud-worker.ts';
import {consumeCommercialBox,createCommercialExportProgress,type CommercialExportProgress} from '../../../../shared/cloud/commercial-attachment-export.ts';
import {createVerifiedExportSink} from '../../../../shared/cloud/commercial-export-file-sink.ts';
import {createNativeExportStore,type ExportInvoke} from './native-export-store.ts';
const destinations=new WeakMap<CommercialExportProgress,string>();
const interrupted=new WeakMap<CommercialExportProgress,Awaited<ReturnType<typeof createNativeExportStore>>>();
const identities=new WeakMap<CommercialExportProgress,string>();
const receipts=new WeakMap<CommercialExportProgress,Map<string,Promise<string>>>();
const activeSaves=new WeakSet<CommercialExportProgress>();
const digest=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new Uint8Array(bytes)))).map(b=>b.toString(16).padStart(2,"0")).join("");
export async function saveNativeCommercialExport(invoke:ExportInvoke,directory:string,api:CloudApi,worker:CloudWorker,contractId:string,boxId:string,pin:{keyEpoch:number;snapshotRevision:number},signal:AbortSignal,progress=createCommercialExportProgress()){
 if(activeSaves.has(progress))throw new Error('Native export progress is busy');
 activeSaves.add(progress);
 const lifecycle=new AbortController();const abort=()=>lifecycle.abort(signal.reason);signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();let finished=false;if(worker.closed)void worker.closed.then(()=>{if(!finished)lifecycle.abort(new Error("Cloud worker closed"));});
 const exportSignal=lifecycle.signal;
 let store:Awaited<ReturnType<typeof createNativeExportStore>>|undefined;let retain=false;let failure:unknown;let failed=false;
 try{
 const prior=destinations.get(progress);if(prior&&prior!==directory)throw new Error('Export progress belongs to another destination');destinations.set(progress,directory);
 const priorStore=interrupted.get(progress);if(priorStore){await priorStore.recover();await priorStore.close();interrupted.delete(progress);}
 store=await createNativeExportStore(invoke,directory,exportSignal);
 const activeStore=store;
 const identity=await activeStore.identity();if(exportSignal.aborted)throw exportSignal.reason;const priorIdentity=identities.get(progress);if(priorIdentity&&priorIdentity!==identity)throw new Error("Export destination identity changed");identities.set(progress,identity);const known=receipts.get(progress)??new Map<string,Promise<string>>();receipts.set(progress,known);for(const [name,hash] of known){const bytes=await activeStore.read(name);try{if(bytes===null||await digest(bytes)!==await hash)throw new Error("Completed export output is missing or changed");}finally{bytes?.fill(0);}}const verifiedStore={...activeStore,publishNew:async(name:string,bytes:Uint8Array,s:AbortSignal)=>{await activeStore.publishNew(name,bytes,s);},verified:(name:string,bytes:Uint8Array)=>{known.set(name,digest(bytes));}};const sink=createVerifiedExportSink(verifiedStore);await consumeCommercialBox(api,worker,contractId,boxId,pin,exportSignal,sink.item,sink.attachment,progress);await Promise.all(known.values());if(exportSignal.aborted)throw exportSignal.reason;return {saved:true,items:progress.items.size,attachments:progress.attachments.size};}catch(error){failed=true;failure=error;if(error instanceof Error&&"recoveryStore" in error){store=(error as Error&{recoveryStore:Awaited<ReturnType<typeof createNativeExportStore>>}).recoveryStore;retain=true;interrupted.set(progress,store);}if(error==="EXPORT_DRAIN_UNCONFIRMED"||error==="EXPORT_TREE_UNCONFIRMED"){retain=true;if(store)interrupted.set(progress,store);}throw error;}finally{try{finished=true;signal.removeEventListener("abort",abort);if(store&&!retain){try{await store.close();}catch(error){interrupted.set(progress,store);throw Object.assign(new Error("Native export cleanup unconfirmed"),{cause:error,operationError:failed?failure:undefined});}}}finally{activeSaves.delete(progress);}}
}
