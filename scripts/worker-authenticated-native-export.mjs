import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {nativeExportAcceptanceHost} from './native-export-acceptance-host.mjs';

// Acceptance transport only: real browser fetch -> the isolated authenticated
// API, real CloudWorker/WASM, and the existing non-UI Rust acceptance host.
export async function workerAuthenticatedNativeExport(input) {
  const require = createRequire(resolve('frontend/package.json'));
  const {chromium} = require('@playwright/test');
  const {createServer} = await import(pathToFileURL(require.resolve('vite')).href);
  const vite = await createServer({
    root: resolve('apps/desktop'),
    configFile: resolve('apps/desktop/vite.config.ts'),
    server: {host: '127.0.0.1', port: 0, strictPort: false, hmr: false,
      proxy: {'/api': {target: input.apiBase, changeOrigin: true}}},
  });
  let browser, host;
  try {
    await vite.listen();
    const address = vite.httpServer.address();
    assert.equal(typeof address, 'object');
    host = nativeExportAcceptanceHost(resolve('target/debug/examples/export_native_acceptance.exe'), [], {
      PASSSHARE_TEST_PUBLISHER: resolve('target/debug/passshare-export-publish.exe'),
    });
    browser = await chromium.launch({headless: true,
      ...(process.env.PASSSHARE_TEST_BROWSER ? {executablePath: process.env.PASSSHARE_TEST_BROWSER} : {})});
    const page = await browser.newPage();
    const apiResponses = [];
    page.on('response', response => {
      if (new URL(response.url()).pathname.startsWith('/api/commercial-contracts/')) apiResponses.push(response.status());
    });
    await page.exposeFunction('nativeInvoke', host.invoke);
    await page.goto(`http://127.0.0.1:${address.port}/cloud-crypto/boot.mjs`);
    const result = await page.evaluate(async input => {
      const {CloudWorker, createCloudApi, saveNativeCommercialExport} = await import('/src/lib/native-export.ts');
      const worker = new CloudWorker();
      try {
        await worker.ready;
        await worker.unlock(input.owner, input.bundle, input.password);
        const api = createCloudApi((path, init) => fetch(path, {...init, headers: {
          'x-passshare-client': 'mobile', authorization: `Bearer ${input.token}`,
        }}));
        return await saveNativeCommercialExport(window.nativeInvoke, input.output, api, worker,
          input.contractId, input.owner.passwordBoxId, input.pin, new AbortController().signal);
      } finally {
        worker.dispose();
        await worker.closed;
      }
    }, input);
    assert.equal(result.saved, true);
    assert.equal(result.items, 12);
    assert.equal(result.attachments, 1);
    assert.ok(apiResponses.length >= 4, 'Real browser must fetch both pages and the attachment snapshot/content');
    assert.ok(apiResponses.every(status => status === 200), 'Authenticated export HTTP responses must succeed');
    return result;
  } finally {
    try { await browser?.close(); }
    finally {
      try { if (host) assert.equal(await host.close(), 0, 'Native acceptance host must exit'); }
      finally { await vite.close(); }
    }
  }
}
