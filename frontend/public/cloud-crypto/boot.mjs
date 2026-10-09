// Worker boot only. All policy lives in the Rust dispatcher (src/worker.rs).
// Place next to the `wasm-bindgen --target web` output and start with
// `new Worker(url, { type: 'module' })`; wait for the ready reply before sending.
import init, { start_worker } from './passshare_cloud_wasm.js';

await init();
start_worker();
