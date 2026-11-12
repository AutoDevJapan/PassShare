import {readFile,open,link,unlink} from 'node:fs/promises';
import {resolve,join,basename} from 'node:path';
import {randomUUID} from 'node:crypto';

// Native host adapter. The root is selected by the caller, never remote input.
export function createAtomicExportStore(root){
 root=resolve(root);
 const path=name=>{if(typeof name!=='string'||basename(name)!==name||!/^((item|attachment)-[a-z0-9-]+\.(json|bin)|attachment-[a-z0-9-]+\.name\.json)$/.test(name))throw new Error('Invalid export filename');return join(root,name);};
 return {
  read:async name=>{try{return new Uint8Array(await readFile(path(name)));}catch(error){if(error.code==='ENOENT')return null;throw error;}},
  publishNew:async(name,bytes,signal)=>{
   const out=path(name),temp=join(root,'.passshare-export-'+randomUUID()+'.tmp');let file;
   try{
    if(signal.aborted)throw signal.reason;file=await open(temp,'wx',0o600);await file.writeFile(bytes);await file.sync();await file.close();file=undefined;
    if(signal.aborted)throw signal.reason;await link(temp,out);
   }finally{await file?.close();await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  },
 };
}
