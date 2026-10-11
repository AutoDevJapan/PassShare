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
  ReadableStream, setTimeout, clearTimeout, atob, btoa, ...globals });
  return exports;
}
const cloudApi = load('cloud-api.ts');
const sharingApi = load('sharing-api.ts', { './cloud-api': cloudApi });
const boxMode = load('box-mode.ts', { './cloud-api': cloudApi });
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
  let release, tree, epoch = 17;
  class Worker {
    constructor() { this.isClosed = false; this.closed = new Promise((resolve) => { this.close = resolve; }); this.ready = Promise.resolve(); workers.push(this); }
    dispose() { this.isClosed = true; this.close(); }
    async unlock(scope, bundle, secret) { unlocks.push({ scope, bundle, secret }); if (delayedUnlock) await new Promise((resolve) => { release = resolve; }); }
  }
  const session = { userId: owner, api: {
    async getBoxState(id, signal) { calls.push({ id, signal }); if (failure) throw new cloudApi.CloudApiError(failure); return { mode, keyEpoch: mode === 'encrypted' ? epoch : null }; },
    getOwnerBundle: async () => ({ bundle: 'opaque-owner-bundle' }), bundleText: (text) => text,
  }, listVaultMembers: async () => [{ userId: owner, role: recipient ? 'member' : 'owner', identityConfirmed: true }], sharing: {} };
  function Items() { return React.createElement('output', null, 'encrypted-items'); }
  function Sharing() { return React.createElement('output', null, 'independent-pin-entry'); }
  const { CloudBoxPanel } = load('CloudBoxPanel.tsx', {
    react: React, 'react/jsx-runtime': requireApp('react/jsx-runtime'), '@shared/i18n/I18nProvider': { useI18n: () => ({ t: (key) => key }) },
    './cloud-api': cloudApi, './cloud-worker': { CloudWorker: Worker }, './EncryptedItems': { EncryptedItems: Items },
    './box-mode': boxMode,
    './CloudSharingPanel': { SharedCloudSharingPanel: Sharing }, './client-cloud.css': {},
  }, { window, document });
  const compatibility = (ensure) => { legacy.push(ensure); return React.createElement('output', null, 'compatibility-items'); };
  renderer.act(() => { tree = renderer.create(React.createElement(CloudBoxPanel, { session, boxId: box, compatibility }), { createNodeMock: () => input }); });
  return { tree, input, workers, window, document, legacy, unlocks, calls, session,
    setMode(value) { mode = value; }, release: () => release?.(),
    setEpoch(value) { epoch = value; }, setFailure(value) { failure = value; },
    async recheck() { renderer.act(() => tree.update(React.createElement(CloudBoxPanel, { session, boxId: box, compatibility, metadataProof: async () => {} }))); await flush(); },
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

for (const end of ['dispose', 'caller-abort']) test(`session owns a delayed response body through ${end}`, async () => {
  let source, cancelled = false;
  const { createCloudSession } = sessionModule(async () => new Response(new ReadableStream({
    start(controller) { source = controller; }, cancel() { cancelled = true; },
  })));
  const session = createCloudSession('https://example.invalid', owner, 'synthetic-session');
  const caller = new AbortController();
  const pending = session.api.getBoxState(box, caller.signal);
  await new Promise(setImmediate);
  if (end === 'dispose') session.dispose(); else caller.abort();
  if (!cancelled) { source.enqueue(new TextEncoder().encode('{"mode":"encrypted","keyEpoch":17}')); source.close(); }
  await assert.rejects(pending);
  assert.equal(cancelled, true); session.dispose();
});

test('response EOF releases upstream abort listener without requiring caller abort', async () => {
  const caller = new AbortController(), attached = new Set();
  const add = caller.signal.addEventListener.bind(caller.signal), remove = caller.signal.removeEventListener.bind(caller.signal);
  caller.signal.addEventListener = (name, fn, options) => { attached.add(fn); add(name, fn, options); };
  caller.signal.removeEventListener = (name, fn, options) => { attached.delete(fn); remove(name, fn, options); };
  const { createCloudSession } = sessionModule(async () => new Response('{"mode":"encrypted","keyEpoch":17}'));
  const session = createCloudSession('https://example.invalid', owner, 'synthetic-session');
  await session.api.getBoxState(box, caller.signal);
  assert.equal(caller.signal.aborted, false); assert.equal(attached.size, 0); session.dispose();
});

test('a broken successful response body remains an unknown outcome, not an authorization failure', async () => {
  const { createCloudSession } = sessionModule(async () => new Response(new ReadableStream({
    start(controller) { controller.error(new TypeError('synthetic connection reset')); },
  })));
  const session = createCloudSession('https://example.invalid', owner, 'synthetic-session');
  const response = await session.transport('/api/encrypted/account-identity', { method: 'PUT', body: '{"opaque":"synthetic"}' });
  await assert.rejects(response.text(), (error) => error.status === 0); session.dispose();
});

test('authorization rejection cancels the unread response body rather than retaining its reader', async () => {
  let cancelled = 0;
  const { createCloudSession } = sessionModule(async () => new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 403 }));
  const session = createCloudSession('https://example.invalid', owner, 'synthetic-session');
  await assert.rejects(session.sharing.getIdentity(new AbortController().signal), (error) => error.status === 403);
  assert.equal(cancelled, 1); session.dispose(); assert.equal(cancelled, 1);
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

for (const change of ['epoch', 'authorization']) test(`same-account metadata refresh after ${change} destroys the held worker and decrypted screen`, async () => {
  const h = host(); await flush(); await h.submit();
  assert.equal(h.json().includes('"encrypted-items"'), true);
  if (change === 'epoch') h.setEpoch(18); else h.setFailure(403);
  await h.recheck(); assert.equal(h.workers[0].isClosed, true);
  assert.equal(h.json().includes('"encrypted-items"'), false); await h.unmount();
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
    '../lib/storage': { clearAllAuthStorage() {}, loadRefreshToken: async () => 'synthetic-session', loadStoredAuthSession: async () => ({ refreshToken: 'synthetic-session', connectAccessToken: 'synthetic-connect' }), saveConnectToken() {} },
    '@shared/lib/connect-session': { async bootstrapConnectSession(storage) { await storage.load(); return { user: { id: account }, accessToken: 'synthetic-connect' }; } },
    '@shared/cloud/session-transport': { createCloudSession: () => ({ userId: account, api: { getBoxState: async () => ({ mode }) }, dispose() { disposed++; } }) },
    '@shared/cloud/box-mode': boxMode,
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

function storedSessionHost() {
  const keys = { refreshToken: 'refresh', connectToken: 'connect', connectExpiresAt: 'expiry' }, values = new Map();
  let queue = Promise.resolve(), held = false, release, reads = 0;
  const navigator = { locks: { request(_name, action) { const result = queue.then(action); queue = result.catch(() => {}); return result; } } };
  const chrome = { runtime: {}, storage: { local: {
    get(names, done) { reads++; queueMicrotask(() => done(Object.fromEntries(names.map((key) => [key, values.get(key)])))); },
    set(entries, done) { const write = () => { for (const [key, value] of Object.entries(entries)) values.set(key, value); done(); };
      if (held) { held = false; release = write; } else queueMicrotask(write); },
    remove(names, done) { for (const key of names) values.delete(key); queueMicrotask(done); },
  } } };
  const api = load('../../packages/extension/src/lib/storage.ts', { './constants': { STORAGE_KEYS: keys } }, { navigator, chrome });
  return { api, values, holdNext() { held = true; }, release: () => release(), get reads() { return reads; } };
}

const authA = { refreshToken: 'session-A', connectAccessToken: 'connect-A', connectExpiresAt: '2040-01-01T00:00:00Z' };
const authB = { refreshToken: 'session-B', connectAccessToken: 'connect-B', connectExpiresAt: '2041-01-01T00:00:00Z' };

test('a late popup session write is erased before a new account may persist its complete session', async () => {
  const h = storedSessionHost(); let current = true;
  h.holdNext(); const old = h.api.saveStoredAuthSession(authA, () => current);
  await new Promise(setImmediate); current = false;
  const next = h.api.saveStoredAuthSession(authB); h.release();
  assert.equal(await old, false); assert.equal(await next, true);
  assert.deepEqual(JSON.parse(JSON.stringify(await h.api.loadStoredAuthSession())), authB);
  assert.equal([...h.values.values()].some((value) => value.includes('session-A') || value.includes('connect-A')), false);
});

test('old refresh/logout storage callbacks cannot replace or erase a newer account', async () => {
  const h = storedSessionHost(); await h.api.saveStoredAuthSession(authB);
  await h.api.saveConnectToken('stale-connect-A', authA.connectExpiresAt, authA.refreshToken);
  await h.api.clearAllAuthStorage(authA.refreshToken);
  const before = h.reads;
  assert.deepEqual(JSON.parse(JSON.stringify(await h.api.loadStoredAuthSession())), authB);
  assert.equal(h.reads - before, 1);
  await h.api.clearAllAuthStorage(authB.refreshToken); assert.equal(await h.api.loadStoredAuthSession(), null);
});

test('flag-off compatibility needs authoritative metadata and is forbidden after observing encrypted mode', async () => {
  let proofs = 0, denied = false;
  const api = { getBoxState: async () => { throw new cloudApi.CloudApiError(404); } };
  const proof = async () => { proofs++; if (denied) throw new cloudApi.CloudApiError(409); };
  const signal = new AbortController().signal;
  await assert.rejects(boxMode.readBoxMode(api, box, signal), (error) => error.status === 404);
  assert.equal(proofs, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(await boxMode.readBoxMode(api, box, signal, proof))), { mode: 'compatibility', keyEpoch: null });
  denied = true; await assert.rejects(boxMode.readBoxMode(api, box, signal, proof), (error) => error.status === 409);
  denied = false; await assert.rejects(boxMode.readBoxMode(api, box, signal, proof, true), (error) => error.status === 404);
  assert.equal(proofs, 2);
});

test('legacy archive never reads or uploads file bytes for encrypted/rejected modes, while proven compatibility works', async () => {
  let modeStatus = 200, encrypted = true, metadataStatus = 200, reads = 0, uploads = 0;
  const imports = load('../../shared/lib/1pux-import.ts', {}, { fetch: async (url, init) => {
    if (url.endsWith('/csrf')) return new Response('{"csrfToken":"synthetic-csrf"}');
    if (url.endsWith('/login')) return new Response('{}');
    if (url.includes('/api/encrypted/')) return new Response(JSON.stringify({ mode: encrypted ? 'encrypted' : 'compatibility', keyEpoch: encrypted ? 17 : null }), { status: modeStatus });
    if (url.endsWith('/connect-token')) return new Response('{"accessToken":"synthetic-connect"}');
    if (url.endsWith(`/v1/vaults/${box}`)) return new Response('{}', { status: metadataStatus });
    if (url.endsWith('/imports/1pux')) { uploads++; assert.equal(atob(JSON.parse(init.body).base64), '\u0000\u00ff'); return new Response('{"imported":1}'); }
    throw new Error('Unexpected route');
  } });
  const file = { arrayBuffer: async () => { reads++; return new Uint8Array([0, 255]).buffer; } };
  const run = () => imports.import1puxWithSession('https://example.invalid', box, file, 'synthetic@example.invalid', 'synthetic-login');
  await assert.rejects(run()); assert.equal(reads, 0); assert.equal(uploads, 0);
  modeStatus = 404; metadataStatus = 409; await assert.rejects(run()); assert.equal(reads, 0); assert.equal(uploads, 0);
  metadataStatus = 200; await run(); assert.equal(reads, 1); assert.equal(uploads, 1);
  encrypted = false; modeStatus = 200; await run(); assert.equal(reads, 2); assert.equal(uploads, 2);
});
