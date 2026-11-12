import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import ts from '../node_modules/typescript/lib/typescript.js';

const requireMobile = createRequire(new URL('../../apps/mobile/package.json', import.meta.url));
const React = requireMobile('react');
const renderer = requireMobile('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const ownerA = '11111111-1111-4111-8111-111111111111';
const ownerB = '22222222-2222-4222-8222-222222222222';
const flush = () => renderer.act(async () => { for (let i=0;i<8;i++) await new Promise(setImmediate); });

// Execute the real Provider and Web receipt adapter. HTTP is a controlled host;
// this does not claim a browser cookie implementation or PostgreSQL acceptance.
function load(relative, imports) {
  const exports = {};
  const source = fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, {compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  }}).outputText, {exports, require(id) {
    if (!Object.hasOwn(imports,id)) throw new Error(`Unmapped import ${id}`);
    return imports[id];
  }, Headers, Response, ReadableStream, AbortController, TextDecoder, TextEncoder});
  return exports;
}

async function host() {
  let account = {id: ownerA}, status = 200, current, finishLogout;
  const requests = [];
  const receiptId = '33333333-3333-4333-8333-333333333333';
  const auth = {
    fetchCurrentUser: async () => account,
    getApiBaseUrl: () => 'https://example.invalid',
    primeCsrfToken: async () => {},
    logout: () => new Promise(resolve => {finishLogout=resolve;}),
    login: async () => account, signup: async () => account,
    async authFetch(path, init) {
      if (path === '/api/auth/connect-token') return Response.json({accessToken:'synthetic'}, {status});
      requests.push({path,init});
      return Response.json({id:receiptId,status:'received',revision:0,history:[],createdAt:'2026-11-13T00:00:00Z',
        request:JSON.parse(init.body),meaning:'request_received_not_contract_or_payment_confirmation'}, {status:201});
    },
  };
  const shared = load('../../shared/cloud/support-receipts-api.ts', {});
  const web = load('../src/lib/support-receipts-api.ts', {'@shared/cloud/support-receipts-api':shared,'./auth-api':auth});
  const provider = load('../src/hooks/useAuthSession.tsx', {
    react:React, 'react/jsx-runtime':requireMobile('react/jsx-runtime'),
    '@passshare/connect':{ConnectClient:class {}}, '../lib/cloud-worker':{lockCloudUi() {}},
    '../lib/auth-api':auth, '../lib/support-receipts-api':web,
  });
  function Consumer() {current=provider.useAuthSession();return null;}
  let tree;
  await renderer.act(async () => {tree=renderer.create(React.createElement(provider.AuthSessionProvider,null,React.createElement(Consumer)));});
  await flush();
  const request={requestId:receiptId,kind:'technical',version:'0.1.0',platform:'web',errorCode:''};
  return {get current(){return current;},requests,request,
    setAccount(id){account=id ? {id} : null;}, setStatus(value){status=value;},
    finishLogout(){finishLogout();},
    async unmount(){await renderer.act(async()=>tree.unmount());},
  };
}

test('Provider exposes owner-bound receipts and invalidates them before logout response', async () => {
  const h=await host();
  try {
    const client=h.current.supportClient;
    await client.create(h.request,new AbortController().signal);
    assert.equal(h.requests[0].init.headers.get('X-PassShare-Receipt-Owner'),ownerA);
    let logout;
    renderer.act(()=>{logout=h.current.logout();});
    await assert.rejects(client.create(h.request,new AbortController().signal));
    assert.equal(h.requests.length,1);
    assert.equal(h.current.supportClient,null);
    await renderer.act(async()=>h.current.refreshConnect());
    assert.equal(h.current.supportClient,null,'logout owns authentication until its response');
    h.finishLogout();await renderer.act(async()=>logout);
  } finally {await h.unmount();}
});

test('same-account refresh preserves client; account change and unmount revoke old ownership', async () => {
  const h=await host();
  let unmounted=false;
  try {
    const first=h.current.supportClient;
    await renderer.act(async()=>h.current.refresh());
    assert.equal(h.current.supportClient,first);
    h.setAccount(ownerB);await renderer.act(async()=>h.current.refresh());
    await assert.rejects(first.create(h.request,new AbortController().signal));
    const second=h.current.supportClient;
    await second.create(h.request,new AbortController().signal);
    assert.equal(h.requests[0].init.headers.get('X-PassShare-Receipt-Owner'),ownerB);
    await h.unmount();unmounted=true;
    await assert.rejects(second.create(h.request,new AbortController().signal));
    assert.equal(h.requests.length,1);
  } finally {if(!unmounted)await h.unmount();}
});

test('confirmed credential rejection clears receipt ownership without waiting for another render route', async () => {
  const h=await host();
  try {
    const old=h.current.supportClient;
    h.setStatus(401);await renderer.act(async()=>h.current.refresh());
    assert.equal(h.current.supportClient,null);
    await assert.rejects(old.create(h.request,new AbortController().signal));
    assert.equal(h.requests.length,0);
  } finally {await h.unmount();}
});

test('release WASM acceptance host resolves the real Provider receipt dependencies', () => {
  const rust=fs.readFileSync(new URL('../../packages/cloud-wasm/examples/web_transport_acceptance.rs',import.meta.url),'utf8');
  const start=rust.indexOf(" stage='react-credential';"), end=rust.indexOf(' function Consumer()',start);
  assert.ok(start>=0 && end>start);
  const root=fileURLToPath(new URL('../../',import.meta.url));
  const context={stage:'',a:{accountId:ownerA},f:{root,renderer:path.join(root,'apps/mobile/node_modules/react-test-renderer')},
    React,ts,fs,path,vm,require:requireMobile,sandbox:{exports:{lockCloudUi(){}}},
    Headers,Response,ReadableStream,AbortController,TextDecoder,TextEncoder};
  vm.runInNewContext(rust.slice(start,end)+';globalThis.providerExports=authSandbox.exports;',context);
  assert.equal(typeof context.providerExports.AuthSessionProvider,'function');
  assert.equal(typeof context.providerExports.useAuthSession,'function');
});
