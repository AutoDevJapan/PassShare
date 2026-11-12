import {lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {consumeCommercialBox,createCommercialExportProgress,type CommercialExportProgress} from '../shared/cloud/commercial-attachment-export.ts';
import {createVerifiedExportSink} from '../shared/cloud/commercial-export-file-sink.ts';
import type {CloudApi} from '../shared/cloud/cloud-api.ts';
import type {CloudWorker} from '../shared/cloud/cloud-worker.ts';
import {createAtomicExportStore} from './atomic-export-store.mjs';

const destinations=new WeakMap<CommercialExportProgress,string>();
const receipts=new WeakMap<CommercialExportProgress,Map<string,string>>();
// Non-UI native-host entry. Callers obtain credentials/keys through existing flows.
// The selected output directory never comes from remote export metadata.
export async function saveCommercialExport(root:string,api:CloudApi,worker:CloudWorker,
 contractId:string,boxId:string,pin:{keyEpoch:number;snapshotRevision:number},signal:AbortSignal,
 progress:CommercialExportProgress=createCommercialExportProgress()){
 root=resolve(root);const directory=await lstat(root,{bigint:true});if(!directory.isDirectory()||directory.isSymbolicLink())throw new Error('Export root must be a real directory');const binding=JSON.stringify([root,directory.dev.toString(),directory.ino.toString(),directory.birthtimeNs.toString()]);const prior=destinations.get(progress);if(prior&&prior!==binding)throw new Error('Export progress belongs to another output directory');destinations.set(progress,binding);
 const store=createAtomicExportStore(root);
 const known=receipts.get(progress)??new Map<string,string>();receipts.set(progress,known);
 for(const [name,hash] of known){const bytes=await store.read(name);try{if(bytes===null||createHash('sha256').update(bytes).digest('hex')!==hash)throw new Error('Completed export output is missing or changed');}finally{bytes?.fill(0);}}
 const sink=createVerifiedExportSink({...store,verified:(name,bytes)=>{known.set(name,createHash('sha256').update(bytes).digest('hex'));}});
 await consumeCommercialBox(api,worker,contractId,boxId,pin,signal,sink.item,sink.attachment,progress);
 return {saved:true,snapshotRevision:pin.snapshotRevision,items:progress.items.size,attachments:progress.attachments.size};
}
