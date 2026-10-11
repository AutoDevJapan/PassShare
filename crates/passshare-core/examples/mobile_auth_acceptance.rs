//! Exercise the actual React provider and secure storage with synthetic boundaries.
//! Node hosts React/TypeScript; Rust verifies observations without secret output.
use serde_json::Value;
use std::process::{Command, Stdio};

const HOST: &str = r#"
import {registerHooks,createRequire} from 'node:module';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
const app=resolve(process.argv[1]);
const require=createRequire(pathToFileURL(join(app,'package.json')));
const ts=require('typescript');
const root=resolve(app,'../..');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}};
const doc=new EventTarget();doc.hidden=false;doc.hasFocus=()=>true;
globalThis.document=doc;
globalThis.window=Object.assign(new EventTarget(),{setInterval:()=>0,clearInterval:()=>{}});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
globalThis.fetch=()=>{throw new Error('Unexpected real network access')};
const native={epoch:0,id:null,foreground:true,unlocked:false};
const listeners=new Set();
const status=()=>({epoch:native.epoch,unlocked:native.unlocked});
const close=()=>{native.epoch++;native.unlocked=false;for(const cb of listeners)cb({payload:status()})};
const fixture=globalThis.__mobileFixture={
  reads:0,logoutCalls:0,failNativeLogout:false,readGate:null,writeFailure:false,
  loginGate:null,logoutGate:null,
  async invoke(command,args={}) {
    if(command==='native_session_status')return status();
    if(command==='native_begin_unlock')return native.epoch;
    if(command==='native_background'){native.foreground=false;close();return}
    if(command==='native_foreground'){native.foreground=true;close();return}
    if(command==='native_lock'){close();return status()}
    if(command==='native_logout'){
      if(this.failNativeLogout){this.failNativeLogout=false;throw new Error('Synthetic IPC failure')}
      native.id=null;close();return;
    }
    if(command==='native_account'){
      const accepted=args.epoch===native.epoch&&(!args.id||native.foreground);
      const changed=accepted&&native.id!==args.id;
      if(changed){native.id=args.id;native.epoch++;native.unlocked=false}
      return {...status(),changed,accepted};
    }
    if(command==='native_complete_unlock'){
      const accepted=args.epoch===native.epoch&&native.foreground&&native.id&&!native.unlocked;
      if(accepted){native.epoch++;native.unlocked=true}
      return {epoch:native.epoch,unlocked:!!accepted};
    }
    if(command==='native_activity')return native.unlocked;
    throw new Error('Unexpected native command');
  },
  async login(){if(this.loginGate)await this.loginGate.promise;return response()},
  async logout(){this.logoutCalls++;if(this.logoutGate)await this.logoutGate.promise},
};
const user={id:'00000000-0000-4000-8000-000000000001',email:'synthetic@example.invalid',createdAt:'2026-01-01'};
let tokenSerial=0;
const response=()=>({user,refreshToken:'synthetic-refresh-'+(++tokenSerial),connectAccessToken:'synthetic-access',connectExpiresAt:'2999-01-01',sessionExpiresAt:'2999-01-01',connectExpiresIn:300});
const modules={
  '@passshare/connect':`export class ConnectClient {constructor(options){this.options=options}}`,
  '@tauri-apps/api/core':`export const isTauri=()=>true;export const invoke=(...args)=>globalThis.__mobileFixture.invoke(...args);`,
  '@tauri-apps/api/event':`export const listen=async(_,cb)=>globalThis.__mobileFixture.listen(cb);`,
  '@shared/i18n/I18nProvider':`export const useI18n=()=>({t:key=>key});`,
  '../lib/auth-api':`export class AuthApiError extends Error{};export const getApiBaseUrl=()=> 'http://127.0.0.1:12345';export const mobileLogin=()=>globalThis.__mobileFixture.login();export const mobileSignup=mobileLogin;export const mobileLogout=()=>globalThis.__mobileFixture.logout();export const fetchCurrentUser=async()=>globalThis.__mobileFixture.user;export const refreshConnectToken=async()=>({connectAccessToken:'synthetic-access',connectExpiresAt:'2999-01-01'});`,
};
fixture.user=user;fixture.listen=cb=>{listeners.add(cb);return ()=>listeners.delete(cb)};
registerHooks({
  resolve(specifier,context,next){
    if(modules[specifier])return {url:'data:text/javascript,'+encodeURIComponent(modules[specifier]),shortCircuit:true};
    if(specifier.startsWith('@shared/'))return {url:pathToFileURL(join(root,'shared',specifier.slice('@shared/'.length)+'.ts')).href,shortCircuit:true};
    if(specifier.startsWith('.')&&context.parentURL?.startsWith(pathToFileURL(join(root,'shared')).href)){
      const path=resolve(dirname(fileURLToPath(context.parentURL)),specifier);
      if(existsSync(path+'.ts'))return {url:pathToFileURL(path+'.ts').href,shortCircuit:true};
    }
    if(specifier==='../lib/secure-storage')return {url:pathToFileURL(join(app,'src/lib/secure-storage.ts')).href,shortCircuit:true};
    if(['react','react/jsx-runtime','react-test-renderer'].includes(specifier))return {url:pathToFileURL(require.resolve(specifier)).href,shortCircuit:true};
    return next(specifier,context);
  },
  load(url,context,next){
    if(url.startsWith('file:')&&/\.tsx?$/.test(url)){
      const source=ts.transpileModule(readFileSync(fileURLToPath(url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText;
      return {format:'module',source,shortCircuit:true};
    }
    return next(url,context);
  }
});
const React=await import('react');const {act,createElement}=React;
const {default:renderer}=await import('react-test-renderer');
const storage=await import(pathToFileURL(join(app,'src/lib/secure-storage.ts')).href);
const backing=new Map();
storage.__setBiometryApiForTests({
  async getData({name}){fixture.reads++;if(fixture.readGate)await fixture.readGate.promise;return {data:backing.get(name)??null}},
  async setData({name,data}){if(fixture.writeFailure){fixture.writeFailure=false;throw new Error('Synthetic store failure')}backing.set(name,data)},
  async removeData({name}){backing.delete(name)},async checkStatus(){return {isAvailable:true}}
});
const {AuthSessionProvider,useAuthSession}=await import(pathToFileURL(join(app,'src/hooks/useAuthSession.tsx')).href);
let context;function Probe(){context=useAuthSession();return null}
let tree;await act(async()=>{tree=renderer.create(createElement(AuthSessionProvider,null,createElement(Probe)));});
const observations={};
await act(async()=>{await context.login('synthetic@example.invalid','synthetic-password')});
const pendingLogout=deferred();fixture.logoutGate=pendingLogout;
let logging;await act(async()=>{logging=context.logout();await Promise.resolve();});
await act(async()=>{doc.hidden=true;doc.dispatchEvent(new Event('visibilitychange'));doc.hidden=false;doc.dispatchEvent(new Event('visibilitychange'));await context.refreshConnect();});
fixture.logoutGate=null;pendingLogout.resolve();await act(async()=>{await logging});
observations.logoutAfterForegroundCleared=!backing.has('auth-session')&&context.user===null&&fixture.logoutCalls===1;
await act(async()=>{await context.login('synthetic@example.invalid','synthetic-password')});
fixture.failNativeLogout=true;let failed=false;
await act(async()=>{try{await context.logout()}catch{failed=true}});
await act(async()=>{await context.login('synthetic@example.invalid','synthetic-password')});
observations.nativeFailureRecovers=failed&&context.user?.id===user.id&&backing.has('auth-session');
const readGate=deferred();fixture.readGate=readGate;const reads=fixture.reads;
let one,two;await act(async()=>{one=context.refreshConnect();two=context.refreshConnect();await Promise.resolve();});
const same=one===two;fixture.readGate=null;readGate.resolve();await act(async()=>{await Promise.all([one,two])});
observations.singleReadShared=same&&fixture.reads===reads+1;
await act(async()=>{await context.biometricUnlock()});
observations.biometricUnlocksOnce=context.unlocked===true;
await act(async()=>{doc.hidden=true;doc.dispatchEvent(new Event('visibilitychange'));doc.hidden=false;doc.dispatchEvent(new Event('visibilitychange'));});
const late=deferred();fixture.readGate=late;let unlocking;
await act(async()=>{unlocking=context.biometricUnlock();await Promise.resolve();});
await act(async()=>{doc.hidden=true;doc.dispatchEvent(new Event('visibilitychange'));doc.hidden=false;doc.dispatchEvent(new Event('visibilitychange'));});
fixture.readGate=null;late.resolve();let accepted;await act(async()=>{accepted=await unlocking});
observations.backgroundRejectsProof=accepted===false&&context.unlocked===false&&context.connectClient===null&&backing.has('auth-session');
await act(async()=>{await context.logout()});
const issued=deferred();fixture.loginGate=issued;let stale;
await act(async()=>{stale=context.login('synthetic@example.invalid','synthetic-password').then(()=>false,()=>true);await Promise.resolve();});
await act(async()=>{await context.logout()});
fixture.loginGate=null;issued.resolve();let rejected;await act(async()=>{rejected=await stale});
observations.lateLoginCannotRestore=rejected&&!backing.has('auth-session')&&context.user===null;
const cancelled=fixture.logoutCalls;fixture.writeFailure=true;let writeFailed=false;
await act(async()=>{try{await context.login('synthetic@example.invalid','synthetic-password')}catch{writeFailed=true}});
observations.failedSaveCancelsSession=writeFailed&&fixture.logoutCalls===cancelled+1&&!backing.has('auth-session');
await act(async()=>{tree.unmount()});storage.__resetBiometryApiForTests();
process.stdout.write(JSON.stringify(observations));
"#;

fn main() {
    let app = std::env::args_os().nth(1).expect("mobile app directory");
    let mut command = Command::new("node");
    command.env_clear();
    for name in ["PATH", "SystemRoot", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let result = command
        .args(["--input-type=module", "-e", HOST])
        .arg(app)
        .stdin(Stdio::null())
        .output()
        .expect("Node React host");
    if !result.status.success() {
        eprintln!(
            "React host exit={:?}, diagnostic bytes={}",
            result.status.code(),
            result.stderr.len()
        );
    }
    assert!(result.status.success(), "actual React auth host failed");
    let observed: Value = serde_json::from_slice(&result.stdout).expect("React observations");
    for name in [
        "logoutAfterForegroundCleared",
        "nativeFailureRecovers",
        "singleReadShared",
        "biometricUnlocksOnce",
        "backgroundRejectsProof",
        "lateLoginCannotRestore",
        "failedSaveCancelsSession",
    ] {
        assert_eq!(observed[name], true, "actual provider regression: {name}");
    }
    println!("actual React auth: seven lifecycle/storage regressions passed");
}
