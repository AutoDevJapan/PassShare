// Transport only: sends a fixed message script to the real Worker and posts the raw replies
// to the Rust example, which makes every pass/fail decision.
import init, { start_worker } from './passshare_cloud_wasm.js';

await init();
let mainThread;
try {
  start_worker();
  mainThread = 'started';
} catch (e) {
  mainThread = String(e);
}

const f = await (await fetch('/fixture.json')).json();
const replies = [];
let resolveNext;
const next = () => new Promise((resolve) => (resolveNext = resolve));
const worker = new Worker('/boot.mjs', { type: 'module' });
worker.onmessage = (e) => resolveNext(JSON.parse(e.data));
worker.onerror = () => resolveNext({ ok: false, error: 'worker error' });

let id = 0;
const receive = async (pending) => {
  const reply = await pending;
  replies.push(reply);
  return reply;
};
const send = (message) => {
  const pending = next();
  worker.postMessage(JSON.stringify({ version: 1, requestId: ++id, ...message }));
  return receive(pending);
};

const owner = JSON.stringify(f.owner);
const context = JSON.stringify(f.context);
const bundle = JSON.stringify(f.bundle);
const envelope = JSON.stringify(f.envelope);
await receive(next()); // ready
await send({ command: 'status' });
const opened = await send({ command: 'unlock', expectedGeneration: 0, owner, bundle, password: f.password });
await send({ command: 'decrypt', expectedGeneration: opened.generation, context, envelope });
const locked = await send({ command: 'lock' });
await send({ command: 'decrypt', expectedGeneration: opened.generation, context, envelope });
const generated = await send({ command: 'generate', expectedGeneration: locked.generation, owner });
const encrypted = await send({ command: 'encrypt', expectedGeneration: generated.generation, context, item: JSON.stringify(f.item) });
const wrapped = await send({ command: 'wrap', expectedGeneration: generated.generation, password: f.password });
const relocked = await send({ command: 'lock' });
const restored = await send({ command: 'unlock', expectedGeneration: relocked.generation, owner, bundle: wrapped.bundle, password: f.password });
await send({ command: 'decrypt', expectedGeneration: restored.generation, context, envelope: encrypted.envelope });
await send({ command: 'lock' });
const negative = [];
const raw = (message) => {
  const pending = next();
  worker.postMessage(message);
  return pending;
};
negative.push(await raw(JSON.stringify({ version: 1, requestId: ++id, command: 'generate', expectedGeneration: 6, owner })));
const oldLock = JSON.stringify({ version: 1, requestId: 4, command: 'lock' });
negative.push(await raw(oldLock));
negative.push(await raw(oldLock));
negative.push(await raw(JSON.stringify({ version: 1, requestId: 13, command: 'status' })));
negative.push(await raw(JSON.stringify({ version: 1, requestId: 14, command: 'status', unknown: true })));
negative.push(await raw({}));
worker.terminate();

const run = new URL(location.href).searchParams.get('run');
const result = await fetch(`/result/${run}`, { method: 'POST', body: JSON.stringify({ mainThread, replies, negative }) });
if (!result.ok) throw new Error('Rust verification refused the result');
document.title = 'cloud worker acceptance: done';
