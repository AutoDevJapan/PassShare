//! Execute the actual TypeScript transport against exported WASM in Node.
//! Node supplies message/timer surfaces only; Rust verifies all observations.
//! Synthetic clock/event checks are not a real Chrome UI acceptance.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use passshare_core::cloud_crypto::{ItemContext, OwnerKeyContext, PasswordBoxKey};
use passshare_core::crypto::{derive_master_key_with_params, generate_salt, MasterKey};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use zeroize::{Zeroize, Zeroizing};

fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    assert_eq!(
        args.len(),
        4,
        "node bindings, TypeScript package, repository root, react-test-renderer package"
    );
    const HOST: &str = r#"
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
let input = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => { let stage='startup'; void (async () => {
 const f = JSON.parse(input), ts = require(f.ts), workers = [], timers = new Map(), listeners = new Map();
 let now = 0, wallOffset=0, nextTimer = 0, constructing = null;
 const window = { addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type,new Set()); listeners.get(type).add(fn); },
   removeEventListener(type, fn) { listeners.get(type)?.delete(fn); }, dispatchEvent(event) { for(const fn of [...(listeners.get(event.type) || [])]) fn(event); } };
 const document = {visibilityState:'visible',addEventListener:window.addEventListener,removeEventListener:window.removeEventListener};
 globalThis.DedicatedWorkerGlobalScope = class { static [Symbol.hasInstance](value) { return value === globalThis; } };
 class Worker {
  constructor() {
   this.dead = false; this.hold = false; this.queue = []; this.mutate = null; this.commands=[]; workers.push(this); constructing = this;
   delete require.cache[require.resolve(f.bindings)]; this.api = require(f.bindings);
   globalThis.postMessage = (raw,transfer=[]) => { const self = constructing; if (self) self.emit(structuredClone(raw,{transfer})); };
   this.api.start_worker(); this.handler = globalThis.onmessage;
  }
  emit(raw) { queueMicrotask(() => { if (this.hold) this.queue.push(raw); else this.onmessage?.({data:this.mutate ? this.mutate(raw) : raw}); }); }
  postMessage(raw,transfer=[]) { this.commands.push(JSON.parse(typeof raw==='string'?raw:raw.message).command); constructing = this; this.handler({data:structuredClone(raw,{transfer})}); }
  terminate() { this.dead = true; }
 }
 const sandbox = {exports:{},Worker,window,document,TextEncoder,Uint8Array,ArrayBuffer,Event:class {constructor(type){this.type=type;}},
  performance:{now:()=>now},Date:{now:()=>now+wallOffset},setTimeout(fn, ms){const id=++nextTimer; timers.set(id,{fn,at:now+ms}); return id;},clearTimeout(id){timers.delete(id);}};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(f.root,'frontend/src/lib/cloud-worker.ts'),'utf8'),
   {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,sandbox);
 const {CloudWorker,lockCloudUi}=sandbox.exports;
 function tick(ms, fire=true) {now+=ms; if(fire) for(const [id,t] of [...timers]) if(t.at<=now){timers.delete(id);t.fn();}}
 const inputEvent = trusted => { const event={type:'keydown',isTrusted:trusted,prevented:false,stopped:false,
  preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;}}; window.dispatchEvent(event); return event; };
 const rejected = async promise => {try {await promise;return false;}catch{return true;}};
 const make = async () => {const c=new CloudWorker();await c.ready;return [c,workers.at(-1)];};
 const secret=f.secret, a={accountId:f.fixture.owner.ownerAccountId,identityVersion:1}, b={accountId:'22222222-2222-4222-8222-222222222222',identityVersion:1};
 const empty = account => JSON.stringify({accountContext:JSON.stringify(account),ownPin:'',remoteRecord:'',pendingRecord:'',verificationCode:''});
 const [owner,ow]=await make();
 stage='owner-unlock'; await owner.unlock(f.fixture.owner,JSON.stringify(f.fixture.bundle),f.password);
 const doubleOpenRefused=await rejected(owner.generate(f.fixture.owner))&&!ow.dead;
 const oldItem=await owner.decrypt(JSON.stringify(f.fixture.envelope),f.fixture.context);
 stage='identity-prepare'; const prepared=await owner.prepareIdentity(empty(a),secret), own=JSON.parse(prepared.publicIdentity);
 const [recipient,rw]=await make(); const rp=await recipient.prepareIdentity(empty(b),secret), peer=JSON.parse(rp.publicIdentity);
 stage='verify-code'; const verified=await owner.verifyPublicIdentity(b,rp.publicIdentity,peer.keyId.toUpperCase().match(/.{1,4}/g).join(' \n'));
 const mismatch=await rejected(owner.verifyPublicIdentity(b,rp.publicIdentity,'0'.repeat(64)));
 stage='sharing-context'; const context=await owner.sharingContext(JSON.stringify({passwordBoxId:f.fixture.owner.passwordBoxId,callerAccountId:a.accountId,
  keyEpoch:f.fixture.owner.keyEpoch,sender:own,recipient:peer,members:[{accountId:a.accountId,role:'owner',membershipConfirmed:true},{accountId:b.accountId,role:'member',membershipConfirmed:true}]}));
 stage='sharing-envelope'; const envelope=await owner.wrapForRecipient(verified,context);
 await recipient.receiveShared(envelope,prepared.publicIdentity,context);
 const sharedItem=await recipient.decrypt(JSON.stringify(f.fixture.envelope),f.fixture.context);
 const recipientWrapRefused=await rejected(recipient.wrap(secret)), recipientRecoveryRefused=await rejected(recipient.createRecoveryMaterial());
 const stableAfterRefusal=await recipient.decrypt(JSON.stringify(f.fixture.envelope),f.fixture.context);
 stage='attachment-transport';
 const ac={passwordBoxId:f.fixture.owner.passwordBoxId,itemId:f.fixture.context.itemId,attachmentId:'cccccccccccccccccccccccccc',attachmentVersion:1,keyEpoch:f.fixture.owner.keyEpoch};
 const bytes=new Uint8Array([0,255,128,0]);const file=await owner.encryptAttachment('添付🦀',bytes,ac);
 const transferDetached=bytes.byteLength===0;
 const ic={...f.fixture.context,itemVersion:3};
 const full={id:ic.itemId,version:3,vault:{id:ic.passwordBoxId},attachments:[{attachmentId:ac.attachmentId,attachmentVersion:1,keyEpoch:ac.keyEpoch}]};
 const itemEnvelope=await owner.encrypt(JSON.stringify(full),ic);
 const attachmentSource={itemEnvelope,expectedItemContext:ic,itemSnapshotRevision:17,attachmentSnapshotRevision:17};
 const plain=await recipient.decryptAttachment(file,ac,attachmentSource);
 const attachmentExact=plain.name==='添付🦀'&&plain.bytes.length===4&&plain.bytes[0]===0&&plain.bytes[1]===255&&plain.bytes[2]===128;
 recipient.releaseAttachment(plain);
 const releasedWiped=plain.name===''&&plain.bytes.every(b=>b===0);
 const maxInput=new Uint8Array(1048576).fill(255), maxFile=await owner.encryptAttachment('',maxInput,ac);
 const maximum=await owner.decryptAttachment(maxFile,ac,attachmentSource);
 const maximumExact=maxInput.byteLength===0&&maximum.name===''&&maximum.bytes.length===1048576&&maximum.bytes.every(b=>b===255);
 owner.releaseAttachment(maximum);
 const oversize=new Uint8Array(1048577).fill(255), oversizeRejected=await rejected(owner.encryptAttachment('',oversize,ac))&&oversize.every(b=>b===0)&&!ow.dead;
 const revisionRejected=await rejected(owner.decryptAttachment(file,ac,{...attachmentSource,attachmentSnapshotRevision:18}))&&!ow.dead;
 const malformedName=await rejected(owner.encryptAttachment(null,new Uint8Array([255]),ac))&&!ow.dead;
 const circular={...ac};circular.unknown=circular;const circularInput=new Uint8Array([255]);
 const circularContextRejected=await rejected(owner.encryptAttachment('',circularInput,circular))&&circularInput.every(b=>b===0)&&!ow.dead;
 // Cancel a transferred plaintext reply and then deliver it through the saved handler.
 const saved=rw.onmessage;rw.hold=true;
 const filePending=recipient.decryptAttachment(file,ac,attachmentSource); await Promise.resolve(); await Promise.resolve();
 recipient.dispose();const attachmentCancelled=await rejected(filePending);
 const lateAttachment=rw.queue.find(raw=>typeof raw==='object');saved?.({data:lateAttachment});
 const attachmentLateWiped=lateAttachment?.bytes.every(b=>b===0)===true;
 const ownerPlain=await owner.decryptAttachment(file,ac,attachmentSource);
 const movedPlain=await owner.decryptAttachment(file,ac,attachmentSource);
 const movedBytes=structuredClone(movedPlain.bytes,{transfer:[movedPlain.bytes.buffer]});
 // Owner's already-returned mutable buffer is wiped on scope invalidation.
 const isolated=await owner.publicIdentity();owner.dispose();const attachmentLockWiped=ownerPlain.bytes.every(b=>b===0);
 const detachedOutputLock=ow.dead&&movedPlain.bytes.byteLength===0;movedBytes.fill(0);
 const [recipient2,rw2]=await make();await recipient2.unlockIdentity(b,peer.keyId,JSON.stringify(JSON.parse(rp.record).bundle),secret);
 await recipient2.receiveShared(envelope,prepared.publicIdentity,context);
 const cancelledHandler=rw2.onmessage; rw2.hold=true;
 const pending=recipient2.decrypt(JSON.stringify(f.fixture.envelope),f.fixture.context); await Promise.resolve();
 recipient2.dispose(); const cancelled=await rejected(pending); const delayed=rw2.queue.pop(); cancelledHandler?.({data:delayed});
 stage='idle'; const [idle,iw]=await make(); await idle.generateIdentity(a); tick(299999); await idle.publicIdentity(); tick(1);
 const identityOnlyExpired=iw.dead && await rejected(idle.publicIdentity());
 const [both,bw]=await make(); await both.generateIdentity(a); tick(299999); await both.generate(f.fixture.owner); tick(1);
 const secondHandleDidNotExtend=bw.dead;
 const [untrusted,uw]=await make(); await untrusted.generateIdentity(a); tick(299999); inputEvent(false); tick(1); const untrustedExpired=uw.dead;
 const [trusted,tw]=await make(); await trusted.generateIdentity(a); tick(299999);inputEvent(true);tick(1); const inputExtended=!tw.dead;tick(299999);const trustedExpired=tw.dead;
 const [late,lw]=await make();await late.generateIdentity(a);tick(300000,false);const consumed=inputEvent(true);const expiredInputConsumed=lw.dead&&consumed.prevented&&consumed.stopped;
 const [background,bgw]=await make();await background.generateIdentity(a);document.visibilityState='hidden';window.dispatchEvent({type:'visibilitychange'});document.visibilityState='visible';
 const [token,tokenw]=await make();await token.generateIdentity(a);lockCloudUi();
 const [sleepClock,sleepw]=await make();await sleepClock.generateIdentity(a);wallOffset=300000;
 const pausedMonotonicExpired=await rejected(sleepClock.publicIdentity())&&sleepw.dead;wallOffset=0;
 const [backwards,backw]=await make();await backwards.generateIdentity(a);wallOffset=-1;
 const backwardsClockExpired=await rejected(backwards.publicIdentity())&&backw.dead;wallOffset=0;
 stage='strict-replies'; const invalid=[];
 for(const mutate of [r=>({...r,identityLocked:null}),r=>({...r,unknown:1}),r=>({...r,generation:r.generation+1}),r=>({...r,requestId:r.requestId+1}),r=>({...r,publicIdentity:null}),r=>({...r,sharedContext:'{}'}),r=>({...r,locked:false}),r=>({...r,error:null})]) {
  const [c,w]=await make();w.mutate=raw=>JSON.stringify(mutate(JSON.parse(raw)));
  invalid.push(await rejected(c.generateIdentity(a))&&w.dead);
 }
 // Exact public API routes/response framing and account-scoped pin storage.
 stage='http-and-pins'; const source=ts.transpileModule(fs.readFileSync(path.join(f.root,'frontend/src/lib/sharing-api.ts'),'utf8'),
   {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const storage=new Map(), calls=[]; let reply=null, status=200, responseHook=null;
 const apiSandbox={exports:{},TextEncoder,TextDecoder,localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
  require(name){if(name==='./auth-api')return {authFetch:async(url,init)=>{calls.push({url,method:init.method??'GET',body:init.body===undefined?null:JSON.parse(init.body)});if(responseHook)return responseHook(url,init);return new Response(JSON.stringify(reply),{status});}};
   if(name==='./cloud-api') return {CloudApiError:class extends Error{constructor(status){super('fixed');this.status=status;}}};throw Error('unexpected module');}};
 vm.runInNewContext(source,apiSandbox);const api=apiSandbox.exports, signal=new AbortController().signal;
 api.savePreparedOwnPin(a.accountId,own); api.savePeerPin(a.accountId,b.accountId,peer);
 const pinIsolation=api.readOwnPin(b.accountId)===null&&api.readPeerPin(b.accountId,a.accountId)===null&&api.readPeerPin(a.accountId,b.accountId).keyId===peer.keyId;
 const record=JSON.parse(prepared.record);api.savePendingIdentity(a.accountId,record);
 const pendingExact=JSON.stringify(api.readPendingIdentity(a.accountId))===JSON.stringify(JSON.parse(api.publicText(record)));
 reply={identity:peer};const member=await api.getMemberIdentity(f.fixture.owner.passwordBoxId,b.accountId,signal);
 reply={identity:peer,extra:null};const memberExtraRefused=await rejected(api.getMemberIdentity(f.fixture.owner.passwordBoxId,b.accountId,signal));
 reply=record;await api.createIdentity(record,signal);
 reply={...record,bundleVersion:2};const wrongVersionRefused=await rejected(api.createIdentity(record,signal));
 reply={grantVersion:1,keyEpoch:context.keyEpoch,stateRevision:8,envelope:JSON.parse(envelope)};await api.putGrant(context.passwordBoxId,7,context,JSON.parse(envelope),signal);
 reply={grantVersion:1,keyEpoch:context.keyEpoch,envelope:JSON.parse(envelope)};await api.getSelfGrant(context.passwordBoxId,context,signal);
 status=403;const removedRefused=await rejected(api.getSelfGrant(context.passwordBoxId,context,signal));
 status=200;reply.envelope.context.senderKeyId='0'.repeat(64);const switchedRefused=await rejected(api.getSelfGrant(context.passwordBoxId,context,signal));
 stage='react-lifetime';
 const React=require(path.join(path.dirname(f.renderer),'react')), renderer=require(f.renderer), {act}=renderer;
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const originalConsoleError=console.error;
 console.error=(...args)=>{if(typeof args[0]==='string'&&args[0].startsWith('react-test-renderer is deprecated.'))return;originalConsoleError(...args);};
 let remoteRecord=record, memberDescriptor=peer, gate=null, locks=0;
 const members=[{userId:a.accountId,email:'owner@example.test',role:'owner',identityConfirmed:true},{userId:b.accountId,email:'peer@example.test',role:'member',identityConfirmed:true}];
 responseHook=async(url,init)=>{
  if(url==='/api/encrypted/account-identity'&&init.method===undefined){if(gate)return gate.promise;return new Response(JSON.stringify(remoteRecord),{status:remoteRecord?200:404});}
  if(url.includes('/member-identities/'))return new Response(JSON.stringify({identity:memberDescriptor}));
  throw Error('unexpected fixture route');
 };
 const panelSandbox={exports:{},document,AbortController,setTimeout:sandbox.setTimeout,clearTimeout:sandbox.clearTimeout,navigator:{locks:{request:async(_key,_options,fn)=>{locks++;return fn();}}},
  require(name){if(name==='react')return React;if(name==='react/jsx-runtime')return require(path.join(path.dirname(f.renderer),'react/jsx-runtime'));
   if(name==='@shared/i18n/I18nProvider')return {useI18n:()=>({t:key=>key})};
   if(name==='../../lib/auth-api')return {listVaultMembers:async()=>members};
   if(name==='../../lib/cloud-worker')return sandbox.exports;
   if(name==='../../lib/cloud-api')return {...apiSandbox.require('./cloud-api'),getBoxState:async()=>({mode:'encrypted',keyEpoch:f.fixture.owner.keyEpoch})};
   if(name==='../../lib/sharing-api')return api;if(name.endsWith('.css'))return {};throw Error('unexpected panel module');}};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(f.root,'frontend/src/pages/app/CloudSharingPanel.tsx'),'utf8'),
  {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,panelSandbox);
 const Panel=panelSandbox.exports.CloudSharingPanel, nodes=new Map();
 const nodeMock=element=>{const key=element.props.name;if(!key)return {};if(!nodes.has(key))nodes.set(key,{value:''});return nodes.get(key);};
 function Shell(props){React.useLayoutEffect(()=>()=>props.worker.dispose(),[props.worker]);return React.createElement(Panel,{...props,key:props.scope.ownerAccountId});}
 const mount=async(worker,scope=f.fixture.owner)=>{let tree;await act(async()=>{tree=renderer.create(React.createElement(Shell,{worker,scope,onLock:()=>{worker.dispose();}}),{createNodeMock:nodeMock});});return tree;};
 const button=(tree,key)=>tree.root.findAllByType('button').find(node=>node.props.children===key);
 const submit=async(tree)=>act(async()=>{tree.root.findByType('form').props.onSubmit({preventDefault(){}});});
 const defer=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
 stage='react-mount'; storage.clear();nodes.clear();remoteRecord=record;
 const [ui,uiw]=await make();await ui.unlock(f.fixture.owner,JSON.stringify(f.fixture.bundle),f.password);const uiTree=await mount(ui);
 stage='react-cancel'; const unpinnedForm=nodes.has('own-code');nodes.get('identity-secret').value=secret;gate=defer();await submit(uiTree);
 const secretClearedOnSubmit=nodes.get('identity-secret').value==='';const callCount=calls.length;
 await act(async()=>{button(uiTree,'sharing.cancel').props.onClick();});
 await act(async()=>{gate.resolve(new Response(JSON.stringify(record)));});gate=null;
 const cancelledUi=uiw.dead&&!uiw.commands.includes('identityPrepare')&&calls.length===callCount;
 await act(async()=>uiTree.unmount());
 stage='react-unmount'; nodes.clear();const [unmount,unmountw]=await make();const unmountTree=await mount(unmount);nodes.get('identity-secret').value=secret;gate=defer();await submit(unmountTree);
 await act(async()=>unmountTree.unmount());await act(async()=>gate.resolve(new Response(JSON.stringify(record))));gate=null;
 const unmountUi=unmountw.dead&&!unmountw.commands.includes('identityPrepare')&&nodes.get('identity-secret').value==='';
 stage='react-switch'; nodes.clear();const [switchOld,sow]=await make();const switchTree=await mount(switchOld);nodes.get('identity-secret').value=secret;gate=defer();await submit(switchTree);
 const heldGate=gate;gate=null;remoteRecord=null;const [switchNew,snw]=await make();
 await act(async()=>switchTree.update(React.createElement(Shell,{worker:switchNew,scope:{...f.fixture.owner,ownerAccountId:b.accountId},onLock:()=>switchNew.dispose()})));
 await act(async()=>heldGate.resolve(new Response(JSON.stringify(record))));
 const accountSwitchUi=sow.dead&&!snw.dead&&!sow.commands.includes('identityPrepare')&&nodes.get('identity-secret').value==='';
 await act(async()=>switchTree.unmount());
 // Missing own pin cannot be replaced with a descriptor copied from a server.
 stage='react-ownpin'; nodes.clear();remoteRecord=record;const [noPin,npw]=await make();const noPinTree=await mount(noPin);nodes.get('identity-secret').value=secret;
 await submit(noPinTree);const missingPinRejected=npw.dead&&button(noPinTree,'sharing.start')===undefined;await act(async()=>noPinTree.unmount());
 // The explicitly entered identity password differs from the old box password.
 stage='react-trust'; nodes.clear();const [confirmed,cfw]=await make();await confirmed.unlock(f.fixture.owner,JSON.stringify(f.fixture.bundle),f.password);const confirmedTree=await mount(confirmed);
 nodes.get('identity-secret').value=secret;nodes.get('own-code').value=own.keyId;await submit(confirmedTree);
 const separatePasswordOpened=cfw.commands.includes('identityPrepare')&&!!button(confirmedTree,'sharing.start')&&button(confirmedTree,'sharing.start').props.disabled;
 await act(async()=>confirmedTree.root.findByType('select').props.onChange({target:{value:b.accountId}}));
 nodes.get('peer-code').value='0'.repeat(64);await act(async()=>button(confirmedTree,'sharing.verify').props.onClick());
 const peerMismatchDisabled=button(confirmedTree,'sharing.start').props.disabled;
 nodes.get('peer-code').value=peer.keyId;await act(async()=>button(confirmedTree,'sharing.verify').props.onClick());const peerMatchEnabled=!button(confirmedTree,'sharing.start').props.disabled;
 const [changed,changedw]=await make();memberDescriptor=JSON.parse(await changed.generateIdentity(b));changed.dispose();
 const beforeChanged=calls.length;await act(async()=>button(confirmedTree,'sharing.start').props.onClick());
 const changedPeerDisabled=button(confirmedTree,'sharing.start').props.disabled&&!calls.slice(beforeChanged).some(call=>call.url.includes('/grants/'));
 await act(async()=>confirmedTree.unmount());
 stage='react-credential';
 let sessionUser={id:a.accountId,email:'owner@example.test'}, credential='synthetic-token-one', sessionValue=null;
 const authSandbox={exports:{},require(name){if(name==='react')return React;if(name==='react/jsx-runtime')return require(path.join(path.dirname(f.renderer),'react/jsx-runtime'));
  if(name==='@passshare/connect')return {ConnectClient:class{constructor(config){this.config=config;}}};
  if(name==='../lib/cloud-worker')return sandbox.exports;
  if(name==='../lib/auth-api')return {fetchCurrentUser:async()=>sessionUser,authFetch:async()=>new Response(JSON.stringify({accessToken:credential})),
    getApiBaseUrl:()=>'',primeCsrfToken:async()=>{},login:async()=>sessionUser,signup:async()=>sessionUser,logout:async()=>{}};
  throw Error('unexpected auth module');}};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(f.root,'frontend/src/hooks/useAuthSession.tsx'),'utf8'),
  {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,authSandbox);
 function Consumer(){sessionValue=authSandbox.exports.useAuthSession();return null;}
 let authTree;await act(async()=>{authTree=renderer.create(React.createElement(authSandbox.exports.AuthSessionProvider,null,React.createElement(Consumer)));});
 const [sameCredential,scw]=await make();await sameCredential.generateIdentity(a);await act(async()=>sessionValue.refreshConnect());const sameCredentialKept=!scw.dead;
 credential='synthetic-token-two';await act(async()=>sessionValue.refreshConnect());const credentialChangeClosed=scw.dead;
 const [accountCredential,acw]=await make();await accountCredential.generateIdentity(a);sessionUser={id:b.accountId,email:'peer@example.test'};
 await act(async()=>sessionValue.refreshConnect());const accountCredentialClosed=acw.dead;
 await act(async()=>authTree.unmount());
 stage='react-legacy-share';
 let encryptedShare=true, legacyRemovals=0;const invitation=defer(), shareTranslate=key=>key;
 const shareSandbox={exports:{},window,document,AbortController,require(name){if(name==='react')return React;
  if(name==='react/jsx-runtime')return require(path.join(path.dirname(f.renderer),'react/jsx-runtime'));
  if(name==='react-router-dom')return {useParams:()=>({vaultId:f.fixture.owner.passwordBoxId}),Link:props=>React.createElement('a',{href:props.to},props.children)};
  if(name==='@shared/i18n/I18nProvider')return {useI18n:()=>({t:shareTranslate})};
  if(name==='../../hooks/useAuthSession')return {useAuthSession:()=>({user:{id:a.accountId},connectClient:{getVault:async()=>({})},refreshConnect:async()=>{}})};
  if(name==='../../lib/cloud-api')return {...apiSandbox.require('./cloud-api'),getBoxState:async()=>({mode:encryptedShare?'encrypted':'compatibility',keyEpoch:encryptedShare?1:null})};
  if(name==='../../lib/auth-api')return {AuthApiError:class extends Error{},listVaultMembers:async()=>members,listVaultInvitations:async()=>[],
    inviteToVault:async()=>invitation.promise,removeVaultMember:async()=>{legacyRemovals++;},revokeVaultInvitation:async()=>{}};
  throw Error('unexpected legacy-share module');}};
 // Keep the dependency identity stable, as the real auth provider does between
 // updates. This avoids turning a fixture object allocation into a refresh loop.
 const shareSession={user:{id:a.accountId},connectClient:{getVault:async()=>({})},refreshConnect:async()=>{}};
 const shareRequire=shareSandbox.require;shareSandbox.require=name=>name==='../../hooks/useAuthSession'?{useAuthSession:()=>shareSession}:shareRequire(name);
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(f.root,'frontend/src/pages/app/VaultSharePage.tsx'),'utf8'),
  {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,shareSandbox);
 const SharePage=shareSandbox.exports.VaultSharePage;let shareTree;
 await act(async()=>{shareTree=renderer.create(React.createElement(SharePage));});
 const encryptedRemoveDisabled=button(shareTree,'app.share.removeMember').props.disabled;
 await act(async()=>button(shareTree,'app.share.removeMember').props.onClick());const encryptedRemoveRefused=legacyRemovals===0;
 await act(async()=>shareTree.root.findByType('input').props.onChange({target:{value:'invite@example.test'}}));
 await act(async()=>shareTree.root.findByType('form').props.onSubmit({preventDefault(){}}));
 await act(async()=>lockCloudUi());await act(async()=>invitation.resolve({id:'synthetic',confirmationCode:'synthetic-invitation-code'}));
 const delayedInviteDiscarded=!JSON.stringify(shareTree.toJSON()).includes('synthetic-invitation-code');
 await act(async()=>shareTree.unmount());encryptedShare=false;
 await act(async()=>{shareTree=renderer.create(React.createElement(SharePage));});
 const compatibilityRemoveEnabled=!button(shareTree,'app.share.removeMember').props.disabled;
 await act(async()=>button(shareTree,'app.share.removeMember').props.onClick());const compatibilityRemoveWorked=legacyRemovals===1;
 await act(async()=>shareTree.unmount());console.error=originalConsoleError;
 process.stdout.write(JSON.stringify({oldItem,sharedItem,stableAfterRefusal,verified,isolated,cancelled,doubleOpenRefused,delayed:typeof delayed==='string',
  transferDetached,attachmentExact,releasedWiped,maximumExact,oversizeRejected,revisionRejected,malformedName,circularContextRejected,detachedOutputLock,attachmentCancelled,attachmentLateWiped,attachmentLockWiped,
   ownerStillAlive:!ow.dead,recipientWrapRefused,recipientRecoveryRefused,identityOnlyExpired,secondHandleDidNotExtend,untrustedExpired,inputExtended,trustedExpired,
   expiredInputConsumed,backgroundClosed:bgw.dead,tokenClosed:tokenw.dead,pausedMonotonicExpired,backwardsClockExpired,invalid,pinIsolation,pendingExact,memberExtraRefused,wrongVersionRefused,removedRefused,switchedRefused,
   member,calls,unpinnedForm,secretClearedOnSubmit,cancelledUi,unmountUi,accountSwitchUi,missingPinRejected,separatePasswordOpened,peerMismatchDisabled,peerMatchEnabled,changedPeerDisabled,locks,
   sameCredentialKept,credentialChangeClosed,accountCredentialClosed,
   encryptedRemoveDisabled,encryptedRemoveRefused,delayedInviteDiscarded,compatibilityRemoveEnabled,compatibilityRemoveWorked,
   listeners:[...listeners.values()].reduce((n,s)=>n+s.size,0)}));
})().catch(error=>{process.stderr.write('transport acceptance failed: '+stage+' '+(['TypeError','Error','ReferenceError'].includes(error.name)?error.name:'rejected'));process.exitCode=1;}); });
"#;
    let mut fixture: Value =
        serde_json::from_str(include_str!("../tests/format1-vector.json")).unwrap();
    // Use the vector's public DTO shape only; all new crypto inputs use OS entropy.
    let password = Zeroizing::new(STANDARD.encode(MasterKey::generate().unwrap().as_bytes()));
    let secret = Zeroizing::new(STANDARD.encode(MasterKey::generate().unwrap().as_bytes()));
    let salt = generate_salt().unwrap();
    let root = derive_master_key_with_params(&password, &salt, 65536, 3, 4).unwrap();
    let key = PasswordBoxKey::generate().unwrap();
    let owner: OwnerKeyContext = serde_json::from_value(fixture["owner"].clone()).unwrap();
    let context: ItemContext = serde_json::from_value(fixture["context"].clone()).unwrap();
    fixture["bundle"] = json!({"format":1,"salt":STANDARD.encode(salt),"wrapped":key.wrap_for_owner(&root,&owner).unwrap()});
    fixture["envelope"] = json!(key.encrypt_item(&fixture["item"], &context).unwrap());
    let mut input = json!({"bindings":args[0],"ts":args[1],"root":args[2],"renderer":args[3],"fixture":fixture,"password":password.as_str(),"secret":secret.as_str()});
    let mut child = Command::new("node")
        .args(["-e", HOST])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let drain = |stream: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            stream.take(65_537).read_to_end(&mut bytes).unwrap();
            bytes
        })
    };
    let stdout = drain(Box::new(stdout));
    let stderr = drain(Box::new(stderr));
    child
        .stdin
        .take()
        .unwrap()
        .write_all(Zeroizing::new(input.to_string()).as_bytes())
        .unwrap();
    for field in ["password", "secret"] {
        if let Value::String(s) = &mut input[field] {
            s.zeroize();
        }
    }
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("transport acceptance deadline");
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let status = child.wait().unwrap();
    let output = stdout.join().unwrap();
    let diagnostics = stderr.join().unwrap();
    if !diagnostics.is_empty() {
        let fixed = String::from_utf8_lossy(&diagnostics);
        for line in fixed.lines() {
            if line.starts_with("transport acceptance failed: ") && line.len() < 100 {
                eprintln!("{line}");
            }
        }
        if let Some(path) = std::env::var_os("PASSSHARE_TRANSPORT_DIAGNOSTICS") {
            std::fs::write(path, &diagnostics).unwrap();
        }
        eprintln!(
            "Node exit {:?}; bounded diagnostic bytes {}",
            status.code(),
            diagnostics.len()
        );
    }
    assert!(
        status.success() && diagnostics.is_empty() && output.len() <= 65_536,
        "Node transport host failed"
    );
    let observed: Value = serde_json::from_slice(&output).expect("bounded transport observations");
    for field in ["oldItem", "sharedItem", "stableAfterRefusal"] {
        assert!(
            serde_json::from_str::<Value>(observed[field].as_str().unwrap()).unwrap()
                == input["fixture"]["item"]
        );
    }
    for field in [
        "transferDetached",
        "attachmentExact",
        "releasedWiped",
        "maximumExact",
        "oversizeRejected",
        "revisionRejected",
        "malformedName",
        "circularContextRejected",
        "detachedOutputLock",
        "attachmentCancelled",
        "attachmentLateWiped",
        "attachmentLockWiped",
        "cancelled",
        "doubleOpenRefused",
        "delayed",
        "recipientWrapRefused",
        "recipientRecoveryRefused",
        "identityOnlyExpired",
        "secondHandleDidNotExtend",
        "untrustedExpired",
        "inputExtended",
        "trustedExpired",
        "expiredInputConsumed",
        "backgroundClosed",
        "tokenClosed",
        "pausedMonotonicExpired",
        "backwardsClockExpired",
        "pinIsolation",
        "pendingExact",
        "memberExtraRefused",
        "wrongVersionRefused",
        "removedRefused",
        "switchedRefused",
        "unpinnedForm",
        "secretClearedOnSubmit",
        "cancelledUi",
        "unmountUi",
        "accountSwitchUi",
        "missingPinRejected",
        "separatePasswordOpened",
        "peerMismatchDisabled",
        "peerMatchEnabled",
        "changedPeerDisabled",
        "sameCredentialKept",
        "credentialChangeClosed",
        "accountCredentialClosed",
        "encryptedRemoveDisabled",
        "encryptedRemoveRefused",
        "delayedInviteDiscarded",
        "compatibilityRemoveEnabled",
        "compatibilityRemoveWorked",
    ] {
        assert_eq!(observed[field], true, "{field}");
    }
    assert_eq!(
        observed["invalid"],
        serde_json::to_value([true; 8]).unwrap()
    );
    assert_eq!(observed["listeners"], 0);
    assert_eq!(
        observed["calls"][0]["url"],
        format!(
            "/api/encrypted/boxes/{}/member-identities/22222222-2222-4222-8222-222222222222",
            fixture["owner"]["passwordBoxId"].as_str().unwrap()
        )
    );
    assert_eq!(
        observed["calls"][2]["url"],
        "/api/encrypted/account-identity"
    );
    assert_eq!(observed["calls"][2]["body"]["expectedVersion"], 0);
    assert!(observed["calls"][2]["body"]
        .get("currentPassword")
        .is_none());
    assert_eq!(observed["calls"][4]["body"]["expectedStateRevision"], 7);
    assert_eq!(observed["calls"][5]["body"], Value::Null);
    println!("WASM + Web transport: binary attachments (transfer, maximum, context, release, cancel/late, detached lock), owner/shared full JSON, independent code, exact routes, pins, strict fields, idle/input/background/credential boundaries passed");
}
