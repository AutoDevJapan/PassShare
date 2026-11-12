import {copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
export async function prepareDesktopPublisher(source=resolve(root,'target/release/passshare-export-publish.exe'),output=resolve(root,'apps/desktop/src-tauri/binaries/passshare-export-publish-x86_64-pc-windows-msvc.exe')){
 const bytes=await readFile(source);if(bytes.length<2||bytes[0]!==0x4d||bytes[1]!==0x5a)throw new Error('Publisher is not a Windows executable');
 await mkdir(dirname(output),{recursive:true});await copyFile(source,output);const actual=await readFile(output);
 const hash=b=>createHash('sha256').update(b).digest('hex');if(hash(bytes)!==hash(actual))throw new Error('Publisher packaging bytes differ');
 const receipt={format:1,bytes:bytes.length,sha256:hash(bytes),target:'x86_64-pc-windows-msvc'};
 await writeFile(output+'.sha256.json',JSON.stringify(receipt)+'\n');return receipt;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))prepareDesktopPublisher().catch(()=>{console.error('Publisher preparation failed');process.exitCode=1;});
