import {nativeMutation} from './lib/native-mutations.js';
import {authHttpError,sendAuthError} from './auth/errors.js';
import {loadEntitlement} from './commercial-live.js';

const uuid=s=>typeof s==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(s);
const id=s=>typeof s==='string'&&/^[a-z0-9]{26}$/.test(s);
const integer=s=>typeof s==='string'&&/^[1-9][0-9]*$/.test(s)&&Number.isSafeInteger(Number(s));
// This is an additional contract-scoped ciphertext export route. Existing core,
// self-hosted and encrypted APIs retain their independent authorization rules.
export function registerCommercialExport(router,{pool}){
 function handle(kind){return async(req,res)=>{
  let c;
  try {
   const keys=kind==='state'?[]:kind==='items'?['epoch','revision','after']:['epoch','revision'];
   if(!uuid(req.params.id)||!id(req.params.boxId)||Object.keys(req.query).some(k=>!keys.includes(k))
    ||(kind!=='state'&&(!integer(req.query.epoch)||!integer(req.query.revision)))||(req.query.after!==undefined&&!id(req.query.after))
    ||(req.params.itemId!==undefined&&!id(req.params.itemId))||(req.params.attachmentId!==undefined&&!id(req.params.attachmentId))
    ||req.method!=='GET'||Number(req.headers['content-length']??0)!==0||req.headers['transfer-encoding'])throw authHttpError(400,'PS051','Invalid encrypted export selector');
   if(!pool||process.env.PASSSHARE_ENCRYPTED_STORAGE!=='true')throw authHttpError(503,'PS019','Encrypted export unavailable');
   c=await pool.connect();await c.query('BEGIN');
   // Match the encrypted SQL lock order: box -> identity/session -> resource.
   // Membership removal, grant revocation and rotation serialize on this box.
   if(!(await c.query('SELECT id FROM connect_vaults WHERE id=$1 FOR UPDATE',[req.params.boxId])).rowCount)throw authHttpError(404,'PS044','Password box not found');
   if(!(await c.query('SELECT id FROM users WHERE id=$1 FOR SHARE',[req.auth.userId])).rowCount)throw authHttpError(401,'PS024','Session expired');
   if(!(await c.query('SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND expires_at>clock_timestamp() FOR SHARE',[req.auth.sessionId,req.auth.userId])).rowCount)throw authHttpError(401,'PS024','Session expired');
   const contract=(await c.query('SELECT id FROM commercial_contracts WHERE id=$1 AND user_id=$2 FOR SHARE',[req.params.id,req.auth.userId])).rows[0];
   if(!contract)throw authHttpError(404,'PS022','Contract not found');
   const ent=await loadEntitlement(c,contract.id,Date.now());
   if(!ent.effective&&!ent.exportWindow?.open)throw authHttpError(403,'PS065','Contract export window unavailable');
   const epoch=(await c.query('SELECT key_epoch,state_revision FROM encrypted_box_state WHERE box_id=$1 FOR SHARE',[req.params.boxId])).rows[0];
   if(!epoch)throw authHttpError(409,'PS055','Encrypted storage is not enabled');
   async function run(command,operation,extra={}){
    const plan=await nativeMutation({command,operation,actor:req.auth.userId,session:req.auth.sessionId,boxId:req.params.boxId,...extra});
    const reply=(await c.query(plan.sql,plan.params.map(v=>v!==null&&typeof v==='object'?JSON.stringify(v):v))).rows[0]?.reply;
    if(reply?.status!==200){if(reply?.status&&reply?.code)throw authHttpError(reply.status,reply.code,reply.message);throw authHttpError(503,'PS019','Encrypted export unavailable');}
    return reply.body;
   }
   // Prove current Box membership and current shared key before exposing any
   // snapshot conflict. Reuse the official SQL authorization, never true flags.
   const firstPage=await run('encrypted-plan','list',{request:{after:null}});
   if(kind!=='state'&&Number(epoch.key_epoch)!==Number(req.query.epoch))throw authHttpError(409,'PS056','Key epoch changed');
   if(kind!=='state'&&Number(epoch.state_revision)!==Number(req.query.revision))throw authHttpError(409,'PS015','Export snapshot changed');
   let result;
   if(kind==='state')result=await run('encrypted-attachment-plan','state');
   else if(kind==='items'){
    const page=req.query.after?await run('encrypted-plan','list',{request:{after:req.query.after}}):firstPage;
    const selected=page.items.slice(0,10),envelopes=[];let bytes=0;
    for(const item of selected){
     const envelope=await run('encrypted-plan','get',{itemId:item.itemId});
     const size=Buffer.byteLength(JSON.stringify(envelope));if(bytes+size>4*1024*1024)break;
     envelopes.push(envelope);bytes+=size;
    }
    const consumed=envelopes.length,more=page.items.length>consumed||page.nextCursor!==null;
    result={envelopes,nextCursor:more?selected[consumed-1]?.itemId??null:null,attachmentsIncluded:false};
   }else{
    result=await run('encrypted-attachment-plan',kind==='attachment'?'get':'item',{itemId:req.params.itemId,attachmentId:req.params.attachmentId,request:{revision:Number(req.query.revision)}});
   }
   // Re-evaluate both session and the server-clock window after all lock waits.
   if(!(await c.query('SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND expires_at>clock_timestamp()',[req.auth.sessionId,req.auth.userId])).rowCount)throw authHttpError(401,'PS024','Session expired');
   const end=await loadEntitlement(c,contract.id,Date.now());if(!end.effective&&!end.exportWindow?.open)throw authHttpError(403,'PS065','Contract export window expired');
   await c.query('COMMIT');c.release();c=null;
   res.set('Cache-Control','no-store');res.json({format:'passshare-encrypted-export-v1',boxId:req.params.boxId,keyEpoch:Number(epoch.key_epoch),snapshotRevision:Number(epoch.state_revision),ciphertextOnly:true,restoresIdentityMembershipOrKeys:false,data:result});
  }catch(e){if(c){await c.query('ROLLBACK').catch(()=>{});c.release();}sendAuthError(res,e?.status?e:authHttpError(503,'PS019','Encrypted export unavailable'));}
 };}
 router.get('/:id/export/boxes/:boxId/state',handle('state'));
 router.get('/:id/export/boxes/:boxId/items',handle('items'));
 router.get('/:id/export/boxes/:boxId/items/:itemId/attachment-snapshot',handle('attachment-index'));
 router.get('/:id/export/boxes/:boxId/items/:itemId/attachments/:attachmentId',handle('attachment'));
}
