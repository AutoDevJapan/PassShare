// Controlled renderer/HTTP hosts. These results are not native WebView or PG evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import http from 'node:http';
import ts from '../node_modules/typescript/lib/typescript.js';
import { createRequire } from 'node:module';
const requireApp = createRequire(new URL('../../apps/mobile/package.json', import.meta.url));
const React = requireApp('react'), renderer = requireApp('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const root = new URL('../../shared/cloud/', import.meta.url);
function load(name, imports = {}, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL(name, root), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: (id) => {
    if (!(id in imports)) throw new Error(`Unmapped import ${id}`);
    return imports[id];
  }, URL, Headers, Response, AbortController, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer,
  setTimeout, clearTimeout, atob, btoa, ...globals });
  return exports;
}
const cloudApi = load('cloud-api.ts');
const sharingApi = load('sharing-api.ts', { './cloud-api': cloudApi });
const sessionModule = (fetch) => load('session-transport.ts', { './cloud-api': cloudApi, './sharing-api': sharingApi }, { fetch });
const box = 'a'.repeat(26), owner = '11111111-1111-4111-8111-111111111111';
const flush = () => renderer.act(async () => { for (let n = 0; n < 10; n++) await new Promise(setImmediate); });
function events() {
  const listeners = new Map();
  return { addEventListener(type, fn) { const set = listeners.get(type) ?? new Set(); set.add(fn); listeners.set(type, set); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); }, dispatchEvent(event) { for (const fn of [...(listeners.get(event.type) ?? [])]) fn(event); },
    count: () => [...listeners.values()].reduce((n, set) => n + set.size, 0) };
}
function host({ mode = 'encrypted', failure = null, delayedUnlock = false, recipient = false } = {}) {
  const window = events(), document = { ...events(), visibilityState: 'visible' };
  const input = { value: 'synthetic-encryption-password' }, workers = [], calls = [], legacy = [], unlocks = [];
  let release, tree;
  class Worker {
    constructor() { this.isClosed = false; this.closed = new Promise((resolve) => { this.close = resolve; }); this.ready = Promise.resolve(); workers.push(this); }
    dispose() { this.isClosed = true; this.close(); }
    async unlock(scope, bundle, secret) { unlocks.push({ scope, bundle, secret }); if (delayedUnlock) await new Promise((resolve) => { release = resolve; }); }
  }
  const session = { userId: owner, api: {
    async getBoxState(id, signal) { calls.push({ id, signal }); if (failure) throw new cloudApi.CloudApiError(failure); return { mode, keyEpoch: mode === 'encrypted' ? 17 : null }; },
    getOwnerBundle: async () => ({ bundle: 'opaque-owner-bundle' }), bundleText: (text) => text,
  }, listVaultMembers: async () => [{ userId: owner, role: recipient ? 'member' : 'owner', identityConfirmed: true }], sharing: {} };
  function Items() { return React.createElement('output', null, 'encrypted-items'); }
  function Sharing() { return React.createElement('output', null, 'independent-pin-entry'); }
  const { CloudBoxPanel } = load('CloudBoxPanel.tsx', {
    react: React, 'react/jsx-runtime': requireApp('react/jsx-runtime'), '@shared/i18n/I18nProvider': { useI18n: () => ({ t: (key) => key }) },
    './cloud-api': cloudApi, './cloud-worker': { CloudWorker: Worker }, './EncryptedItems': { EncryptedItems: Items },
    './CloudSharingPanel': { SharedCloudSharingPanel: Sharing }, './client-cloud.css': {},
  }, { window, document });
  const compatibility = (ensure) => { legacy.push(ensure); return React.createElement('output', null, 'compatibility-items'); };
  renderer.act(() => { tree = renderer.create(React.createElement(CloudBoxPanel, { session, boxId: box, compatibility }), { createNodeMock: () => input }); });
  return { tree, input, workers, window, document, legacy, unlocks, calls, session,
    setMode(value) { mode = value; }, release: () => release?.(),
    async submit() { renderer.act(() => tree.root.findByType('form').props.onSubmit({ preventDefault() {} })); await flush(); },
    async lock() { renderer.act(() => window.dispatchEvent({ type: 'passshare:cloud-lock' })); await flush(); },
    async unmount() { renderer.act(() => tree.unmount()); await flush(); },
    json: () => JSON.stringify(tree.toJSON()) };
}

test('simultaneous immutable native sessions use their own session bearer, never cookies or another account', async () => {
  const requests = [];
  const { createCloudSession } = sessionModule(async (url, init) => { requests.push({ url: url.href, init }); return new Response('{"mode":"encrypted","keyEpoch":17}'); });
  const first = createCloudSession('https://first.example.invalid', 'first', 'session-first');
  const second = createCloudSession('https://second.example.invalid', 'second', 'session-second');
  await Promise.all([first.api.getBoxState(box), second.api.getBoxState(box)]);
  assert.deepEqual(requests.map((r) => r.init.headers.get('Authorization')), ['Bearer session-first', 'Bearer session-second']);
  assert.deepEqual(requests.map((r) => new URL(r.url).hostname), ['first.example.invalid', 'second.example.invalid']);
  for (const { init } of requests) { assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store'); }
  assert.equal(Object.isFrozen(first), true); first.dispose(); second.dispose();
});

test('account/epoch change during a held HTTP response cannot return that old response', async () => {
  let release, current = true;
  const { createCloudSession } = sessionModule(() => new Promise((resolve) => { release = resolve; }));
  const session = createCloudSession('https://example.invalid', owner, 'synthetic-session', () => current);
  const pending = session.api.getBoxState(box); current = false;
  release(new Response('{"mode":"encrypted","keyEpoch":17}'));
  await assert.rejects(pending, (error) => error.status === 401);
  session.dispose();
});

test('dispose aborts a held request and rejects later requests before network activity', async () => {
  let signal, sends = 0;
  const { createCloudSession } = sessionModule((_url, init) => { sends++; signal = init.signal; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); });
  const session = createCloudSession('https://example.invalid', owner, 'synthetic-session');
  const pending = session.api.getBoxState(box); session.dispose();
  assert.equal(signal.aborted, true); await assert.rejects(pending);
  await assert.rejects(session.api.getBoxState(box), (error) => error.status === 401);
  assert.equal(sends, 1);
});

test('real redirect response is not followed and cannot transmit the session bearer to its destination', async () => {
  let direct = 0, redirected = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/destination') { redirected++; response.end('{}'); }
    else { direct++; response.writeHead(302, { Location: '/destination' }); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { createCloudSession } = sessionModule(fetch);
  const session = createCloudSession(`http://127.0.0.1:${server.address().port}`, owner, 'synthetic-session');
  try { await assert.rejects(session.api.getBoxState(box)); assert.equal(direct, 1); assert.equal(redirected, 0); }
  finally { session.dispose(); await new Promise((resolve) => server.close(resolve)); }
});

for (const status of [401, 403, 409, 404]) test(`failed mode ${status} cannot mount compatibility or start a worker`, async () => {
  const h = host({ failure: status }); await flush();
  assert.equal(h.legacy.length, 0); assert.equal(h.workers.length, 0); assert.equal(h.tree.root.findAllByType('form').length, 0);
  await h.unmount(); assert.equal(h.window.count(), 0); assert.equal(h.document.count(), 0);
});

test('compatibility gate sees encryption before any subsequent legacy operation', async () => {
  const h = host({ mode: 'compatibility' }); await flush();
  assert.ok(h.legacy.length); const ensure = h.legacy.at(-1);
  await ensure(); h.setMode('encrypted');
  await renderer.act(async () => { await assert.rejects(ensure(), (error) => error.status === 409); });
  assert.equal(h.json().includes('compatibility-items'), false);
  await assert.rejects(ensure(), (error) => error.status === 409); await h.unmount();
});

for (const end of ['lock', 'background', 'unmount']) test(`held unlock after ${end} cannot reveal a prior worker or draft`, async () => {
  const h = host({ delayedUnlock: true }); await flush(); await h.submit();
  assert.equal(h.input.value, ''); assert.equal(h.unlocks[0].scope.keyEpoch, 17); assert.equal(h.legacy.length, 0);
  if (end === 'background') { h.document.visibilityState = 'hidden'; renderer.act(() => h.document.dispatchEvent({ type: 'visibilitychange' })); }
  else await h[end]();
  h.release(); await flush(); assert.equal(h.workers[0].isClosed, true);
  assert.equal(h.json().includes('"encrypted-items"'), false);
  if (end !== 'unmount') await h.unmount();
});

test('recipient enters independent identity/pin flow without an owner password or legacy items', async () => {
  const h = host({ recipient: true }); await flush();
  assert.equal(h.tree.root.findAllByType('input').length, 0); await h.submit();
  assert.equal(h.json().includes('independent-pin-entry'), true);
  assert.equal(h.unlocks.length, 0); assert.equal(h.legacy.length, 0); await h.unmount();
});

function backgroundHost() {
  let listener, mode = 'compatibility', account = owner, disposed = 0, details = 0, writes = 0;
  const chrome = { runtime: { onMessage: { addListener(fn) { listener = fn; } } }, alarms: { onAlarm: { addListener() {} } } };
  class Client {
    async listVaults() { return [{ id: box }]; }
    async listItems() { return [{ id: 'b'.repeat(26), category: 'LOGIN' }]; }
    async getItem() { details++; return { id: 'b'.repeat(26), title: 'Synthetic', username: 'synthetic-user', password: 'synthetic-password', url: 'https://example.invalid' }; }
    async createItem() { writes++; }
  }
  load('../../packages/extension/src/background/service-worker.ts', {
    '@passshare/connect': { ConnectClient: Client },
    '../lib/auth-api': { fetchCurrentUser: async () => ({ id: account }), getApiBaseUrl: () => 'https://example.invalid', refreshConnectToken: async () => ({}) },
    '../lib/constants': { OFFSCREEN_CLEAR_CLIPBOARD: 'offscreen' },
    './clipboard-clear': { handleClipboardClearAlarm() {}, scheduleClipboardClear() {} },
    '../lib/connect-items': { connectItemFromApi: (item) => item, connectItemToCreateBody: (body) => body, hostnameMatchesItem: () => true },
    '../lib/password-generator': { generatePassword: () => 'synthetic-generated' },
    '../lib/storage': { clearAllAuthStorage() {}, loadRefreshToken: async () => 'synthetic-session', loadStoredConnectToken: async () => ({ token: 'synthetic-connect' }), saveConnectToken() {} },
    '@shared/lib/connect-session': { async bootstrapConnectSession(storage) { await storage.load(); return { user: { id: account }, accessToken: 'synthetic-connect' }; } },
    '@shared/cloud/session-transport': { createCloudSession: () => ({ userId: account, api: { getBoxState: async () => ({ mode }) }, dispose() { disposed++; } }) },
  }, { chrome });
  return { send: (message) => new Promise((resolve) => listener(message, {}, resolve)),
    setMode(value) { mode = value; }, setAccount(value) { account = value; },
    get details() { return details; }, get writes() { return writes; }, get disposed() { return disposed; } };
}

test('background discovery excludes encrypted boxes and never returns cached plaintext passwords', async () => {
  const h = backgroundHost();
  const first = await h.send({ type: 'GET_CREDENTIALS_FOR_HOST', hostname: 'example.invalid' });
  assert.equal(first.ok, true); assert.equal(first.matches[0].password, ''); assert.equal(first.matches[0].accountId, owner);
  assert.equal(h.details, 1);
  h.setMode('encrypted');
  const after = await h.send({ type: 'GET_CREDENTIALS_FOR_HOST', hostname: 'example.invalid' });
  assert.equal(after.ok, true); assert.equal(after.matches.length, 0); assert.equal(h.details, 1); assert.equal(h.disposed, 2);
});

test('background fill and page save recheck current mode and cannot consume a prior account selection', async () => {
  const h = backgroundHost();
  const request = { type: 'FILL_CREDENTIAL', accountId: owner, vaultId: box, itemId: 'b'.repeat(26) };
  const before = await h.send(request); assert.equal(before.ok, true); assert.equal(before.matches[0].password, 'synthetic-password');
  h.setMode('encrypted'); assert.equal((await h.send(request)).ok, false); assert.equal(h.details, 1);
  assert.equal((await h.send({ type: 'SAVE_CREDENTIAL', password: 'synthetic-page-secret' })).ok, false); assert.equal(h.writes, 0);
  h.setMode('compatibility'); h.setAccount('22222222-2222-4222-8222-222222222222');
  assert.equal((await h.send(request)).ok, false); assert.equal(h.details, 1);
  h.setAccount(owner); assert.equal((await h.send(request)).ok, true); assert.equal(h.details, 2);
  assert.equal(h.disposed, 5);
});
