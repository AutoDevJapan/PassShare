import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';
// Test-host transport only. Never retries an ambiguous mutation.
export function nativeExportAcceptanceHost(binary,args=[],env={}){
 const child=spawn(binary,args,{windowsHide:true,env:{...process.env,...env},stdio:['pipe','pipe','pipe']});let sequence=0,terminal=null;const pending=new Map();
 const fail=error=>{terminal=error;for(const p of pending.values())p.reject(error);pending.clear();};
 const exited=new Promise(resolve=>{child.once('error',fail);child.once('close',code=>{fail(new Error('Native acceptance host closed'));resolve(code);});});
 child.stdin.on('error',fail);child.stderr.on('data',()=>{});
 createInterface({input:child.stdout}).on('line',line=>{try{const r=JSON.parse(line),p=pending.get(r.id);if(!p)throw new Error('Unknown acceptance response');pending.delete(r.id);r.ok?p.resolve(r.value):p.reject(r.error);}catch(error){fail(error);child.kill();}});
 return {invoke:(command,args)=>new Promise((resolve,reject)=>{if(terminal){reject(terminal);return;}const id=++sequence;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,command,args})+'\n',error=>{if(error)fail(error);});}),close:async()=>{child.stdin.end();return await exited;}};
}
