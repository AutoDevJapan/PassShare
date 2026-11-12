import type {VerifiedExportStore} from '../../../../shared/cloud/commercial-export-file-sink.ts';
export type ExportInvoke=(command:string,args:Record<string,unknown>)=>Promise<unknown>;
export async function createNativeExportStore(invoke:ExportInvoke,directory:string,signal:AbortSignal):Promise<VerifiedExportStore&{identity():Promise<string>;recover():Promise<void>;close():Promise<void>}>{
 const check=()=>{if(signal.aborted)throw signal.reason;};check();
 const sessionId=await invoke('commercial_export_open',{directory});
 if(typeof sessionId!=='string'||!sessionId)throw new Error('Native export session unavailable');
 let cancelTask:Promise<unknown>|undefined;const cancel=()=>{cancelTask??=invoke("commercial_export_cancel",{sessionId});void cancelTask.catch(()=>{});};signal.addEventListener("abort",cancel,{once:true});
 let uncertain=false;let closed=false,closing:Promise<void>|undefined;const active=new Set<Promise<unknown>>();
 const current=()=>{if(closed)throw new Error('Native export session closed');};
 const call=(command:string,args:Record<string,unknown>)=>{current();const task=invoke(command,args);active.add(task);void task.then(()=>active.delete(task),()=>active.delete(task));return task;};
 const close=()=>{if(uncertain)return Promise.reject(new Error("Native export drain requires recovery"));if(!closing){closed=true;closing=(async()=>{await Promise.allSettled([...active]);if(cancelTask)await cancelTask;signal.removeEventListener("abort",cancel);await invoke('commercial_export_close',{sessionId});})();}return closing;};
 if(signal.aborted){await close();throw signal.reason;}
 return {recover:async()=>{const result=await invoke("commercial_export_recover",{sessionId});if(result!==true)throw new Error("Native export drain remains unconfirmed");uncertain=false;},identity:async()=>{const value=await call("commercial_export_identity",{sessionId});if(typeof value!=="string"||!value)throw new Error("Native destination identity unavailable");return value;},read:async(name)=>{const value=await call('commercial_export_read',{sessionId,name});if(value===null)return null;if(!Array.isArray(value)||value.some(b=>!Number.isInteger(b)||b<0||b>255))throw new Error('Invalid native export response');const bytes=new Uint8Array(value);try{current();return bytes;}catch(error){bytes.fill(0);throw error;}},
 publishNew:async(name,bytes,operationSignal)=>{if(uncertain)throw new Error("Native export drain requires recovery");check();current();if(operationSignal.aborted)throw operationSignal.reason;try{await call('commercial_export_publish',{sessionId,name,bytes:Array.from(bytes)});}catch(error){if(error==='EXPORT_DRAIN_UNCONFIRMED'||error==='EXPORT_TREE_UNCONFIRMED')uncertain=true;if(error==='EXPORT_EXISTS')throw Object.assign(new Error('Export output exists'),{code:'EEXIST'});throw error;}},close};
}
