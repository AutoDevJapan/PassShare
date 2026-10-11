// Node React host fixture. No browser, production crypto, or server is replaced
// by this acceptance evidence: worker/API boundaries are controlled explicitly.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from '../node_modules/typescript/lib/typescript.js';
import { createRequire } from 'node:module';
const reactRequire = createRequire(new URL('../../apps/mobile/package.json', import.meta.url));
const React = reactRequire('react');
const renderer = reactRequire('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const root = new URL('../', import.meta.url);
const box = 'a'.repeat(26), itemId = 'b'.repeat(26), attachmentId = 'c'.repeat(26);
const owner = '11111111-1111-4111-8111-111111111111';
const scope = { passwordBoxId: box, ownerAccountId: owner, keyEpoch: 1 };
const itemContext = { passwordBoxId: box, itemId, itemVersion: 17, keyEpoch: 1 };
const values = { title: 'Original', category: 'LOGIN', username: 'user', password: 'synthetic', url: 'https://example.invalid', notes: '', body: '', tags: '', favorite: false };
const seed = { id: itemId, version: 17, vault: { id: box, custom: null }, ...values,
  fields: [{ custom: [null, { value: 'synthetic' }] }], urls: [{ href: values.url, custom: null }],
  attachments: [{ attachmentId, attachmentVersion: 17, keyEpoch: 1, custom: { keep: [null, 7] } }], unknown: { order: [3, 2, 1] } };
function moduleAt(path, imports, globals = {}) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(new URL(path, root), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(source, { exports, require: (id) => { if (!(id in imports)) throw new Error(`Missing fixture import: ${id}`); return imports[id]; },
    Uint8Array, ArrayBuffer, Blob, URL, TextEncoder, TextDecoder, AbortController, Number, Object, ...globals });
  return exports;
}
function apiAt(imports, globals) {
  const module = moduleAt('../shared/cloud/cloud-api.ts', {}, globals);
  return module.createCloudApi(imports['./auth-api'].authFetch);
}
function target() {
  const listeners = new Map();
  return { addEventListener(type, fn) { const set = listeners.get(type) ?? new Set(); set.add(fn); listeners.set(type, set); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatchEvent(event) { for (const fn of [...(listeners.get(event.type) ?? [])]) fn(event); },
    count: () => [...listeners.values()].reduce((n, set) => n + set.size, 0) };
}
const flush = async () => { await renderer.act(async () => { for (let n = 0; n < 20; n++) await new Promise(setImmediate); }); };
function all(node, predicate) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap((child) => all(child, predicate));
  return [...(predicate(node) ? [node] : []), ...all(node.props?.children, predicate)];
}
function host({ empty = false, attachmentFailure = null, itemFailure = null, holdRead = false, unavailable = false, realReact = false } = {}) {
  const window = target(), document = { ...target(), visibilityState: 'visible', activeElement: { focus() {} }, body: { append() {} },
    createElement: () => ({ click() { calls.download++; }, remove() {} }) };
  const hooks = []; let slot = 0, effects = [], cleanups = [], tree, mounted, userId = owner, heldScope = { ...scope }, locked = 0;
  const fileInput = { value: '', files: null, click() {}, multiple: true };
  const jsx = (type, props) => ({ type, props: props ?? {} });
  function ItemForm() {}
  const labels = Object.fromEntries(['searchPlaceholder', 'submitAdd', 'submitSave', 'edit', 'delete', 'cancelEdit', 'emptyList', 'notSet'].map((name) => [name, name]));
  const calls = { create: 0, item: [], attachment: [], encrypt: [], readBuffers: [], decryptSources: [], download: 0, released: [], revoked: [] };
  const envelopes = new Map(); let nonce = 0, revision = 17, releaseRead;
  const seal = (full, context) => {
    const text = JSON.stringify({ format: 1, context, nonce: String(++nonce), ciphertext: 'opaque' }); envelopes.set(text, structuredClone(full)); return text;
  };
  const initial = seal(seed, itemContext);
  let closeWorker;
  const worker = { isClosed: false, closed: new Promise((resolve) => { closeWorker = resolve; }), dispose() { this.isClosed = true; closeWorker(); },
    async decrypt(envelope) { return JSON.stringify(envelopes.get(envelope)); },
    async createItem(text) { calls.create++; const full = { id: itemId, version: 1, vault: { id: box }, ...JSON.parse(text), attachments: [] }; return seal(full, { ...itemContext, itemVersion: 1 }); },
    async editItem(original, text, context) { const full = JSON.parse(original); Object.assign(full, JSON.parse(text)); full.version = context.itemVersion; return seal(full, context); },
    async editAttachmentItem(original, text, context) {
      const full = JSON.parse(original), request = JSON.parse(text); full.version = context.itemVersion;
      const refs = full.attachments ??= [];
      if (request.action === 'add') refs.push({ attachmentId: 'd'.repeat(25) + String(refs.length), attachmentVersion: 1, keyEpoch: 1 });
      else if (request.action === 'remove') full.attachments = refs.filter((r) => r.attachmentId !== request.attachmentId);
      else refs.find((r) => r.attachmentId === request.attachmentId).attachmentVersion++;
      return seal(full, context);
    },
    async encryptAttachment(name, bytes, context) { calls.encrypt.push({ name, bytes: [...bytes], context }); bytes.fill(0); return 'opaque-file'; },
    async decryptAttachment(_envelope, context, source) { calls.decryptSources.push({ context, source }); return { name: '日本語.bin', bytes: new Uint8Array([0, 255, 0]) }; },
    releaseAttachment(plain) { plain.bytes.fill(0); plain.name = ''; calls.released.push(plain); },
  };
  class ApiError extends Error { constructor(status, code) { super('Fixed error'); this.status = status; this.code = code; } }
  const api = { CloudApiError: ApiError, getBoxState: async () => ({ mode: 'encrypted', keyEpoch: 1 }),
    getAttachmentState: async () => { if (unavailable) throw new ApiError(403); return { stateRevision: revision, keyEpoch: 1 }; },
    listEncryptedItems: async () => ({ items: empty ? [] : [{ itemId, itemVersion: 17, keyEpoch: 1 }], nextCursor: null }),
    getEncryptedItem: async () => initial, validateItemContext() {}, readItemEnvelope: JSON.parse,
    getAttachmentItemSnapshot: async () => initial, getEncryptedAttachment: async () => 'opaque-file', deleteEncryptedItem: async () => {},
    async putEncryptedItem(context, previous, envelope) { calls.item.push({ context, previous, envelope }); if (itemFailure !== null) throw new ApiError(itemFailure); revision++; return envelope; },
    async writeEncryptedAttachment(prepared) { calls.attachment.push(structuredClone(prepared)); if (attachmentFailure !== null) throw new ApiError(attachmentFailure); revision += 2; return revision; },
  };
  const imports = {
    react: { useMemo(fn, deps) { const n = slot++; if (!hooks[n] || deps.some((d, i) => d !== hooks[n].deps[i])) hooks[n] = { deps, value: fn() }; return hooks[n].value; },
      useCallback(fn, deps) { const n = slot++; if (!hooks[n] || deps.some((d, i) => d !== hooks[n].deps[i])) hooks[n] = { deps, value: fn }; return hooks[n].value; },
      useRef(value) { return hooks[slot++] ??= { current: value }; }, useState(value) { const n = slot++; hooks[n] ??= value; return [hooks[n], (fn) => { hooks[n] = typeof fn === 'function' ? fn(hooks[n]) : fn; }]; },
      useLayoutEffect(fn, deps) { const n = slot++; if (!hooks[n] || deps.some((d, i) => d !== hooks[n][i])) { cleanups[n]?.(); hooks[n] = deps; effects.push(() => { cleanups[n] = fn(); }); } } },
    'react/jsx-runtime': { jsx, jsxs: jsx }, '@shared/ui/ItemForm.js': { ItemForm },
    '@shared/types/item.js': { emptyFormValues: () => ({ ...values, title: '', password: '' }), formValuesFromItem: () => ({ ...values }),
      ITEM_CATEGORIES: ['LOGIN'], categoryLabel: () => 'LOGIN' },
    '@shared/i18n/I18nProvider': { useI18n: () => ({ t: (key) => key }) }, '../../hooks/useAuthSession': { useAuthSession: () => ({ user: { id: userId } }) },
    './useItemLabels': { useItemLabels: () => labels }, './connect-items': { connectItemFromApi: (item) => ({ ...item, tags: [] }) },
    './cloud-api': api, './encrypted-items.css': {},
  };
  if (realReact) { imports.react = React; imports['react/jsx-runtime'] = reactRequire('react/jsx-runtime'); }
  const URLFixture = { createObjectURL: () => 'blob:fixture', revokeObjectURL: (url) => calls.revoked.push(url) };
  const { EncryptedItems: EncryptedItemsPage } = moduleAt('../shared/cloud/EncryptedItems.tsx', imports, { window, document, URL: URLFixture });
  function render() {
    if (realReact) {
      renderer.act(() => {
        const element = React.createElement(EncryptedItemsPage, { worker, scope: heldScope, api, userId, onLock: () => locked++ });
        if (mounted) mounted.update(element);
        else mounted = renderer.create(element, { createNodeMock: (node) => node.type === 'input' ? fileInput : { querySelector: () => ({ focus() {}, type: 'password' }) } });
      });
      const snapshot = (node) => {
        if (typeof node !== 'object') return node;
        const children = node.children.map(snapshot);
        return { type: node.type, props: { ...node.props, children: children.length === 1 ? children[0] : children } };
      };
      tree = snapshot(mounted.root); return tree;
    }
    slot = 0; tree = EncryptedItemsPage({ worker, scope: heldScope, api, userId, onLock: () => locked++ });
    for (const node of all(tree, (node) => !!node.props.ref)) {
      const ref = node.props.ref;
      const element = node.type === 'input' ? fileInput : { querySelector: () => ({ focus() {}, type: 'password' }) };
      if (typeof ref === 'function') ref(element); else ref.current = element;
    }
    const pending = effects; effects = []; pending.forEach((fn) => fn()); return tree;
  }
  const button = (label) => all(render(), (n) => n.type === 'button' && (n.props.children === label || n.props['aria-label'] === label))[0];
  const form = () => all(render(), (n) => n.type === ItemForm)[0];
  const select = (files) => { const input = all(render(), (n) => n.type === 'input' && n.props.type === 'file')[0]; fileInput.files = files; fileInput.value = 'synthetic'; input.props.onChange({ currentTarget: fileInput }); };
  const file = (bytes = [0, 255], name = '日本語.bin') => ({ name, size: bytes.length, arrayBuffer: async () => {
    if (holdRead) await new Promise((resolve) => { releaseRead = resolve; });
    const buffer = Uint8Array.from(bytes); calls.readBuffers.push(buffer); return buffer.buffer;
  } });
  render();
  return { calls, worker, window, document, render, button, form, select, file, fileInput,
    get locked() { return locked; }, releaseRead: () => releaseRead?.(), setUser: (id) => { userId = id; }, setScope: (next) => { heldScope = { ...heldScope, ...next }; },
    unmount: () => { if (realReact) renderer.act(() => mounted.unmount()); else for (const cleanup of cleanups) cleanup?.(); },
    async open() { await flush(); const click = () => button(empty ? 'submitAdd' : 'edit: Original').props.onClick();
      if (realReact) renderer.act(click); else click(); await flush(); render(); },
    setAttachmentFailure(status) { attachmentFailure = status; }, setItemFailure(status) { itemFailure = status; } };
}

test('new item plus arbitrary binary/empty/259-byte files closes only after all saves', async () => {
  const h = host({ empty: true }); await h.open();
  h.button('attachments.add').props.onClick(); h.select([h.file(), h.file([], '空'), h.file(Array.from({ length: 259 }, (_, i) => i % 256), 'same'), h.file([255], 'same')]);
  h.form().props.onSubmit({ ...values }); await flush();
  assert.equal(h.calls.create, 1); assert.equal(h.calls.attachment.length, 4); assert.equal(h.form(), undefined);
  assert.deepEqual(h.calls.encrypt.map((r) => r.bytes.length), [2, 0, 259, 1]);
  assert.deepEqual(h.calls.encrypt[2].bytes, Array.from({ length: 259 }, (_, i) => i % 256));
  assert.deepEqual(h.calls.encrypt[0].bytes, [0, 255]); assert.equal(h.fileInput.value, '');
});
test('lost creation reply retries exact ID and envelope without second create', async () => {
  const h = host({ empty: true, itemFailure: 0 }); await h.open();
  h.button('attachments.add').props.onClick(); h.select([h.file()]); h.form().props.onSubmit(values); await flush();
  assert.ok(h.form()); assert.equal(h.calls.attachment.length, 0);
  h.setItemFailure(null); h.button('encryptedItems.retrySame').props.onClick(); await flush();
  assert.equal(h.calls.create, 1); assert.equal(h.calls.item[0].envelope, h.calls.item[1].envelope);
  assert.equal(h.calls.attachment.length, 1); assert.equal(h.form(), undefined);
});
test('lost attachment reply retains form and reuses exact prepared atomic mutation', async () => {
  const h = host({ attachmentFailure: 0 }); await h.open();
  h.button('attachments.add').props.onClick(); h.select([h.file()]); h.form().props.onSubmit(values); await flush();
  assert.ok(h.form()); assert.equal(h.calls.encrypt.length, 1);
  h.setAttachmentFailure(null); h.button('encryptedItems.retrySame').props.onClick(); await flush();
  assert.equal(h.calls.encrypt.length, 1); assert.deepEqual(h.calls.attachment[0], h.calls.attachment[1]); assert.equal(h.form(), undefined);
});
test('409 deletion retains original reference and draft; no automatic retry', async () => {
  const h = host({ attachmentFailure: 409 }); await h.open();
  h.button('attachments.delete').props.onClick(); h.form().props.onSubmit(values); await flush();
  assert.ok(h.form()); assert.equal(h.form().props.values.title, 'Original');
  assert.equal(h.calls.attachment.length, 1); assert.equal(h.calls.attachment[0].expectedVersion, 17);
  assert.equal(h.calls.attachment[0].envelope, null); assert.equal(h.calls.encrypt.length, 0);
  assert.equal(h.button('encryptedItems.retrySame'), undefined);
});
test('replacement uses file17 and keeps unknown reference attributes; cancellation restores old name', async () => {
  const h = host(); await h.open(); h.button('attachments.replace').props.onClick(); h.select([h.file([255, 0], '変更.bin')]);
  h.button('attachments.undoReplace').props.onClick(); assert.ok(all(h.render(), (n) => n.props.children === '日本語.bin').length);
  h.button('attachments.replace').props.onClick(); h.select([h.file([255, 0], '変更.bin')]); h.form().props.onSubmit(values); await flush();
  assert.equal(h.calls.attachment[0].expectedVersion, 17); assert.equal(h.calls.attachment[0].context.attachmentVersion, 18);
  assert.equal(h.calls.attachment[0].itemContext.itemVersion, 19);
  assert.deepEqual(h.calls.encrypt[0].bytes, [255, 0]); assert.equal(h.form(), undefined);
});
test('oversize rejects complete selection, file input clears, no type filter', async () => {
  const h = host({ empty: true }); await h.open(); h.select([h.file(), { ...h.file(), size: 1048577 }]);
  assert.equal(all(h.render(), (n) => n.type === 'input' && n.props.type === 'file')[0].props.accept, undefined);
  assert.equal(h.fileInput.value, ''); assert.equal(all(h.render(), (n) => n.props.children === 'attachments.pending').length, 0);
});
test('download authenticates item17/file17 at same revision then wipes/revokes', async () => {
  const h = host(); await h.open(); h.button('attachments.download').props.onClick(); await flush();
  assert.equal(h.calls.download, 1); assert.deepEqual(h.calls.revoked, ['blob:fixture']);
  const source = h.calls.decryptSources.at(-1); assert.equal(source.context.attachmentVersion, 17);
  assert.equal(source.source.expectedItemContext.itemVersion, 17);
  assert.equal(source.source.itemSnapshotRevision, source.source.attachmentSnapshotRevision);
  assert.ok(h.calls.released.every((p) => p.bytes.every((b) => b === 0) && p.name === ''));
});
for (const boundary of ['cancel', 'unmount', 'background', 'logout', 'account', 'box', 'epoch', 'idle']) test(`late file read after ${boundary} cannot encrypt or save`, async () => {
  const h = host({ empty: true, holdRead: true }); await h.open(); h.select([h.file()]); h.form().props.onSubmit(values); await flush();
  if (boundary === 'cancel') h.button('cancelEdit').props.onClick();
  if (boundary === 'unmount') h.unmount();
  if (boundary === 'background') { h.document.visibilityState = 'hidden'; h.document.dispatchEvent({ type: 'visibilitychange' }); }
  if (boundary === 'logout') h.window.dispatchEvent({ type: 'passshare:cloud-lock' });
  if (boundary === 'account') { h.setUser('22222222-2222-4222-8222-222222222222'); h.render(); }
  if (boundary === 'box') { h.setScope({ passwordBoxId: 'e'.repeat(26) }); h.render(); }
  if (boundary === 'epoch') { h.setScope({ keyEpoch: 2 }); h.render(); }
  if (boundary === 'idle') h.worker.dispose();
  h.releaseRead(); await flush(); assert.equal(h.calls.encrypt.length, 0); assert.equal(h.calls.attachment.length, 0);
  assert.ok(h.calls.readBuffers.length > 0 && h.calls.readBuffers.every((bytes) => bytes.every((b) => b === 0)));
  assert.equal(h.fileInput.value, '');
  if (boundary === 'unmount') assert.equal(h.window.count() + h.document.count(), 0);
});
test('attachment access rejection keeps item form and disables attachment add', async () => {
  const h = host({ unavailable: true }); await h.open(); assert.ok(h.form()); assert.equal(h.locked, 0);
  assert.equal(h.button('attachments.add').props.disabled, true);
});

test('actual React host preserves a failed attachment draft and releases lifecycle listeners', async () => {
  const h = host({ realReact: true, empty: true, attachmentFailure: 0 }); await h.open();
  renderer.act(() => { h.select([h.file()]); });
  renderer.act(() => { h.form().props.onSubmit(values); }); await flush();
  assert.ok(h.form()); assert.equal(h.calls.create, 1); assert.equal(h.calls.attachment.length, 1);
  h.setAttachmentFailure(null); renderer.act(() => h.button('encryptedItems.retrySame').props.onClick()); await flush();
  assert.equal(h.form(), undefined); assert.deepEqual(h.calls.attachment[0], h.calls.attachment[1]);
  h.unmount(); assert.equal(h.window.count() + h.document.count(), 0);
});

test('actual React unmount discards a delayed File read and clears the selected input', async () => {
  const h = host({ realReact: true, empty: true, holdRead: true }); await h.open();
  renderer.act(() => { h.select([h.file()]); h.form().props.onSubmit(values); }); await flush();
  h.unmount(); h.releaseRead(); await flush();
  assert.equal(h.calls.attachment.length, 0); assert.equal(h.calls.encrypt.length, 0); assert.equal(h.fileInput.value, '');
});
for (const boundary of ['account', 'box', 'epoch']) test(`actual React ${boundary} switch clears the chooser and rejects the old file read`, async () => {
  const h = host({ realReact: true, empty: true, holdRead: true }); await h.open();
  renderer.act(() => { h.select([h.file()]); h.form().props.onSubmit(values); }); await flush();
  // The chooser can still contain a newly selected File while a delayed read is
  // pending. React detaches its ref as well as running the session cleanup.
  h.fileInput.value = 'synthetic-pending-selection';
  renderer.act(() => {
    if (boundary === 'account') h.setUser('22222222-2222-4222-8222-222222222222');
    if (boundary === 'box') h.setScope({ passwordBoxId: 'e'.repeat(26) });
    if (boundary === 'epoch') h.setScope({ keyEpoch: 2 });
    h.render();
  });
  assert.equal(h.fileInput.value, ''); h.releaseRead(); await flush();
  assert.equal(h.calls.encrypt.length, 0); assert.equal(h.calls.attachment.length, 0);
  assert.ok(h.calls.readBuffers.every((bytes) => bytes.every((b) => b === 0)));
  h.unmount(); assert.equal(h.window.count() + h.document.count(), 0);
});

test('a stale replacement-cancel callback cannot alter a frozen prepared draft', async () => {
  const h = host({ attachmentFailure: 0 }); await h.open();
  h.button('attachments.replace').props.onClick(); h.select([h.file([0, 255], '変更.bin')]);
  const undo = h.button('attachments.undoReplace').props.onClick;
  h.form().props.onSubmit(values); await flush(); undo();
  assert.ok(all(h.render(), (node) => node.props.children === '変更.bin').length);
  h.setAttachmentFailure(null); h.button('encryptedItems.retrySame').props.onClick(); await flush();
  assert.deepEqual(h.calls.attachment[0], h.calls.attachment[1]); assert.equal(h.calls.encrypt.length, 1);
});

test('attachment GET refuses a response beyond its own public envelope bound', async () => {
  const api = apiAt({ './auth-api': { authFetch: async () =>
    new Response('x'.repeat(1404001), { status: 200, headers: { 'Content-Length': '1404001' } }) } }, { Response, atob, btoa });
  await assert.rejects(api.getEncryptedAttachment({ passwordBoxId: box, itemId, attachmentId, attachmentVersion: 17, keyEpoch: 1 }, 17, new AbortController().signal),
    (error) => error.status === 502 && error.message === 'Encrypted storage request failed');
});

test('actual HTTP attachment transport embeds opaque envelopes and validates complete atomic reply', async () => {
  let reply = { stateRevision: 19, itemVersion: 18, attachmentVersion: 18, keyEpoch: 1 }, seen;
  const api = apiAt({ './auth-api': { authFetch: async (url, init) => {
    seen = { url, init }; return new Response(JSON.stringify(reply), { status: 200 });
  } } }, { Response, atob, btoa });
  const context = { ...itemContext, attachmentId, attachmentVersion: 18 }; delete context.itemVersion;
  const envelope = JSON.stringify({ format: 1, context: { ...itemContext, itemVersion: 18 }, nonce: btoa('\0'.repeat(24)), ciphertext: btoa('\0'.repeat(16)) });
  const prepared = { context, itemContext: { ...itemContext, itemVersion: 18 }, revision: 17, itemEnvelope: envelope, expectedVersion: 17, envelope: '{"opaque":"synthetic"}' };
  assert.equal(await api.writeEncryptedAttachment(prepared, new AbortController().signal), 19);
  const body = JSON.parse(seen.init.body); assert.deepEqual(Object.keys(body).sort(), ['envelope', 'expectedStateRevision', 'expectedVersion', 'item']);
  assert.equal(body.item.expectedVersion, 17); assert.equal(body.expectedVersion, 17); assert.equal(seen.init.method, 'PUT');
  reply = { ...reply, stateRevision: 18 }; await assert.rejects(api.writeEncryptedAttachment(prepared, new AbortController().signal));
  reply = { stateRevision: 19, itemVersion: 18, deleted: true, keyEpoch: 1 };
  assert.equal(await api.writeEncryptedAttachment({ ...prepared, context: { ...context, attachmentVersion: 17 }, envelope: null }, new AbortController().signal), 19);
  assert.equal(seen.init.method, 'DELETE'); assert.equal(JSON.parse(seen.init.body).keyEpoch, 1);
});

test('public attachment state and item snapshot use recipient routes and reject malformed metadata', async () => {
  let reply = { stateRevision: 17, keyEpoch: 1 }, seen;
  const api = apiAt({ './auth-api': { authFetch: async (url, init) => {
    seen = { url, init }; return new Response(JSON.stringify(reply), { status: 200 });
  } } }, { Response, atob, btoa });
  const signal = new AbortController().signal;
  assert.deepEqual(JSON.parse(JSON.stringify(await api.getAttachmentState(box, signal))), reply);
  assert.equal(seen.url, `/api/encrypted/boxes/${box}/attachment-state`);
  assert.equal(seen.init.signal, signal);
  for (const bad of [{ stateRevision: 0, keyEpoch: 1 }, { stateRevision: 17, keyEpoch: '1' },
    { stateRevision: 17, keyEpoch: 1, members: [] }]) {
    reply = bad; await assert.rejects(api.getAttachmentState(box, signal), (error) => error.status === 502);
  }
  reply = { format: 1, context: itemContext, nonce: btoa('\0'.repeat(24)), ciphertext: btoa('\0'.repeat(16)) };
  await api.getAttachmentItemSnapshot(itemContext, 17, signal);
  assert.equal(seen.url, `/api/encrypted/boxes/${box}/items/${itemId}/attachment-snapshot?revision=17`);
});
