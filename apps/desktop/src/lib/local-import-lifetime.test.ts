import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';

test('real desktop handler never imports a file resolved after its view is disposed', async () => {
  const source = fs.readFileSync(new URL('../components/MainPanel.tsx', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('  async function handleImportFile('), source.indexOf('\n  if (enablingRecovery)'));
  let finish!: (value: string) => void;
  const text = new Promise<string>(resolve => { finish = resolve; });
  let started!: () => void;
  const readStarted = new Promise<void>(resolve => { started = resolve; });
  let saves = 0;
  const importLifetime = {current: {active: true, busy: false}};
  const context = vm.createContext({importLifetime, masterPassword: 'synthetic', boxPath: 'synthetic.pbox',
    nativeImportStatus: async () => ({epoch: 1, unlocked: true}),
    importOnepasswordCsv: async () => { saves++; return 1; },
    setImportMessage: () => {}, setListError: () => {}, refreshItems: async () => {},
    itemLabels: {importSuccess: '{count}'}, formatTauriError: String});
  vm.runInContext(stripTypeScriptTypes(body) + ';globalThis.run=handleImportFile', context);
  const pending = context.run({target: {files: [{text: () => { started(); return text; }}], value: 'chosen'}});
  await readStarted;
  importLifetime.current.active = false;
  finish('Title,Password\nSynthetic,value');
  await pending;
  assert.equal(saves, 0);
});

test('recovery navigation invalidates the current flight before React commits the next view', () => {
  const source = fs.readFileSync(new URL('../components/MainPanel.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('  function showRecovery()');
  const end = source.indexOf('\n  async function refreshItems', start);
  const lifetime = {active: true, busy: true};
  let observed: boolean | undefined;
  const context = vm.createContext({importLifetime: {current: lifetime},
    setEnablingRecovery: () => { observed = lifetime.active; }});
  vm.runInContext(stripTypeScriptTypes(source.slice(start, end)) + ';showRecovery()', context);
  assert.equal(observed, false);
  assert.equal(lifetime.active, false);
  assert.equal(lifetime.busy, true);
});

test('late list results and import success never update a disposed import view', async () => {
  const source = fs.readFileSync(new URL('../components/MainPanel.tsx', import.meta.url), 'utf8');
  const refresh = source.slice(source.indexOf('  async function refreshItems('), source.indexOf('\n  useEffect(', source.indexOf('  async function refreshItems(')));
  const handler = source.slice(source.indexOf('  async function handleImportFile('), source.indexOf('\n  if (enablingRecovery)'));
  let finish!: (value: unknown[]) => void;
  let started!: () => void;
  const reached = new Promise<void>(resolve => { started = resolve; });
  const response = new Promise<unknown[]>(resolve => { finish = resolve; });
  const lifetime = {active: true, busy: false};
  const effects: string[] = [];
  const context = vm.createContext({importLifetime: {current: lifetime}, masterPassword: 'synthetic', boxPath: 'original.pbox', searchQuery: '',
    nativeImportStatus: async () => ({epoch: 7, unlocked: true}), importOnepasswordCsv: async () => 1,
    listItems: () => { started(); return response; }, searchItems: () => response,
    setItems: () => effects.push('items'), setImportMessage: () => effects.push('success'), setListError: () => effects.push('error'),
    itemLabels: {importSuccess: '{count}'}, formatTauriError: String});
  vm.runInContext(stripTypeScriptTypes(refresh + handler) + ';globalThis.run=handleImportFile', context);
  const pending = context.run({target: {files: [{text: async () => 'synthetic csv'}], value: 'chosen'}});
  await reached;
  lifetime.active = false;
  finish([]);
  await pending;
  assert.deepEqual(effects, []);
  assert.equal(lifetime.busy, false);
});

test('real handler binds epoch and Box, suppresses concurrent selection, and releases failed flights', async () => {
  const source = fs.readFileSync(new URL('../components/MainPanel.tsx', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('  async function handleImportFile('), source.indexOf('\n  if (enablingRecovery)'));
  let finish!: (value: string) => void;
  const text = new Promise<string>(resolve => { finish = resolve; });
  const calls: unknown[][] = [];
  let fail = true;
  const importLifetime = {current: {active: true, busy: false}};
  const context = vm.createContext({importLifetime, masterPassword: 'synthetic', boxPath: '  original.pbox  ',
    nativeImportStatus: async () => ({epoch: 7, unlocked: true}),
    importOnepasswordCsv: async (...args: unknown[]) => { calls.push(args); if (fail) throw Error('save rejected'); return 1; },
    setImportMessage: () => {}, setListError: () => {}, refreshItems: async () => {},
    itemLabels: {importSuccess: '{count}'}, formatTauriError: String});
  vm.runInContext(stripTypeScriptTypes(body) + ';globalThis.run=handleImportFile', context);
  const event = () => ({target: {files: [{text: () => text}], value: 'chosen'}});
  const first = context.run(event());
  await context.run(event());
  finish('synthetic csv');
  await first;
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['synthetic csv', 'synthetic', 7, 'original.pbox']);
  assert.equal(importLifetime.current.busy, false);
  fail = false;
  await context.run(event());
  assert.equal(calls.length, 2);
  assert.equal(importLifetime.current.busy, false);
});
