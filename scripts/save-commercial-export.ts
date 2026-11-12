import {consumeCommercialBox,createCommercialExportProgress,type CommercialExportProgress} from '../shared/cloud/commercial-attachment-export.ts';
import {createVerifiedExportSink} from '../shared/cloud/commercial-export-file-sink.ts';
import type {CloudApi} from '../shared/cloud/cloud-api.ts';
import type {CloudWorker} from '../shared/cloud/cloud-worker.ts';
import {createAtomicExportStore} from './atomic-export-store.mjs';

// Non-UI native-host entry. Callers obtain credentials/keys through existing flows.
// The selected output directory never comes from remote export metadata.
export async function saveCommercialExport(root:string,api:CloudApi,worker:CloudWorker,
 contractId:string,boxId:string,pin:{keyEpoch:number;snapshotRevision:number},signal:AbortSignal,
 progress:CommercialExportProgress=createCommercialExportProgress()){
 const sink=createVerifiedExportSink(createAtomicExportStore(root));
 await consumeCommercialBox(api,worker,contractId,boxId,pin,signal,sink.item,sink.attachment,progress);
 return {saved:true,snapshotRevision:pin.snapshotRevision,items:progress.items.size,attachments:progress.attachments.size};
}
