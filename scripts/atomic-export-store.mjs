import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {open,link,unlink,lstat} from 'node:fs/promises';
import {resolve,join,basename} from 'node:path';
import {randomUUID} from 'node:crypto';

// Caller-selected local directory. Existing entries are never replaced.
export function createAtomicExportStore(root){
 root=resolve(root);
 const identity=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.birthtimeNs===b.birthtimeNs;
 const path=name=>{if(typeof name!=='string'||basename(name)!==name||!/^((item|attachment)-[a-z0-9-]+\.(json|bin)|attachment-[a-z0-9-]+\.name\.json)$/.test(name))throw new Error('Invalid export filename');return join(root,name);};
 const stat=p=>lstat(p,{bigint:true});
 return {
  read:async name=>{
   let file;
   try{
    const p=path(name),before=await stat(p);if(!before.isFile()||before.isSymbolicLink())throw new Error('Export output must be a regular file');
    file=await open(p,'r');const held=await file.stat({bigint:true});if(!identity(before,held))throw new Error('Export output identity changed');
    const bytes=new Uint8Array(await file.readFile());const after=await file.stat({bigint:true});
    if(!identity(held,await stat(p))||held.size!==after.size||held.mtimeNs!==after.mtimeNs){bytes.fill(0);throw new Error('Export output changed during read');}
    return bytes;
   }catch(error){if(error.code==='ENOENT')return null;throw error;}finally{await file?.close();}
  },
  publishNew:async(name,bytes,signal)=>{
   if(signal.aborted)throw signal.reason;
   const destination=path(name);
   if(process.platform==='win32'){
    const executable=fileURLToPath(new URL('../target/debug/passshare-export-publish.exe',import.meta.url));
    await new Promise((resolve,reject)=>{
     const child=spawn(executable,[destination],{windowsHide:true,stdio:['pipe','ignore','pipe']});
     let errorText='';child.stderr.on('data',b=>{if(errorText.length<1024)errorText+=b.toString();});
     child.stdin.on('error',()=>{});child.on('error',reject);
     child.on('close',code=>{if(code===0)resolve();else reject(Object.assign(new Error('Atomic export publication failed'),{code:'EXPORT_PUBLISH_FAILED'}));});
     if(signal.aborted){child.stdin.end();}else child.stdin.end(bytes);
    });
    return;
   }
   const out=path(name),temp=join(root,'.passshare-export-'+randomUUID()+'.tmp');let file,owned;
   try{
    if(signal.aborted)throw signal.reason;
    file=await open(temp,'wx',0o600);owned=await file.stat({bigint:true});
    await file.writeFile(bytes);await file.sync();
    if(signal.aborted)throw signal.reason;
    if(!identity(owned,await stat(temp)))throw new Error('Export temporary identity changed');
    await link(temp,out);
    if(!identity(owned,await stat(out)))throw new Error('Export publication identity changed');
   }finally{
    // Never remove an entry merely because it still occupies our temporary name.
    // Keep the created object open through publication and compare identity again.
    try{if(owned){const current=await stat(temp);if(!identity(owned,current))throw new Error('Export temporary cleanup identity changed');await unlink(temp);}}
    finally{await file?.close();}
   }
  },
 };
}
