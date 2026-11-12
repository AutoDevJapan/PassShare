import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createNativeExportStore} from '../src/lib/native-export-store.ts';
test('native output session binds destination and preserves existing-file classification',async()=>{
 const calls:Array<{command:string;args:any}>=[];const invoke=async(command:string,args:any)=>{calls.push({command,args});if(command==='commercial_export_open')return 'owned-session';if(command==='commercial_export_read')return [0,255,1];if(command==='commercial_export_publish')throw 'EXPORT_EXISTS';};
 const store=await createNativeExportStore(invoke,'C:/selected',new AbortController().signal);
 assert.deepEqual([...(await store.read('item-a-v1.json'))!],[0,255,1]);
 await assert.rejects(store.publishNew('item-a-v1.json',new Uint8Array([9]),new AbortController().signal),(e:any)=>e.code==='EEXIST');
 assert.equal(calls[1].args.sessionId,'owned-session');assert.equal('directory' in calls[1].args,false);await store.close();
});
test('cancelled native export never opens a destination',async()=>{let calls=0;const c=new AbortController();c.abort('cancel');await assert.rejects(createNativeExportStore(async()=>{calls++;},'C:/selected',c.signal));assert.equal(calls,0);});
