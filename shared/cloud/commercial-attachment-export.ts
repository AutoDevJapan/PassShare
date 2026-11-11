import type {CloudApi} from './cloud-api.ts';
import {CloudApiError} from './cloud-api.ts';
import type {AttachmentContext,AttachmentPlaintext,CloudWorker,ItemContext} from './cloud-worker.ts';

// The consumer must copy/save inside this callback; plaintext is released on every exit.
export async function consumeCommercialAttachment(
 api:Pick<CloudApi,'getCommercialAttachmentItemSnapshot'|'getCommercialEncryptedAttachment'>,
 worker:Pick<CloudWorker,'decryptAttachment'|'releaseAttachment'>,
 contractId:string,item:ItemContext,attachment:AttachmentContext,revision:number,
 signal:AbortSignal,consume:(file:AttachmentPlaintext)=>Promise<void>,
):Promise<void>{
 item={...item};attachment={...attachment};
 const current=()=>{if(signal.aborted)throw new CloudApiError(409);};
 current();
 if(item.passwordBoxId!==attachment.passwordBoxId||item.itemId!==attachment.itemId||item.keyEpoch!==attachment.keyEpoch)throw new CloudApiError(400);
 const parent=await api.getCommercialAttachmentItemSnapshot(contractId,item,revision,signal);current();
 const body=await api.getCommercialEncryptedAttachment(contractId,attachment,revision,signal);current();
 const file=await worker.decryptAttachment(body,attachment,{itemEnvelope:parent,expectedItemContext:item,itemSnapshotRevision:revision,attachmentSnapshotRevision:revision});
 try{current();await consume(file);current();}finally{worker.releaseAttachment(file);}
}
