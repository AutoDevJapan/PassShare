import type {CloudApi} from '../../../../shared/cloud/cloud-api.ts';
import type {CloudWorker} from '../../../../shared/cloud/cloud-worker.ts';
import {consumeCommercialBox,createCommercialExportProgress,type CommercialExportProgress} from '../../../../shared/cloud/commercial-attachment-export.ts';
import {createVerifiedExportSink} from '../../../../shared/cloud/commercial-export-file-sink.ts';
import {createNativeExportStore,type ExportInvoke} from './native-export-store.ts';
const destinations=new WeakMap<CommercialExportProgress,string>();
export async function saveNativeCommercialExport(invoke:ExportInvoke,directory:string,api:CloudApi,worker:CloudWorker,contractId:string,boxId:string,pin:{keyEpoch:number;snapshotRevision:number},signal:AbortSignal,progress=createCommercialExportProgress()){
 const prior=destinations.get(progress);if(prior&&prior!==directory)throw new Error('Export progress belongs to another destination');destinations.set(progress,directory);
 const store=await createNativeExportStore(invoke,directory,signal);
 try{const sink=createVerifiedExportSink(store);await consumeCommercialBox(api,worker,contractId,boxId,pin,signal,sink.item,sink.attachment,progress);return {saved:true,items:progress.items.size,attachments:progress.attachments.size};}finally{await store.close();}
}
