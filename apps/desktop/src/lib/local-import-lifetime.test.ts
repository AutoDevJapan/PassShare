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
  let saves = 0;
  const importLifetime = {current: {active: true, busy: false}};
  const context = vm.createContext({importLifetime, masterPassword: 'synthetic', boxPath: 'synthetic.pbox',
    nativeImportStatus: async () => ({epoch: 1, unlocked: true}),
    importOnepasswordCsv: async () => { saves++; return 1; },
    setImportMessage: () => {}, setListError: () => {}, refreshItems: async () => {},
    itemLabels: {importSuccess: '{count}'}, formatTauriError: String});
  vm.runInContext(stripTypeScriptTypes(body) + ';globalThis.run=handleImportFile', context);
  const pending = context.run({target: {files: [{text: () => text}], value: 'chosen'}});
  await Promise.resolve();
  importLifetime.current.active = false;
  finish('Title,Password\nSynthetic,value');
  await pending;
  assert.equal(saves, 0);
});

test('real handler binds epoch and Box, suppresses concurrent selection, and releases failed flights', async () => {
  const source = fs.readFileSync(new URL('../components/MainPanel.tsx', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('  async function handleImportFile('), source.indexOf('\n  if (enablingRecovery)'));
  let finish!: (value: string) => void;
  const text = new Promise<string>(resolve => { finish = resolve; });
  const calls: unknown[][] = [];
  let fail = true;
  const importLifetime = {current: {active: true, busy: false}};
  const context = vm.createContext({importLifetime, masterPassword: 'synthetic', boxPath: 'original.pbox',
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
