import type {CloudApi} from './cloud-api.ts';
import {CloudApiError} from './cloud-api.ts';
import type {AttachmentContext,AttachmentPlaintext,CloudWorker,ItemContext} from './cloud-worker.ts';

// The consumer must copy/save inside this callback; plaintext is released on every exit.
export async function consumeCommercialAttachment(
 api:Pick<CloudApi,'getCommercialAttachmentItemSnapshot'|'getCommercialEncryptedAttachment'>,
 worker:Pick<CloudWorker,'decryptAttachment'|'releaseAttachment'>,
 contractId:string,item:ItemContext,attachment:AttachmentContext,revision:number,
 signal:AbortSignal,consume:(file:AttachmentPlaintext,signal:AbortSignal)=>Promise<void>,
):Promise<void>{
 item={...item};attachment={...attachment};
 const current=()=>{if(signal.aborted)throw new CloudApiError(409);};
 current();
 if(item.passwordBoxId!==attachment.passwordBoxId||item.itemId!==attachment.itemId||item.keyEpoch!==attachment.keyEpoch)throw new CloudApiError(400);
 const parent=await api.getCommercialAttachmentItemSnapshot(contractId,item,revision,signal);current();
 const body=await api.getCommercialEncryptedAttachment(contractId,attachment,revision,signal);current();
 const file=await worker.decryptAttachment(body,attachment,{itemEnvelope:parent,expectedItemContext:item,itemSnapshotRevision:revision,attachmentSnapshotRevision:revision});
 let released=false;
 const release=()=>{if(!released){released=true;worker.releaseAttachment(file);}};
 // Abort wipes immediately, but completion still drains the sink. A caller must
 // never mistake cancellation for quiescence while a write remains outstanding.
 const onAbort=()=>release();
 try{current();signal.addEventListener('abort',onAbort,{once:true});await consume(file,signal);current();}
 finally{signal.removeEventListener('abort',onAbort);release();}
}

// Resume only the same export snapshot after a normal worker re-unlock. No key,
// membership or authorization is restored by this progress record.
const activeExports=new WeakSet<CommercialExportProgress>();
export type CommercialExportProgress={binding:string;items:Set<string>;attachments:Set<string>};
export function createCommercialExportProgress():CommercialExportProgress{return {binding:'',items:new Set(),attachments:new Set()};}
// Pages and attachments share one immutable snapshot; delivery is sequential and backpressured.
export async function consumeCommercialBox(
 api:Pick<CloudApi,'getCommercialExportPage'|'getCommercialAttachmentItemSnapshot'|'getCommercialEncryptedAttachment'>,
 worker:Pick<CloudWorker,'decrypt'|'decryptAttachment'|'releaseAttachment'>,
 contractId:string,boxId:string,pin:{keyEpoch:number;snapshotRevision:number},signal:AbortSignal,
 consumeItem:(itemJSON:string,context:ItemContext,signal:AbortSignal)=>Promise<void>,
 consumeAttachment:(file:AttachmentPlaintext,context:AttachmentContext,signal:AbortSignal)=>Promise<void>,
 progress:CommercialExportProgress=createCommercialExportProgress(),
):Promise<void>{
 pin={...pin};let after:string|null=null;const seen=new Set<string>();
 const binding=JSON.stringify([contractId,boxId,pin.keyEpoch,pin.snapshotRevision]);
 if(progress.binding&&progress.binding!==binding)throw new CloudApiError(409);
 if(activeExports.has(progress))throw new CloudApiError(409);
 activeExports.add(progress);
 try{
 progress.binding=binding;
 // A contract export has a 30/minute server budget. Retry only the rejected GET,
 // never a delivered sink callback, and keep cancellation responsive while waiting.
 const request=async<T>(run:()=>Promise<T>):Promise<T>=>{
  try{return await run();}catch(error){
   if(!(error instanceof CloudApiError)||error.status!==429)throw error;
   await new Promise<void>((resolve,reject)=>{
    if(signal.aborted){reject(new CloudApiError(409));return;}
    const abort=()=>{clearTimeout(timer);reject(new CloudApiError(409));};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},61000);
    signal.addEventListener('abort',abort,{once:true});
   });
   return run();
  }
 };
 const limitedApi={getCommercialAttachmentItemSnapshot:(...args:Parameters<CloudApi['getCommercialAttachmentItemSnapshot']>)=>request(()=>api.getCommercialAttachmentItemSnapshot(...args)),getCommercialEncryptedAttachment:(...args:Parameters<CloudApi['getCommercialEncryptedAttachment']>)=>request(()=>api.getCommercialEncryptedAttachment(...args))};
 const current=()=>{if(signal.aborted)throw new CloudApiError(409);};
 do{
  current();const page=await request(()=>api.getCommercialExportPage(contractId,boxId,pin,after,signal));current();
  for(const envelope of page.envelopes){
   const context={...envelope.context};
   if(seen.has(context.itemId)||(after!==null&&context.itemId<=after))throw new CloudApiError(502);
   seen.add(context.itemId);
   const plain=await worker.decrypt(JSON.stringify(envelope),context);current();
   const item=JSON.parse(plain);if(!progress.items.has(context.itemId)){await consumeItem(plain,{...context},signal);progress.items.add(context.itemId);current();}
   for(const ref of item.attachments??[]){
    const attachment={passwordBoxId:boxId,itemId:context.itemId,attachmentId:ref.attachmentId,attachmentVersion:ref.attachmentVersion,keyEpoch:ref.keyEpoch};
        const key=JSON.stringify([context.itemId,attachment.attachmentId,attachment.attachmentVersion]);
    if(!progress.attachments.has(key)){
     await consumeCommercialAttachment(limitedApi,worker,contractId,context,attachment,pin.snapshotRevision,signal,async(file,sinkSignal)=>{await consumeAttachment(file,{...attachment},sinkSignal);progress.attachments.add(key);});
     current();
    }
   }
  }
  if(page.nextCursor!==null&&(page.envelopes.length===0||page.nextCursor!==page.envelopes.at(-1)!.context.itemId||page.nextCursor===after))throw new CloudApiError(502);
  after=page.nextCursor;
 }while(after!==null);
 }finally{activeExports.delete(progress);}
}
